/**
 * Pages Function: /api/dl — download counter (no KV, no D1: the counter lives
 * on the origin presence daemon, same box as /api/online).
 *
 *   POST /api/dl {"f": "<filename>"}   → count one download, returns {ok:true,dl:n}
 *   GET  /api/dl                       → {"dl":n} (all files summed)
 *
 * Allowed filenames are pinned to the release artifact names, so this cannot
 * be abused as a generic write endpoint. Anything else 400s.
 */
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'cache-control': 'no-store',
};
const ORIGIN = 'http://213-163-205-153.sslip.io';
const FILES = new Set([
  'VOIDClient-Setup.exe',
  'VOID-Client-1.4.2-Setup.exe',
  'VOID-Client-1.4.2-x86_64.AppImage',
  'VOID-Client-1.4.2-x64.tar.gz',
  'VOID-Client-1.4.3-Setup.exe',
  'VOID-Client-1.4.3-x86_64.AppImage',
  'VOID-Client-1.4.3-x64.tar.gz',
]);

export async function onRequest(context) {
  const { request } = context;
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

  if (request.method === 'POST') {
    try {
      const j = JSON.parse((await request.text()) || '{}');
      if (typeof j.f !== 'string' || !FILES.has(j.f)) {
        return Response.json({ error: 'bad f' }, { status: 400, headers: cors });
      }
      const up = await fetch(`${ORIGIN}/dl`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ f: j.f }),
        signal: AbortSignal.timeout(8000),
      });
      return new Response(await up.text(), { status: up.status, headers: { ...cors, 'content-type': 'application/json' } });
    } catch {
      return Response.json({ error: 'upstream' }, { status: 502, headers: cors });
    }
  }

  if (request.method === 'GET') {
    try {
      const up = await fetch(`${ORIGIN}/dl`, { signal: AbortSignal.timeout(8000) });
      return new Response(await up.text(), { status: up.status, headers: { ...cors, 'content-type': 'application/json' } });
    } catch {
      return Response.json({ dl: 0, degraded: true }, { headers: cors });
    }
  }

  return Response.json({ error: 'use POST to count or GET to read' }, { status: 405, headers: cors });
}
