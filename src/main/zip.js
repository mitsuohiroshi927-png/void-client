'use strict';
/**
 * Minimal, dependency-free archive extraction.
 *
 * Adoptium ships .zip on Windows and .tar.gz everywhere else, so both are
 * needed. Implemented here rather than pulled from npm to keep the app free of
 * runtime dependencies (the whole point of the launcher being lightweight).
 *
 *   unzipInto(zip, dir)             — extract every file from a .zip
 *   unzipFiltered(zip, dir, test)   — extract matching entries, flattened
 *   untarGzInto(tgz, dir)           — extract every file from a .tar.gz
 *   extractArchive(file, dir)       — pick zip vs tar.gz from the filename
 */

const fsp = require('fs').promises;
const path = require('path');
const zlib = require('zlib');

/* ------------------------------------------------------------------ zip */

function findEocd(buf) {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function* zipEntries(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) return;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) return;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const extAttr = buf.readUInt32LE(off + 38);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    if (name.includes('..') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) continue;

    const lnameLen = buf.readUInt16LE(localOff + 26);
    const lextraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lnameLen + lextraLen;
    yield {
      name,
      method,
      raw: buf.subarray(dataStart, dataStart + compSize),
      extAttr,
      isDir: name.endsWith('/'),
    };
  }
}

async function writeEntry(destDir, name, data, mode) {
  const outPath = path.join(destDir, name);
  const rel = path.relative(destDir, outPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return;
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.writeFile(outPath, data);
  if (process.platform !== 'win32' && mode) {
    await fsp.chmod(outPath, mode).catch(() => {});
  }
}

async function unzipInto(zipPath, destDir) {
  const buf = await fsp.readFile(zipPath);
  let n = 0;
  for (const e of zipEntries(buf)) {
    if (e.isDir) { await fsp.mkdir(path.join(destDir, e.name), { recursive: true }); continue; }
    const data = e.method === 0 ? e.raw : zlib.inflateRawSync(e.raw);
    const mode = ((e.extAttr >>> 16) & 0o777) || (/\/bin\//.test(e.name) ? 0o755 : 0o644);
    await writeEntry(destDir, e.name, data, mode);
    n++;
  }
  return n;
}

async function unzipFiltered(zipPath, destDir, test, { flatten = false } = {}) {
  const buf = await fsp.readFile(zipPath);
  const root = path.resolve(destDir);
  let n = 0;
  for (const e of zipEntries(buf)) {
    if (e.isDir || !test(e.name)) continue;
    const data = e.method === 0 ? e.raw : zlib.inflateRawSync(e.raw);
    // Archive members keep their directory structure so nested config trees
    // survive. flatten:true is kept for callers that only want loose files.
    const rel = flatten ? path.basename(e.name) : e.name;
    const out = path.resolve(root, rel.replace(/^[/\\]+/, ''));
    // Zip-slip: a crafted ../ entry must never write outside the target dir.
    if (out !== root && !out.startsWith(root + path.sep)) continue;
    await fsp.mkdir(path.dirname(out), { recursive: true });
    await fsp.writeFile(out, data);
    n++;
  }
  return n;
}

/* -------------------------------------------------------------- tar.gz */

/** Parse a POSIX/GNU tar buffer and yield {name, data, mode, isDir}. */
function* tarEntries(buf) {
  let off = 0;
  let longName = null;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    // End of archive: two zero blocks.
    if (header.every((b) => b === 0)) break;

    const readStr = (start, len) => {
      const s = header.subarray(start, start + len);
      const z = s.indexOf(0);
      return s.subarray(0, z === -1 ? s.length : z).toString('utf8');
    };
    let name = readStr(0, 100);
    const modeStr = readStr(100, 8).trim();
    const mode = modeStr ? parseInt(modeStr, 8) : 0o644;
    const size = parseInt(readStr(124, 12).trim() || '0', 8);
    const type = readStr(156, 1) || '0';
    const prefix = readStr(345, 155);
    const magic = readStr(257, 6);

    if (prefix) name = `${prefix}/${name}`;
    off += 512;
    const data = buf.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;

    // GNU long name (type 'L') applies to the *next* entry.
    if (type === 'L') { longName = data.toString('utf8').replace(/\0+$/, ''); continue; }
    if (longName) { name = longName; longName = null; }

    if (type === 'x' || type === 'g') continue; // pax headers
    if (name.includes('..') || name.startsWith('/')) continue;
    if (magic && !magic.startsWith('ustar')) continue;

    yield { name, data, mode, isDir: type === '5' || name.endsWith('/') };
  }
}

async function untarGzInto(tgzPath, destDir) {
  const gz = await fsp.readFile(tgzPath);
  const tar = zlib.gunzipSync(gz);
  let n = 0;
  for (const e of tarEntries(tar)) {
    if (e.isDir) { await fsp.mkdir(path.join(destDir, e.name), { recursive: true }); continue; }
    await writeEntry(destDir, e.name, e.data, e.mode || 0o644);
    n++;
  }
  return n;
}

/** Extract a .zip or .tar.gz based on the file's magic bytes (not just its name). */
async function extractArchive(file, destDir) {
  const fh = await fsp.open(file, 'r');
  const head = Buffer.alloc(4);
  await fh.read(head, 0, 4, 0);
  await fh.close();
  if (head[0] === 0x50 && head[1] === 0x4b) return { kind: 'zip', count: await unzipInto(file, destDir) };
  if (head[0] === 0x1f && head[1] === 0x8b) return { kind: 'tar.gz', count: await untarGzInto(file, destDir) };
  throw new Error(`Unsupported archive format: ${path.basename(file)}`);
}

async function listZip(zipPath) {
  const buf = await fsp.readFile(zipPath);
  const out = [];
  for (const e of zipEntries(buf)) if (!e.isDir) out.push(e.name);
  return out;
}

module.exports = { unzipInto, unzipFiltered, untarGzInto, extractArchive, listZip };
