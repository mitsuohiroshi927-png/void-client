'use strict';
/**
 * Player statistics for the dashboard.
 *
 * Numbers come from the presence endpoint (server/stats.php), which the VOID FPS
 * mod beats into every 60s. The launcher only DISPLAYS what the server reports:
 * when the endpoint is unreachable or empty we show the real number (0, or the
 * local count) rather than inventing a marketing figure.
 */

const fs = require('fs');
const path = require('path');

const UA = 'VOIDClient/1.0 (+https://github.com/mitsuohiroshi927-png/void-client)';
const TIMEOUT_MS = 6000;

/** Local usage counter — how many distinct installs this launcher has seen. */
function localStatsFile(root) {
  return path.join(root, 'stats.json');
}

function readLocal(root) {
  try {
    const j = JSON.parse(fs.readFileSync(localStatsFile(root), 'utf8'));
    return {
      installId: typeof j.installId === 'string' ? j.installId : null,
      firstLaunch: Number(j.firstLaunch) || 0,
      launches: Number(j.launches) || 0,
      sessions: Array.isArray(j.sessions) ? j.sessions : [],
    };
  } catch {
    return { installId: null, firstLaunch: 0, launches: 0, sessions: [] };
  }
}

function writeLocal(root, data) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(localStatsFile(root), JSON.stringify(data, null, 2));
}

/**
 * Record one launcher start. Returns the updated local record.
 * installId is a random opaque id — no hardware fingerprint, no PII.
 */
function recordLaunch(root) {
  const now = Date.now();
  const data = readLocal(root);
  if (!data.installId) data.installId = require('crypto').randomBytes(16).toString('hex');
  if (!data.firstLaunch) data.firstLaunch = now;
  data.launches += 1;
  // Keep 90 days of session timestamps for a real "active today" figure.
  data.sessions = [...data.sessions.filter((t) => now - t < 86400e3 * 90), now];
  writeLocal(root, data);
  return data;
}

function localSummary(root) {
  const now = Date.now();
  const d = readLocal(root);
  return {
    online: 0,
    today: d.sessions.filter((t) => now - t < 86400e3).length > 0 ? 1 : 0,
    total_players: d.installId ? 1 : 0,
    total_sessions: d.launches,
    launches: d.launches,
    first_launch: d.firstLaunch,
    source: 'local',
  };
}

async function fetchJson(url, ms = TIMEOUT_MS) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Dashboard stats. Always resolves — a dead endpoint degrades to local numbers
 * with `source: 'local'` so the UI can label it honestly.
 */
async function getStats(baseUrl, root) {
  const local = localSummary(root);
  if (!baseUrl) return { ok: true, ...local };

  const url = `${String(baseUrl).replace(/\/+$/, '')}?action=stats`;
  try {
    const j = await fetchJson(url);
    if (!j || j.ok !== true) throw new Error(j && j.error ? j.error : 'bad payload');
    return {
      ok: true,
      online: Number(j.online) || 0,
      today: Number(j.today) || 0,
      total_players: Number(j.total_players) || 0,
      total_sessions: Number(j.total_sessions) || 0,
      window: Number(j.window) || 120,
      launches: local.launches,
      source: 'server',
    };
  } catch (e) {
    return { ok: true, ...local, error: e.message };
  }
}

/**
 * Beat presence from the launcher itself, for people who use the launcher but
 * are not in-game (lobby time still counts as "using the client").
 * Best-effort: never throws, never blocks the UI.
 */
async function sendHeartbeat(baseUrl, payload) {
  if (!baseUrl) return { ok: false, skipped: true };
  const url = `${String(baseUrl).replace(/\/+$/, '')}?action=heartbeat`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(t);
  }
}

module.exports = { recordLaunch, localSummary, getStats, sendHeartbeat };
