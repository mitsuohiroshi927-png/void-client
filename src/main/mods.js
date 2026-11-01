'use strict';
/**
 * Mod management.
 *
 * VOID FPS is treated as a read-only artifact: this module copies the built jar
 * into the game's mods/ folder and never edits it. The mod's own settings file
 * (config/voidfps.properties) is untouched — the launcher only ever reads the
 * mod's metadata to display it.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { exists, ensureDir } = require('./installer');

/**
 * Locate a built VOID FPS jar. Search order: explicit settings path, cwd, home, cache.
 *
 * Version-agnostic on purpose: the bundled jar is renamed every release
 * (vendor/void-fps-<ver>.jar), so a hardcoded version here would silently stop
 * matching the moment the jar is bumped.
 */
const VOIDFPS_JAR_RE = /^void-fps-.+\.jar$/i;

async function findVoidFpsJar(explicitPath) {
  const candidates = [];
  if (explicitPath) candidates.push(explicitPath);
  const home = require('os').homedir();
  const dirs = [
    process.cwd(),
    home,
    path.join(home, 'Downloads'),
    path.dirname(process.execPath || '')
  ];
  // Newest version wins: list each dir and sort descending so a leftover old jar
  // next to the fresh one does not get picked.
  for (const dir of dirs) {
    try {
      const hits = (await fsp.readdir(dir))
        .filter((e) => VOIDFPS_JAR_RE.test(e))
        .sort()
        .reverse();
      if (hits.length) candidates.push(path.join(dir, hits[0]));
    } catch {
      /* dir missing or unreadable */
    }
  }
  for (const c of candidates) {
    if (c && (await exists(c))) return c;
  }
  return null;
}

/** Read fabric.mod.json from inside a jar (central directory scan, no unzip dep). */
async function readFabricModJson(jarPath) {
  const zlib = require('zlib');
  const buf = await fsp.readFile(jarPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    if (name !== 'fabric.mod.json') continue;
    const lnameLen = buf.readUInt16LE(localOff + 26);
    const lextraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lnameLen + lextraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);
    const raw = method === 0 ? data : zlib.inflateRawSync(data);
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      return null;
    }
  }
  return null;
}

async function sha256(file) {
  const buf = await fsp.readFile(file);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Describe the bundled/target VOID FPS jar for the UI. */
async function inspectVoidFps(explicitPath) {
  const jarPath = await findVoidFpsJar(explicitPath);
  if (!jarPath) {
    return { found: false, hint: 'Place void-fps-<version>.jar next to VOID Client, or pick it in Settings.' };
  }
  const meta = await readFabricModJson(jarPath);
  const stat = await fsp.stat(jarPath);
  return {
    found: true,
    path: jarPath,
    size: stat.size,
    sha256: await sha256(jarPath),
    id: meta && meta.id,
    name: meta && meta.name,
    version: meta && meta.version,
    description: meta && meta.description,
    depends: meta && meta.depends,
  };
}

/** List jars currently in mods/. */
async function listInstalledMods(gameDir) {
  const modsDir = path.join(gameDir, 'mods');
  if (!(await exists(modsDir))) return [];
  const entries = await fsp.readdir(modsDir);
  // Icon URLs come from the origin sidecar written at install time — a jar
  // itself carries no icon, so without this every installed mod falls back to
  // an initial letter even though Modrinth has artwork for it.
  let origins = {};
  try {
    origins = JSON.parse(await fsp.readFile(path.join(modsDir, '.origins.json'), 'utf8'));
  } catch { origins = {}; }
  const out = [];
  for (const e of entries) {
    // Disabled mods are parked as "name.jar.disabled" — Fabric ignores them, but
    // the launcher still lists them so you can switch them back on.
    const off = /\.jar\.disabled$/i.test(e);
    if (!/\.jar$/i.test(e) && !off) continue;
    const full = path.join(modsDir, e);
    const meta = await readFabricModJson(full).catch(() => null);
    const stat = await fsp.stat(full);
    const org = origins[e] || {};
    out.push({
      file: e,
      path: full,
      size: stat.size,
      id: meta ? meta.id : null,
      name: meta ? meta.name : e.replace(/\.disabled$/i, ''),
      version: meta ? meta.version : null,
      disabled: off,
      isVoidFps: meta ? meta.id === 'voidfps' : /void/i.test(e),
      iconUrl: org.iconUrl || null,
      projectSlug: org.slug || null,
    });
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/** Copy the VOID FPS jar into mods/ (idempotent, only when the hash differs). */
async function installVoidFps(gameDir, jarPath) {
  const modsDir = path.join(gameDir, 'mods');
  await ensureDir(modsDir);
  const target = path.join(modsDir, path.basename(jarPath));
  if (await exists(target)) {
    const [a, b] = await Promise.all([sha256(target), sha256(jarPath)]);
    if (a === b) return { copied: false, target };
  }
  // Remove any previous VOID FPS build so we never end up with two.
  for (const e of await fsp.readdir(modsDir)) {
    if (/^void-fps-.*\.jar$/i.test(e) && e !== path.basename(jarPath)) {
      const p = path.join(modsDir, e);
      const meta = await readFabricModJson(p).catch(() => null);
      if (meta && meta.id === 'voidfps') await fsp.unlink(p).catch(() => {});
    }
  }
  await fsp.copyFile(jarPath, target);
  return { copied: true, target };
}

/**
 * Copy a user-supplied jar into a mods directory.
 *
 * `modsDir` is the profile's mods folder itself — callers already hold the exact
 * path (profiles/<id>/mods), so appending 'mods' here again would bury the jar in
 * mods/mods/ where Fabric never looks and the mod silently never loads.
 */
async function addMod(modsDir, srcPath) {
  await ensureDir(modsDir);
  const target = path.join(modsDir, path.basename(srcPath));
  await fsp.copyFile(srcPath, target);
  return target;
}

async function removeMod(gameDir, fileName) {
  const p = path.join(gameDir, 'mods', path.basename(fileName));
  await fsp.unlink(p);
  return true;
}

/**
 * Remove any VOID FPS jar that a previous launcher build copied into mods/.
 *
 * VOID FPS now ships inside the client, so a jar sitting in mods/ would be a
 * duplicate mod id and Fabric refuses to start. Delete it and report what went.
 */
async function removeBundledVoidFps(gameDir) {
  const modsDir = path.join(gameDir, 'mods');
  if (!(await exists(modsDir))) return [];
  const removed = [];
  for (const e of await fsp.readdir(modsDir)) {
    if (!/\.jar$/i.test(e)) continue;
    const full = path.join(modsDir, e);
    const meta = await readFabricModJson(full).catch(() => null);
    if ((meta && meta.id === 'voidfps') || /^void-?fps/i.test(e)) {
      await fsp.unlink(full).catch(() => {});
      removed.push(e);
    }
  }
  return removed;
}

/** Whether the mod's own config exists yet (read-only check). */
async function hasModConfig(gameDir) {
  return exists(path.join(gameDir, 'config', 'voidfps.properties'));
}

/**
 * Seed `config/voidfps-feedback.url` into the game dir on first run.
 *
 * The mod reads its webhook from the Minecraft config dir. Without this the file
 * only appears if the user creates it by hand, so feedback silently no-ops.
 *
 * Write-ONCE: never overwrite an existing file. The URL is a secret the user may
 * have rotated themselves, and clobbering it on every launch would both lose
 * their change and fight them. ENOENT (missing dir) is expected on a clean
 * install and is handled by ensureDir.
 */
async function seedFeedbackWebhook(gameDir, url) {
  if (!gameDir || !url) return false;
  try {
    const cfgDir = path.join(gameDir, 'config');
    const dest = path.join(cfgDir, 'voidfps-feedback.url');
    if (await exists(dest)) return false; // user's own copy wins, always
    await ensureDir(cfgDir);
    await fsp.writeFile(dest, `${String(url).trim()}\n`, 'utf8');
    return true;
  } catch {
    // Seeding is best-effort: a read-only or missing game dir must not break launch.
    return false;
  }
}

module.exports = {
  findVoidFpsJar,
  readFabricModJson,
  inspectVoidFps,
  seedFeedbackWebhook,
  listInstalledMods,
  installVoidFps,
  addMod,
  removeMod,
  hasModConfig,
  removeBundledVoidFps,
  sha256,
};
