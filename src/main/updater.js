/**
 * Launcher self-update, Modrinth-style.
 *
 * The launcher is an NSIS installer, so "update" means: find a newer installer,
 * download it, verify it, then run it and quit. We never patch files in place —
 * a half-written exe is worse than an old one, and the installer already knows
 * how to replace itself.
 *
 * Two rules this follows:
 *   - It must never block startup. A dead update server cannot stop the user
 *     from playing, so every network call has a timeout and every failure is a
 *     returned value, never a throw.
 *   - It must never install anything the user did not agree to. Check is
 *     automatic; download and run are always an explicit click.
 *
 * Manifest shape (update.json served next to stats.php):
 *   {
 *     "version": "1.1.0",
 *     "notes": "What changed",
 *     "url": "https://.../VOID-Client-1.1.0-Setup.exe",
 *     "sha256": "…",              // optional but verified when present
 *     "mandatory": false,          // true = nag on every launch
 *     "platforms": { "win32": { "url": "...", "sha256": "..." } }  // optional
 *   }
 */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { shell } = require('electron');

// Separate from the mod's update.json on purpose — see settings.js updateUrl.
const DEFAULT_MANIFEST = 'https://deepconvert.my.id/voidfps/launcher.json';
const UA = 'VoidClient (launcher; +https://deepconvert.my.id/voidfps)';
const TIMEOUT_MS = 12000;

/** Parse "1.2.10" into [1,2,10] so 1.2.10 > 1.2.9 (string compare gets this wrong). */
function parseVersion(v) {
  return String(v || '0')
    .trim()
    .replace(/^v/i, '')
    .split(/[.\-+]/)
    .map((p) => parseInt(p, 10))
    .map((n) => (Number.isFinite(n) ? n : 0));
}

/** -1 / 0 / 1, so callers can reason about "newer" without string compare. */
function compareVersions(a, b) {
  const A = parseVersion(a);
  const B = parseVersion(b);
  const len = Math.max(A.length, B.length);
  for (let i = 0; i < len; i++) {
    const x = A[i] || 0;
    const y = B[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

async function fetchJson(url, timeout = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Pick the entry for this platform. A single-platform manifest (the simple
 * case) has url/sha256 at the top level; a multi-platform one nests them.
 */
function pickAsset(manifest) {
  const key = process.platform === 'win32' ? 'win32' : process.platform;
  const plat = manifest.platforms && manifest.platforms[key];
  if (plat && plat.url) {
    return {
      url: plat.url,
      sha256: plat.sha256 || manifest.sha256 || '',
      size: plat.size || manifest.size || 0,
    };
  }
  return {
    url: manifest.url || '',
    sha256: manifest.sha256 || '',
    size: manifest.size || 0,
  };
}

/**
 * Ask the server what the newest build is.
 *
 * Never throws: on any failure it returns ok:false with a reason, because the
 * caller is a UI that should show "couldn't check" rather than crash the app.
 */
async function check({ current, manifestUrl, timeout } = {}) {
  const url = manifestUrl || DEFAULT_MANIFEST;
  const me = current || '0.0.0';
  let manifest;
  try {
    manifest = await fetchJson(url, timeout);
  } catch (e) {
    return { ok: false, error: `Could not reach the update server (${e.message})`, current: me };
  }
  if (!manifest || !manifest.version) {
    return { ok: false, error: 'Update manifest is missing a version field', current: me };
  }
  const asset = pickAsset(manifest);
  const cmp = compareVersions(manifest.version, me);
  return {
    ok: true,
    current: me,
    latest: String(manifest.version),
    updateAvailable: cmp > 0,
    // A manifest that claims an older version than what's running is a
    // misconfigured server, not an update — surface that instead of hiding it.
    downgrade: cmp < 0,
    notes: manifest.notes || '',
    mandatory: !!manifest.mandatory,
    url: asset.url,
    sha256: asset.sha256,
    size: asset.size,
  };
}

async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('error', reject);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/** Where the downloaded installer waits. Named by version so two updates don't collide. */
function stagedPath(version) {
  return path.join(os.tmpdir(), `VOID-Client-${version}-Setup.exe`);
}

/**
 * Download the installer and verify it before it is ever executed.
 *
 * The hash check matters: we are about to run this file with the user's
 * privileges, so a truncated download or a hijacked mirror must fail here
 * rather than at install time.
 */
async function download({ version, url, sha256, onProgress } = {}) {
  if (!url) return { ok: false, error: 'Update manifest has no download URL' };
  const dest = stagedPath(version || 'update');
  const tmp = `${dest}.part`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10 * 60 * 1000);

  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;

    const out = fs.createWriteStream(tmp);
    let got = 0;
    let lastTick = 0;

    const reader = res.body.getReader ? res.body.getReader() : null;
    if (reader) {
      // Web streams (Node 18+/Electron): report progress as chunks land.
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out.write(Buffer.from(value));
        got += value.length;
        const now = Date.now();
        if (onProgress && now - lastTick > 200) {
          lastTick = now;
          onProgress({ got, total, pct: total ? Math.round((got / total) * 100) : 0 });
        }
      }
      await new Promise((r) => out.end(r));
    } else {
      for await (const chunk of res.body) {
        out.write(chunk);
        got += chunk.length;
      }
      await new Promise((r) => out.end(r));
    }

    if (total && got !== total) {
      throw new Error(`Download truncated (${got} of ${total} bytes)`);
    }

    if (sha256) {
      const actual = await sha256File(tmp);
      if (actual.toLowerCase() !== String(sha256).toLowerCase()) {
        throw new Error('Downloaded installer failed its SHA-256 check — refusing to run it');
      }
    }

    // Only now does the file get its real name, so a .part leftover can never be
    // mistaken for a verified installer.
    await fsp.rename(tmp, dest);
    return { ok: true, file: dest, bytes: got, verified: !!sha256 };
  } catch (e) {
    await fsp.unlink(tmp).catch(() => {});
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Hand the verified installer to Windows and let it do the replace.
 *
 * we quit right after: NSIS cannot overwrite an exe that is still running, so
 * staying alive would make the install fail with a locked-file error.
 */
async function apply({ file, onQuit } = {}) {
  if (!file) return { ok: false, error: 'No downloaded installer to run' };
  const exists = await fsp.access(file).then(() => true).catch(() => false);
  if (!exists) return { ok: false, error: 'The downloaded installer is gone' };

  if (process.platform !== 'win32') {
    // Can't run a Windows installer here; open the folder so it's still useful.
    await shell.showItemInFolder(file).catch(() => {});
    return { ok: true, opened: true, file };
  }

  const child = spawn(file, [], { detached: true, stdio: 'ignore' });
  child.unref();
  if (onQuit) setTimeout(onQuit, 800);
  return { ok: true, launched: true, file };
}

/** Delete staged installers from previous sessions. Best-effort housekeeping. */
async function cleanup() {
  const dir = os.tmpdir();
  const files = await fsp.readdir(dir).catch(() => []);
  let removed = 0;
  for (const f of files) {
    if (/^VOID-Client-.*-Setup\.exe(\.part)?$/i.test(f)) {
      const p = path.join(dir, f);
      const st = await fsp.stat(p).catch(() => null);
      // Leave anything from the last hour alone: it may be an update in flight.
      if (st && Date.now() - st.mtimeMs > 3600_000) {
        await fsp.unlink(p).then(() => { removed++; }).catch(() => {});
      }
    }
  }
  return removed;
}

module.exports = {
  DEFAULT_MANIFEST,
  parseVersion,
  compareVersions,
  check,
  download,
  apply,
  cleanup,
  sha256File,
  stagedPath,
};
