/**
 * Pages Function: /api/online — HTTPS front for the presence server.
 *
 *   POST /api/online   {"h": "<64-hex sha256>"}  → ping (mark presence)
 *   GET  /api/online                            → {"online":n,"total":n}
 *
 * The launcher and the site never touch the raw host: this function forwards
 * to the presence daemon on the origin box (shape-validated here AND there).
 */
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'cache-control': 'no-store',
};
const ORIGIN = 'http://213-163-205-153.sslip.io';

export async function onRequest(context) {
  const { request } = context;
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

  if (request.method === 'POST') {
    try {
      const j = JSON.parse((await request.text()) || '{}');
      if (typeof j.h !== 'string' || !/^[0-9a-f]{64}$/.test(j.h)) {
        return Response.json({ error: 'bad h' }, { status: 400, headers: cors });
      }
      const up = await fetch(`${ORIGIN}/ping`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ h: j.h }),
        signal: AbortSignal.timeout(8000),
      });
      return new Response(await up.text(), { status: up.status, headers: { ...cors, 'content-type': 'application/json' } });
    } catch {
      return Response.json({ error: 'upstream' }, { status: 502, headers: cors });
    }
  }

  if (request.method === 'GET') {
    try {
      const up = await fetch(`${ORIGIN}/count`, { signal: AbortSignal.timeout(8000) });
      return new Response(await up.text(), { status: up.status, headers: { ...cors, 'content-type': 'application/json' } });
    } catch {
      return Response.json({ online: 0, total: 0, degraded: true }, { headers: cors });
    }
  }

  return Response.json({ error: 'use POST to ping or GET to read' }, { status: 405, headers: cors });
}
