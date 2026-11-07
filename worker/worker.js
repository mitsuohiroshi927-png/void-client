
/**
 * VOID Client online counter — anonymous, one-way hashes only.
 *
 * POST /ping  {h: "<64-hex sha256>"}  → mark presence
 * GET  /count                          → {online, total}
 *
 * Storage: ONE Durable Object (SQLite) — global, not per-colo. online = unique
 * hashes seen in the last 5 min; total = unique hashes seen today (rows older
 * than ~25 h are swept). A hash salt-rotates daily in the launcher, so nothing
 * is trackable across days and no table ever grows past a day's users.
 */
export class Presence {
  constructor(state) {
    this.state = state;
    this.mem = new Map();        // h -> lastSeen (seconds), backed by sqlite
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    await this.state.blockConcurrencyWhile(async () => {
      try {
        const rows = await this.state.storage.sql.exec(
          "SELECT h, last FROM presence WHERE last > ?1",
          Math.floor(Date.now() / 1000) - 25 * 3600
        ).toArray();
        for (const r of rows) this.mem.set(r.h, r.last);
      } catch { /* fresh table */ }
      this.loaded = true;
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const now = Math.floor(Date.now() / 1000);
    await this.load();

    if (request.method === "POST" && url.pathname === "/ping") {
      let body; try { body = await request.json(); } catch { return j({ error: "bad json" }, 400); }
      const h = body && body.h;
      if (typeof h !== "string" || !/^[0-9a-f]{64}$/.test(h)) return j({ error: "bad h" }, 400);
      this.mem.set(h, now);
      try { this.state.storage.sql.exec("INSERT INTO presence (h, last) VALUES (?1, ?2) ON CONFLICT(h) DO UPDATE SET last = ?2", h, now); }
      catch {
        await this.state.storage.sql.exec("CREATE TABLE IF NOT EXISTS presence (h TEXT PRIMARY KEY, last INTEGER)");
        await this.state.storage.sql.exec("INSERT INTO presence (h, last) VALUES (?1, ?2) ON CONFLICT(h) DO UPDATE SET last = ?2", h, now);
      }
      // occasional sweep: anything older than 25 h cannot return (day salt)
      if (this.mem.size % 50 === 0) {
        for (const [k, t] of this.mem) if (t < now - 25 * 3600) this.mem.delete(k);
        try { await this.state.storage.sql.exec("DELETE FROM presence WHERE last < ?1", now - 25 * 3600); } catch {}
      }
      return j({ ok: true });
    }

    if (url.pathname === "/count") {
      let online = 0, total = 0;
      for (const t of this.mem.values()) { total++; if (t >= now - 300) online++; }
      return j({ online, total, updated: now });
    }

    return j({ error: "not found" }, 404);
  }
}

const j = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, GET",
        "access-control-allow-headers": "content-type",
      }});
    }
    const id = env.PRESENCE.idFromName("global");
    const stub = env.PRESENCE.get(id);
    const upstream = new Request(url.toString().replace(url.origin, "https://presence.internal"), request);
    return stub.fetch(upstream);
  },
};
