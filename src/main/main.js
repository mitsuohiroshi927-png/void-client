'use strict';
/**
 * VOID Client — Electron main process.
 *
 * All privileged work (downloads, filesystem, spawning Java) lives here.
 * The renderer stays sandboxed with contextIsolation and only talks to this
 * file through the narrow preload bridge.
 */

const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');

const auth = require('./auth');
const installer = require('./installer');
const launch = require('./launch');
const mods = require('./mods');
const deps = require('./deps');
const catalog = require('./catalog');
const modpack = require('./modpack');
const stats = require('./stats');
const hardware = require('./hardware');
const javaRuntime = require('./java-runtime');
const updater = require('./updater');
const { DiscordRpc } = require('./rpc');
const { Store } = require('./settings');

const isDev = !app.isPackaged;
let win = null;
let store = null;
let mcProcess = null;
let authState = { session: null, profile: null };
let pollCancel = null;

/* -------------------------------------------------------------- windows */

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#0b0d10',
    frame: true,
    autoHideMenuBar: true,
    title: 'VOID Client',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => {
    win = null;
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/* -------------------------------------------------------------- helpers */

function paths() {
  const s = store.get();
  return {
    root: s.root,
    gameDir: s.gameDir,
    configFile: path.join(app.getPath('userData'), 'launcher.json'),
    sessionFile: path.join(app.getPath('userData'), 'session.json'),
  };
}

async function saveSession(data) {
  const f = paths().sessionFile;
  await fsp.mkdir(path.dirname(f), { recursive: true });
  await fsp.writeFile(f, JSON.stringify(data, null, 2), { mode: 0o600 });
}

async function loadSession() {
  try {
    const raw = await fsp.readFile(paths().sessionFile, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Refresh the MSA token when needed, then walk the Xbox/Minecraft chain. */
async function ensureChain(saved) {
  let msa = saved.msa;
  if (!msa || !msa.accessToken) throw new Error('No saved sign-in.');
  if (msa.expiresAt && Date.now() > msa.expiresAt - 60_000) {
    msa = await auth.refreshMsa(msa.refreshToken);
  }
  const chain = await auth.completeChain(msa);
  await saveSession({ msa: chain.msa, profile: chain.profile, mc: chain.mc });
  authState = { session: chain.mc, profile: chain.profile, msa: chain.msa };
  return chain;
}

/* ------------------------------------------------------------------ IPC */

/**
 * Copy user-picked or user-dropped files into the ACTIVE profile.
 *
 * Jars go to mods/, zips go to resourcepacks/ — so dropping either kind from
 * Explorer just works. Everything stays inside the active profile, so nothing
 * leaks between profiles. Returns what landed where.
 */
async function copyJarsToActiveProfile(paths) {
  const s = store.get();
  const added = [];
  for (const f of paths) {
    const ext = path.extname(f).toLowerCase();
    if (ext !== '.jar' && ext !== '.zip') continue;
    const sub = ext === '.jar' ? 'mods' : 'resourcepacks';
    const dir = path.join(s.gameDir, 'profiles', s.profile, sub);
    await fsp.mkdir(dir, { recursive: true });
    added.push(await mods.addMod(dir, f));
  }
  return { ok: true, added, profile: s.profile };
}

function registerIpc() {
  /* ---- settings ---- */
  /* ------------------------------------------------------- hardware / java */

ipcMain.handle('hardware:probe', async () => {
  try {
    const report = await hardware.probe();
    // Cache on the store so the UI can paint instantly next launch.
    await store.patch({ hardware: report });
    return report;
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('java:list', async () => {
  // Shape the reply for the Settings panel: which runtime is active, whether a
  // managed (downloaded) JRE exists, and whether any suitable system Java was
  // found. Never throw — the panel renders "none found" instead of an error.
  const s = store.get();
  const out = { managed: null, suitable: null, all: [] };
  try {
    if (s.javaPath) {
      const probe = await hardware.probeJava(s.javaPath);
      if (probe && probe.major) out.suitable = probe;
    }
    const managedPath = await javaRuntime.managedRuntimePath(s.root, 21);
    if (managedPath) {
      const probe = await hardware.probeJava(managedPath);
      out.managed = probe || { path: managedPath, major: 21 };
    }
    out.all = await hardware.findJavaRuntimes();
    if (!out.suitable) {
      out.suitable = out.all.find((r) => r.suitable) || null;
    }
  } catch (e) {
    out.error = e.message;
  }
  return out;
});

ipcMain.handle('java:install', async (_evt, { major } = {}) => {
  const s = store.get();
  try {
    const r = await javaRuntime.installRuntime(s.root, {
      major: major || 21,
      onLog: (line) => send('install:log', { line }),
      onProgress: (got, total) => send('install:progress', {
        phase: 'java', done: got, total, label: 'Java runtime',
      }),
    });
    await store.patch({ javaPath: r.path, javaRuntime: 'managed' });
    return { ok: true, path: r.path, release: r.release };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('java:pick', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Select java.exe / javaw.exe',
    properties: ['openFile'],
    filters: process.platform === 'win32'
      ? [{ name: 'Java executable', extensions: ['exe'] }]
      : [{ name: 'All files', extensions: ['*'] }],
  });
  if (r.canceled || !r.filePaths.length) return null;
  const info = await hardware.javaAt(r.filePaths[0]);
  return { path: r.filePaths[0], info };
});

ipcMain.handle('profile:create', async (_e, name, opts) => {
  try {
    const s = await store.load();
    const clean = String(name || '').trim();
    if (!clean) throw new Error('Profile name is required');
    if (clean.length > 24) throw new Error('Profile name is too long');
    let id = clean.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'profile';
    let n = 2;
    const base = id;
    while (s.profiles[id]) id = `${base}-${n++}`;
    s.profiles[id] = {
      id,
      name: clean,
      description: (opts && opts.description) || 'Custom profile — add only the mods you want.',
      ram: (opts && opts.ram) || 0,
      width: (opts && opts.width) || 0,
      height: (opts && opts.height) || 0,
      jvmArgs: [],
      icon: '◈',
      mods: {
        voidFps: opts && opts.voidFps === false ? false : true,
        inheritShared: false,
        extraJar: true,
      },
    };
    await store.save(s);
    await fsp.mkdir(path.join(s.gameDir, 'profiles', id, 'mods'), { recursive: true }).catch(() => {});
    return { ok: true, id, profiles: s.profiles };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('profile:delete', async (_e, profileId) => {
  try {
    const s = await store.load();
    if (!s.profiles[profileId]) throw new Error('no such profile');
    if (Object.keys(s.profiles).length <= 1) throw new Error('Cannot delete the last profile');
    if (profileId === 'default') throw new Error('The default profile cannot be deleted');
    delete s.profiles[profileId];
    if (s.profile === profileId) s.profile = Object.keys(s.profiles)[0];
    await store.save(s);
    return { ok: true, profiles: s.profiles, profile: s.profile };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});


ipcMain.handle('profile:rename', async (_e, profileId, name) => {
  try {
    const s = await store.load();
    if (!s.profiles[profileId]) throw new Error('no such profile');
    const clean = String(name || '').trim();
    if (!clean) throw new Error('Profile name is required');
    if (clean.length > 24) throw new Error('Profile name is too long');
    s.profiles[profileId].name = clean;
    await store.save(s);
    return { ok: true, profiles: s.profiles };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('profile:select', async (_e, profileId) => {
  try {
    const s = await store.load();
    if (!s.profiles[profileId]) throw new Error('no such profile');
    s.profile = profileId;
    await store.save(s);
    return { ok: true, profile: profileId, ...store.resolved() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// RAM/resolution for the ACTIVE profile. Separate from settings:patch so the
// renderer cannot accidentally write one profile's numbers onto another.
ipcMain.handle('profile:setValues', async (_e, vals) => {
  try {
    const data = await store.setProfileValues(vals || {});
    return { ok: true, ...store.resolved(), storedProfile: data && data.storedProfile };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/**
 * Everything the active profile actually owns on disk: mods, resource packs and
 * any modpack it was built from. Paths mirror the vanilla game layout so
 * resource packs are found by the game without extra wiring.
 */
ipcMain.handle('profile:content', async () => {
  try {
    const s = await store.load();
    const id = s.profiles[s.profile] ? s.profile : 'default';
    const base = path.join(s.gameDir, 'profiles', id);
    const read = async (kind, dir) => {
    const files = await fsp.readdir(dir).catch(() => []);
    const out = [];
    for (const f of files) {
      if (f.startsWith('.')) continue;
      const st = await fsp.stat(path.join(dir, f)).catch(() => null);
      // ".disabled" is how a mod is switched off: Fabric only loads *.jar, so
      // the suffix parks the file without moving it out of the profile.
      const disabled = /\.disabled$/i.test(f);
      out.push({
        name: disabled ? f.replace(/\.disabled$/i, '') : f,
        file: f,
        size: st ? st.size : 0,
        kind,
        disabled,
      });
    }
    return out;
    };
    return {
      ok: true,
      profileId: id,
      profileName: (s.profiles[id] || {}).name || id,
      mods: await read('mod', path.join(base, 'mods')),
      resourcepacks: await read('resourcepack', path.join(base, 'resourcepacks')),
      shaders: await read('shader', path.join(base, 'shaderpacks')),
    };
  } catch (e) {
    return { ok: false, error: e.message, mods: [], resourcepacks: [] };
  }
});

/**
 * Content counts for ANY profile, not just the active one. The Profiles page
 * shows a card per profile, so it needs each profile's own numbers without
 * switching to it first.
 */
ipcMain.handle('profile:contentOf', async (_e, profileId) => {
  try {
    const s = await store.load();
    const id = s.profiles[profileId] ? profileId : s.profile;
    const base = path.join(s.gameDir, 'profiles', id);
    const count = async (dir) => {
      const files = await fsp.readdir(dir).catch(() => []);
      return files.filter((f) => !f.startsWith('.')).length;
    };
    return {
      ok: true,
      profileId: id,
      mods: new Array(await count(path.join(base, 'mods'))).fill(0),
      resourcepacks: new Array(await count(path.join(base, 'resourcepacks'))).fill(0),
      shaders: new Array(await count(path.join(base, 'shaderpacks'))).fill(0),
    };
  } catch (e) {
    return { ok: false, error: e.message, mods: [], resourcepacks: [], shaders: [] };
  }
});

/**
 * Switch a content file on/off by renaming it.
 *
 * Fabric only scans *.jar, so parking a file as "name.jar.disabled" disables it
 * while keeping it inside the profile — nothing is moved or deleted, and toggling
 * back is lossless.
 */
ipcMain.handle('profile:toggleContent', async (_e, kind, file, disable) => {
  try {
    const s = await store.load();
    const id = s.profiles[s.profile] ? s.profile : 'default';
    const sub = kind === 'resourcepack' ? 'resourcepacks'
      : kind === 'shader' ? 'shaderpacks'
        : 'mods';
    const base = path.join(s.gameDir, 'profiles', id, sub);
    const safe = path.basename(String(file || ''));
    const from = path.join(base, safe);
    const to = disable
      ? path.join(base, `${safe}.disabled`)
      : path.join(base, safe.replace(/\.disabled$/i, ''));
    await fsp.rename(from, to);
    return { ok: true, file: path.basename(to) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('profile:removeContent', async (_e, kind, file) => {
  try {
    const s = await store.load();
    const id = s.profiles[s.profile] ? s.profile : 'default';
    // Each content kind lives in its own folder; a shader removed from mods/
    // would silently delete nothing and report success.
    const sub = kind === 'resourcepack' ? 'resourcepacks'
      : kind === 'shader' ? 'shaderpacks'
        : 'mods';
    // basename() so a crafted name can never escape the profile folder.
    const target = path.join(s.gameDir, 'profiles', id, sub, path.basename(String(file || '')));
    await fsp.rm(target, { recursive: true, force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});


ipcMain.handle('versions:list', async (_e, prefix) => {
  try {
    const all = await installer.listVersions(prefix || '1.21');
    return { ok: true, versions: all };
  } catch (e) {
    return { ok: false, error: e.message, versions: [] };
  }
});

ipcMain.handle('settings:get', async () => {
  // resolved() merges the active profile (including hardware-adaptive values)
  // into ram/width/height so the renderer has ONE source of truth.
  const s = store.resolved();
  // The raw hardware recommendation is sent separately so the profile panel can
  // label it as a hint without confusing it with the user's actual value.
  const tuned = (s.hardware && s.hardware.tuned) || null;
  return { ...s, paths: paths(), tuned };
});

  ipcMain.handle('settings:patch', async (_e, partial) => {
    // RAM/resolution belong to the ACTIVE profile, not to global settings, so a
    // save must not silently overwrite the adaptive profile with stale numbers.
    const { ram, width, height, maxFps, ...rest } = partial || {};
    if (ram != null || width != null || height != null || maxFps != null) {
      await store.setProfileValues({ ram, width, height, maxFps });
    }
    await store.patch(rest);
    // Keep gameDir in sync when root changes and gameDir wasn't set explicitly.
    if (partial.root && !partial.gameDir) {
      await store.patch({ gameDir: path.join(partial.root, 'game') });
    }
    // Always hand back the resolved view: changing profile must immediately
    // update the RAM/resolution summary the same way settings:get does.
    return { ...store.resolved(), paths: paths() };
  });

  ipcMain.handle('settings:pickDir', async (_e, kind) => {
    const res = await dialog.showOpenDialog(win, {
      title: kind === 'java' ? 'Select java.exe' : 'Select folder',
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('settings:pickFile', async (_e, filters) => {
    const res = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: filters || [{ name: 'Java Archive', extensions: ['jar'] }],
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });

  /* ---- auth ---- */
  ipcMain.handle('auth:status', async () => {
    if (authState.profile) return { signedIn: true, profile: authState.profile };
    const saved = await loadSession();
    if (!saved || !saved.msa) return { signedIn: false };
    try {
      const chain = await ensureChain(saved);
      return { signedIn: true, profile: chain.profile };
    } catch (e) {
      return { signedIn: false, error: e.message };
    }
  });

  ipcMain.handle('auth:begin', async () => {
    const dc = await auth.requestDeviceCode();
    send('auth:device-code', {
      userCode: dc.userCode,
      verificationUri: dc.verificationUri,
      expiresIn: dc.expiresIn,
    });
    // Poll in the background; the renderer shows the code meanwhile.
    (async () => {
      try {
        const msa = await auth.pollForToken(dc.deviceCode, dc.interval, dc.expiresIn * 1000, (left) =>
          send('auth:tick', { secondsLeft: left })
        );
        const chain = await auth.completeChain(msa);
        await saveSession({ msa: chain.msa, profile: chain.profile, mc: chain.mc });
        authState = { session: chain.mc, profile: chain.profile, msa: chain.msa };
        send('auth:done', { profile: chain.profile });
      } catch (e) {
        send('auth:error', { message: e.message });
      }
    })();
    return { started: true, userCode: dc.userCode, verificationUri: dc.verificationUri };
  });

  ipcMain.handle('auth:openLink', async (_e, url) => {
    if (typeof url === 'string' && /^https:\/\/(microsoft\.com|www\.microsoft\.com|login\.live\.com)\//.test(url)) {
      await shell.openExternal(url);
      return true;
    }
    return false;
  });

  ipcMain.handle('auth:signOut', async () => {
    authState = { session: null, profile: null };
    await fsp.unlink(paths().sessionFile).catch(() => {});
    return true;
  });

  /* ---- install ---- */
  ipcMain.handle('install:run', async (_e, opts = {}) => {
    const s = store.get();
    const mcVersion = opts.mcVersion || s.mcVersion;
    const useFabric = opts.useFabric !== undefined ? opts.useFabric : s.useFabric;
    try {
      const result = await installer.installAll({
        mcVersion,
        root: s.root,
        useFabric,
        loaderVersion: s.fabricLoader || undefined,
        onPhase: (phase, done, total, label) => send('install:progress', { phase, done, total, label }),
      });
      send('install:done', {
        mcVersion,
        fabric: result.fabric ? result.fabric.loaderVersion : null,
      });
      return {
        ok: true,
        mcVersion,
        fabricLoader: result.fabric ? result.fabric.loaderVersion : null,
      };
    } catch (e) {
      send('install:error', { message: e.message });
      return { ok: false, error: e.message };
    }
  });

  /* ---- mods ---- */
  ipcMain.handle('mods:inspect', async () => {
    const s = store.get();
    const info = await mods.inspectVoidFps(s.voidFpsJarSource || '');
    // The Mods page must reflect what the ACTIVE PROFILE will actually load:
    // its own folder, plus mods/ only when the profile inherits shared mods.
    // listInstalledMods() expects the GAME dir and appends 'mods' itself, so
    // passing the profile's mods folder would look in profiles/<id>/mods/mods/.
    const profileGameDir = path.join(s.gameDir, 'profiles', s.profile);
    const profMods = await mods.listInstalledMods(profileGameDir).catch(() => []);
    const sharedMods = await mods.listInstalledMods(s.gameDir).catch(() => []);
    const inherit = !!(s.profiles?.[s.profile]?.mods?.inheritShared);
    const seen = new Set(profMods.map((m) => m.file));
    const installed = inherit
      ? [...profMods, ...sharedMods.filter((m) => !seen.has(m.file)).map((m) => ({ ...m, shared: true }))]
      : profMods;
    const hasConfig = await mods.hasModConfig(s.gameDir);
    return { voidFps: info, installed, sharedCount: sharedMods.length, profile: s.profile, inheritShared: inherit, hasModConfig: hasConfig };
  });

  ipcMain.handle('mods:installVoidFps', async () => {
    const s = store.get();
    const jar = await mods.findVoidFpsJar(s.voidFpsJarSource || '');
    if (!jar) return { ok: false, error: 'VOID FPS jar not found.' };
    const r = await mods.installVoidFps(s.gameDir, jar);
    return { ok: true, ...r };
  });

  ipcMain.handle('mods:add', async () => {
    const res = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Fabric mods', extensions: ['jar'] }],
    });
    if (res.canceled) return { ok: false };
    return copyJarsToActiveProfile(res.filePaths);
  });

  // Drag & drop from Explorer hands us real paths, so no dialog is involved.
  // Accept a mixed selection: .jar -> mods/, .zip -> resourcepacks/.
  ipcMain.handle('mods:addPaths', async (_e, paths) => {
    if (!Array.isArray(paths) || !paths.length) return { ok: false, added: [] };
    return copyJarsToActiveProfile(paths);
  });

  /* ------------------------------- mod catalog ------------------------------ */
  ipcMain.handle('catalog:search', async (_e, { source, query, offset }) => {
    const st = store.get();
    const mcVersion = st.mcVersion || '1.21.11';
    try {
      const out = source === 'curseforge'
        ? await catalog.searchCurseforge(query, { apiKey: st.curseforgeApiKey, mcVersion, offset: offset || 0 })
        : await catalog.searchModrinth(query, { mcVersion, offset: offset || 0 });
      // Mark which results are already present in the ACTIVE PROFILE so the UI
      // can disable them — checking mods/ would light up mods the profile never loads.
      // listInstalledMods() takes a GAME dir and appends 'mods' itself, so the
      // profile's own mods/ folder is scanned by passing the profile dir.
      const scanDirs = [path.join(st.gameDir, 'profiles', st.profile)];
      if (st.profiles?.[st.profile]?.mods?.inheritShared) scanDirs.push(st.gameDir);
      const installed = (await Promise.all(scanDirs.map((d) => mods.listInstalledMods(d).catch(() => [])))).flat();
      const names = new Set(installed.map((m) => String(m.name || '').toLowerCase()));
      const ids = new Set(installed.map((m) => String(m.id || '').toLowerCase()));
      for (const h of out.hits) {
        h.installed = ids.has(String(h.slug || '').toLowerCase())
          || ids.has(String(h.id).toLowerCase())
          || names.has(String(h.name || '').toLowerCase());
      }
      return { ok: true, ...out, mcVersion };
    } catch (e) {
      return { ok: false, error: e.message, hits: [], total: 0, mcVersion };
    }
  });

  ipcMain.handle('catalog:install', async (_e, hit, opts = {}) => {
    const st = store.get();
    const mcVersion = st.mcVersion || '1.21.11';
    try {
      const file = await catalog.resolveFile(hit, { mcVersion, loader: 'fabric', apiKey: st.curseforgeApiKey });

      // Where the jar lands decides which profile sees it. Default is the ACTIVE
      // PROFILE's own folder, so a mod downloaded while "PvP" is selected never
      // appears in Vanilla. opts.scope='shared' writes to mods/ for people who
      // explicitly want the mod available in every profile.
      const scope = opts.scope === 'shared' ? 'shared' : 'profile';
      const targetDir = scope === 'shared'
        ? path.join(st.gameDir, 'mods')
        : path.join(st.gameDir, 'profiles', st.profile, 'mods');
      await fsp.mkdir(targetDir, { recursive: true });

      const r = await catalog.downloadMod(targetDir, file, {
        onProgress: (got, total) => send('catalog:progress', { slug: hit.slug, got, total }),
      });
      send('mods:changed', { file: r.file });
      return { ok: true, ...r, versionNumber: file.versionNumber, scope, profile: st.profile };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /* --------------------- modpacks + resource packs ------------------------- */

  // Generic Modrinth search by project type. Resource packs are not
  // loader-specific, so no loader facet is applied for them.
  ipcMain.handle('catalog:searchProjects', async (_e, { query, type = 'mod', offset = 0 } = {}) => {
    const st = store.get();
    const mcVersion = st.mcVersion || '1.21.11';
    try {
      const out = await catalog.searchProjects(query, { mcVersion, type, offset: offset || 0 });
      return { ok: true, ...out, mcVersion, type };
    } catch (e) {
      return { ok: false, error: e.message, hits: [], total: 0, mcVersion, type };
    }
  });

  // Every compatible version of one project, so the user can pick an exact build
  // instead of being forced onto "latest".
  ipcMain.handle('catalog:projectVersions', async (_e, { projectId, type = 'mod' } = {}) => {
    const st = store.get();
    const mcVersion = st.mcVersion || '1.21.11';
    try {
      // Shaders and resource packs are loader-agnostic; only mods/modpacks ask
      // Modrinth for a Fabric build.
      const loader = (type === 'resourcepack' || type === 'shader') ? null : 'fabric';
      const versions = await catalog.projectVersions(projectId, { mcVersion, loader });
      return { ok: true, versions, mcVersion };
    } catch (e) {
      return { ok: false, error: e.message, versions: [] };
    }
  });

  /**
   * Install a mod, modpack or resource pack into the ACTIVE PROFILE.
   *
   * Mods land in `mods/`, resource packs in `resourcepacks/` (the vanilla name,
   * so the game sees them), and a modpack is unpacked as a whole into the profile
   * — including any other profile it needs. Nothing is ever written outside the
   * profile folder, so packs cannot leak across profiles.
   */
  ipcMain.handle('catalog:installProject', async (_e, { project, file, type = 'mod' } = {}) => {
    const st = store.get();
    const mcVersion = st.mcVersion || '1.21.11';
    const profileId = st.profiles[st.profile] ? st.profile : 'default';
    const profileDir = path.join(st.gameDir, 'profiles', profileId);
    try {
      if (!project || !project.id) throw new Error('No project selected');

      // Shaders and resource packs are loader-agnostic; only mods/modpacks ask
      // Modrinth for a Fabric build.
      const loader = (type === 'resourcepack' || type === 'shader') ? null : 'fabric';
      const chosen = file || await catalog.resolveFile(
        { source: project.source || 'modrinth', id: project.id },
        { mcVersion, loader, apiKey: st.curseforgeApiKey },
      );
      if (!chosen || !chosen.url) throw new Error('No compatible file found for this version');

      // Shaders and resource packs both land as plain zips in the active profile.
      if (type === 'resourcepack' || type === 'shader') {
        const dir = path.join(profileDir, type === 'shader' ? 'shaderpacks' : 'resourcepacks');
        await fsp.mkdir(dir, { recursive: true });
        const r = await catalog.downloadMod(dir, { ...chosen, filename: chosen.filename || `${project.slug}.zip` }, {
          onProgress: (got, total) => send('catalog:progress', { slug: project.slug, got, total }),
        });
        return { ok: true, kind: type, ...r, profile: profileId };
      }

      if (type === 'modpack') {
        // The pack itself is downloaded first, then unpacked as a unit.
        const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'void-pack-'));
        const archived = await catalog.downloadMod(tmpDir, chosen);
        const result = await modpack.installMrpack(archived.path, profileDir, {
          mcVersion,
          onProgress: (p) => send('catalog:progress', { slug: project.slug, phase: p.phase, got: p.done, total: p.total }),
        });
        await fsp.rm(tmpDir, { recursive: true, force: true });
        // Remember which pack built this profile so the UI can show it.
        const s2 = await store.load();
        if (s2.profiles[profileId]) {
          s2.profiles[profileId].modpack = { id: project.id, name: result.packName, version: result.versionId };
          // A pack pins its own Minecraft version; follow it rather than booting
          // a version whose mods were never built for it.
          if (result.declaredMc) s2.mcVersion = result.declaredMc;
          await store.save(s2);
        }
        send('mods:changed', { file: `${result.packName} (modpack)` });
        return { ok: true, kind: 'modpack', profile: profileId, ...result };
      }

      const dir = path.join(profileDir, 'mods');
      await fsp.mkdir(dir, { recursive: true });
      const r = await catalog.downloadMod(dir, chosen, {
        onProgress: (got, total) => send('catalog:progress', { slug: project.slug, got, total }),
      });
      send('mods:changed', { file: r.file });
      return { ok: true, kind: 'mod', ...r, profile: profileId };
    } catch (e) {
      return { ok: false, error: e.message, kind: type };
    }
  });

  /* ---------------------------------- stats --------------------------------- */

  // Dashboard numbers. `online` is the count the presence server reports; when the
  // endpoint is unreachable we fall back to local counters and say so via `source`.
  ipcMain.handle('stats:get', async () => {
    const st = store.get();
    const data = await stats.getStats(st.statsUrl || '', app.getPath('userData'));
    return { ok: true, ...data };
  });

  // Launcher-side presence: ticks while the client is open so the dashboard shows
  // people sitting in the launcher, not only people in-game.
  let statsTimer = null;
  ipcMain.handle('stats:startPresence', async () => {
    const st = store.get();
    if (!st.statsUrl) return { ok: false, error: 'No stats endpoint configured.' };
    const local = stats.recordLaunch(app.getPath('userData'));
    const payload = () => ({
      uuid: local.installId,
      name: st.username || 'Player',
      server: 'launcher',
      version: st.mcVersion || '',
      client: app.getVersion(),
    });
    const beat = () => {
      // Not while the window is hidden: a parked launcher has nothing to report,
      // and the next beat after it returns picks the same cadence back up.
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) return;
      stats.sendHeartbeat(st.statsUrl, payload()).catch(() => {});
    };
    beat();
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = setInterval(beat, 60000);
    return { ok: true, installId: local.installId };
  });

  app.on('will-quit', () => {
  if (statsTimer) clearInterval(statsTimer);
  // Leave Discord's socket politely, otherwise the presence can stick around.
  if (rpc) { try { rpc.shutdown(); } catch { /* nothing to do */ } }
});

  ipcMain.handle('catalog:testCurseforge', async (_e, key) => {
    try {
      await catalog.searchCurseforge('sodium', { apiKey: key, limit: 1 });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('mods:remove', async (_e, file) => {
    const s = store.get();
    // Mods live per profile now. removeMod() takes a GAME dir and appends 'mods'
    // itself, so pass the profile (or game) dir — never a mods/ folder.
    const candidates = [
      path.join(s.gameDir, 'profiles', s.profile),
      s.gameDir,
    ];
    for (const dir of candidates) {
      if (await fsp.access(path.join(dir, 'mods', path.basename(file))).then(() => true).catch(() => false)) {
        await mods.removeMod(dir, file);
        return { ok: true, dir };
      }
    }
    return { ok: false, error: 'Mod file not found in profile or shared folder.' };
  });

  ipcMain.handle('mods:openFolder', async (_e, which) => {
    const s = store.get();
    const target =
      which === 'mods' ? path.join(s.gameDir, 'profiles', s.profile, 'mods')
      : which === 'shared' ? path.join(s.gameDir, 'mods')
      : which === 'game' ? s.gameDir : s.root;
    await fsp.mkdir(target, { recursive: true });
    await shell.openPath(target);
    return true;
  });

  /* ---- launcher self-update (Modrinth-style) ---- */
  ipcMain.handle('update:check', async () => {
    const s = store.get();
    return updater.check({
      current: app.getVersion(),
      manifestUrl: s.updateUrl || updater.DEFAULT_MANIFEST,
    });
  });

  ipcMain.handle('update:download', async (_e, info) => {
    const r = await updater.download({
      version: info && info.version,
      url: info && info.url,
      sha256: info && info.sha256,
      // Stream progress to the renderer so a 120 MB download is not a frozen UI.
      onProgress: (p) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win && !win.isDestroyed()) win.webContents.send('update:progress', p);
      },
    });
    return r;
  });

  ipcMain.handle('update:apply', async (_e, info) => {
    const r = await updater.apply({
      file: info && info.file,
      // The installer cannot replace a running exe, so update-and-quit is one
      // action: staying open would make NSIS fail on a locked file.
      onQuit: () => app.quit(),
    });
    return r;
  });

  ipcMain.handle('rpc:test', async (_e, clientId) => {
    // Probe with the id being typed, so a user can verify before saving.
    const id = String(clientId || (store.get().discordClientId || '')).trim();
    if (!id) return { ok: false, error: 'Paste a Discord Application ID first.' };
    if (!/^\d{17,20}$/.test(id)) return { ok: false, error: 'That does not look like an Application ID (17-20 digits).' };
    const probe = new DiscordRpc({ clientId: id, appName: 'VOID Client' });
    try {
      const connected = await probe.connect();
      if (!connected) {
        return { ok: false, error: 'Discord is not running, or no Discord app with this ID exists.' };
      }
      await probe.setActivity({
        details: 'Connection test',
        state: 'VOID Client',
        startTimestamp: Date.now(),
        assets: { large_image: 'void', large_text: 'VOID Client' },
      });
      return { ok: true };
    } finally {
      // Leave the test presence up briefly so the user can see it, then clear.
      setTimeout(() => { try { probe.shutdown(); } catch { /* ignore */ } }, 8000);
    }
  });

  ipcMain.handle('update:openPage', async () => {
    const s = store.get();
    return { ok: true, url: s.updateUrl || updater.DEFAULT_MANIFEST };
  });

  /* ---- launch ---- */
  ipcMain.handle('profile:openFolder', async () => {
    const s = store.get();
    const id = (s.profiles || {})[s.profile] ? s.profile : 'default';
    const dir = path.join(s.gameDir, 'profiles', id);
    await fsp.mkdir(dir, { recursive: true }).catch(() => {});
    await shell.openPath(dir);
    return { ok: true, dir };
  });

  ipcMain.handle('launch:play', async () => {
    const s = store.get();
    const prof = store.activeProfile();
    try {
      // 1. Auth
      let saved = await loadSession();
      let chain;
      if (authState.profile && authState.session) {
        chain = { mc: authState.session, profile: authState.profile };
      } else if (saved && saved.msa) {
        chain = await ensureChain(saved);
      } else {
        throw new Error('Sign in with Microsoft first.');
      }

      // 2. Version json
      const versionJson = await installer.resolveVersionJson(s.mcVersion, s.root);
      let fabric = null;
      if (s.useFabric) {
        const installedId = `${s.mcVersion}-fabric-${s.fabricLoader || ''}`;
        const direct = path.join(s.root, 'versions', installedId, `${installedId}.json`);
        let profileJson = null;
        if (s.fabricLoader && fs.existsSync(direct)) {
          profileJson = JSON.parse(await fsp.readFile(direct, 'utf8'));
          fabric = { id: installedId, mainClass: profileJson.mainClass, libraries: profileJson.libraries || [] };
        } else {
          const fab = await installer.installFabric(s.mcVersion, s.root, s.fabricLoader || undefined, (phase, done, total, label) =>
            send('install:progress', { phase, done, total, label })
          );
          fabric = { id: fab.id, mainClass: fab.mainClass, libraries: fab.libraries };
        }
      }

      // 3. VOID FPS is bundled inside the client, so it is never written into
      //    mods/ — a copy there gives Fabric two mod ids and aborts the boot.
      //    Sweep stale copies left by older builds, and make sure the active
      //    profile's own mods folder exists so the user can drop jars there.
      try {
        const removed = await mods.removeBundledVoidFps(s.gameDir);
        if (removed && removed.length) {
          send('launch:log', { line: `[launcher] removed stale VOID FPS jar from mods/: ${removed.join(', ')}` });
        }
      } catch (e) {
        send('launch:log', { line: `[launcher] WARN voidfps cleanup: ${e.message}` });
      }
      const profileModsDir = path.join(s.gameDir, 'profiles', s.profile, 'mods');
      await fsp.mkdir(profileModsDir, { recursive: true }).catch(() => {});

      // 3b. Required mod dependencies (VOID FPS hard-depends on Fabric API).
      if (s.useFabric && s.autoDeps !== false) {
        try {
          const fa = await deps.ensureFabricApi(s.gameDir, s.mcVersion, (m) =>
            send('launch:log', { line: `[launcher] ${m}` })
          );
          if (fa.installed) send('launch:log', { line: `[launcher] Fabric API ${fa.versionNumber} ready` });
        } catch (e) {
          send('launch:log', { line: `[launcher] WARN fabric-api: ${e.message}` });
        }
      }

      // 4. Java path — resolve a runtime that can actually run 1.21.11.
      //    Order: explicit user path > managed JRE > system Java 21+ > download.
      let javaPath = s.javaPath;
      let javaNote = '';
      if (!javaPath) {
        const managed = await javaRuntime.managedRuntimePath(s.root, 21);
        if (managed) {
          javaPath = managed;
          javaNote = 'managed runtime';
        } else {
          const picked = await hardware.pickRuntime('');
          if (picked && picked.suitable) {
            javaPath = picked.path;
            javaNote = `system Java ${picked.major}`;
          } else {
            // No usable Java on this machine — fetch an official Temurin JRE.
            send('launch:log', { line: '[launcher] No Java 21 found, downloading a runtime...' });
            try {
              const r = await javaRuntime.installRuntime(s.root, {
                major: 21,
                onLog: (line) => send('launch:log', { line: `[launcher] ${line}` }),
                onProgress: (got, total) => send('install:progress', {
                  phase: 'java', done: got, total, label: 'Java runtime',
                }),
              });
              javaPath = r.path;
              javaNote = 'downloaded runtime';
              await store.patch({ javaPath: r.path, javaRuntime: 'managed' });
            } catch (e) {
              throw new Error(
                `No Java 21+ runtime available and the download failed (${e.message}). ` +
                `Install Java 21 (Temurin) or pick javaw.exe in Settings.`
              );
            }
          }
        }
      }
      send('launch:log', { line: `[launcher] Java: ${javaNote || javaPath}` });

      // 5. Build + spawn
      const spec = await launch.buildLaunchSpec({
        root: s.root,
        mcVersion: s.mcVersion,
        fabric,
        versionJson,
        session: {
          name: chain.profile.name,
          uuid: chain.profile.id,
          accessToken: chain.mc.accessToken,
          userType: 'msa',
          clientId: auth.CLIENT_ID,
          xuid: '',
        },
        settings: {
          javaPath,
          ram: prof.ram || s.ram,
          width: prof.width || s.width,
          height: prof.height || s.height,
          gameDir: s.gameDir,
          profile: s.profile,
          profileMods: (s.profiles[s.profile] || {}).mods || { voidFps: true, inheritShared: false, extraJar: true },
          profileModsDir: path.join(s.gameDir, 'profiles', s.profile, 'mods'),
          gcPause: (s.hardware && s.hardware.tuned && s.hardware.tuned.gcPause) || 50,
          safetyMode: !!s.safetyMode,
          lowMemory: !!(s.hardware && s.hardware.ramMB && s.hardware.ramMB < 4096),
          // Profile flags now come from src/main/jvm.js; settings.jvmArgs is
          // legacy, so only user-typed extra args are appended here.
          extraJvmArgs: parseArgs(s.extraJvmArgs || ''),
        },
      });

      await fsp.mkdir(s.gameDir, { recursive: true });

      send('launch:status', { state: 'starting', version: spec.versionName });
      mcProcess = launch.spawnMinecraft(spec, {
        cwd: s.gameDir,
        onData: (stream, text) => {
          send('launch:log', { stream, text });
          // A join rewrites the presence; anything else is ignored. Cheap regex,
          // and only while a game is running.
          const host = parseServerFromLog(text);
          if (host && host !== currentServer) {
            currentServer = host;
            rpcSetPlaying({ version: runningVersion, server: host, where: currentWhere });
            return;
          }
          const loc = parseWhereFromLog(text);
          if (loc) {
            if (loc.version && loc.version !== runningVersion) runningVersion = loc.version;
            if (loc.where && loc.where !== currentWhere) currentWhere = loc.where;
            rpcSetPlaying({ version: runningVersion, server: currentServer, where: currentWhere });
          }
        },
        onExit: (code, signal) => {
          mcProcess = null;
          currentServer = null;
          currentWhere = 'In menu';
          send('launch:status', { state: 'exited', code, signal });
          // Back to the idle presence as soon as the game is gone.
          rpcSetIdle();
          // ON  = launcher stays open after the game closes (default).
          // OFF = the launcher closes together with Minecraft.
          const keep = store && store.get() && store.get().keepLauncherOpen;
          if (!keep && win && !win.isDestroyed()) win.close();
        },
        onError: (e) => send('launch:status', { state: 'error', message: e.message }),
      });

      // In-game presence: start from the menu, then follow the game's own logs
      // as it reports its version, screen, and server.
      currentServer = null;
      currentWhere = 'In menu';
      runningVersion = spec.versionName || null;
      playStart = Date.now();
      rpcSetPlaying({ version: runningVersion, server: null, where: currentWhere });

      // Give the game the CPU: drop this process to idle priority while it runs.
      // Windows: BELOW_NORMAL(0x4000) — Linux/mac: nice +10. Restored on exit.
      try {
        if (mcProcess && mcProcess.pid) {
          if (process.platform === 'win32') {
            require('child_process').spawn('wmic', [
              'process', 'where', `ProcessId=${process.pid}`, 'call', 'setpriority', 'value="16384"',
            ], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
          } else {
            try { os.setPriority(process.pid, 10); } catch { /* not permitted */ }
          }
        }
      } catch { /* priority is a nicety, never fatal */ }

      return { ok: true, pid: mcProcess.pid, version: spec.versionName };
    } catch (e) {
      send('launch:status', { state: 'error', message: e.message });
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('launch:kill', async () => {
    if (mcProcess) {
      mcProcess.kill();
      mcProcess = null;
      return { ok: true };
    }
    return { ok: false, error: 'No game running.' };
  });

  /* ---- misc ---- */
  ipcMain.handle('app:info', async () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    dev: isDev,
  }));

  ipcMain.handle('app:openExternal', async (_e, url) => {
    if (typeof url === 'string' && /^https:\/\//.test(url)) {
      await shell.openExternal(url);
      return true;
    }
    return false;
  });
}

function parseArgs(str) {
  if (!str) return [];
  // Simple whitespace split; JVM args here never contain spaces inside quotes.
  return str.split(/\s+/).filter(Boolean);
}

/* ----------------------------------------------------------------- boot */

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  store = new Store(path.join(app.getPath('userData'), 'launcher.json'));
  await store.load();
  registerIpc();
  createWindow();

  // Probe hardware in the background so the first launch already has a tuned
  // profile. Never block the window on it — a slow WMIC/lspci must not stall UI.
  probeInBackground();

  // Check for a new launcher build a few seconds in, once the UI is up. It only
  // notifies; installing stays a deliberate click.
  checkForUpdateInBackground();

  // Announce the launcher in Discord. Best-effort: silent when Discord is closed.
  rpcSetIdle();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/** Run the hardware probe once per session (or when the cache is missing). */
let probeRunning = null;
function probeInBackground() {
  const s = store.get();
  if (s.hardware && s.hardware.tuned && !s.autoTuneStale) return;
  if (probeRunning) return probeRunning;
  probeRunning = hardware.probe()
    .then(async (report) => {
      await store.patch({ hardware: report, autoTuneStale: false });
      send('hardware:ready', report);
      return report;
    })
    .catch(() => null)
    .finally(() => { probeRunning = null; });
  return probeRunning;
}

/* ------------------------- Discord Rich Presence ------------------------- */

let rpc = null;
/** Timestamp the launcher came up — RPC shows it as the elapsed counter. */
const sessionStart = Date.now();
// Reset on every launch so the elapsed timer counts playtime, not uptime.
let playStart = Date.now();
// Server the player is currently on, or null while in the main menu. Discord
// rejects empty strings, so this gates the `state` field.
let currentServer = null;
// Where the game is: In menu / Multiplayer / Singleplayer. Starts as In menu.
let currentWhere = 'In menu';
// Version reported by the running game; falls back to the launcher's selection
// until the game logs its own version.
let runningVersion = null;

/**
 * Pull the address out of a game log line.
 *
 * The player wants the address they joined, shown as-is: a typed hostname stays
 * a hostname and a typed IP stays an IP. The port is dropped because it is noise
 * on a presence line, and localhost/local log lines are ignored since there is no
 * server to name.
 */
function parseServerFromLog(text) {
  if (!text) return null;
  const m = text.match(/Connecting to ([^,\s]+)(?:,\s*(\d+))?/);
  if (!m) return null;
  const host = m[1];
  if (!host) return null;
  if (/^(localhost|127\.0\.0\.1)$/i.test(host)) return null;
  return host;
}

/**
 * Work out which screen the game is on from its log, so the presence can say
 * "Multiplayer" / "Singleplayer" instead of guessing from the launcher.
 *
 * Returns null for lines that say nothing about location, which keeps the last
 * known value rather than flickering back to the menu.
 */
function parseWhereFromLog(text) {
  if (!text) return null;
  // The real running version, so the presence follows the instance in use.
  const v = text.match(/Loading Minecraft ([\d.\w-]+?)(?:\s|$)/);
  if (v) return { version: v[1] };
  if (/Connecting to /.test(text)) return { where: 'Multiplayer' };
  if (/Starting integrated minecraft server/.test(text)) return { where: 'Singleplayer' };
  if (/LWJGL Version|Setting user:/.test(text)) return { where: 'In menu' };
  return null;
}

/**
 * (Re)build the RPC client from current settings.
 * Returns null when the feature is off or no application id is configured —
 * RPC needs a real Discord app id, so an unconfigured build stays silent
 * instead of spamming failed handshakes.
 */
function rpcEnsure() {
  const s = store.get();
  if (s.discordRpc === false) return null;
  const id = s.discordClientId;
  if (!id) return null;
  if (rpc && rpc.clientId === String(id)) return rpc;
  if (rpc) rpc.shutdown();
  rpc = new DiscordRpc({ clientId: id, appName: 'VOID Client' });
  return rpc;
}

/** Presence while the launcher sits idle: the app name, nothing else. */
function rpcSetIdle() {
  const r = rpcEnsure();
  if (!r) return;
  r.setActivity({
    details: 'In menu',
    startTimestamp: sessionStart,
    assets: { large_image: 'void', large_text: 'VOID Client' },
  }).catch(() => {});
}

/**
 * Presence while Minecraft runs: version and, once the player joins, the server.
 *
 * `server` stays null until the game log reveals a join, because Discord ignores
 * an activity that carries a null/empty string field.
 */
function rpcSetPlaying({ version, server, where }) {
  const r = rpcEnsure();
  if (!r) return;
  const act = {
    details: where || 'In menu',
    startTimestamp: playStart,
    assets: { large_image: 'void', large_text: 'VOID Client' },
  };
  // Bottom line: the version the running game reports, so it always matches the
  // instance actually open rather than whatever the launcher has selected, with
  // the joined address appended once a server session is live.
  const ver = version ? `Minecraft ${version}` : null;
  if (ver && server) act.state = `${ver} · ${server}`;
  else if (ver) act.state = ver;
  else if (server) act.state = server;
  r.setActivity(act).catch(() => {});
}

/** Presence while a download/install runs — Modrinth-style "installing" line. */
function rpcSetInstalling(what) {
  const r = rpcEnsure();
  if (!r) return;
  r.setActivity({
    details: what ? `Installing ${what}` : 'Installing',
    state: 'VOID Client',
    startTimestamp: sessionStart,
    assets: { large_image: 'void', large_text: 'VOID Client' },
  }).catch(() => {});
}

/**
 * Look for a newer launcher build shortly after startup.
 *
 * Deliberately silent on failure: a launcher that pops an error because the
 * update server is down is worse than one that never checks. The renderer gets
 * a single event, and only when there is genuinely something newer.
 */
let updateTimer = null;
function checkForUpdateInBackground() {
  clearTimeout(updateTimer);
  updateTimer = setTimeout(async () => {
    const s = store.get();
    if (s.autoUpdate === false) return;
    try {
      const r = await updater.check({
        current: app.getVersion(),
        manifestUrl: s.updateUrl || updater.DEFAULT_MANIFEST,
      });
      if (r.ok && r.updateAvailable) send('update:available', r);
    } catch { /* offline / bad manifest: say nothing, the user can retry manually */ }
    // Staged installers from earlier runs are dead weight; clear the old ones.
    updater.cleanup().catch(() => {});
  }, 4000);
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (mcProcess) {
    // Leave the game running; just detach.
    mcProcess.removeAllListeners();
  }
});