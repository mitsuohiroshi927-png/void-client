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
 *     "version": "1.2.3",
 *     "notes": "What changed",
 *     "url": "https://.../VOID-Client-1.2.3-Setup.exe",
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
const { once } = require('events');
const { spawn } = require('child_process');
const { app, shell } = require('electron');

// Separate from the mod's update.json on purpose — see settings.js updateUrl.
const DEFAULT_MANIFEST = 'https://mitsuohiroshi927-png.github.io/void-client/launcher.json';
// If the project site is down or the manifest is malformed there, fall back to Releases
// rather than reporting "no update" — a dead feed must not strand every installed copy.
const FALLBACK_MANIFEST = 'https://github.com/mitsuohiroshi927-png/void-client/releases/latest/download/launcher.json';
const UA = 'VoidClient (launcher; +https://github.com/mitsuohiroshi927-png/void-client)';
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
  // Candidate list, primary first. Every entry is checked against the same sha256, so a
  // mirror can only ever be accepted if it serves byte-identical bytes.
  const list = (entry) => {
    if (!entry) return [];
    const seen = new Set();
    const out = [];
    for (const u of [entry.url, entry.primary, entry.mirror, ...(entry.urls || [])]) {
      if (typeof u === 'string' && u && !seen.has(u)) { seen.add(u); out.push(u); }
    }
    return out;
  };
  if (plat && (plat.url || plat.primary)) {
    return {
      url: plat.url || plat.primary,
      urls: list(plat),
      sha256: plat.sha256 || manifest.sha256 || '',
      size: plat.size || manifest.size || 0,
    };
  }
  // Only one platform present that isn't ours: that entry is still the right
  // answer. Without this, a win32-only manifest on any other host yields an
  // empty asset, and the UI reports "update available" with nothing to fetch.
  const keys = manifest.platforms ? Object.keys(manifest.platforms) : [];
  if (keys.length === 1) {
    const only = manifest.platforms[keys[0]];
    if (only && (only.url || only.primary || (only.urls && only.urls.length))) {
      return {
        url: only.url || only.primary || (only.urls || [])[0] || '',
        urls: list(only),
        sha256: only.sha256 || manifest.sha256 || '',
        size: only.size || manifest.size || 0,
      };
    }
  }
  return {
    url: manifest.url || manifest.primary || '',
    urls: list(manifest),
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
  const me = current || '0.0.0';
  // Primary feed first (the project site), then the fallback. A single unreachable or
  // malformed feed must not look like "you're up to date" — that would silently strand
  // every installed copy on an old build.
  const feeds = [];
  const push = (u) => { if (u && !feeds.includes(u)) feeds.push(u); };
  push(manifestUrl);
  push(DEFAULT_MANIFEST);
  push(FALLBACK_MANIFEST);

  let manifest = null;
  let source = '';
  let lastError = '';
  for (const url of feeds) {
    try {
      const m = await fetchJson(url, timeout);
      if (m && m.version) { manifest = m; source = url; break; }
      lastError = lastError || 'Update manifest is missing a version field';
    } catch (e) {
      lastError = e.message;
    }
  }
  if (!manifest) {
    return { ok: false, error: `Could not reach the update server (${lastError})`, current: me };
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
    urls: asset.urls,
    sha256: asset.sha256,
    size: asset.size,
    // Which feed answered — useful when the site is down and Releases took over.
    source,
    // Optional small hot-swap payload (app code only). Its absence keeps the
    // flow on the full installer with zero behavior change.
    hot: manifest.hot && manifest.hot.sha256 && Number(manifest.hot.size) > 0
      ? { url: manifest.hot.url, urls: manifest.hot.urls, sha256: manifest.hot.sha256, size: manifest.hot.size }
      : null,
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

/** Same idea for the hot-swap payload (app.asar + vendor jar), much smaller. */
function hotStagedPath(version) {
  return path.join(os.tmpdir(), `VOID-Client-${version}-hot.tar.gz`);
}

/**
 * One download attempt against one URL. Throws on truncation or hash mismatch so
 * download() can move on to the next candidate — a bad mirror must never be run.
 *
 * Writes honour backpressure: a 122 MB installer streamed without waiting for
 * 'drain' buffers the whole file in RAM. On any failure the file handle is closed
 * before rethrowing, so a retry cannot leak a descriptor per attempt.
 */
async function downloadOnce({ url, tmp, sha256, onProgress, signal }) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  // content-length is the ON-THE-WIRE size. When the response is content-encoded the
  // decoded body is longer, so comparing the two would report a bogus truncation and
  // reject a perfectly good installer. The length check only applies to an identity
  // response; the sha256 gate below still runs either way.
  const encoded = !!res.headers.get('content-encoding');

  const out = fs.createWriteStream(tmp);
  let got = 0;
  let lastTick = 0;

  const write = async (chunk) => {
    if (!out.write(chunk)) await once(out, 'drain');
  };

  try {
    const reader = res.body.getReader ? res.body.getReader() : null;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await write(Buffer.from(value));
        got += value.length;
        const now = Date.now();
        if (onProgress && now - lastTick > 200) {
          lastTick = now;
          onProgress({ got, total, pct: total ? Math.round((got / total) * 100) : 0 });
        }
      }
    } else {
      for await (const chunk of res.body) {
        await write(chunk);
        got += chunk.length;
      }
    }
    await new Promise((r) => out.end(r));
  } catch (e) {
    out.destroy();
    await new Promise((r) => out.once('close', r));
    throw e;
  }

  if (!encoded && total && got !== total) {
    throw new Error(`Download truncated (${got} of ${total} bytes)`);
  }
  if (sha256) {
    const actual = await sha256File(tmp);
    if (actual.toLowerCase() !== String(sha256).toLowerCase()) {
      throw new Error('Downloaded installer failed its SHA-256 check — refusing to run it');
    }
  }
  return got;
}

/**
 * Download the installer, trying each candidate URL in order.
 *
 * `urls` exists because the installer is mirrored (own site + GitHub Releases). A mirror
 * that is down must not block an update, and every attempt still has to pass the SHA-256
 * gate — a fallback is a second chance, not a weaker check.
 */
async function download({ version, url, urls, sha256, onProgress, staged } = {}) {
  const candidates = (Array.isArray(urls) && urls.length ? urls : [url]).filter(Boolean);
  if (!candidates.length) return { ok: false, error: 'Update manifest has no download URL' };
  const dest = staged || stagedPath(version || 'update');
  const tmp = `${dest}.part`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10 * 60 * 1000);
  let lastError = null;

  for (const candidate of candidates) {
    try {
      const got = await downloadOnce({ url: candidate, tmp, sha256, onProgress, signal: ctrl.signal });
      // Only now does the file get its real name, so a .part leftover can never be
      // mistaken for a verified installer.
      await fsp.rename(tmp, dest);
      // Clear BEFORE returning: leaving the 10-minute abort timer armed keeps the
      // Electron main process (and the event loop) alive long after the update is
      // staged, so the app cannot quit cleanly.
      clearTimeout(timer);
      return { ok: true, file: dest, bytes: got, verified: !!sha256, from: candidate };
    } catch (e) {
      lastError = e;
      await fsp.unlink(tmp).catch(() => {});
      // A cancel is deliberate; don't burn the mirror list on it.
      if (e.name === 'AbortError') break;
    }
  }

  clearTimeout(timer);
  return { ok: false, error: lastError ? lastError.message : 'Download failed' };
}

/**
 * Modrinth-style update: swap only the app code (app.asar + the vendored jar),
 * not the 122 MB shell. The payload is a tar.gz extracted into the resources
 * directory. An AppImage is read-only, so there hot swaps are refused up front
 * and the caller falls back to the full download.
 *
 * The swap itself happens AFTER this process exits: a running Electron keeps
 * app.asar open, so swapping now could fail with a locked file. We stage the
 * payload next to the target and hand the replacement to a tiny detached
 * script that waits a moment, moves files, and starts the app again.
 */
async function applyHot({ file } = {}) {
  // Platform capability first: an AppImage or dev run can never hot-swap, no
  // matter what was staged. Only then does the staged file need to exist.
  if (process.env.APPIMAGE) {
    return { ok: false, reason: 'appimage', error: 'AppImage updates need the full download' };
  }
  if (!app.isPackaged) {
    return { ok: false, reason: 'dev', error: 'Hot-swap applies to installed builds only' };
  }
  if (!file) return { ok: false, error: 'No hot-swap payload staged' };
  if (!(await fsp.access(file).then(() => true).catch(() => false))) {
    return { ok: false, error: 'The hot-swap payload is gone' };
  }
  // Electron keeps app.asar open while we run, so the move must happen after
  // this process exits. Stage the payload now, then hand over to a detached
  // script: wait, replace, clean up, start the new build. The payload's
  // SHA-256 was already verified at download time.
  const res = process.resourcesPath;
  const staging = path.join(res, 'update-staging');
  await fsp.mkdir(staging, { recursive: true });
  try {
    await new Promise((resolve, reject) => {
      const p = spawn('tar', ['-xzf', file, '-C', staging], { stdio: 'ignore' });
      p.on('error', (e) => reject(new Error(`Extraction failed: ${e.message}`)));
      p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`Extraction failed (exit ${c})`))));
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (!fs.existsSync(path.join(staging, 'app.asar'))) {
    return { ok: false, error: 'The payload did not contain app.asar' };
  }
  const exe = process.execPath;
  let swap;
  if (process.platform === 'win32') {
    const bat = [
      '@echo off',
      'timeout /t 2 /nobreak >nul',
      `copy /y "%~dp0app.asar" "%~1\\app.asar" >nul`,
      `xcopy /e /y /i "%~dp0vendor" "%~1\\vendor" >nul`,
      'cd /d "%~1"',
      'rmdir /s /q "%~dp0"',
      `start "" "%~2"`,
      '',
    ].join('\r\n');
    swap = path.join(staging, 'swap.bat');
    await fsp.writeFile(swap, bat, 'utf8');
    spawn('cmd', ['/c', swap, res, exe], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else {
    const sh = [
      '#!/bin/sh',
      'sleep 2',
      'cp -f "$1/app.asar" "$2/app.asar"',
      'cp -a "$1/vendor/." "$2/vendor/"',
      'rm -rf "$1"',
      'exec "$3"',
      '',
    ].join('\n');
    swap = path.join(staging, 'swap.sh');
    await fsp.writeFile(swap, sh, 'utf8');
    await fsp.chmod(swap, 0o755);
    spawn('/bin/sh', [swap, staging, res, exe], { detached: true, stdio: 'ignore' }).unref();
  }
  // The swap script takes over from here: quitting now lets it replace files
  // and start the new build within seconds — Modrinth-style, no full installer.
  return { ok: true, hotSwapped: true, file };
}


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
    if (/^VOID-Client-.*-(Setup\.exe|-hot\.tar\.gz)(\.part)?$/i.test(f)) {
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
  applyHot,
  hotStagedPath,
  cleanup,
  sha256File,
  stagedPath,
};
