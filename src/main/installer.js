'use strict';
/**
 * Minecraft + Fabric installation engine.
 *
 * Everything is pulled from official sources:
 *   - version manifest : launchermeta.mojang.com
 *   - libraries/assets : piston-data.mojang.com / resources.download.minecraft.net
 *   - Fabric loader    : meta.fabricmc.net
 *
 * Layout (matches the vanilla launcher, so the same game dir works everywhere):
 *   <root>/versions/<id>/<id>.json + <id>.jar
 *   <root>/libraries/...
 *   <root>/assets/indexes/<assetIndex>.json + objects/<ab>/<hash>
 *   <root>/natives/<versionId>/  (extracted native libs, per-launch dir)
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const VERSION_MANIFEST = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';
const RESOURCES = 'https://resources.download.minecraft.net';
const FABRIC_META = 'https://meta.fabricmc.net/v2';

const UA = 'VoidClient/1.0.0 (launcher; +https://github.com/mitsuohiroshi927-png/void-client)';

/* ---------------------------------------------------------------- helpers */

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}

/** Download a URL to a file with an optional sha1 check. Skips when the file already matches. */
async function download(url, dest, expectedSha1, onProgress) {
  if (await exists(dest)) {
    if (!expectedSha1) return { skipped: true };
    const have = await sha1File(dest);
    if (have === expectedSha1) return { skipped: true };
  }
  await ensureDir(path.dirname(dest));
  const tmp = `${dest}.part`;

  // Assets are ~4000 files per version over flaky CDNs: a dropped TLS session at
  // file 4000 must not abort the whole install. Retry with backoff, then verify
  // the sha1 — a truncated body never reaches `dest`.
  const ATTEMPTS = 5;
  let lastErr = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let got = 0;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) {
        // 404 means the asset is genuinely gone — retrying cannot help.
        if (res.status === 404) throw Object.assign(new Error(`HTTP 404 for ${url}`), { fatal: true });
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      const total = Number(res.headers.get('content-length') || 0);
      const body = Readable.fromWeb(res.body);
      body.on('data', (chunk) => {
        got += chunk.length;
        if (onProgress && total) onProgress(got, total);
      });
      await pipeline(body, fs.createWriteStream(tmp));

      // Content-length mismatch (truncated transfer) surfaces here as a short file.
      if (total && got !== total) {
        throw new Error(`short read for ${path.basename(dest)}: got ${got}/${total} bytes`);
      }
      if (expectedSha1) {
        const have = await sha1File(tmp);
        if (have !== expectedSha1) {
          throw new Error(`Checksum mismatch for ${path.basename(dest)} (expected ${expectedSha1.slice(0, 12)}…, got ${have.slice(0, 12)}…)`);
        }
      }
      await fsp.rename(tmp, dest);
      return { skipped: false, bytes: got, attempts: attempt };
    } catch (e) {
      lastErr = e;
      await fsp.unlink(tmp).catch(() => {});
      if (e.fatal || attempt === ATTEMPTS) break;
      // 0.5s, 1s, 2s, 4s — absorbs momentary CDN hiccups without hammering.
      await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
    }
  }
  throw lastErr;
}

/** Mojang rule evaluation for libraries and arguments. */
/** Mojang OS name for the host platform. */
function currentOsName() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'osx';
  return 'linux';
}

/** Mojang arch token for the host platform. */
function currentArch() {
  return process.arch === 'arm64' ? 'arm64' : 'x86_64';
}

function rulesAllow(rules, features = {}, osName = currentOsName(), arch = currentArch()) {
  if (!rules || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    let match = true;
    if (rule.os) {
      if (rule.os.name && rule.os.name !== osName) match = false;
      if (match && rule.os.arch && rule.os.arch !== arch) match = false;
    }
    if (rule.features) {
      for (const [k, v] of Object.entries(rule.features)) {
        if (Boolean(features[k]) !== Boolean(v)) match = false;
      }
    }
    if (match) allowed = rule.action === 'allow';
  }
  return allowed;
}

function mavenToPath(name) {
  // group:artifact:version[:classifier][@ext]
  const [coord, ext] = name.split('@');
  const parts = coord.split(':');
  const [group, artifact, version, classifier] = parts;
  const fileName = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.${ext || 'jar'}`;
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${fileName}`;
}

/* ------------------------------------------------------- vanilla version */

async function fetchVersionManifest() {
  const res = await fetch(VERSION_MANIFEST, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Version manifest HTTP ${res.status}`);
  return res.json();
}

async function resolveVersionJson(versionId, root) {
  const local = path.join(root, 'versions', versionId, `${versionId}.json`);
  if (await exists(local)) {
    return JSON.parse(await fsp.readFile(local, 'utf8'));
  }
  const manifest = await fetchVersionManifest();
  const entry = manifest.versions.find((v) => v.id === versionId);
  if (!entry) throw new Error(`Minecraft ${versionId} is not in the official version manifest.`);
  const res = await fetch(entry.url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Version json HTTP ${res.status}`);
  const json = await res.json();
  await ensureDir(path.dirname(local));
  await fsp.writeFile(local, JSON.stringify(json));
  return json;
}

/** Fabric loader profile JSON, assembled from the Fabric meta API. */
/**
 * Every Minecraft version Mojang still publishes that starts with a given prefix.
 * Used to populate the version picker instead of hardcoding a list, so new 1.21.x
 * releases show up without a launcher update.
 *
 * @param {string} prefix  e.g. '1.21'
 * @returns {Promise<Array<{id:string, type:string, releaseTime:string, javaMajor:number|null}>>}
 */
async function listVersions(prefix = '1.21') {
  const cached = path.join(os.tmpdir(), 'voidclient-manifest.json');
  let manifest = null;
  try {
    const st = await fsp.stat(cached);
    if (Date.now() - st.mtimeMs < 6 * 3600 * 1000) {
      manifest = JSON.parse(await fsp.readFile(cached, 'utf8'));
    }
  } catch { /* no cache */ }
  if (!manifest || !Array.isArray(manifest.versions)) {
    const res = await fetch('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json', {
      headers: { 'User-Agent': UA },
    });
    if (!res.ok) throw new Error(`version_manifest HTTP ${res.status}`);
    manifest = await res.json();
    await fsp.writeFile(cached, JSON.stringify(manifest)).catch(() => {});
  }
  return (manifest.versions || [])
    .filter((v) => String(v.id).startsWith(prefix))
    .filter((v) => v.type === 'release')
    .map((v) => ({ id: v.id, type: v.type, releaseTime: v.releaseTime }));
}

/** Is this an exact 1.21.x version Mojang actually ships? */
async function versionExists(id) {
  const all = await listVersions('1.');
  return all.some((v) => v.id === id);
}

/**
 * Java major required by a version, read from its own version json.
 * Fabric + Mojang both refuse to run 1.21.x on anything below this.
 */
async function requiredJavaMajor(mcVersion, root) {
  if (mcVersion.startsWith('1.20.5') || /^1\.(21|[2-9])/.test(mcVersion)) return 21;
  if (/^1\.(18|19|20(?![.](5|6)))/.test(mcVersion)) return 17;
  return 21;
}

async function resolveFabricProfile(mcVersion, loaderVersion) {
  let loader = loaderVersion;
  if (!loader) {
    const res = await fetch(`${FABRIC_META}/versions/loader/${mcVersion}`, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`Fabric meta HTTP ${res.status} for ${mcVersion}`);
    const list = await res.json();
    if (!list.length) throw new Error(`No Fabric loader found for Minecraft ${mcVersion}.`);
    loader = list[0].loader.version;
  }
  const res = await fetch(`${FABRIC_META}/versions/loader/${mcVersion}/${loader}/profile/json`, {
    headers: { 'User-Agent': UA },
  });
  if (!res.ok) throw new Error(`Fabric profile HTTP ${res.status}`);
  const profile = await res.json();
  return { loaderVersion: loader, profile };
}

/* ------------------------------------------------------------ installers */

/**
 * Install the vanilla client jar + libraries + assets.
 * `onPhase(phase, done, total, label)` reports progress.
 */
async function installVanilla(versionId, root, onPhase) {
  const vjson = await resolveVersionJson(versionId, root);
  const vdir = path.join(root, 'versions', versionId);
  await ensureDir(vdir);

  // 1. client jar
  const jar = path.join(vdir, `${versionId}.jar`);
  const clientDl = vjson.downloads && vjson.downloads.client;
  if (!clientDl) throw new Error(`Version ${versionId} has no client download.`);
  onPhase && onPhase('client', 0, 1, `Minecraft ${versionId} client`);
  await download(clientDl.url, jar, clientDl.sha1);
  onPhase && onPhase('client', 1, 1, `Minecraft ${versionId} client`);

  // 2. libraries
  const libs = (vjson.libraries || []).filter((l) => rulesAllow(l.rules));
  let done = 0;
  for (const lib of libs) {
    const artifact = lib.downloads && lib.downloads.artifact;
    if (!artifact || !artifact.url) continue;
    const dest = path.join(root, 'libraries', artifact.path || mavenToPath(lib.name));
    await download(artifact.url, dest, artifact.sha1);
    done += 1;
    onPhase && onPhase('libraries', done, libs.length, 'Libraries');
  }

  // 3. assets
  const assetIndex = vjson.assetIndex;
  if (assetIndex) {
    const indexDir = path.join(root, 'assets', 'indexes');
    const indexPath = path.join(indexDir, `${assetIndex.id}.json`);
    await download(assetIndex.url, indexPath, assetIndex.sha1);
    const index = JSON.parse(await fsp.readFile(indexPath, 'utf8'));
    const objects = Object.values(index.objects);
    let adone = 0;
    const CONCURRENCY = 16;
    let cursor = 0;
    const failed = [];
    async function worker() {
      while (cursor < objects.length) {
        const obj = objects[cursor++];
        const sub = obj.hash.slice(0, 2);
        const dest = path.join(root, 'assets', 'objects', sub, obj.hash);
        try {
          if (!(await exists(dest))) {
            await download(`${RESOURCES}/${sub}/${obj.hash}`, dest, obj.hash);
          }
        } catch (e) {
          // Record and keep going: one dead asset object should not discard 4000
          // successfully downloaded files. Retried once at the end.
          failed.push({ obj, sub, dest, err: e });
        }
        adone += 1;
        if (adone % 25 === 0 || adone === objects.length) {
          onPhase && onPhase('assets', adone, objects.length, 'Assets');
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    // Second pass, serial and slow — gives a flaky CDN one more chance per file.
    for (const f of failed.slice()) {
      try {
        await download(`${RESOURCES}/${f.sub}/${f.obj.hash}`, f.dest, f.obj.hash);
        failed.splice(failed.indexOf(f), 1);
      } catch { /* stays in failed */ }
    }
    if (failed.length) {
      throw new Error(`${failed.length} asset(s) could not be downloaded — check your connection and retry. First: ${failed[0].obj.hash}`);
    }
    onPhase && onPhase('assets', objects.length, objects.length, 'Assets');
  }

  return vjson;
}

/**
 * Merge the Fabric profile over the vanilla version json:
 * adds the loader libraries and switches the main class. The vanilla jar is
 * never modified — Fabric loads it from disk at runtime.
 */
async function installFabric(mcVersion, root, loaderVersion, onPhase) {
  const { loaderVersion: resolved, profile } = await resolveFabricProfile(mcVersion, loaderVersion);
  const installedId = `${mcVersion}-fabric-${resolved}`;
  const vdir = path.join(root, 'versions', installedId);
  await ensureDir(vdir);

  let done = 0;
  const libs = (profile.libraries || []).filter((l) => rulesAllow(l.rules));
  for (const lib of libs) {
    const dl = lib.downloads && lib.downloads.artifact;
    const dest = path.join(root, 'libraries', dl && dl.path ? dl.path : mavenToPath(lib.name));
    if (dl && dl.url) {
      await download(dl.url, dest, dl.sha1);
    } else {
      // Fabric meta omits downloads for some libs; use Maven Central directly.
      const rel = mavenToPath(lib.name);
      await download(`https://maven.fabricmc.net/${rel}`, dest, null);
    }
    done += 1;
    onPhase && onPhase('fabric', done, libs.length, 'Fabric Loader');
  }

  // Profile json so the install is visible to other launchers too.
  const profileId = profile.id || installedId;
  await fsp.writeFile(path.join(vdir, `${installedId}.json`), JSON.stringify(profile, null, 2));
  // The Fabric profile inherits the vanilla client jar via inheritsFrom.
  return {
    id: installedId,
    profileId,
    loaderVersion: resolved,
    mainClass: profile.mainClass,
    libraries: profile.libraries || [],
    arguments: profile.arguments || {},
  };
}

/**
 * Full install pipeline: vanilla + fabric (optional).
 */
async function installAll({ mcVersion, root, useFabric, loaderVersion, onPhase }) {
  await ensureDir(root);
  const vanilla = await installVanilla(mcVersion, root, onPhase);
  let fabric = null;
  if (useFabric) {
    fabric = await installFabric(mcVersion, root, loaderVersion, onPhase);
  }
  return { vanilla, fabric };
}

module.exports = {
  listVersions,
  versionExists,
  requiredJavaMajor,
  currentOsName,
  currentArch,
  VERSION_MANIFEST,
  FABRIC_META,
  fetchVersionManifest,
  resolveVersionJson,
  resolveFabricProfile,
  installVanilla,
  installFabric,
  installAll,
  download,
  rulesAllow,
  mavenToPath,
  exists,
  ensureDir,
  sha1File,
};
