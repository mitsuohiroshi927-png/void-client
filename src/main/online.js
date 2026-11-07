/**
 * Online counter (Modrinth-style): "N people online right now".
 *
 * Privacy contract — the entire payload is a one-way SHA-256 of
 * (today's date salt + a random install id). No account, no username, no
 * hardware fingerprint, no IP use. The salt turns over daily, so a hash can
 * never be tracked across days and the "seen total" is per-day distinct.
 *
 * The user can turn the whole thing off in Settings (onlineOptOut, default
 * false = share the anonymous ping — it is the number every other launcher
 * shows by default and the point of the feature).
 */
'use strict';

const { net } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BEAT_MS = 3 * 60 * 1000; // server window is 5 min; beat well inside it

/* One HTTPS front serves both verbs: POST = ping, GET = count (the Pages
 * function forwards to the presence daemon on the origin box). */
const ENDPOINT = 'https://voidclient.my.id/api/online';
const FALLBACK_ENDPOINTS = ['https://void-client-c8q.pages.dev/api/online'];

/* The counter is best-effort: try the primary front, then the mirrors. */
function endpoints(url) {
  const list = [];
  if (url) list.push(url);
  list.push(ENDPOINT, ...FALLBACK_ENDPOINTS);
  return list.filter((u, i) => list.indexOf(u) === i);
}

let timer = null;

/* The install id: a random UUID persisted in userData. Random and local —
 * regeneration on file loss is fine, presence has no continuity requirements. */
function ensureInstallId(userData) {
  const file = path.join(userData, 'online-id');
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { /* first run */ }
  const id = crypto.randomUUID();
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(file, id, 'utf8');
  return id;
}

/* One-way, day-salted fingerprint: sha256("<YYYY-MM-DD>:<id>") as hex. */
function dailyHash(installId, now = new Date()) {
  const salt = now.toISOString().slice(0, 10);
  return crypto.createHash('sha256').update(`${salt}:${installId}`).digest('hex');
}

async function ping(url, h) {
  const body = JSON.stringify({ h });
  for (const endpoint of endpoints(url)) {
    const ok = await new Promise((resolve) => {
      const req = net.request({ method: 'POST', url: endpoint.replace(/\/+$/, '') });
      req.setHeader('content-type', 'application/json');
      const t = setTimeout(() => { req.destroy(); resolve(false); }, 8000);
      req.on('response', (res) => {
        res.resume();
        clearTimeout(t);
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      });
      req.on('error', () => { clearTimeout(t); resolve(false); });
      req.end(body);
    });
    if (ok) return true;
  }
  return false;
}

async function count(url) {
  for (const endpoint of endpoints(url)) {
    const data = await new Promise((resolve) => {
      const req = net.request({ method: 'GET', url: endpoint.replace(/\/+$/, '') });
      const t = setTimeout(() => { req.destroy(); resolve(null); }, 8000);
      req.on('response', (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          clearTimeout(t);
          try {
            const j = JSON.parse(body);
            resolve({ online: Number(j.online) || 0, total: Number(j.total) || 0 });
          } catch { resolve(null); }
        });
      });
      req.on('error', () => { clearTimeout(t); resolve(null); });
      req.end();
    });
    if (data) return data;
  }
  throw new Error('All online-count fronts failed');
}

/* Cadence: one ping while the app runs. Returns a stop function. */
function start(getUrl, getHash) {
  const beat = () => {
    const url = getUrl();
    const h = getHash();
    if (!url || !h) return;
    ping(url, h).catch(() => {}); // presence is best-effort by design
  };
  beat();
  timer = setInterval(beat, BEAT_MS);
  return () => { if (timer) { clearInterval(timer); timer = null; } };
}

module.exports = { ensureInstallId, dailyHash, ping, count, start, BEAT_MS, ENDPOINT };
