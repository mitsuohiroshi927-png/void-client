'use strict';
/**
 * Crash detector — turns a dead game (or a dead launcher) into a short,
 * English, actionable message instead of a silent exit or a raw stack trace.
 *
 * Pure logic lives here so verify_launcher.js can exercise it; the only I/O is
 * reading crash reports and log tails.
 */

const fs = require('fs');
const path = require('path');

/**
 * Exit codes that mean "the game ended on its own terms": a clean quit (0) and
 * the two graceful stops a user or shutdown may deliver (130 SIGINT, 143
 * SIGTERM). Anything else — or any unhandled signal — is a crash.
 */
const CLEAN_CODES = new Set([0, 130, 143]);

/**
 * Stack frames that name a mod we recognize. Everything modpack-ish maps to a
 * human phrase; unknown frames stay "unknown" rather than a wrong guess.
 */
const KNOWN_FRAMES = [
  { rx: /\bid\.agung\.voidfps\b/, mod: 'VOID Client (the bundled mod)' },
  { rx: /\bme\.jellysquid\.mods\.sodium\b|\bsodium\b/i, mod: 'Sodium' },
  { rx: /\bnet\.coderbot\.iris\b|\biris\b/i, mod: 'Iris' },
  { rx: /\bme\.zeroeightsix\.lithium\b|\blithium\b/i, mod: 'Lithium' },
  { rx: /\bnet\.fabricmc\b/, mod: 'Fabric Loader / Fabric API' },
];

/**
 * True when the game process ended in a way the player did not ask for.
 * `killedByLauncher` suppresses the report for the launcher's own STOP button.
 * `code === null` means the process died without an exit code we could read
 * (spawn error territory) — the launcher surfaces that separately as a launch
 * failure, not a game crash.
 */
function isCrashExit(code, signal, { killedByLauncher = false } = {}) {
  if (killedByLauncher) return false;
  if (signal) return true;
  if (code === null || code === undefined) return false;
  return !CLEAN_CODES.has(code);
}

/** Newest crash report written after `sinceMs` (when this game session began). */
function latestCrashReport(dir, sinceMs = 0) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const hits = names
    .filter((f) => f.startsWith('crash-') && f.endsWith('.txt'))
    .map((f) => {
      const full = path.join(dir, f);
      try {
        const st = fs.statSync(full);
        return st.isFile() ? { full, mtime: st.mtimeMs } : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((e) => e.mtime >= sinceMs)
    .sort((a, b) => b.mtime - a.mtime);
  return hits.length ? hits[0].full : null;
}

/** Last `maxBytes` of a text file, or '' when it cannot be read. */
function tailText(file, maxBytes = 16384) {
  try {
    const st = fs.statSync(file);
    const size = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(size);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buf, 0, size, st.size - size);
    } finally {
      fs.closeSync(fd);
    }
    return buf.toString('utf8').replace(/\u0000/g, '');
  } catch {
    return '';
  }
}

/** What broke, from a crash report body. Returns a one-line human phrase. */
function describe(text) {
  const dm = text.match(/^Description: (.+)$/m);
  if (dm) return dm[1].trim();
  const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
  for (const line of lines) {
    if (/---- Minecraft Crash Report ----/.test(line)) continue;
    if (line.startsWith('//')) continue;
    return line;
  }
  return '';
}

/** The main exception line (`…Exception: message` / `…Error: message`). */
function exceptionLine(text) {
  const m = text.match(/^([\w.$]+(?:Exception|Error)[^\r\n]*)$/m);
  return m ? m[1].trim() : '';
}

/**
 * Mods the crash names as MISSING (Fabric resolution failures). Matches the
 * two real shapes a 1.21 crash report takes:
 *   - "Missing mods: [sodium, iris]"
 *   - "Mod 'X' requires ... mod 'Y'" (dependency chains)
 * Returns lowercase slugs suitable for a Modrinth search, or [].
 */
function missingMods(text) {
  if (!text) return [];
  const out = [];
  const push = (v) => {
    const slug = String(v || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (slug && slug.length > 2 && !out.includes(slug)) out.push(slug);
  };
  for (const m of text.matchAll(/Missing mods?:? ?\[([^\]]+)\]/gi)) {
    for (const part of m[1].split(',')) push(part);
  }
  for (const m of text.matchAll(/requires\s*[\n\r]?\s*(?:-\s*)?(?:mod|library)\s*'([^']+)'/gi)) push(m[1]);
  for (const m of text.matchAll(/Mod '([^']+)' requires/gi)) {
    // multi-line dependency block after this line: also scan for '- mod' bullets
    const tail = text.slice(m.index, m.index + 900);
    for (const d of tail.matchAll(/-\s*(?:mod|library)\s*'([^']+)'/gi)) push(d[1]);
  }
  return out.slice(0, 6); // cap: a resolution dump never names more than a handful
}

/** Best-effort suspect: a KNOWN_FRAMES hit, else ''. */
function suspectedMod(text) {
  const hit = KNOWN_FRAMES.find((f) => f.rx.test(text));
  return hit ? hit.mod : '';
}

/**
 * Build the message the launcher shows. `steps` is the part that matters:
 * every crash must leave the user knowing what to do next. Input is optional —
 * a crash with no report file still yields the exit-code basics plus defaults.
 */
function summarize({ code = null, signal = null, reportText = '', logTail = '', reportFile = '' } = {}) {
  const detail = (reportText && (describe(reportText) || exceptionLine(reportText))) ||
    (signal ? `Process killed by ${signal}` : `Exit code ${code}`);
  const suspect = reportText ? suspectedMod(reportText) : '';
  const missing = reportText ? missingMods(reportText) : [];
  if (missing.length) {
    steps.push('The game is missing mods it needs — the button below installs them, then press RELAUNCH.');
  }

  const steps = [];
  if (reportText) steps.push(`Open the crash report for the full details (saved at ${reportFile}).`);
  else steps.push('No crash report was written — check the game log for the last lines before it died.');
  if (/out of memory|OutOfMemoryError|ran out of memory/i.test(reportText + ' ' + logTail)) {
    steps.push('The game ran out of memory: lower the memory allocation in Settings → Memory, then launch again.');
  } else if (/OpenGL|GL_INVALID|gpu|graphics/i.test(detail)) {
    steps.push('This looks graphics-related: update your GPU drivers, and try turning VSync off in the game options.');
  }
  if (suspect) {
    steps.push(`The stack trace names ${suspect} — remove or update it in Mods, then launch again.`);
  } else {
    steps.push('If it crashes again right away: enable Safe mode in Settings (disables VOID extras and extra mods) and try once more.');
  }
  if (!reportText) {
    steps.push('If it went away on its own, just press PLAY to relaunch.');
  } else {
    steps.push('Press RELAUNCH to start the game again — crashes are often one-off.');
  }

  return {
    title: 'Minecraft crashed',
    detail,
    suspect,
    missing,
    steps,
    reportFile: reportFile || '',
  };
}

/** Copyable plain-text block: everything the modal shows, for a bug report. */
function toText(s, extra = {}) {
  const lines = [
    'VOID Client crash report',
    extra.version ? `Launcher version: ${extra.version}` : null,
    s.detail ? `What broke: ${s.detail}` : null,
    s.suspect ? `Suspect: ${s.suspect}` : null,
    s.reportFile ? `Crash report: ${s.reportFile}` : null,
    '',
    'What to do next:',
    ...s.steps.map((x, i) => `  ${i + 1}. ${x}`),
  ];
  return lines.filter((x) => x !== null).join('\n');
}

module.exports = {
  CLEAN_CODES,
  isCrashExit,
  latestCrashReport,
  tailText,
  describe,
  exceptionLine,
  suspectedMod,
  missingMods,
  summarize,
  toText,
};
