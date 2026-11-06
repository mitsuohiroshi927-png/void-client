'use strict';
/**
 * Launch engine — builds the exact JVM command line and spawns Minecraft.
 *
 * Argument handling follows the vanilla launcher: `${placeholder}` substitution
 * inside both the library-provided JVM args and the version json arguments,
 * with Mojang rule evaluation so only Windows-relevant entries survive.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { exists, rulesAllow, mavenToPath } = require('./installer');
const { unzipFiltered } = require('./zip');
const mods = require('./mods');
const { VERSION } = require('./version');
const mcver = require('./mcver');

/**
 * Resolve the feedback webhook that gets seeded into `<gameDir>/config/voidfps-feedback.url`.
 *
 * The URL is deliberately NOT a constant in this file: `launch.js` is bundled
 * into the installer's asar, so anything written here is readable by anyone who
 * downloads the .exe (`asar extract`). Resolution order, first hit wins:
 *
 *   1. VOIDFPS_FEEDBACK_URL env var — CI/release builds inject it at build time
 *      so it never lands in a committed source file.
 *   2. `<userData>/voidfps-feedback.url` — operator-side override, writable
 *      without a rebuild (this is the normal path for a locally built exe).
 *   3. None — seeding is skipped and the mod falls back to local-only feedback.
 *
 * Returns '' when nothing is configured.
 */
function resolveFeedbackUrl(userDataDir) {
  const fromEnv = (process.env.VOIDFPS_FEEDBACK_URL || '').trim();
  if (/^https:\/\/discord\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(fromEnv)) return fromEnv;

  if (userDataDir) {
    try {
      const fromFile = fs
        .readFileSync(path.join(userDataDir, 'voidfps-feedback.url'), 'utf8')
        .trim();
      if (/^https:\/\/discord\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(fromFile)) return fromFile;
    } catch (_) {
      /* absent or unreadable: fall through */
    }
  }
  return '';
}

/* ------------------------------------------------------- natives handling */

/** True when this library entry is a natives artifact (modern classifier-in-name format). */
const jvm = require('./jvm');

function isNativesLib(lib) {
  if (!lib || !lib.name) return false;
  if (lib.natives) return true;
  const classifiers = (lib.downloads && lib.downloads.classifiers) || {};
  if (Object.keys(classifiers).some((k) => /^natives-/.test(k))) return true;
  // 1.21.11 style: org.lwjgl:lwjgl-glfw:3.3.3:natives-windows
  return /:natives-/.test(lib.name) || /-natives-/.test(lib.name);
}

/** Current-OS natives classifier suffix set; we build for Windows. */
function nativesSuffix() {
  if (process.platform === 'win32') return process.arch === 'arm64' ? 'natives-windows-arm64' : 'natives-windows';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'natives-macos-arm64' : 'natives-macos';
  return process.arch === 'arm64' ? 'natives-linux-arm64' : 'natives-linux';
}

/** Extract native-typed libraries into a per-version natives dir. */
async function extractNatives(versionJson, libraries, root, nativesDir) {
  await fsp.mkdir(nativesDir, { recursive: true });
  const suffix = nativesSuffix();
  const targets = [];
  for (const lib of libraries) {
    if (!isNativesLib(lib)) continue;
    // Only take the entry that matches this OS/arch.
    const name = lib.name || '';
    const m = name.match(/:(natives-[a-z0-9-]+)$/);
    if (m) {
      if (m[1] !== suffix) continue;
    } else if (lib.natives) {
      const cls = (lib.natives.windows || '').replace('${arch}', '64');
      if (process.platform === 'win32' && !cls) continue;
    }
    if (!rulesAllow(lib.rules)) continue;
    const artifact = lib.downloads && lib.downloads.artifact;
    const p = artifact && artifact.path
      ? path.join(root, 'libraries', artifact.path)
      : path.join(root, 'libraries', mavenToPath(name));
    if (await exists(p)) targets.push(p);
  }

  const stamp = `${suffix}:${targets.map((t) => path.basename(t)).sort().join(',')}`;
  const stampFile = path.join(nativesDir, '.extracted');
  if (await exists(stampFile)) {
    const prev = await fsp.readFile(stampFile, 'utf8').catch(() => '');
    if (prev === stamp) return targets.length;
  }
  for (const jarPath of targets) {
    await unzipFiltered(jarPath, nativesDir, (n) => /\.(dll|so|dylib)$/i.test(n) && !n.includes('META-INF'));
  }
  await fsp.writeFile(stampFile, stamp);
  return targets.length;
}

async function findArtifact(lib, root, classifier) {
  const pathGuess = mavenToPath(lib.name).replace(/\.jar$/, `-${classifier}.jar`);
  const p = path.join(root, 'libraries', pathGuess);
  return (await exists(p)) ? p : null;
}

/* ----------------------------------------------------- argument assembly */

function substitute(template, vars) {
  return template.replace(/\$\{([^}]+)\}/g, (m, key) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : m;
  });
}

/** Flatten the version json `arguments` arrays honouring rules. */
function flattenArgs(list, features) {
  const out = [];
  for (const entry of list || []) {
    if (typeof entry === 'string') {
      out.push(entry);
      continue;
    }
    if (entry && Array.isArray(entry.value) || (entry && typeof entry.value === 'string')) {
      if (!rulesAllow(entry.rules, features)) continue;
      if (Array.isArray(entry.value)) out.push(...entry.value);
      else out.push(entry.value);
    }
  }
  return out;
}

/**
 * Build the launch specification.
 * @returns {{command:string, args:string[], classpath:string, mainClass:string, nativeDir:string}}
 */
async function buildLaunchSpec(opts) {
  const {
    root,
    mcVersion,
    fabric,             // {mainClass, libraries, id} | null
    versionJson,        // vanilla version json
    session,            // {name, uuid, accessToken, userType, xuid, clientId}
    settings,           // {javaPath, ram, width, height, gameDir, extraJvmArgs}
    versionType = 'release',
  } = opts;

  const libraries = [];
  const libArgs = [];

  const pushLib = (lib) => {
    if (!rulesAllow(lib.rules)) return;
    // Natives jars are extracted to a directory, never put on the classpath.
    if (isNativesLib(lib)) return;
    const artifact = lib.downloads && lib.downloads.artifact;
    const p = artifact && artifact.path
      ? path.join(root, 'libraries', artifact.path)
      : path.join(root, 'libraries', mavenToPath(lib.name));
    if (!libraries.includes(p)) libraries.push(p);
  };

  // Fabric libs first (they must win on the classpath), then vanilla.
  if (fabric && fabric.libraries) for (const l of fabric.libraries) pushLib(l);
  for (const l of versionJson.libraries || []) pushLib(l);

  // JVM args contributed by libraries (e.g. lwjgl -XstartOnFirstThread, osx only).
  for (const l of [...(fabric ? fabric.libraries || [] : []), ...(versionJson.libraries || [])]) {
    if (!rulesAllow(l.rules)) continue;
    if (l.arguments && l.arguments.jvm) libArgs.push(...flattenArgs(l.arguments.jvm, {}));
  }

  // The vanilla client jar must be on the classpath for Fabric's Knot to locate
  // the game ("Minecraft game provider couldn't locate the game!"). If it is
  // still absent here the launch would end in Fabric's crash window, so fail
  // with a message the launcher can actually show.
  const clientJar = path.join(root, 'versions', mcVersion, `${mcVersion}.jar`);
  if (await exists(clientJar)) {
    if (!libraries.includes(clientJar)) libraries.push(clientJar);
  } else {
    throw new Error(`Minecraft ${mcVersion} client jar is missing — install the version first, then launch again.`);
  }

  // VOID Client ships INSIDE the client (vendor/void-client-<ver>.jar). Fabric only
  // scans mods/ for entrypoints, so a classpath jar is on the JVM's classpath but
  // never registered as a mod — -Dfabric.addMods is what makes it load. Verified:
  // classpath alone => 48 mods, no voidfps; addMods => 50 mods, voidfps 0.2.0.
  // It is still never copied into mods/, so the user never sees it as installed.
  //
  // Mods are the profile's own folder (gameDir/profiles/<id>/mods) plus, when the
  // profile opts in, the shared gameDir/mods folder. Which of those load is driven
  // by the ACTIVE PROFILE (settings.profileMods):
  //   voidFps:false       -> bundle not added at all (Vanilla profile stays clean)
  //   inheritShared:true  -> also pull gameDir/mods into the classpath
  //   extraJar:false      -> do not attach the profile's own mods folder
  // NOTE: older profiles persisted this flag as `extras`, which this code never
  // read — the profile folder was silently skipped and installed mods never loaded.
  // Read both spellings so existing profiles keep working; default to true.
  const pm = settings.profileMods || { voidFps: true, inheritShared: false, extraJar: true };
  const attachProfileJars = pm.extraJar !== false && pm.extras !== false;
  let bundledVoidFps = null;
  const extraModJars = [];
  const say = (line) => {
    // One helper for every launcher-side message on this path: these used to be
    // written to settings.onLog only, which the launch handler never passed — so a
    // skipped bundle was completely silent and the game simply started without the mod.
    if (typeof settings.onLog === 'function') settings.onLog(line);
    if (typeof settings.log === 'function') settings.log(line.replace(/^\[launcher\] /, ''));
  };

  // Find the bundled jar FIRST: whether it may be attached depends on the range that
  // jar declares for itself, so the decision cannot be made before it is located.
  if (pm.voidFps !== false) {
    const bundledCandidates = [
      path.join(process.resourcesPath || '', 'vendor'),
      path.join(__dirname, '..', '..', 'vendor'),
    ];
    for (const dir of bundledCandidates) {
      try {
        const jars = (await fsp.readdir(dir)).filter((f) => /^void-(?:fps|client)-.*\.jar$/i.test(f));
        if (jars.length) { bundledVoidFps = path.join(dir, jars.sort().pop()); break; }
      } catch { /* directory absent in this layout */ }
    }
    if (!bundledVoidFps) {
      say('[launcher] WARN VOID Client bundle not found next to the launcher (resources/vendor) — starting without it');
    }
  }

  // The jar is the single source of truth for which Minecraft versions it supports.
  // A hand-rolled table here used to allow every year-based release (26.x) while the
  // jar declares `minecraft: "1.21.11"`, so Fabric was handed a jar it refuses to
  // load — a boot error instead of a skipped mod.
  let voidFpsDeclared = null;
  if (bundledVoidFps) {
    const meta = await mods.readFabricModJson(bundledVoidFps).catch(() => null);
    voidFpsDeclared = (meta && meta.depends && meta.depends.minecraft) || null;
  }
  // NB: the version comes from the top-level `mcVersion` parameter, not from the settings
  // object. This code used to read the version out of `settings`, a field the launch
  // handler never sends — so the value was undefined, every version check failed, and the
  // bundled mod was silently never attached in ANY release that carried it.
  const voidFpsVerdict = bundledVoidFps
    ? (voidFpsDeclared ? mcver.satisfies(voidFpsDeclared, mcVersion) : null)
    : false;
  // null = the declaration could not be read/understood. Attach anyway and say so:
  // Fabric's own resolver then reports the real problem by name, which beats a silent
  // no-mod launch.
  const wantVoidFps = pm.voidFps !== false && !!bundledVoidFps && voidFpsVerdict !== false;
  if (pm.voidFps !== false && bundledVoidFps && voidFpsVerdict === null) {
    say(`[launcher] WARN could not read the VOID Client Minecraft range (${String(voidFpsDeclared)}) — attaching it anyway`);
  }
  if (pm.voidFps !== false && bundledVoidFps && voidFpsVerdict === false) {
    say(`[launcher] VOID Client skipped: it supports Minecraft ${voidFpsDeclared}, this instance is ${mcVersion}`);
  }

  if (wantVoidFps) {
    // Seed the feedback webhook into the Minecraft config dir, once. The mod reads
    // it from there; without it the feedback feature silently no-ops.
    if (settings.gameDir) {
      const webhook = resolveFeedbackUrl(
        process.env.APPDATA ? path.join(process.env.APPDATA, 'void-client') : undefined,
      );
      if (!webhook) {
        say('[launcher] No feedback webhook configured (set VOIDFPS_FEEDBACK_URL or userData/voidfps-feedback.url).');
      }
      const seeded = await mods
        .seedFeedbackWebhook(settings.gameDir, webhook)
        .catch(() => false);
      if (seeded) say('[launcher] VOID Client feedback webhook configured.');
    }
  }
  if (bundledVoidFps && wantVoidFps && !libraries.includes(bundledVoidFps)) {
    libraries.unshift(bundledVoidFps);
    extraModJars.push(bundledVoidFps);
  }
  // Per-profile mods folder: gameDir/profiles/<profile>/mods. Keeps a PvP mod
  // list out of the Vanilla session entirely.
  if (attachProfileJars && settings.profileModsDir) {
    try {
      const own = (await fsp.readdir(settings.profileModsDir)).filter((f) => /\.jar$/i.test(f));
      for (const f of own) {
        const full = path.join(settings.profileModsDir, f);
        if (!libraries.includes(full)) libraries.unshift(full);
        extraModJars.push(full);
      }
    } catch { /* profile folder not created yet */ }
  }

  // Shared folder (gameDir/mods) — only when the profile opts in. Without this the
  // documented `inheritShared:true` did nothing, so a mod marked "available in every
  // profile" still never loaded.
  if (pm.inheritShared === true && settings.gameDir) {
    try {
      const sharedDir = path.join(settings.gameDir, 'mods');
      const shared = (await fsp.readdir(sharedDir)).filter((f) => /\.jar$/i.test(f));
      for (const f of shared) {
        const full = path.join(sharedDir, f);
        if (!libraries.includes(full)) libraries.unshift(full);
        extraModJars.push(full);
      }
    } catch { /* no shared folder */ }
  }
  const classpath = libraries.join(path.delimiter);
  const nativesDir = path.join(root, 'natives', fabric ? fabric.id : mcVersion);
  // Natives now live in both the vanilla and the Fabric library list.
  const allLibsForNatives = [...(fabric ? fabric.libraries || [] : []), ...(versionJson.libraries || [])];
  const nativeCount = await extractNatives(versionJson, allLibsForNatives, root, nativesDir);

  const tmpDir = path.join(root, 'tmp');
  await fsp.mkdir(tmpDir, { recursive: true });

  const vars = {
    auth_player_name: session.name,
    version_name: fabric ? fabric.id : mcVersion,
    game_directory: settings.gameDir || path.join(root, 'game'),
    assets_root: path.join(root, 'assets'),
    assets_index_name: versionJson.assetIndex ? versionJson.assetIndex.id : 'legacy',
    auth_uuid: session.uuid,
    auth_access_token: session.accessToken,
    auth_session: session.accessToken,
    user_type: session.userType || 'msa',
    version_type: versionType,
    clientid: session.clientId || '',
    auth_xuid: session.xuid || '',
    resolution_width: settings.width || 1280,
    resolution_height: settings.height || 720,
    natives_directory: nativesDir,
    launcher_tmpdir: tmpDir,
    launcher_name: 'voidclient',
    launcher_version: VERSION,
    classpath,
    classpath_separator: path.delimiter,
    library_directory: path.join(root, 'libraries'),
  };

  // Version json jvm/game args
  const vArgs = versionJson.arguments || {};
  const jvmTemplates = flattenArgs(vArgs.jvm, {});
  const gameTemplates = flattenArgs(vArgs.game, {
    has_custom_resolution: true,
    is_demo_user: false,
    has_quick_plays_support: false,
  });

  const features = {
    has_custom_resolution: true,
    is_demo_user: false,
    has_quick_plays_support: false,
  };

  const heapMB = Number(settings.ram) || 4096;
  const tunedArgs = jvm.buildArgs({
    profile: settings.profile || null,
    heapMB,
    gcPause: settings.gcPause || 50,
    safety: !!settings.safetyMode,
    lowMemory: !!settings.lowMemory || heapMB <= 2048,
    // "Boost" JVM tuning is a user toggle now that presets are gone, not a
    // side effect of which profile card was selected.
    boost: !!settings.boostFlags,
  });

  const args = [];
  args.push(`-Xms${heapMB}M`, `-Xmx${heapMB}M`);
  // Reserve only what the client actually needs, so the largest possible
  // region of the heap is addressable without committing physical RAM.
  if (heapMB >= 4096) args.push('-XX:+AlwaysActAsServerClassMachine');
  args.push('-Dfile.encoding=UTF-8');
  args.push(`-Djava.library.path=${nativesDir}`);
  args.push('-Dminecraft.launcher.brand=voidclient', `-Dminecraft.launcher.version=${VERSION}`);
  args.push(...tunedArgs);

  // User args win, but anything that collides with a flag we already set is
  // dropped — two -Xmx or a conflicting GC choice makes the JVM refuse to start.
  if (settings.extraJvmArgs && settings.extraJvmArgs.length) {
    args.push(...jvm.dedupeAgainst(settings.extraJvmArgs, args));
  }
  const jvm2 = args;

  for (const t of jvmTemplates) {
    if (t === '-cp' || t === '-classpath') continue; // we add it explicitly after
    if (t === '${classpath}') continue;
    jvm2.push(substitute(t, vars));
  }
  for (const t of libArgs) {
    if (t === '${classpath}' || t === '-cp' || t === '-classpath') continue;
    jvm2.push(substitute(t, vars));
  }

  // Fabric will not discover these by classpath alone; addMods registers them.
  if (extraModJars.length) {
    jvm2.push(`-Dfabric.addMods=${extraModJars.join(path.delimiter)}`);
  }
  jvm2.push('-cp', classpath);

  // JVM properties can arrive from three places (our defaults, the vanilla
  // version json, and the Fabric profile). Dedupe them: last occurrence wins,
  // which is how the JVM itself resolves repeated -D flags. Also route JNA's
  // temp dir away from the natives folder, where it would litter extracted DLLs.
  const seen = new Map();
  const deduped = [];
  for (const a of jvm2) {
    if (typeof a !== 'string') { deduped.push(a); continue; }
    const m = a.match(/^-D([^=]+)=/);
    if (!m) { deduped.push(a); continue; }
    if (m[1] === 'jna.tmpdir') { deduped.push(`-Djna.tmpdir=${tmpDir}`); continue; }
    if (seen.has(m[1])) deduped[seen.get(m[1])] = null;
    seen.set(m[1], deduped.length);
    deduped.push(a);
  }
  const finalJvm = deduped.filter((a) => a !== null);

  const mainClass = (fabric && fabric.mainClass) || versionJson.mainClass;
  const game = gameTemplates.map((t) => substitute(t, vars));

  return {
    java: settings.javaPath || 'java',
    args: [...finalJvm, mainClass, ...game],
    mainClass,
    classpath,
    nativeDir: nativesDir,
    libraries,
    nativeCount,
    versionName: fabric ? fabric.id : mcVersion,
  };
}

/**
 * Spawn Minecraft. Returns the child process; the caller wires stdout/stderr.
 */
function spawnMinecraft(spec, { cwd, onData, onExit, onError }) {
  const child = spawn(spec.java, spec.args, {
    cwd: cwd || process.cwd(),
    env: { ...process.env },
    windowsHide: false,
  });
  if (onData) {
    child.stdout.on('data', (d) => onData('stdout', d.toString()));
    child.stderr.on('data', (d) => onData('stderr', d.toString()));
  }
  if (onExit) child.on('exit', (code, signal) => onExit(code, signal));
  if (onError) child.on('error', (e) => onError(e));
  return child;
}

module.exports = { buildLaunchSpec, spawnMinecraft, extractNatives, substitute, flattenArgs, isNativesLib, nativesSuffix };
