'use strict';
/**
 * Modpack (.mrpack) installer.
 *
 * A Modrinth modpack is a plain zip: `modrinth.index.json` lists the files to
 * download (with sha1 + sha512), `overrides/` holds configs, and
 * `client-overrides/` holds client-only configs. Both override trees are applied
 * so the pack behaves the same as it does in the official launcher.
 *
 * The pack is unpacked INTO a profile folder, never into the shared game dir, so
 * installing a pack can never leak files into another profile.
 */
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const zip = require('./zip');

const UA = 'VoidClient/1.0.0 (launcher; +https://voidclient.local)';

async function fetchBuffer(url, timeout = 60000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(t);
  }
}

/** Download one file to a temp path, verifying sha1 when the pack provides it. */
async function fetchToFile(url, dest, expectSha1) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 120000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.part`;
    const fh = await fsp.open(tmp, 'w');
    await pipeline(Readable.fromWeb(res.body), fh.createWriteStream());
    await fh.close();
    if (expectSha1) {
      const buf = await fsp.readFile(tmp);
      const got = crypto.createHash('sha1').update(buf).digest('hex');
      if (got.toLowerCase() !== String(expectSha1).toLowerCase()) {
        await fsp.rm(tmp, { force: true });
        throw new Error(`Checksum mismatch for ${path.basename(dest)}`);
      }
    }
    await fsp.rename(tmp, dest);
    return { path: dest, size: (await fsp.stat(dest)).size };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Modrinth's `client`/`server` env flags decide who needs a file. This launcher
 * only plays the client, so files marked server-only are skipped.
 */
function neededForClient(file) {
  const env = file.env || {};
  if (env.client === 'unsupported') return false;
  if (env.server === 'required' && env.client === 'optional') return false;
  return true;
}

/**
 * Where a modpack entry lands inside a profile folder. Entries already carry
 * their full relative path (e.g. `mods/sodium.jar`, `config/foo.json`), so the
 * path is used as-is — but it must stay inside the profile.
 */
function safeJoin(base, rel) {
  const rel2 = String(rel).replace(/^[/\\]+/, '');
  const out = path.resolve(base, rel2);
  const root = path.resolve(base);
  if (out !== root && !out.startsWith(root + path.sep)) {
    throw new Error(`Refusing to write outside the profile: ${rel}`);
  }
  return out;
}

/**
 * Install a modpack into `profileDir`. Returns what actually landed so the UI
 * can report real numbers instead of guessing.
 */
async function installMrpack(mrpackPath, profileDir, { mcVersion, onProgress } = {}) {
  const raw = await fsp.readFile(mrpackPath);
  const files = zip.listZip ? await zip.listZip(mrpackPath) : null;

  // The index is small; pull it out of the archive by name.
  const indexName = 'modrinth.index.json';
  if (!files || !files.includes(indexName)) {
    throw new Error('This .mrpack has no modrinth.index.json — not a valid modpack.');
  }

  await fsp.mkdir(profileDir, { recursive: true });
  const idxDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'void-mrpack-'));
  await zip.unzipFiltered(mrpackPath, idxDir, (name) => name === indexName);
  const index = JSON.parse(await fsp.readFile(path.join(idxDir, indexName), 'utf8'));
  await fsp.rm(idxDir, { recursive: true, force: true });

  const packName = (index.name || 'Modpack').trim();
  const declaredMc = (index.dependencies || {}).minecraft || null;

  // Overrides: `overrides/` first, then `client-overrides/` so the client tree
  // wins on conflicts. The prefix is stripped as we write, because Minecraft
  // expects `config/x.json`, not `overrides/config/x.json`.
  const stripPrefix = async (prefix) => {
    await zip.unzipFiltered(mrpackPath, profileDir, (n) => n.startsWith(`${prefix}/`));
    // unzipFiltered wrote `overrides/...` verbatim; move it up one level.
    const from = path.join(profileDir, prefix);
    if (await fsp.stat(from).then(() => true).catch(() => false)) {
      await flattenInto(from, profileDir);
      await fsp.rm(from, { recursive: true, force: true });
    }
  };
  await stripPrefix('overrides');
  await stripPrefix('client-overrides');

  const wanted = (index.files || []).filter(neededForClient);
  let done = 0;
  const written = [];
  const failed = [];

  for (const f of wanted) {
    const dest = safeJoin(profileDir, f.path);
    const sha1 = ((f.hashes || {}).sha1 || '').toLowerCase() || null;
    if (onProgress) onProgress({ phase: 'modpack', file: f.path, done, total: wanted.length });
    try {
      // Skip a file that is already present and intact.
      if (sha1 && await fileSha1(dest).then((h) => h === sha1).catch(() => false)) {
        done += 1;
        written.push(f.path);
        continue;
      }
      await fetchToFile(f.downloads[0], dest, sha1);
      written.push(f.path);
    } catch (e) {
      failed.push({ path: f.path, error: e.message });
    }
    done += 1;
  }

  // A second pass retries transient network failures, same policy as the game
  // installer.
  for (const miss of failed.slice()) {
    const f = wanted.find((x) => x.path === miss.path);
    if (!f) continue;
    try {
      await fetchToFile(f.downloads[0], safeJoin(profileDir, f.path), ((f.hashes || {}).sha1 || '').toLowerCase() || null);
      failed.splice(failed.findIndex((x) => x.path === miss.path), 1);
      written.push(f.path);
    } catch { /* stays in failed */ }
  }

  return {
    packName,
    versionId: index.versionId || null,
    declaredMc,
    mcVersion: mcVersion || declaredMc,
    total: wanted.length,
    installed: written.length,
    failed,
    written,
  };
}

async function fileSha1(p) {
  const buf = await fsp.readFile(p);
  return crypto.createHash('sha1').update(buf).digest('hex');
}

/** Move every entry of `from` into `to`, merging directories. */
async function flattenInto(from, to) {
  const entries = await fsp.readdir(from, { withFileTypes: true });
  for (const e of entries) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) {
      await fsp.mkdir(dst, { recursive: true });
      await flattenInto(src, dst);
      await fsp.rm(src, { recursive: true, force: true });
    } else {
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      await fsp.rename(src, dst).catch(async () => {
        await fsp.copyFile(src, dst);
        await fsp.rm(src, { force: true });
      });
    }
  }
}

module.exports = { installMrpack, fileSha1, safeJoin };
