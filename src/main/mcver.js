'use strict';
/**
 * Minecraft version matching for a mod's declared dependency range.
 *
 * The launcher decides whether to attach the bundled VOID Client jar, and that
 * decision has to agree with what the jar itself says. It used to be a hand-rolled
 * version table in launch.js: it allowed every year-based release (26.x, 27.x)
 * while the jar declares `minecraft: "1.21.11"` — so Fabric was handed a jar it
 * refuses to load, and the user got a boot error instead of a working mod.
 *
 * Supported declaration forms (everything shipped so far uses the first two):
 *   1.21.11               exact
 *   >=1.21.11 <1.22       whitespace- or comma-separated comparators
 *   [1.21.11,1.22)        Maven bracket range
 *   >=1.21.11             open-ended
 *   1.21.x / 1.21.*       any patch of that series
 *   *                     anything
 *
 * satisfies() returns null — not false — when the declaration cannot be parsed, so
 * callers can decide how loud to be instead of silently guessing.
 */

/** Numeric parts of a version, plus whether it carries a pre-release suffix. */
function parseVersion(value) {
  const raw = String(value == null ? '' : value).trim();
  // Build metadata (+build.6) never affects ordering; a pre-release (-rc1) does.
  const core = raw.split('+')[0];
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-(.*))?$/.exec(core);
  if (!m) return null;
  return {
    // Padding keeps 1.21 and 1.21.0 equal, which is what people mean by them.
    parts: [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)],
    prerelease: Boolean(m[4] && m[4].length),
    raw,
  };
}

/** -1 / 0 / 1, with a pre-release sorting below its release. */
function compare(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a.parts[i] !== b.parts[i]) return a.parts[i] < b.parts[i] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  return a.prerelease ? -1 : 1;
}

function oneConstraint(token, actual) {
  // Maven bracket range: [1.21.11,1.22) — a square bracket is inclusive on that side.
  if (/^[[(]/.test(token) && /[\])]$/.test(token)) {
    const m = /^[[(]\s*([^,[\]()]+)\s*,\s*([^,[\]()]+)\s*[\])]$/.exec(token);
    if (!m) return null;
    const low = parseVersion(m[1]);
    const high = parseVersion(m[2]);
    if (!low || !high) return null;
    const okLow = token.startsWith('[') ? compare(actual, low) >= 0 : compare(actual, low) > 0;
    const okHigh = token.endsWith(']') ? compare(actual, high) <= 0 : compare(actual, high) < 0;
    return okLow && okHigh;
  }

  const cmp = /^(>=|<=|==|=|>|<)\s*(.+)$/.exec(token);
  if (cmp) {
    const bound = parseVersion(cmp[2]);
    if (!bound) return null;
    const d = compare(actual, bound);
    switch (cmp[1]) {
      case '>=': return d >= 0;
      case '<=': return d <= 0;
      case '>': return d > 0;
      case '<': return d < 0;
      default: return d === 0;
    }
  }

  // A trailing .x / .* wildcard means "any patch release of that series".
  const series = /^(\d+(?:\.\d+)*)\.[xX*]$/.exec(token);
  if (series) {
    const nums = series[1].split('.').map(Number);
    for (let i = 0; i < nums.length; i++) {
      if (actual.parts[i] !== nums[i]) return false;
    }
    return true;
  }

  const exact = parseVersion(token);
  if (!exact) return null;
  return compare(actual, exact) === 0;
}

/**
 * Does `actual` satisfy the range `declared`?
 * true / false, or null when the declaration could not be understood.
 */
function satisfies(declared, actual) {
  const spec = String(declared == null ? '' : declared).trim();
  const version = parseVersion(actual);
  if (!version) return null;
  if (!spec || spec === '*') return true;
  // A bracket range is ONE token — its comma is part of the syntax, so the comma
  // split below must not see it. A list of several bracket ranges (a union) is not
  // supported and comes back as null rather than as a wrong answer.
  const tokens = /^[[(].*[\])]$/.test(spec) ? [spec] : spec.split(/[\s,]+/).filter(Boolean);
  if (!tokens.length) return true;
  let verdict = true;
  for (const token of tokens) {
    const ok = oneConstraint(token, version);
    if (ok === null) return null;
    if (!ok) verdict = false;
  }
  return verdict;
}

/** Convenience for a fabric.mod.json `depends` block: true only when satisfied. */
function satisfiesMinecraft(declared, actual) {
  return satisfies(declared, actual) === true;
}

module.exports = { satisfies, satisfiesMinecraft, parseVersion, compare };
