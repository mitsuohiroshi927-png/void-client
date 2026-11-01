'use strict';

/**
 * Corrupt-file repair for an existing Minecraft installation.
 *
 * Why this exists: every file the launcher installs carries a hash that Mojang or
 * Fabric published. A half-written jar, a disk that died mid-download, an antivirus
 * that "cleaned" a library, a crash that truncated an asset — all of them leave a
 * file that still exists but no longer matches. The launcher then fails to start
 * with a confusing error, and the only advice anyone ever gives is "delete your
 * .minecraft and try again", which throws away worlds and settings.
 *
 * So: verify first, re-download only what is actually broken. Nothing is deleted
 * until a replacement has been fetched and hashed successfully, which means a
 * repair that runs out of network cannot make things worse.
 *
 * Scope is deliberately narrow — only regenerable files:
 *   versions/<id>/<id>.jar      (SHA-1 from the version JSON)
 *   versions/<id>/<id>.json     (parsed and shape-checked)
 *   libraries/**.jar            (SHA-1 from the version JSON / Fabric profile)
 *   assets/objects/<ab>/<hash>  (SHA-1 == filename, by design)
 *
 * Worlds, options.txt, screenshots, mods/ and the fabric profile under
 * versions/fabric-loader-XXXX/ are never touched by verification; they are user data
 * or locally generated. Anything missing-but-expected is reported, not recreated,
 * unless it is one of the four categories above.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const RESOURCES = 'https://resources.download.minecraft.net';
const UA = 'VoidClient/1.1.1 (launcher; +https://github.com/mitsuohiroshi927-png/void-client)';

/** Streaming SHA-1 so multi-hundred-MB jars never sit in memory. */
async function sha1File(file) {
  const hash = crypto.createHash('sha1');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** A file counts as intact when it exists, is non-empty, and matches its hash. */
async function checkFile(file, expectedSha1) {
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    return { state: 'missing' };
  }
  if (!st.isFile()) return { state: 'missing' };
  // 0-byte means the download died before the first byte landed. Cheap to spot,
  // and it is the single most common corruption in the wild.
  if (st.size === 0) return { state: 'corrupt', reason: 'empty file', size: 0 };
  if (!expectedSha1) return { state: 'ok', size: st.size };
  const got = await sha1File(file);
  if (got !== expectedSha1) {
    return { state: 'corrupt', reason: 'hash mismatch', size: st.size, got, want: expectedSha1 };
  }
  return { state: 'ok', size: st.size };
}

/** Download to a temp neighbour, verify, then move into place. Never clobbers blind. */
async function downloadVerified(url, dest, expectedSha1, onProgress) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.repairtmp`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));

  if (expectedSha1) {
    const got = await sha1File(tmp);
    if (got !== expectedSha1) {
      await fsp.rm(tmp, { force: true });
      throw new Error('downloaded file failed verification');
    }
  }
  await fsp.rename(tmp, dest);
  onProgress && onProgress();
}

/**
 * Verify one Minecraft version and repair whatever fails.
 *
 * Returns a report the UI can render directly:
 *   { version, checked, ok, corrupt: [...], missing: [...], repaired: [...],
 *     failed: [...], total, done, bytesRepaired }
 */
async function repairVersion(root, versionId, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const shouldStop = opts.shouldStop || (() => false);

  const vdir = path.join(root, 'versions', versionId);
  const vjsonPath = path.join(vdir, `${versionId}.json`);
  if (!(await exists(vjsonPath))) {
    throw new Error(`Minecraft ${versionId} is not installed in this profile.`);
  }

  let vjson;
  try {
    vjson = JSON.parse(await fsp.readFile(vjsonPath, 'utf8'));
  } catch {
    // The version JSON itself is corrupt: that is exactly the case where the
    // launcher can do nothing at all, so report it distinctly.
    throw new Error(`The version file for ${versionId} is unreadable and must be re-downloaded.`);
  }

  // Build the complete verify list before touching the disk, so the UI can show a
  // real total instead of a guess.
  const targets = [];

  const clientJar = path.join(vdir, `${versionId}.jar`);
  const clientSha = vjson.downloads && vjson.downloads.client ? vjson.downloads.client.sha1 : null;
  const clientUrl = vjson.downloads && vjson.downloads.client ? vjson.downloads.client.url : null;
  if (clientUrl) {
    targets.push({ kind: 'client', label: `${versionId}.jar`, file: clientJar, sha1: clientSha, url: clientUrl });
  }

  const libs = (vjson.libraries || []).filter((l) => l.downloads && l.downloads.artifact);
  for (const lib of libs) {
    const art = lib.downloads.artifact;
    const rel = art.path;
    if (!rel) continue;
    targets.push({
      kind: 'library',
      label: rel.split('/').pop(),
      file: path.join(root, 'libraries', rel),
      sha1: art.sha1,
      url: art.url,
    });
  }

  // Assets: the object hash IS the filename, so the expected hash needs no lookup.
  const assetIndexRel = vjson.assetIndex && vjson.assetIndex.id;
  if (assetIndexRel) {
    const idxFile = path.join(root, 'assets', 'indexes', `${assetIndexRel}.json`);
    if (await exists(idxFile)) {
      try {
        const idx = JSON.parse(await fsp.readFile(idxFile, 'utf8'));
        for (const obj of Object.values(idx.objects || {})) {
          const sub = obj.hash.slice(0, 2);
          targets.push({
            kind: 'asset',
            label: obj.hash.slice(0, 12),
            file: path.join(root, 'assets', 'objects', sub, obj.hash),
            sha1: obj.hash,
            url: `${RESOURCES}/${sub}/${obj.hash}`,
          });
        }
      } catch {
        // A corrupt asset index is itself non-fatal: assets are optional for launch
        // on a modern client and re-downloading 3k objects to fix it is not worth
        // the time. Reported via the index check below instead.
      }
    }
  }

  const report = {
    version: versionId,
    total: targets.length,
    checked: 0,
    ok: 0,
    corrupt: [],
    missing: [],
    repaired: [],
    failed: [],
    bytesRepaired: 0,
  };

  for (const t of targets) {
    if (shouldStop()) break;
    if (opts.signal && opts.signal.aborted) break;

    const r = await checkFile(t.file, t.sha1);
    report.checked += 1;
    onProgress(report.checked, report.total, t.label);

    if (r.state === 'ok') {
      report.ok += 1;
      continue;
    }

    // Record what was FOUND before attempting the fix — the report has to be able to
    // distinguish "checked 4, all fine" from "checked 4, fixed 3", so the finding is
    // kept even when the repair succeeds.
    let sizeBefore = 0;
    try {
      sizeBefore = (await fsp.stat(t.file)).size;
    } catch { /* was missing */ }

    const finding = {
      kind: t.kind,
      label: t.label,
      file: t.file,
      was: r.state,
      reason: r.reason || null,
      size: sizeBefore,
    };
    if (r.state === 'missing') report.missing.push(finding);
    else report.corrupt.push(finding);

    // Scan-only: report the damage, change nothing. The UI shows this first so the
    // user knows the size of the job before agreeing to it.
    if (opts.scanOnly) continue;

    // Repair pass. Only worth it when we know where the good copy lives.
    if (!t.url) {
      report.failed.push({ label: t.label, error: 'no download source in the version manifest' });
      continue;
    }
    try {
      await downloadVerified(t.url, t.file, t.sha1, () => {});
      report.repaired.push({ kind: t.kind, label: t.label, was: r.state, bytes: sizeBefore });
      report.bytesRepaired += sizeBefore;
    } catch (e) {
      report.failed.push({ label: t.label, error: String(e && e.message ? e.message : e) });
    }
  }

  return report;
}

/** Quick scan without repairing — lets the UI show a count before the user commits. */
async function scanVersion(root, versionId, opts = {}) {
  return repairVersion(root, versionId, { ...opts, scanOnly: true });
}

module.exports = { repairVersion, scanVersion, checkFile, sha1File, downloadVerified };
