'use strict';
/**
 * Bundled Java runtime (JRE) manager.
 *
 * Many players have no Java at all, or a 32-bit / Java 8 install that cannot run
 * 1.21.11. Rather than telling them to go install one, we fetch an official
 * Eclipse Temurin JRE from the Adoptium API, verify its SHA-256, and keep it
 * inside the launcher's own directory. Nothing is installed system-wide.
 */

const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { exists, ensureDir } = require('./installer');
const { extractArchive } = require('./zip');

const ADOPTIUM = 'https://api.adoptium.net/v3/assets/latest';
const UA = 'VoidClient/1.1.1';

/** Map Node platform/arch to Adoptium's naming. */
function adoptiumTarget() {
  const osMap = { win32: 'windows', darwin: 'mac', linux: 'linux' };
  const os = osMap[process.platform] || 'linux';
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  return { os, arch };
}

/** Query Adoptium for the newest JRE matching the target. */
async function resolveRuntime({ major = 21, os, arch } = {}) {
  const t = adoptiumTarget();
  const targetOs = os || t.os;
  const targetArch = arch || t.arch;
  const url = `${ADOPTIUM}/${major}/hotspot?architecture=${targetArch}&image_type=jre&os=${targetOs}&vendor=eclipse`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Adoptium HTTP ${res.status}`);
  const list = await res.json();
  if (!Array.isArray(list) || !list.length) {
    throw new Error(`No Temurin ${major} JRE published for ${targetOs}/${targetArch}.`);
  }
  const rel = list[0];
  const bin = rel.binary;
  return {
    release: rel.release_name,
    major,
    os: targetOs,
    arch: targetArch,
    filename: bin.package.name,
    url: bin.package.link,
    size: bin.package.size,
    sha256: bin.package.checksum,
  };
}

/** Find java(w) inside an extracted runtime tree (versioned folder or flat). */
async function locateJavaExe(dir) {
  // Accept every naming variant, not just the host's: a runtime can be resolved
  // for a target os other than the one running the launcher (and the archive
  // always decides what is really inside). Prefer javaw on Windows because it
  // spawns without a console window; plain java exists on every platform.
  const names = ['javaw.exe', 'java.exe', 'java'];
  const candidates = [
    ...names.map((n) => path.join(dir, 'bin', n)),
  ];
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    for (const n of names) candidates.push(path.join(dir, e.name, 'bin', n));
  }
  for (const c of candidates) if (await exists(c)) return c;
  return candidates[0];
}

/** Extract a runtime archive and locate the java(w) executable inside it. */
async function extractRuntime(archivePath, destDir) {
  await ensureDir(destDir);
  // Adoptium ships .zip for Windows and .tar.gz elsewhere; extractArchive
  // sniffs the magic bytes so a mislabelled file still works.
  await extractArchive(archivePath, destDir);
  // Temurin archives contain a single top-level folder (jdk-21.0.13+9-jre).
  // Ask locateJavaExe rather than assuming a name: the archive decides.
  const exe = await locateJavaExe(destDir);
  if (!(await exists(exe))) {
    throw new Error('Runtime archive extracted but no java executable was found.');
  }
  return exe;
}

/** Download + verify + extract a managed runtime. Returns the java path. */
async function installRuntime(root, { major = 21, onProgress, onLog } = {}) {
  const info = await resolveRuntime({ major });
  const dir = path.join(root, 'runtime', `jre-${info.major}`);
  // The archive contains a versioned folder (jdk-21.0.13+9-jre), so the exe is
  // not directly under dir/bin. Resolve it once and remember the real path.
  const exe = await locateJavaExe(dir);
  const marker = path.join(dir, '.complete');

  if (await exists(marker)) {
    const stored = JSON.parse(await fsp.readFile(marker, 'utf8').catch(() => '{}'));
    if (stored.release === info.release && (await exists(exe))) {
      return { path: exe, ...info, cached: true };
    }
  }

  const tmp = path.join(root, 'runtime', info.filename);
  await ensureDir(path.dirname(tmp));
  if (onLog) onLog(`Downloading Java ${info.major} runtime (${(info.size / 1048576).toFixed(0)} MB)`);

  const res = await fetch(info.url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Runtime download HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || info.size;
  let got = 0;
  const hash = crypto.createHash('sha256');
  const out = require('fs').createWriteStream(tmp);
  const body = Readable.fromWeb(res.body);
  body.on('data', (c) => { got += c.length; if (onProgress) onProgress(got, total); });
  body.on('data', (c) => hash.update(c));
  await pipeline(body, out);

  const digest = hash.digest('hex');
  if (info.sha256 && digest !== info.sha256) {
    await fsp.unlink(tmp).catch(() => {});
    throw new Error('Java runtime checksum mismatch — download rejected.');
  }

  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  const javaPath = await extractRuntime(tmp, dir);
  await fsp.unlink(tmp).catch(() => {});
  await fsp.writeFile(marker, JSON.stringify({ release: info.release, sha256: digest }));
  if (onLog) onLog(`Java ${info.major} runtime ready`);
  return { path: javaPath, ...info };
}

/** Returns the managed runtime's java path if one is already installed. */
async function managedRuntimePath(root, major = 21) {
  const dir = path.join(root, 'runtime', `jre-${major}`);
  if (!(await exists(path.join(dir, '.complete')))) return null;
  // The archive nests the JDK in a versioned folder, so resolve the real exe
  // instead of assuming bin/java sits directly under dir.
  return locateJavaExe(dir);
}

module.exports = { resolveRuntime, installRuntime, managedRuntimePath, adoptiumTarget };
