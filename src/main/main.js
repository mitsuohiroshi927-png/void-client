'use strict';
/**
 * VOID Client — Electron main process.
 *
 * All privileged work (downloads, filesystem, spawning Java) lives here.
 * The renderer stays sandboxed with contextIsolation and only talks to this
 * file through the narrow preload bridge.
 */

const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, session, nativeImage } = require('electron');
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
const perfmods = require('./perfmods');
const stats = require('./stats');
const hardware = require('./hardware');
const javaRuntime = require('./java-runtime');
const updater = require('./updater');
const repair = require('./repair');
const { DiscordRpc } = require('./rpc');
const { Store, activeProfileId } = require('./settings');

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
  const userData = app.getPath('userData');
  return {
    root: s.root,
    gameDir: s.gameDir,
    configFile: path.join(userData, 'launcher.json'),
    sessionFile: path.join(userData, 'session.json'),
    // One file per account: the active one is what session.json mirrors, so every existing
    // reader keeps working while several accounts can sit side by side and be switched.
    accountsDir: path.join(userData, 'accounts'),
    accountIndexFile: path.join(userData, 'accounts-index.json'),
  };
}

/** Read the account index ({ active: "<uuid>" }); never throws. */
async function readAccountIndex() {
  try {
    const data = JSON.parse(await fsp.readFile(paths().accountIndexFile, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

async function writeAccountIndex(data) {
  const f = paths().accountIndexFile;
  await fsp.mkdir(path.dirname(f), { recursive: true });
  await fsp.writeFile(f, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/** Every stored account, newest first, with the active one flagged. */
async function listAccounts() {
  const dir = paths().accountsDir;
  const index = await readAccountIndex();
  let files = [];
  try {
    files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    files = [];
  }
  const out = [];
  for (const f of files) {
    try {
      const data = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8'));
      if (!data || !data.profile) continue;
      out.push({
        uuid: data.profile.id,
        name: data.profile.name,
        skins: data.profile.skins || [],
        addedAt: data.addedAt || 0,
        active: data.profile.id === index.active,
      });
    } catch { /* unreadable file: skip it rather than break the whole list */ }
  }
  return out.sort((a, b) => b.addedAt - a.addedAt);
}

async function saveSession(data) {
  const f = paths().sessionFile;
  await fsp.mkdir(path.dirname(f), { recursive: true });
  await fsp.writeFile(f, JSON.stringify(data, null, 2), { mode: 0o600 });

  // Multi-account: the same blob is kept per profile id, and this one becomes the active
  // account. A save without a profile (older callers) only touches the session mirror.
  const id = data && data.profile && data.profile.id;
  if (!id) return;
  try {
    const dir = paths().accountsDir;
    await fsp.mkdir(dir, { recursive: true });
    const existing = JSON.parse(await fsp.readFile(path.join(dir, `${id}.json`), 'utf8').catch(() => 'null'));
    const record = { ...data, addedAt: (existing && existing.addedAt) || Date.now() };
    await fsp.writeFile(path.join(dir, `${id}.json`), JSON.stringify(record, null, 2), { mode: 0o600 });
    await writeAccountIndex({ active: id });
  } catch (e) {
    // The session itself is already safe; failing to file it must not break sign-in.
    console.error('[accounts] could not store account:', e.message);
  }
}

async function loadSession() {
  const index = await readAccountIndex();
  if (index.active) {
    try {
      const raw = await fsp.readFile(path.join(paths().accountsDir, `${index.active}.json`), 'utf8');
      const data = JSON.parse(raw);
      if (data && data.msa) return data;
    } catch { /* account file gone: fall through to the session mirror */ }
  }
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

/**
 * Remember which catalog project a jar came from.
 *
 * A downloaded jar has no link back to its Modrinth/CurseForge project, so
 * without this sidecar we cannot tell an outdated mod from a current one and
 * "update my mods" is impossible. Stored per profile as `mods/.origins.json`
 * so entries never leak across profiles.
 */
async function recordModOrigin(profileDir, file, meta) {
  const manifestPath = path.join(profileDir, 'mods', '.origins.json');
  let map = {};
  try {
    map = JSON.parse(await fsp.readFile(manifestPath, 'utf8')) || {};
  } catch {
    map = {};   // missing or corrupt — start clean rather than throw
  }
  map[file] = { ...meta, installedAt: new Date().toISOString() };
  try {
    await fsp.writeFile(manifestPath, JSON.stringify(map, null, 2), 'utf8');
  } catch {
    // A failed sidecar write must never fail the install itself.
  }
  return map;
}

async function readModOrigins(profileDir) {
  try {
    return JSON.parse(await fsp.readFile(path.join(profileDir, 'mods', '.origins.json'), 'utf8')) || {};
  } catch {
    return {};
  }
}

/**
 * Ask the catalog whether any installed, catalog-sourced mod has a newer build
 * for this profile's Minecraft version. User-dropped jars are skipped: with no
 * project id attached we genuinely cannot know, and guessing would offer
 * "updates" that are really downgrades or replacements.
 */
async function findModUpdates(profileDir, mcVersion) {
  const origins = await readModOrigins(profileDir);
  const files = await fsp.readdir(path.join(profileDir, 'mods')).catch(() => []);
  const onDisk = new Set(files);
  const updates = [];

  for (const [file, o] of Object.entries(origins)) {
    if (!onDisk.has(file)) continue;           // user deleted it
    // Older manifests used `id`; new ones write `projectId`. Accept both so a
    // profile recorded before the rename still reports updates.
    const projectId = o.projectId || o.id;
    if (!projectId) continue;                  // manually added jar
    try {
      const versions = await catalog.projectVersions(projectId, {
        mcVersion, loader: 'fabric',
      });
      const newest = versions.find((v) => v.versionType === 'release') || versions[0];
      if (!newest) continue;
      const newestId = newest.id;
      if (!newestId || newestId === o.versionId) continue;   // already current
      updates.push({
        file,
        name: o.name || file,
        slug: o.slug,
        projectId,
        source: o.source || 'modrinth',
        from: o.versionNumber || 'unknown',
        to: newest.versionNumber || newest.name || 'newer',
        versionId: newestId,
        // Carried through so the update row shows the mod's real artwork.
        iconUrl: o.iconUrl || null,
      });
    } catch {
      // Offline or project pulled — never block the rest of the scan.
    }
  }
  return updates;
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

    // Start from the profile the user is already on, so creating a profile does not
    // silently reset RAM, resolution, JVM args, skin or FPS cap to defaults. The
    // user asked for "keep the settings from before" — a new profile is a variation
    // on what they were using, not a factory reset.
    const src = opts && opts.copyFrom && s.profiles[opts.copyFrom]
      ? s.profiles[opts.copyFrom]
      : (s.profiles[s.profile] || null);

    s.profiles[id] = {
      id,
      name: clean,
      description: (opts && opts.description) || 'Custom profile — add only the mods you want.',
      ram: (opts && opts.ram) || (src ? src.ram : 0),
      width: (opts && opts.width) || (src ? src.width : 0),
      height: (opts && opts.height) || (src ? src.height : 0),
      // Carry over every per-profile performance/behaviour knob we know about.
      jvmArgs: (src && Array.isArray(src.jvmArgs)) ? [...src.jvmArgs] : [],
      maxFps: src ? src.maxFps : undefined,
      skins: src ? src.skins : undefined,
      // Version + loader are per-profile so one install can run a 1.21.11 Fabric pack
      // and a 26.3 vanilla world side by side. Falls back to the global setting for
      // profiles created before this existed.
      mcVersion: (opts && opts.mcVersion) || (src && src.mcVersion) || s.mcVersion || '1.21.11',
      loader: (opts && opts.loader) || (src && src.loader) || 'fabric',
      icon: '◈',
      hidden: false,          // user-made profiles are always visible
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

ipcMain.handle('profile:copyMods', async (_e, fromId, toId) => {
  try {
    const s = await store.load();
    const from = s.profiles[fromId];
    const to = s.profiles[toId];
    if (!from || !to) throw new Error('no such profile');
    const fromDir = path.join(s.gameDir, 'profiles', fromId, 'mods');
    const toDir = path.join(s.gameDir, 'profiles', toId, 'mods');
    await fsp.mkdir(toDir, { recursive: true });
    let jars = [];
    try { jars = (await fsp.readdir(fromDir)).filter((f) => /\.jar$/i.test(f)); } catch { return { ok: true, copied: 0 }; }
    let copied = 0;
    for (const f of jars) {
      // Never overwrite: the target profile is the user's, not ours.
      const dest = path.join(toDir, f);
      if (await fsp.access(dest).then(() => true).catch(() => false)) continue;
      try { await fsp.copyFile(path.join(fromDir, f), dest); copied++; } catch { /* skip unreadable */ }
    }
    return { ok: true, copied };
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
    // Callers hand us whatever the row displays, which for a switched-off mod is
    // the real on-disk name WITH the ".disabled" suffix. Normalise to the stem
    // first, then add or strip the suffix exactly once, so the toggle works in
    // both directions instead of only the first one.
    const stem = path.basename(String(file || '')).replace(/\.disabled$/i, '');
    const safe = stem;
    const from = path.join(base, disable ? safe : `${safe}.disabled`);
    const to = path.join(base, disable ? `${safe}.disabled` : safe);
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
    // `''` means EVERY release and must not fall back to the 1.21 filter — only a
    // true undefined does. `prefix || '1.21'` treated the empty string as "unset",
    // which silently hid every year-based release (26.1, 26.2, 26.3 …).
    const all = await installer.listVersions(prefix == null ? '1.21' : prefix);
    return { ok: true, versions: all };
  } catch (e) {
    return { ok: false, error: e.message, versions: [] };
  }
});

ipcMain.handle('playtime:get', async () => {
  const s = store.get() || {};
  const now = new Date();
  const todayKey = now.toISOString().slice(0, 10);
  // A total that has rolled past midnight reports today as 0 without rewriting
  // the store — reading the clock must not mutate state.
  const todaySeconds = s.playtimeDay === todayKey ? (s.playtimeToday || 0) : 0;
  const days = s.playtimeDays || {};

  // Monday..Sunday of the CURRENT week, which is the week the player expects when
  // they say "this week". getDay() is 0=Sunday, so Sunday maps to index 6.
  const monday = new Date(now);
  const back = (now.getDay() + 6) % 7;
  monday.setDate(now.getDate() - back);
  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const week = labels.map((label, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { label, date: key, seconds: days[key] || 0, isToday: key === todayKey, isFuture: d > now };
  });
  // Fold the live session into today's bar only.
  const t = week.find((w) => w.isToday);
  if (t) {
    const stored = days[t.date] || 0;
    const extra = (sessionStartedAt ? Math.round((Date.now() - sessionStartedAt) / 1000) : 0);
    t.seconds = Math.max(stored, todaySeconds) + extra;
  }

  return {
    ok: true,
    total: s.playtimeTotal || 0,
    today: todaySeconds,
    sessions: s.playtimeSessions || 0,
    lastPlayed: s.lastPlayed || null,
    // Live seconds for the session in flight, so the UI can tick it up.
    running: sessionStartedAt ? Math.round((Date.now() - sessionStartedAt) / 1000) : 0,
    week,
  };
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

  ipcMain.handle('auth:signOut', async (_e, uuid) => {
    // Signing out with a uuid removes that account; without one it clears the active account.
    const id = uuid ? String(uuid).replace(/[^0-9a-zA-Z-]/g, '') : (await readAccountIndex()).active;
    if (id) await fsp.unlink(path.join(paths().accountsDir, `${id}.json`)).catch(() => {});
    const rest = await listAccounts();
    authState = { session: null, profile: null };
    await fsp.unlink(paths().sessionFile).catch(() => {});
    if (rest.length) {
      // Another account is still stored: make it active instead of leaving nothing signed in.
      await writeAccountIndex({ active: rest[0].uuid });
      try {
        const raw = await fsp.readFile(path.join(paths().accountsDir, `${rest[0].uuid}.json`), 'utf8');
        await ensureChain(JSON.parse(raw));
      } catch { /* stays signed out, the list is still shown */ }
    } else {
      await writeAccountIndex({});
    }
    return true;
  });

  /* ---- multiple accounts ---- */

  /**
   * Switch the active account. The stored per-account file is handed to ensureChain(), which
   * refreshes the token if needed and mirrors the fresh session into session.json — so the rest
   * of the launcher (and the game) never has to know there is more than one account.
   */
  ipcMain.handle('accounts:switch', async (_e, uuid) => {
    try {
      const id = String(uuid || '').replace(/[^0-9a-zA-Z-]/g, '');
      if (!id) throw new Error('No account selected.');
      const raw = await fsp.readFile(path.join(paths().accountsDir, `${id}.json`), 'utf8');
      const data = JSON.parse(raw);
      if (!data || !data.msa) throw new Error('That account has no saved sign-in.');
      await writeAccountIndex({ active: id });
      const chain = await ensureChain(data);
      send('auth:done', { profile: chain.profile });
      return { ok: true, profile: chain.profile, accounts: await listAccounts() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /**
   * Forget an account. Removing the active one falls through to the newest remaining account
   * (or to signed-out when it was the last), so the launcher is never left pointing at a
   * session that no longer exists.
   */
  ipcMain.handle('accounts:remove', async (_e, uuid) => {
    try {
      const id = String(uuid || '').replace(/[^0-9a-zA-Z-]/g, '');
      const index = await readAccountIndex();
      await fsp.unlink(path.join(paths().accountsDir, `${id}.json`)).catch(() => {});
      if (index.active === id) {
        const rest = await listAccounts();
        authState = { session: null, profile: null };
        if (rest.length) {
          await writeAccountIndex({ active: rest[0].uuid });
          const raw = await fsp.readFile(path.join(paths().accountsDir, `${rest[0].uuid}.json`), 'utf8');
          await ensureChain(JSON.parse(raw)).catch(() => {});
        } else {
          await writeAccountIndex({});
          await fsp.unlink(paths().sessionFile).catch(() => {});
        }
      }
      return { ok: true, accounts: await listAccounts() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('accounts:list', async () => {
    const accounts = await listAccounts();
    return { ok: true, accounts, active: accounts.find((a) => a.active) || null };
  });

  /* ---- account head for the in-game account (no Microsoft session needed) ---- */

  /**
   * The account the GAME is using, from gameDir/config/voidfps_accounts.json (written by the
   * mod's account switcher). Premium entries carry their real Mojang UUID, which is enough to
   * ask Mojang for the skin; an offline entry has a made-up UUID and simply has no skin, so the
   * UI keeps its letter instead of inventing a head.
   */
  async function activeGameAccountUuid(gameDir) {
    try {
      const raw = await fsp.readFile(path.join(gameDir, 'config', 'voidfps_accounts.json'), 'utf8');
      const data = JSON.parse(raw);
      const list = Array.isArray(data.accounts) ? data.accounts : [];
      const active = list.find((a) => a && a.uuid === data.active) || list[0];
      const id = active && String(active.uuid || '').replace(/-/g, '');
      return id && /^[0-9a-f]{32}$/i.test(id) ? id.toLowerCase() : null;
    } catch {
      return null;
    }
  }

  async function skinUrlForUuid(uuid) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`, {
        headers: { 'User-Agent': 'VoidClient (launcher)' },
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      const body = await res.json();
      const prop = (body.properties || []).find((p) => p && p.name === 'textures');
      if (!prop || !prop.value) return null;
      const decoded = JSON.parse(Buffer.from(prop.value, 'base64').toString('utf8'));
      const skin = decoded.textures && decoded.textures.SKIN;
      return skin && skin.url ? skin.url : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Cut the head out of a skin sheet in the MAIN process (nativeImage). Two reasons it has to
   * happen here rather than in the renderer: Mojang hands out `http://textures.minecraft.net`
   * URLs, and Chromium refuses an insecure subresource on a file:// page (so the renderer's
   * <img>/canvas path silently produced a letter every time), and this needs no CORS at all.
   * Two 8x8 crops — face (8,8) and the hat overlay (40,8) — that the renderer stacks.
   */
  const HEAD_CACHE = new Map();

  async function headForUrl(url) {
    const key = String(url || '');
    if (!key) return null;
    if (HEAD_CACHE.has(key)) return HEAD_CACHE.get(key);
    try {
      const res = await fetch(key, { headers: { 'User-Agent': 'VoidClient (launcher)' } });
      if (!res.ok) return null;
      const crops = headCropsFrom(Buffer.from(await res.arrayBuffer()));
      if (!crops) return null;
      if (HEAD_CACHE.size > 24) HEAD_CACHE.delete(HEAD_CACHE.keys().next().value);
      HEAD_CACHE.set(key, crops);
      return crops;
    } catch {
      return null;
    }
  }

  function headCropsFrom(png) {
    try {
      const img = nativeImage.createFromBuffer(png);
      if (img.isEmpty()) return null;
      const size = img.getSize();
      const face = img.crop({ x: 8, y: 8, width: 8, height: 8 }).toDataURL();
      const hat = size.width >= 64 && size.height >= 64
        ? img.crop({ x: 40, y: 8, width: 8, height: 8 }).toDataURL()
        : null;
      return face ? { face, hat } : null;
    } catch {
      return null;
    }
  }

  /**
   * Heads for the UI. Called with a skin URL (any stored account) it just crops that skin;
   * called with nothing it falls back to the account the GAME plays with, so the chip has a
   * head even when the launcher itself is signed out.
   */
  ipcMain.handle('account:head', async (_e, skinUrl) => {
    if (skinUrl) {
      const crops = await headForUrl(skinUrl);
      return crops ? { ok: true, ...crops } : { ok: false, error: 'skin unavailable' };
    }
    const s = store.get();
    const uuid = await activeGameAccountUuid(s.gameDir || '');
    if (!uuid) return { ok: false, error: 'no premium in-game account' };
    const cache = (s.skinHeads && typeof s.skinHeads === 'object') ? s.skinHeads : {};
    if (cache[uuid] && cache[uuid].face) return { ok: true, uuid, cached: true, ...cache[uuid] };

    const url = await skinUrlForUuid(uuid);
    if (!url) return { ok: false, uuid, error: 'no skin for that account' };
    try {
      const crops = await headForUrl(url);
      if (!crops) return { ok: false, uuid, error: 'skin was not an image' };
      // Cache by UUID: sessionserver is rate limited, and the head never changes mid-session.
      const next = { ...cache };
      const keys = Object.keys(next);
      if (keys.length >= 5) delete next[keys[0]];
      next[uuid] = crops;
      await store.patch({ skinHeads: next });
      return { ok: true, uuid, ...crops };
    } catch (e) {
      return { ok: false, uuid, error: e.message };
    }
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

  /* ---- integrity / repair ---- */
  // Verify the installed client against the hashes Mojang published and re-fetch
  // only what fails. Scan first so the user sees the size of the job, then repair.
  ipcMain.handle('repair:scan', async () => {
    const s = store.get();
    try {
      const report = await repair.scanVersion(s.root, s.mcVersion, {
        onProgress: (done, total, label) => send('repair:progress', { phase: 'scan', done, total, label }),
      });
      return { ok: true, report };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('repair:run', async () => {
    const s = store.get();
    try {
      const report = await repair.repairVersion(s.root, s.mcVersion, {
        onProgress: (done, total, label) => send('repair:progress', { phase: 'repair', done, total, label }),
      });
      return { ok: true, report };
    } catch (e) {
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
    //
    // `s.profile` can be null (a fresh install with no profile yet, or a
    // launcher.json whose stored id no longer matches any profile). Without
    // this guard path.join throws ERR_INVALID_ARG_TYPE and the ENTIRE Mods page
    // fails to render — the empty state must come from a missing folder, not
    // from an exception in the handler.
    const profileGameDir = s.profile
      ? path.join(s.gameDir, 'profiles', s.profile)
      : s.gameDir;
    const profMods = s.profile
      ? await mods.listInstalledMods(profileGameDir).catch(() => [])
      : [];
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
    if (!jar) return { ok: false, error: 'VOID Client jar not found.' };
    const r = await mods.installVoidFps(s.gameDir, jar);
    return { ok: true, ...r };
  });

  /* ------------------------------- perf mod set ----------------------------- */
  // The version that matters is the ACTIVE PROFILE's, not the global default.
  // A profile pinned to 26.3 must be offered the 26.3 builds for its own
  // folder; asking Modrinth for the global version would grey out every mod and
  // claim "nothing available" for a profile that could install all of them.
  // Returns null when no usable profile is selected, so the caller can say so
  // instead of silently resolving against the wrong version.
  const perfTarget = () => {
    const st = store.get();
    const profileId = activeProfileId(st.profiles, st.profile);
    if (!profileId) return null;
    const prof = (st.profiles && st.profiles[profileId]) || {};
    return {
      st,
      profileId,
      profileDir: path.join(st.gameDir, 'profiles', profileId),
      // `mcVersion` is what the profile actually stores; `mc` was read instead, so a
      // profile pinned to another version was offered this install's builds.
      mcVersion: prof.mcVersion || prof.mc || st.mcVersion || '1.21.11',
    };
  };

  // The one-click FPS boost. Reports which mods actually exist for the selected
  // Minecraft version AND which are already installed, BEFORE installing, so the
  // button can say "Install 3" while the 13 the user already has sit greyed out
  // instead of being re-downloaded.
  ipcMain.handle('perf:check', async () => {
    const t = perfTarget();
    if (!t) return { ok: true, needsProfile: true, mcVersion: null, rows: [], counts: { total: perfmods.PERF_MODS.length, available: 0, present: 0, missing: 0, unavailable: 0 } };
    const { mcVersion, profileId, profileDir } = t;
    try {
      const rows = await catalog.perfSetSupport({
        mcVersion, loader: perfmods.DEFAULT_LOADER, mods: perfmods.PERF_MODS, profileDir,
      });
      return {
        ok: true, mcVersion, profile: profileId, rows,
        counts: {
          total: rows.length,
          // `withBuild` = published for this MC version at all; `available` =
          // actually left to install. Keeping them distinct stops "18 available
          // / 18 present" from reading like a contradiction in logs.
          withBuild: rows.filter((r) => r.ok).length,
          available: rows.filter((r) => r.ok && !r.present).length,
          present: rows.filter((r) => r.ok && r.present).length,
          missing: rows.filter((r) => r.ok && !r.present).length,
          unavailable: rows.filter((r) => !r.ok).length,
        },
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('perf:install', async (_e, slugs) => {
    const t = perfTarget();
    if (!t) return { ok: false, error: 'Create a profile first.' };
    const { mcVersion, profileId, profileDir } = t;
    const modsDir = path.join(profileDir, 'mods');
    // The renderer sends the ticked slugs. Fall back to the full set when
    // nothing is sent (older renderer, or a direct call) so the handler can
    // never install zero mods because of a missing argument.
    //
    // Intersecting against PERF_MODS is what makes a stale or tampered renderer
    // harmless: any slug not in our own list is dropped here, so the UI cannot
    // talk the launcher into downloading an arbitrary Modrinth project.
    const wanted = Array.isArray(slugs) && slugs.length
      ? perfmods.PERF_MODS.filter((m) => slugs.includes(m.slug))
      : perfmods.PERF_MODS;
    if (!wanted.length) return { ok: false, error: 'No known performance mods were selected.' };
    try {
      const r = await catalog.installPerfSet(modsDir, {
        mcVersion,
        loader: perfmods.DEFAULT_LOADER,
        mods: wanted,
        onProgress: (p) => send('perf:progress', p),
      });
      // Record provenance for everything that landed, so the existing
      // "N mod updates available" banner can update these like any other mod.
      // The title/icon come from the resolve step: a mod row that shows a slug
      // and no logo looks like a failed install even when it worked.
      const support = await catalog.perfSetSupport({
        mcVersion, loader: perfmods.DEFAULT_LOADER, mods: wanted, profileDir,
      });
      const bySlug = new Map(support.filter((s) => s.ok).map((s) => [s.slug, s]));
      for (const it of r.installed) {
        const s = bySlug.get(it.slug) || {};
        await recordModOrigin(profileDir, it.file, {
          source: 'modrinth',
          id: s.slug || it.slug,
          projectId: s.slug || it.slug,
          slug: s.slug || it.slug,
          name: s.title || it.slug,
          iconUrl: s.iconUrl || null,
          versionNumber: it.version,
        });
      }
      if (r.counts.installed) send('mods:changed', { file: `${r.counts.installed} performance mods` });
      return { ok: true, profile: profileId, mcVersion, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
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
      // A dependency already carries its resolved `file` from resolveDependencies —
      // re-resolving it would be a second network round-trip for data we hold, and
      // would fail on a flaky link even though the jar URL is known. Use it as-is.
      const file = (hit && hit.file && hit.file.url)
        ? hit.file
        : await catalog.resolveFile(hit, { mcVersion, loader: 'fabric', apiKey: st.curseforgeApiKey });

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
      // Record where this jar came from. Without it we cannot tell later whether
      // an installed mod is out of date, because a jar on disk carries no link
      // back to its Modrinth/CurseForge project.
      await recordModOrigin(profileDir, r.file, {
        source: project.source || 'modrinth',
        id: project.id,
        slug: project.slug,
        name: project.name,
        versionId: chosen.versionId || chosen.id || null,
        versionNumber: chosen.versionNumber || chosen.name || null,
        file: r.file,
        // Persisted so the Installed list can show real artwork instead of a
        // letter; only available at install time from the project record.
        iconUrl: project.iconUrl || project.icon_url || null,
        sha1: chosen.hashes && chosen.hashes.sha1 ? chosen.hashes.sha1 : (r.sha1 || null),
      });
      send('mods:changed', { file: r.file });
      return { ok: true, kind: 'mod', ...r, profile: profileId };
    } catch (e) {
      return { ok: false, error: e.message, kind: type };
    }
  });

  /* ------------------------------ mod updates ------------------------------- */

  // Which installed mods have a newer build for the active profile.
  ipcMain.handle('mods:checkUpdates', async () => {
    const st = store.get();
    const profileId = activeProfileId(st.profiles, st.profile);
    // activeProfileId returns null when nothing usable is selected, and
    // path.join(dir, null) throws — so this guard has to come BEFORE the join.
    // It also sits inside the try: a thrown handler returns a rejected promise
    // to the renderer, which is a red error in the console rather than a clean
    // "no profile yet" state.
    try {
      if (!profileId) return { ok: true, updates: [], profile: null, reason: 'no-profile' };
      const profileDir = path.join(st.gameDir, 'profiles', profileId);
      const updates = await findModUpdates(profileDir, st.mcVersion || '1.21.11');
      return { ok: true, updates, profile: profileId };
    } catch (e) {
      return { ok: false, error: e.message, updates: [] };
    }
  });

  // Install one mod update: keep the old jar on disk only until the new one
  // lands, so a failed download never leaves the user with no mod at all.
  ipcMain.handle('mods:applyUpdate', async (_e, { file, projectId, versionId, name: displayName, iconUrl } = {}) => {
    const st = store.get();
    const profileId = activeProfileId(st.profiles, st.profile);
    const backup = path.join(os.tmpdir(), `void-mod-bak-${Date.now()}`);
    try {
      // Guard before any path is built from it: path.join(dir, null) throws
      // before the first line of real work, so the user would see a raw
      // ERR_INVALID_ARG_TYPE instead of being told to pick a profile.
      if (!profileId) throw new Error('No profile selected.');
      const modsDir = path.join(st.gameDir, 'profiles', profileId, 'mods');
      if (!projectId || !versionId) throw new Error('Missing project or version');
      // Resolve the exact build the banner promised. Without the id this would
      // silently download "latest" and the user could not tell the difference.
      const chosen = await catalog.resolveFile({ source: 'modrinth', id: projectId, versionId },
        { mcVersion: st.mcVersion || '1.21.11', loader: 'fabric', apiKey: st.curseForgeApiKey });
      if (!chosen || !chosen.url) throw new Error('That version has no downloadable file');
      const target = { ...chosen, versionNumber: chosen.versionNumber || chosen.name || null };

      // Read the old record BEFORE deleting it — it holds the display name.
      const prevOrigins = await readModOrigins(path.join(st.gameDir, 'profiles', profileId));
      const prev = (file && prevOrigins[file]) || {};

      if (file) {
        await fsp.mkdir(backup, { recursive: true });
        await fsp.rename(path.join(modsDir, file), path.join(backup, file)).catch(() => {});
      }
      const r = await catalog.downloadMod(modsDir, target, {
        onProgress: (got, total) => send('catalog:progress', { slug: projectId, got, total }),
      });
      const newFile = r.file || target.filename || target.file;
      // The new file may legitimately have a different name; drop the old one.
      if (file && newFile !== file) await fsp.rm(path.join(modsDir, file), { force: true });

      const origins = prevOrigins;
      if (file) delete origins[file];
      origins[newFile] = {
        source: 'modrinth', id: projectId, slug: prev.slug || projectId,
        // Prefer the caller-supplied display values: `prev` is looked up by the
        // OLD filename, which is already gone by now, so it would fall back to
        // the raw jar name and lose the human-readable title.
        name: displayName || prev.name || newFile,
        versionId, versionNumber: target.versionNumber || null,
        file: newFile, iconUrl: iconUrl || prev.iconUrl || null,
        updatedAt: new Date().toISOString(),
      };
      await fsp.writeFile(path.join(modsDir, '.origins.json'), JSON.stringify(origins, null, 2), 'utf8');
      await fsp.rm(backup, { recursive: true, force: true });

      send('mods:changed', { file: r.file });
      return { ok: true, file: r.file };
    } catch (e) {
      // Put the previous build back so the profile stays bootable.
      if (file) {
        await fsp.rename(path.join(backup, file), path.join(modsDir, file)).catch(() => {});
      }
      return { ok: false, error: e.message };
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

  /* ---- dependency awareness ---- */

  // Which installed mods would stop working if this jar were deleted?
  //
  // Read straight from each jar's fabric.mod.json: `depends` is authoritative and
  // local, so this works offline and cannot disagree with what the loader will do
  // at boot. Fabric API is the classic case — plenty of mods depend on it, and
  // removing it turns every one of them into a crash on startup.
  const modMetaCache = new Map();

  async function readModMeta(file) {
    if (modMetaCache.has(file)) return modMetaCache.get(file);
    let meta = null;
    try {
      // readFabricModJson() does a central-directory scan of the zip, so it needs
      // no unzip dependency and never chokes on a jar that is merely large.
      meta = await mods.readFabricModJson(file);
    } catch { /* not a readable mod jar */ }
    modMetaCache.set(file, meta);
    return meta;
  }

  /** True when `meta` declares a dependency that `depId` provides. */
  function dependsOn(meta, depId) {
    if (!meta) return false;
    const deps = meta.depends || {};
    if (deps[depId] !== undefined) return true;
    // A mod also breaks if it depends on an id that the removed mod `provides`.
    return false;
  }

  ipcMain.handle('mods:dependents', async (_e, file) => {
    const s = store.get();
    const base = path.basename(String(file || ''));

    // Identify the target mod id from its own metadata.
    const dirs = [
      path.join(s.gameDir, 'profiles', s.profile, 'mods'),
      path.join(s.gameDir, 'mods'),
    ];
    let targetMeta = null;
    let targetDir = null;
    for (const d of dirs) {
      const p = path.join(d, base);
      if (await fsp.access(p).then(() => true).catch(() => false)) {
        targetMeta = await readModMeta(p);
        targetDir = d;
        break;
      }
    }
    const ids = [];
    if (targetMeta && targetMeta.id) ids.push(String(targetMeta.id));
    if (targetMeta && Array.isArray(targetMeta.provides)) {
      for (const p of targetMeta.provides) ids.push(String(p));
    }
    // Fabric API's jar declares a dozen ids; fall back to the filename so a jar we
    // could not parse still gets useful protection.
    if (!ids.length) {
      const guess = base.replace(/[-_]?\d[\w.+-]*\.jar$/i, '').replace(/\.jar$/i, '');
      if (guess) ids.push(guess);
    }

    const dependents = [];
    const seen = new Set();
    for (const d of dirs) {
      let entries = [];
      try { entries = await fsp.readdir(d); } catch { continue; }
      for (const e of entries) {
        if (!/\.jar$/i.test(e) || e === base) continue;
        if (seen.has(e)) continue;
        const meta = await readModMeta(path.join(d, e));
        if (!meta) continue;
        const hits = ids.filter((id) => dependsOn(meta, id));
        if (hits.length) {
          seen.add(e);
          dependents.push({ file: e, name: meta.name || meta.id || e, id: meta.id || '', needs: hits });
        }
      }
    }

    return {
      ok: true,
      file: base,
      ids,
      name: targetMeta ? (targetMeta.name || targetMeta.id) : base,
      dependents,
      isFabricApi: ids.some((i) => /fabric-api|fabric$/i.test(i)) || /fabric-api/i.test(base),
    };
  });

  ipcMain.handle('mods:dependencies', async (_e, hit, opts) => {
    try {
      const s = store.get();
      const mcVersion = (opts && opts.mcVersion) || s.mcVersion || '1.21.11';
      // The renderer may hand us a search hit (has source + project_id) or a bare
      // slug / project id. Normalise both: resolveFile dispatches on `hit.source`,
      // so it must be set, and `id` is the project id it looks up.
      const projectId = (hit && (hit.project_id || hit.id)) || (typeof hit === 'string' ? hit : null);
      if (!projectId) return { ok: false, error: 'No project identifier supplied' };
      const norm = {
        source: (hit && hit.source) || 'modrinth',
        type: (hit && hit.type) || 'mod',
        id: projectId,
        project_id: projectId,
        slug: hit && hit.slug,
      };
      const file = await catalog.resolveFile(norm, { mcVersion, apiKey: s.curseforgeApiKey });
      const deps = await catalog.resolveDependencies(file, { mcVersion });

      // Filter out anything already present in this profile — warning about a mod
      // the user already has is noise.
      const dirs = [
        path.join(s.gameDir, 'profiles', s.profile, 'mods'),
        path.join(s.gameDir, 'mods'),
      ];
      const installed = [];
      for (const d of dirs) {
        try {
          installed.push(...(await fsp.readdir(d)));
        } catch { /* folder may not exist yet */ }
      }
      const names = installed.join('\n').toLowerCase();
      const missing = deps.required.filter((d) => {
        const slug = String(d.slug || '').toLowerCase();
        const title = String(d.title || '').toLowerCase();
        const fn = d.file ? String(d.file.filename).toLowerCase() : '';
        if (fn && installed.some((f) => f.toLowerCase() === fn)) return false;
        if (slug && names.includes(slug)) return false;
        if (title && names.includes(title.replace(/\s+/g, ''))) return false;
        return true;
      });

      // Split the missing ones by whether we can actually fetch them. A required
      // dependency with no build for this MC/loader must NOT vanish — dropping it
      // silently lets the user install a mod that will crash on launch.
      const unavailable = missing.filter((d) => !d.installable);

      return { ok: true, file, required: deps.required, missing, unavailable, optional: deps.optional };
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
      // Mirror list from the manifest, primary first — a dead mirror must not block
      // the update, and every attempt is still hash-checked.
      urls: info && info.urls,
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
      // The ACTIVE PROFILE owns its Minecraft version and its loader. Both used to be
      // read from the global settings here, so the version printed on the profile card
      // and the version actually launched could disagree — and when the launched
      // version was not one the bundled VOID Client supports, the mod skipped itself
      // with nothing but a log line nobody saw. Profile wins; the global value is the
      // fallback for profiles created before they had their own version.
      const mcVersion = prof.mcVersion || s.mcVersion || '1.21.11';
      const useFabric = prof.loader ? prof.loader !== 'vanilla' : !!s.useFabric;
      if (mcVersion !== s.mcVersion || useFabric !== !!s.useFabric) {
        send('launch:log', {
          line: `[launcher] profile "${prof.name || s.profile}": Minecraft ${mcVersion}${useFabric ? ' + Fabric' : ' (vanilla)'}`,
        });
      }

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
      const versionJson = await installer.resolveVersionJson(mcVersion, s.root);
      // How much Java this exact version needs. Read from the version json above
      // (javaVersion.majorVersion) so year-based releases like 26.3 — which wants
      // Java 25 — are handled without a launcher update.
      const requiredJava = await installer.requiredJavaMajor(mcVersion, s.root);

      // 2a. The vanilla client jar must be on disk BEFORE Fabric boots: Knot
      //     locates the game through the classpath, and a missing or
      //     half-downloaded jar is exactly what makes Fabric fail with
      //     "Minecraft game provider couldn't locate the game!". Verify size
      //     (cheap stat) first, then one sha1 against the version json, and
      //     repair by reinstalling — installVanilla skips everything that
      //     already matches its official checksum, so only what is broken
      //     actually re-downloads.
      const clientInfo = versionJson.downloads && versionJson.downloads.client;
      const clientJar = path.join(s.root, 'versions', mcVersion, `${mcVersion}.jar`);
      let jarOk = false;
      if (clientInfo) {
        const st = await fsp.stat(clientJar).catch(() => null);
        if (st && st.size === clientInfo.size) {
          jarOk = (await installer.sha1File(clientJar)) === clientInfo.sha1;
        }
      }
      if (!jarOk) {
        send('launch:log', { line: `[launcher] Minecraft ${mcVersion} client jar missing or corrupted — downloading it now...` });
        await installer.installVanilla(mcVersion, s.root, (phase, done, total, label) =>
          send('install:progress', { phase, done, total, label })
        );
      }

      let fabric = null;
      if (useFabric) {
        const installedId = `${mcVersion}-fabric-${s.fabricLoader || ''}`;
        const direct = path.join(s.root, 'versions', installedId, `${installedId}.json`);
        let profileJson = null;
        if (s.fabricLoader && fs.existsSync(direct)) {
          profileJson = JSON.parse(await fsp.readFile(direct, 'utf8'));
          fabric = { id: installedId, mainClass: profileJson.mainClass, libraries: profileJson.libraries || [] };
        } else {
          const fab = await installer.installFabric(mcVersion, s.root, s.fabricLoader || undefined, (phase, done, total, label) =>
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
          send('launch:log', { line: `[launcher] removed stale VOID Client jar from mods/: ${removed.join(', ')}` });
        }
      } catch (e) {
        send('launch:log', { line: `[launcher] WARN voidfps cleanup: ${e.message}` });
      }
      const profileModsDir = path.join(s.gameDir, 'profiles', s.profile, 'mods');
      await fsp.mkdir(profileModsDir, { recursive: true }).catch(() => {});

      // 3b. Required mod dependencies (VOID FPS hard-depends on Fabric API).
      if (useFabric && s.autoDeps !== false) {
        try {
          const fa = await deps.ensureFabricApi(s.gameDir, mcVersion, (m) =>
            send('launch:log', { line: `[launcher] ${m}` })
          );
          if (fa.installed) send('launch:log', { line: `[launcher] Fabric API ${fa.versionNumber} ready` });
        } catch (e) {
          send('launch:log', { line: `[launcher] WARN fabric-api: ${e.message}` });
        }
      }

      // 4. Java path — resolve a runtime matching what the SELECTED VERSION needs.
      //    Order: explicit user path > managed JRE >= required > system Java >
      //    auto-download the right major (with a progress bar in the UI).
      //
      //    The required major is read from the version's own manifest entry rather
      //    than hardcoded to 21: 1.21.x wants Java 21, but the year-based releases
      //    (26.x) want a newer one, and shipping the wrong major fails at boot with
      //    an obscure UnsupportedClassVersionError.
      const needMajor = Number(requiredJava) || 21;
      let javaPath = s.javaPath;
      let javaNote = '';
      // An explicitly configured java.exe only counts if it is new enough — an old
      // Java in javaPath would otherwise be used and crash the game.
      if (javaPath) {
        const probe = await hardware.probeJava(javaPath).catch(() => null);
        if (!probe || Number(probe.major || 0) < needMajor) {
          send('launch:log', { line: `[launcher] configured Java is older than ${needMajor}, ignoring it` });
          javaPath = null;
        }
      }
      if (!javaPath) {
        const managed = await javaRuntime.managedRuntimePath(s.root, needMajor);
        if (managed) {
          javaPath = managed;
          javaNote = `managed Java ${needMajor}`;
        } else {
          const picked = await hardware.pickRuntime('');
          if (picked && picked.suitable && Number(picked.major || 0) >= needMajor) {
            javaPath = picked.path;
            javaNote = `system Java ${picked.major}`;
          } else {
            // Nothing usable on this machine — fetch an official Temurin JRE of the
            // exact major the game needs. The progress bar is driven by
            // install:progress, which the renderer shows over the Play button.
            send('launch:log', { line: `[launcher] No Java ${needMajor} found, downloading a runtime...` });
            send('install:phase', { phase: 'java', label: `Downloading Java ${needMajor}`, running: true });
            try {
              const r = await javaRuntime.installRuntime(s.root, {
                major: needMajor,
                onLog: (line) => send('launch:log', { line: `[launcher] ${line}` }),
                onProgress: (got, total) => send('install:progress', {
                  phase: 'java', done: got, total, label: `Java ${needMajor}`,
                }),
              });
              javaPath = r.path;
              javaNote = `downloaded Java ${needMajor}`;
              // Remember it per-major so switching back to an older version does not
              // overwrite the path a newer one needs.
              await store.patch({ javaPath: r.path, javaRuntime: 'managed' });
            } catch (e) {
              throw new Error(
                `No Java ${needMajor}+ runtime available and the download failed (${e.message}). ` +
                `Install Java ${needMajor} (Temurin) or pick javaw.exe in Settings.`
              );
            } finally {
              send('install:phase', { phase: 'java', running: false });
            }
          }
        }
      }
      send('launch:log', { line: `[launcher] Java: ${javaNote || javaPath}` });

      // 5. Build + spawn
      const spec = await launch.buildLaunchSpec({
        root: s.root,
        mcVersion,
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
          // buildLaunchSpec reports what it decided (bundled mod attached or skipped,
          // and why) through this. Without it those messages had nowhere to go and a
          // skipped VOID Client looked like a mod that simply did not load.
          onLog: (line) => send('launch:log', { line }),
        },
      });

      await fsp.mkdir(s.gameDir, { recursive: true });

      // Playtime clock starts the moment the JVM spawns and stops on exit. It is
      // per-session so a crash still books the minutes actually played.
      sessionStartedAt = Date.now();
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
          // Book the session before announcing the exit, so a launcher that quits
          // with the game still records the time just played.
          const played = recordPlaytime(store, sessionStartedAt);
          sessionStartedAt = null;
          send('launch:status', { state: 'exited', code, signal, played: played.session, total: played.total });
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
  // catalog.js needs the live store to read proxyUrl; it cannot require the
  // module itself because settings.js exports the class, not an instance.
  catalog.setStore(store);
  // Mod icons load from cdn.modrinth.com inside the renderer, which does NOT
  // inherit Node's proxy settings. Without this, a proxied user sees a broken
  // image on every mod even though the catalog itself works fine.
  try {
    const { proxyUrl } = store.get() || {};
    if (proxyUrl) await session.defaultSession.setProxy({ proxyRules: proxyUrl });
  } catch { /* a bad proxy string must not block startup */ }
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

/* ------------------------------ Playtime -------------------------------- */

/** Epoch ms when the current session's JVM spawned, or null when nothing runs. */
let sessionStartedAt = null;
/**
 * Book a finished session into the store.
 *
 * Time is kept in three buckets so the launcher can show "this session", "today",
 * and the lifetime total without re-summing a log. Sessions under a minute are
 * dropped: a crash-on-launch or an instant quit is noise, not playtime, and it
 * would otherwise inflate the session count on every failed start.
 */
function recordPlaytime(store, startedAt) {
  const empty = { session: 0, total: 0, today: 0 };
  if (!store || !startedAt) return empty;
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (seconds < 60) {
    const cur = store.get() || {};
    return { session: seconds, total: cur.playtimeTotal || 0, today: cur.playtimeToday || 0 };
  }

  const today = new Date().toISOString().slice(0, 10);
  const s = store.get() || {};
  // `playtimeDay` is the day the `today` counter belongs to — a new day resets it.
  const todayBefore = s.playtimeDay === today ? (s.playtimeToday || 0) : 0;

  // Per-day ledger, trimmed to the last 30 entries. The week chart reads the last
  // seven of these; keeping a month lets a future "this month" view work without
  // touching the store shape again.
  const days = { ...(s.playtimeDays || {}) };
  days[today] = (todayBefore + seconds);
  const keys = Object.keys(days).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - 30))) delete days[k];

  const next = {
    playtimeTotal: (s.playtimeTotal || 0) + seconds,
    playtimeToday: todayBefore + seconds,
    playtimeDay: today,
    playtimeDays: days,
    playtimeSessions: (s.playtimeSessions || 0) + 1,
    lastPlayed: new Date().toISOString(),
  };
  store.set(next);
  return { session: seconds, total: next.playtimeTotal, today: next.playtimeToday };
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

/**
 * Buttons that ride along with every presence frame.
 *
 * Discord renders at most two, and a button is only interactive when its url is
 * a plain http(s) address — anything else is silently dropped by the client, so
 * this stays a single literal with no interpolation.
 *
 * Points at the GitHub Pages site: the old void-client-c8q.pages.dev host is
 * frozen at 1.2.0 and would send people to a stale download.
 */
const SITE_URL = 'https://mitsuohiroshi927-png.github.io/void-client/';
const RPC_BUTTONS = [{ label: 'Website', url: SITE_URL }];

/** Presence while the launcher sits idle: the app name, nothing else. */
function rpcSetIdle() {
  const r = rpcEnsure();
  if (!r) return;
  r.setActivity({
    details: 'In menu',
    startTimestamp: sessionStart,
    assets: { large_image: 'void', large_text: 'VOID Client' },
    buttons: RPC_BUTTONS,
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
    buttons: RPC_BUTTONS,
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
    buttons: RPC_BUTTONS,
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