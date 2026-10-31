'use strict';
/**
 * Hardware detection + adaptive tuning.
 *
 * Goal: the launcher must not assume a gaming PC. Everything here degrades
 * gracefully — if a probe fails (no WMIC, no lspci, container, no GPU), we fall
 * back to conservative defaults rather than throwing.
 *
 * Probes are cheap and non-blocking on a failed lookup: every external command
 * has a short timeout and its failure is a valid outcome.
 */

const { execFile } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

function run(cmd, args, timeout = 4000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        // `java -version` writes to stderr, so a non-zero exit or empty stdout is
        // not a failure by itself — return whatever was produced.
        resolve(String(stdout || '') + String(stderr || ''));
      });
    } catch {
      resolve('');
    }
  });
}

function mbToGb(v) {
  return Math.round((v / 1024) * 10) / 10;
}

/** Total physical RAM in MB, cross-platform. */
async function detectRamMB() {
  const total = os.totalmem() / (1024 * 1024);
  if (total > 0) return Math.round(total);
  return 4096;
}

/** CPU name + core counts. */
async function detectCpu() {
  const cpus = os.cpus() || [];
  const model = (cpus[0] && cpus[0].model ? cpus[0].model : 'Unknown CPU').trim();
  return {
    model,
    physical: Math.max(1, Math.round(cpus.length / 2) || cpus.length), // SMT estimate
    logical: Math.max(1, cpus.length),
    arch: process.arch,
    // A very rough capability tier used only for choosing safe defaults.
    lowEnd: cpus.length <= 4 || /celeron|pentium|athlon|atom|e-?series/i.test(model),
  };
}

/** GPU name, VRAM (MB), vendor — best effort per platform. */
async function detectGpu() {
  const result = { name: 'Unknown GPU', vramMB: 0, vendor: 'unknown', integrated: false };

  if (process.platform === 'win32') {
    const out = await run('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion | ConvertTo-Json -Compress',
    ]);
    try {
      let parsed = JSON.parse(out.trim() || 'null');
      if (Array.isArray(parsed)) {
        // Prefer the discrete card with the most reported VRAM.
        parsed.sort((a, b) => (b.AdapterRAM || 0) - (a.AdapterRAM || 0));
        parsed = parsed[0];
      }
      if (parsed && parsed.Name) {
        result.name = parsed.Name;
        result.vramMB = Math.round((parsed.AdapterRAM || 0) / (1024 * 1024));
        result.driver = parsed.DriverVersion || '';
      }
    } catch { /* keep defaults */ }
  } else if (process.platform === 'darwin') {
    const out = await run('system_profiler', ['SPDisplaysDataType', '-json']);
    try {
      const j = JSON.parse(out || '{}');
      const g = (j.SPDisplaysDataType || [])[0] || {};
      result.name = g.sppci_model || g._name || 'Apple GPU';
      result.vramMB = parseInt(String(g.spdisplays_vram || '0'), 10) || 0;
    } catch { /* keep defaults */ }
  } else {
    // Linux: try lspci, then glxinfo, then sysfs — any one may be missing
    // (containers, minimal images). Failure here is normal, not an error.
    const out = await run('lspci', []);
    const line = out.split('\n').find((l) => /VGA|3D controller|Display/i.test(l));
    if (line) {
      result.name = line.split(':').slice(-1)[0].trim();
      const v = line.match(/(\d+)(MB|GB)\b/i);
      if (v) result.vramMB = v[2].toUpperCase() === 'GB' ? +v[1] * 1024 : +v[1];
    }
    if (result.name === 'Unknown GPU') {
      const gl = await run('glxinfo', ['-B']);
      const m = gl.match(/Device:\s*(.+)/i);
      if (m) result.name = m[1].trim();
    }
    if (result.name === 'Unknown GPU') {
      try {
        const cards = fs.readdirSync('/sys/class/drm').filter((d) => /^card\d+$/.test(d));
        for (const c of cards) {
          const uevent = fs.readFileSync(`/sys/class/drm/${c}/device/uevent`, 'utf8');
          const drv = (uevent.match(/DRIVER=(.+)/) || [])[1];
          if (drv) { result.name = `${drv} GPU`; result.kernelDriver = drv; break; }
        }
      } catch { /* no sysfs drm */ }
    }
  }

  // Heuristics: nothing here is authoritative, it only picks a default profile.
  const n = (result.name || '').toLowerCase();
  result.integrated = /intel|uhd|iris|vega|radeon graphics|apple m\d|mesa|llvmpipe|swiftshader|basic render/i.test(n);
  result.softwareRenderer = /llvmpipe|swiftshader|basic render|microsoft basic/i.test(n);
  if (/nvidia|geforce|rtx|gtx|quadro/i.test(n)) result.vendor = 'nvidia';
  else if (/amd|radeon|rx \d/i.test(n)) result.vendor = 'amd';
  else if (/intel/i.test(n)) result.vendor = 'intel';
  else if (/apple/i.test(n)) result.vendor = 'apple';

  return result;
}

/** Installed Java version at a given path, or null. */
async function javaAt(p) {
  const candidates = p ? [p] : process.platform === 'win32' ? ['javaw', 'java'] : ['java'];
  for (const c of candidates) {
    const out = await run(c, ['-version'], 6000);
    if (!out) continue;
    const m = out.match(/version "?(\d+)(?:\.(\d+))?/);
    if (!m) continue;
    const major = m[1] === '1' ? parseInt(m[2], 10) : parseInt(m[1], 10);
    const bits = /64-Bit/i.test(out) ? 64 : /32-Bit/i.test(out) ? 32 : null;
    const vendor = /Temurin|Adoptium/i.test(out) ? 'temurin'
      : /GraalVM/i.test(out) ? 'graal'
      : /Zulu/i.test(out) ? 'zulu'
      : /Microsoft/i.test(out) ? 'microsoft'
      : /OpenJDK/i.test(out) ? 'openjdk'
      : 'unknown';
    const suitable = (major >= 21) && bits !== 32;
    return { path: c, major, bits, vendor, suitable, raw: out.trim().split('\n')[0] };
  }
  return null;
}

/** Scan common JVM install locations so users don't have to browse. */
async function findJavaRuntimes() {
  const found = [];
  const push = (p) => { if (p && !found.some((f) => f.path === p)) found.push({ path: p }); };

  const sys = await javaAt('java');
  if (sys) push(sys.path);

  if (process.platform === 'win32') {
    for (const base of [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Java'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Java'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Eclipse Adoptium'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'jdk'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Eclipse Adoptium'),
    ]) {
      try {
        for (const d of fs.readdirSync(base)) {
          const exe = path.join(base, d, 'bin', 'javaw.exe');
          if (fs.existsSync(exe)) push(exe);
          const exe2 = path.join(base, d, 'bin', 'java.exe');
          if (fs.existsSync(exe2)) push(exe2);
        }
      } catch { /* directory absent */ }
    }
  } else if (process.platform === 'darwin') {
    const jvms = '/Library/Java/JavaVirtualMachines';
    try {
      for (const d of fs.readdirSync(jvms)) {
        const exe = path.join(jvms, d, 'Contents', 'Home', 'bin', 'java');
        if (fs.existsSync(exe)) push(exe);
      }
    } catch { /* absent */ }
  } else {
    for (const base of ['/usr/lib/jvm', '/usr/java', path.join(os.homedir(), '.sdkman', 'candidates', 'java')]) {
      try {
        for (const d of fs.readdirSync(base)) {
          const exe = path.join(base, d, 'bin', 'java');
          if (fs.existsSync(exe)) push(exe);
        }
      } catch { /* absent */ }
    }
  }

  const detailed = [];
  for (const f of found) {
    const info = await javaAt(f.path);
    if (info) detailed.push(info);
  }
  // Only 21+ can run 1.21.11; surface them first but keep others visible.
  detailed.sort((a, b) => (b.major || 0) - (a.major || 0));
  return detailed;
}

/**
 * Select a Minecraft-appropriate runtime.
 * 1.21.11 needs Java 21+. We never silently pick a 32-bit or pre-17 JVM.
 */
async function pickRuntime(preferred) {
  if (preferred) {
    const info = await javaAt(preferred);
    if (info) return { ...info, source: 'custom', suitable: info.major >= 21 && info.bits !== 32 };
    return null;
  }
  const all = await findJavaRuntimes();
  const good = all.find((j) => j.major >= 21 && j.bits !== 32);
  if (good) return { ...good, source: 'system', suitable: true };
  const any = all[0];
  if (any) return { ...any, source: 'system', suitable: false };
  return null;
}

/**
 * Derive safe JVM settings for the detected machine.
 * Rules chosen so that a 4 GB laptop never gets an 8 GB heap and never gets a
 * heap so small that 1.21.11 GC-thrashes.
 */
function tuneForHardware(hw) {
  const ramMB = hw.ramMB;
  const gpu = hw.gpu;
  const cpu = hw.cpu;

  // Heap: reserve ~2 GB for the OS + whatever else runs. Cap at 8 GB — beyond
  // that Minecraft's G1 collector gets worse, not better, on client-side play.
  const reserved = ramMB <= 8192 ? 2048 : 3072;
  let heap = Math.floor((ramMB - reserved) / 512) * 512;
  heap = Math.max(2048, Math.min(heap, 8192));
  if (ramMB < 4096) heap = 1536; // sub-4 GB machines: small heap, rely on VOID FPS

  // Resolution: never preselect 4K on weak hardware.
  const weakGpu = gpu.integrated || gpu.softwareRenderer || (gpu.vramMB > 0 && gpu.vramMB < 2048);
  let width = 1280;
  let height = 720;
  if (gpu.softwareRenderer || ramMB < 4096) { width = 854; height = 480; }
  else if (weakGpu) { width = 1280; height = 720; }
  else if (!gpu.integrated && gpu.vramMB >= 4096) { width = 1600; height = 900; }

  // GC: G1 is correct for every modern client. Only tune the pause target.
  const gcPause = weakGpu || cpu.lowEnd ? 75 : 50;

  return {
    ramMB: heap,
    width,
    height,
    gcPause,
    jvmArgs: [
      '-XX:+UseG1GC',
      '-XX:+ParallelRefProcEnabled',
      `-XX:MaxGCPauseMillis=${gcPause}`,
      '-XX:+DisableExplicitGC',
      '-XX:G1NewSizePercent=20',
      '-XX:G1ReservePercent=20',
      '-XX:G1HeapRegionSize=8M',
      // Prevent the client from hogging focus / crashing on odd DPI setups.
      '-Dfile.encoding=UTF-8',
    ],
    tier: gpu.softwareRenderer || ramMB < 4096 ? 'low' : weakGpu || cpu.lowEnd ? 'medium' : 'high',
  };
}

/** Full hardware report + recommendation. Never throws. */
async function probe() {
  const [ramMB, cpu, gpu] = await Promise.all([detectRamMB(), detectCpu(), detectGpu()]);
  const hw = { ramMB, ramGb: mbToGb(ramMB), cpu, gpu, os: { platform: process.platform, arch: process.arch, release: os.release() } };
  const tuned = tuneForHardware(hw);
  const runtime = await pickRuntime('');
  // Hoist the tier to the top level: the UI reads report.tier directly, and the
  // recommendation is only meaningful together with the RAM/CPU/GPU snapshot.
  return { ...hw, tier: tuned.tier, tuned, runtime, is64bit: process.arch === 'x64' || process.arch === 'arm64' };
}

module.exports = {
  probe,
  detectRamMB,
  detectCpu,
  detectGpu,
  tuneForHardware,
  javaAt,
  findJavaRuntimes,
  probeJava: javaAt,
  pickRuntime,
};
