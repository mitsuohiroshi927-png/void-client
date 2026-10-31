'use strict';
/**
 * Discord Rich Presence for VOID Client.
 *
 * Speaks the Discord IPC protocol directly over the OS socket, using only
 * node's `net` module. The popular `discord-rpc` package would work too, but it
 * drags in a websocket library and ~40 transitive deps for a feature that is
 * two frames of length-prefixed JSON — not worth it in a launcher that markets
 * itself as light.
 *
 * Wire format (little-endian):
 *   [int32 op][int32 payload length][utf8 JSON payload]
 *
 * Everything here is best-effort. Discord not installed, not running, socket
 * busy, user disabled it — all of it fails silently. A launcher must never
 * complain because a chat app is closed.
 */

const net = require('net');
const path = require('path');

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

/** How long to wait for the handshake before giving up on this socket. */
const HANDSHAKE_TIMEOUT_MS = 5000;
/** Discord kicks idle clients; keep the pipe warm. */
const PING_INTERVAL_MS = 15000;
/** How often the "elapsed" timer is refreshed in the UI-safe path. */
const MAX_PIPE_INDEX = 10;

class DiscordRpc {
  constructor({ clientId, appName = 'VOID Client' } = {}) {
    this.clientId = String(clientId || '');
    // Shown as the app name in the Discord profile hover card.
    this.appName = appName;
    this.socket = null;
    this.ready = false;
    this.connectPromise = null;
    this.pingTimer = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.nextNonce = 1;
    this.destroyed = false;
    this.lastActivity = null;
    /** Set while connect() waits for the READY frame. */
    this._onReady = null;
  }

  /* ---------------------------- socket plumbing ---------------------------- */

  /**
   * Candidate endpoints, in the order Discord itself probes them.
   * Windows uses named pipes, macOS/Linux a unix socket in a per-user dir.
   */
  static candidates() {
    const out = [];
    for (let i = 0; i < MAX_PIPE_INDEX; i++) {
      if (process.platform === 'win32') {
        out.push(`\\\\?\\pipe\\discord-ipc-${i}`);
      } else {
        const base =
          process.env.XDG_RUNTIME_DIR ||
          process.env.TMPDIR ||
          process.env.TMP ||
          process.env.TEMP ||
          '/tmp';
        out.push(path.join(base, `discord-ipc-${i}`));
        // Discord also snaps its socket into subdirectories on some distros.
        for (const sub of ['app/com.discordapp.Discord', 'snap.discord', 'app/com.discordapp.DiscordCanary']) {
          out.push(path.join(base, sub, `discord-ipc-${i}`));
        }
      }
    }
    return out;
  }

  /** Try every candidate; first one that connects wins. */
  async connect() {
    if (this.ready && this.socket && !this.socket.destroyed) return true;
    if (this.connectPromise) return this.connectPromise;
    if (!this.clientId) return false;

    this.connectPromise = (async () => {
      for (const endpoint of DiscordRpc.candidates()) {
        try {
          const sock = await this._tryEndpoint(endpoint);
          if (sock) {
            this.socket = sock;
            this._wire(sock);
            const ok = await this._handshake();
            if (ok) {
              this.ready = true;
              this._startPing();
              return true;
            }
            this._teardown();
          }
        } catch {
          /* try the next endpoint */
        }
      }
      return false;
    })().finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  _tryEndpoint(endpoint) {
    return new Promise((resolve) => {
      const sock = net.createConnection(endpoint);
      const done = (ok) => {
        sock.removeAllListeners('error');
        sock.removeAllListeners('connect');
        clearTimeout(t);
        resolve(ok ? sock : null);
      };
      const t = setTimeout(() => {
        sock.destroy();
        done(false);
      }, HANDSHAKE_TIMEOUT_MS);
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
    });
  }

  _wire(sock) {
    sock.on('data', (chunk) => this._onData(chunk));
    sock.on('error', () => this._teardown());
    sock.on('close', () => {
      // Only react to the socket we currently believe in; a stale close event
      // from a previous attempt must not clear a live connection.
      if (this.socket === sock) this._teardown();
    });
  }

  _teardown() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.ready = false;
    if (this.socket) {
      try {
        this.socket.removeAllListeners();
        this.socket.destroy();
      } catch {
        /* already gone */
      }
      this.socket = null;
    }
    for (const [, { reject, timer }] of this.pending) {
      clearTimeout(timer);
      reject(new Error('rpc closed'));
    }
    this.pending.clear();
  }

  _startPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      this._send(OP_PING, {});
    }, PING_INTERVAL_MS);
    // A pending ping must not hold the process open at quit time.
    if (this.pingTimer.unref) this.pingTimer.unref();
  }

  /* ------------------------------- protocol -------------------------------- */

  _frame(op, payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const head = Buffer.alloc(8);
    head.writeInt32LE(op, 0);
    head.writeInt32LE(body.length, 4);
    return Buffer.concat([head, body]);
  }

  _send(op, payload) {
    if (!this.socket || this.socket.destroyed) return false;
    try {
      this.socket.write(this._frame(op, payload));
      return true;
    } catch {
      return false;
    }
  }

  /** Send a command and resolve with Discord's reply for that nonce. */
  _command(cmd, args) {
    return new Promise((resolve, reject) => {
      if (!this.ready && cmd !== 'DISPATCH') {
        reject(new Error('not connected'));
        return;
      }
      const nonce = `${this.nextNonce++}`;
      const timer = setTimeout(() => {
        this.pending.delete(nonce);
        reject(new Error(`rpc timeout: ${cmd}`));
      }, HANDSHAKE_TIMEOUT_MS);
      this.pending.set(nonce, { resolve, reject, timer });
      const ok = this._send(OP_FRAME, { cmd, args, nonce });
      if (!ok) {
        clearTimeout(timer);
        this.pending.delete(nonce);
        reject(new Error('send failed'));
      }
    });
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // Frames can be split across packets or arrive several at a time.
    while (this.buffer.length >= 8) {
      const op = this.buffer.readInt32LE(0);
      const len = this.buffer.readInt32LE(4);
      if (len < 0 || len > 1 << 20) {
        this._teardown();
        return;
      }
      if (this.buffer.length < 8 + len) return;
      const body = this.buffer.subarray(8, 8 + len).toString('utf8');
      this.buffer = this.buffer.subarray(8 + len);
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }
      this._dispatch(op, msg);
    }
  }

  _dispatch(op, msg) {
    // Handshake completion: the single reader signals the waiting _handshake().
    if (this._onReady && msg && msg.evt === 'READY') this._onReady();
    if (op === OP_PING) {
      this._send(OP_PONG, msg);
      return;
    }
    if (op === OP_CLOSE) {
      this._teardown();
      return;
    }
    const nonce = msg && msg.nonce;
    if (nonce && this.pending.has(nonce)) {
      const { resolve, timer } = this.pending.get(nonce);
      clearTimeout(timer);
      this.pending.delete(nonce);
      if (msg.evt === 'ERROR') resolve({ ok: false, error: msg.data && msg.data.message });
      else resolve({ ok: true, data: msg.data });
    }
  }

  async _handshake() {
    if (!this._send(OP_HANDSHAKE, { v: 1, client_id: this.clientId })) return false;
    // Discord answers with a DISPATCH READY frame. _onData is the single reader
    // of the stream; a second listener raced it for the same bytes and starved
    // this wait, so the ready flag is resolved from inside _dispatch instead.
    return new Promise((resolve) => {
      this._onReady = () => {
        this._onReady = null;
        clearTimeout(t);
        resolve(true);
      };
      const t = setTimeout(() => {
        this._onReady = null;
        resolve(false);
      }, HANDSHAKE_TIMEOUT_MS);
    });
  }

  /* ------------------------------- public API ------------------------------ */

  /**
   * Publish an activity. Call on a state change only — Discord shows "last
   * updated" and spamming it looks broken.
   *
   * `startTimestamp` is deliberately a millisecond epoch: Discord renders the
   * "xx:xx elapsed" counter from it.
   */
  async setActivity(activity) {
    if (this.destroyed) return false;
    if (!this.ready) {
      const ok = await this.connect();
      if (!ok) return false;
    }
    const payload = {
      // timestamps.start is what makes the "elapsed" tick in the profile card.
      timestamps: activity.startTimestamp ? { start: activity.startTimestamp } : undefined,
      details: activity.details,
      state: activity.state,
      assets: activity.assets,
      // "Ask to join" is meaningless for a launcher; keep buttons off unless given.
      buttons: activity.buttons,
      instance: false,
    };
    // Drop undefined keys so Discord does not render empty fields.
    for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];

    try {
      const r = await this._command('SET_ACTIVITY', { pid: process.pid, activity: payload });
      this.lastActivity = payload;
      return !!(r && r.ok);
    } catch {
      return false;
    }
  }

  clearActivity() {
    return this._command('SET_ACTIVITY', { pid: process.pid, activity: null }).catch(() => false);
  }

  shutdown() {
    this.destroyed = true;
    try {
      this._send(OP_CLOSE, {});
    } catch {
      /* ignore */
    }
    this._teardown();
  }
}

module.exports = { DiscordRpc };
