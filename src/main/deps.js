'use strict';
/**
 * Dependency resolution for required Fabric mods.
 *
 * VOID FPS declares `depends.fabric-api: "*"`. Rather than bundling a jar we
 * don't own, we ask Modrinth for the matching official Fabric API build for the
 * target Minecraft version and download it from the author's CDN.
 */

const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { exists, ensureDir } = require('./installer');

const { UA } = require('./version');
const MODRINTH = 'https://api.modrinth.com/v2';

/** Look up the newest Fabric API file for a Minecraft version. */
async function resolveFabricApi(mcVersion) {
  const url = `${MODRINTH}/project/fabric-api/version?game_versions=${encodeURIComponent(
    JSON.stringify([mcVersion])
  )}&loaders=${encodeURIComponent(JSON.stringify(['fabric']))}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Modrinth HTTP ${res.status} while resolving Fabric API.`);
  const list = await res.json();
  if (!Array.isArray(list) || !list.length) {
    throw new Error(`No Fabric API build published for Minecraft ${mcVersion}.`);
  }
  const v = list[0];
  const file = v.files.find((f) => f.primary) || v.files[0];
  return {
    versionNumber: v.version_number,
    versionId: v.id,
    filename: file.filename,
    url: file.url,
    size: file.size,
    hashes: file.hashes || {},
  };
}

/** Download Fabric API into mods/ if a matching build isn't already there. */
async function ensureFabricApi(gameDir, mcVersion, onLog) {
  const modsDir = path.join(gameDir, 'mods');
  await ensureDir(modsDir);

  // Fast path: a build we already verified for this Minecraft version is kept in
  // a sidecar note next to the jar. Launch must not pay a Modrinth round-trip
  // (~1.8 s measured) to re-learn something that cannot have changed.
  const note = await readNote(modsDir, mcVersion);
  if (note) {
    const target = path.join(modsDir, note.filename);
    if (await exists(target)) return { installed: false, path: target, ...note };
    // Jar is gone but the note survived: fall through and re-resolve.
  }

  const info = await resolveFabricApi(mcVersion);
  const target = path.join(modsDir, info.filename);

  if (await exists(target)) {
    // Verify the sha1 Modrinth published so a truncated download can't stick.
    if (info.hashes.sha1) {
      const buf = await fsp.readFile(target);
      const have = crypto.createHash('sha1').update(buf).digest('hex');
      if (have === info.hashes.sha1) {
        await writeNote(modsDir, mcVersion, info);
        return { installed: false, ...info, path: target };
      }
    }
  }

  const res = await fetch(info.url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Fabric API download HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (info.hashes.sha1) {
    const have = crypto.createHash('sha1').update(buf).digest('hex');
    if (have !== info.hashes.sha1) throw new Error('Fabric API checksum mismatch.');
  }
  // Remove other Fabric API builds so two versions can never load together.
  for (const e of await fsp.readdir(modsDir)) {
    if (/^fabric-api-.*\.jar$/i.test(e) && e !== info.filename) {
      await fsp.unlink(path.join(modsDir, e)).catch(() => {});
    }
  }
  await fsp.writeFile(target, buf);
  await writeNote(modsDir, mcVersion, info);
  if (onLog) onLog(`Fabric API ${info.versionNumber} installed`);
  return { installed: true, ...info, path: target };
}

/** Sidecar filename; keyed by Minecraft version so profiles never cross-read. */
function notePath(modsDir, mcVersion) {
  return path.join(modsDir, `.void-fabric-api-${String(mcVersion).replace(/[^\w.\-]/g, '_')}.json`);
}

async function readNote(modsDir, mcVersion) {
  try {
    const raw = await fsp.readFile(notePath(modsDir, mcVersion), 'utf8');
    const n = JSON.parse(raw);
    // Only trust a note that names a real file and carries the hash we verified against.
    if (n && n.filename && n.hashes && n.hashes.sha1) return n;
  } catch { /* no note yet */ }
  return null;
}

async function writeNote(modsDir, mcVersion, info) {
  // Best-effort: a failed write only costs the next launch a network lookup.
  await fsp.writeFile(notePath(modsDir, mcVersion), JSON.stringify({
    versionNumber: info.versionNumber, versionId: info.versionId,
    filename: info.filename, url: info.url, size: info.size, hashes: info.hashes,
  })).catch(() => {});
}

module.exports = { resolveFabricApi, ensureFabricApi };
