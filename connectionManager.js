"use strict";

/**
 * connectionManager.js — single authoritative Mineflayer connection lifecycle controller.
 *
 * State machine:
 *   STOPPED -> CONNECTING -> ONLINE -> WAITING_TO_RECONNECT -> CONNECTING ...
 *   any state -> SHUTTING_DOWN (graceful process exit)
 *
 * Guarantees:
 *  - Exactly one bot instance ever exists (tracked by a generation id).
 *  - Exactly one pending reconnect timer ever exists.
 *  - Events from dead/old bot generations are ignored (stale-event protection).
 *  - The spawn timeout only aborts its own generation; it can never kill a newer bot
 *    and it never clears the reconnect timer.
 *  - kicked / end / error / "reason" / timeouts all funnel into ONE guarded retry path,
 *    so a retry can never be lost or duplicated.
 *  - The failure counter is reset only after the connection proves itself stable
 *    (spawn + STABLE_AFTER_MS), not on the raw spawn event.
 */

const STATES = {
  STOPPED: "STOPPED",
  CONNECTING: "CONNECTING",
  ONLINE: "ONLINE",
  WAITING_TO_RECONNECT: "WAITING_TO_RECONNECT",
  SHUTTING_DOWN: "SHUTTING_DOWN",
};

// Classify a kick/disconnect/error reason (lower-cased text) into a category.
function classifyDisconnect(text) {
  const s = String(text || "").toLowerCase();
  if (!s) return "unknown";
  // Permanent-ish, configuration-related rejections
  if (s.includes("invalid session") || s.includes("bad login") || s.includes("failed to verify"))
    return "auth";
  if (s.includes("invalid username or password") || s.includes("invalid credentials"))
    return "auth";
  if (s.includes("whitelist")) return "whitelist";
  if (s.includes("banned") || s.includes("ban hammer") || s.includes("unauthorized ip"))
    return "ban";
  if (s.includes("version") && (s.includes("mismatch") || s.includes("outdated") || s.includes("not compatible") || s.includes("required")))
    return "version";
  // Vanilla protocol handshake rejections ("Outdated server!", "Client ... out of date")
  if (s.includes("outdated server") || s.includes("out of date")) return "version";
  if (s.includes("no permission") || s.includes("server full") || s.includes("is full") || s.includes("you are already online"))
    return "rejected";
  // Throttle detection (also matches legacy wasThrottled strings)
  if (s.includes("throttl") || s.includes("wait before reconnect") || s.includes("too fast") || s.includes("loginlimit"))
    return "throttle";
  // Transient network failures
  if (
    s.includes("econnreset") || s.includes("epipe") || s.includes("etimedout") ||
    s.includes("enotfound") || s.includes("eai_again") || s.includes("econnrefused") ||
    s.includes("connection refused") || s.includes("timed out") || s.includes("timeout") ||
    s.includes("partialreaderror") || s.includes("socketclosed") || s.includes("keepaliveerror") ||
    s.includes("write after end") || s.includes("this socket has been ended") ||
    s.includes("network") || s.includes("disconnected from server") || s.includes("ping timeout")
  )
    return "network";
  return "unknown";
}

class ConnectionManager {
  /**
   * @param {object} opts
   *  - createFn (required): () => botLike — creates exactly one Mineflayer-like bot.
   *  - log(level, msg)
   *  - retry: { baseDelayMs, maxDelayMs, minDelayMs, jitterRatio, throttlePenaltyMs, connectTimeoutMs, stableAfterMs }
   *  - hooks: { onStateChange(state, info), onConnected(bot), onDisconnected(info), onGiveUp(info) }
   */
  constructor(opts = {}) {
    if (typeof opts.createFn !== "function") {
      throw new Error("ConnectionManager requires a createFn option");
    }
    this._createFn = opts.createFn;
    this._log = typeof opts.log === "function" ? opts.log : () => {};
    const r = opts.retry || {};
    this.retry = {
      baseDelayMs: num(r.baseDelayMs, 3000),
      maxDelayMs: Math.max(num(r.maxDelayMs, 60000), num(r.minDelayMs, 2000)),
      minDelayMs: num(r.minDelayMs, 2000),
      jitterRatio: clamp(num(r.jitterRatio, 0.25), 0, 1),
      throttlePenaltyMs: num(r.throttlePenaltyMs, 60000),
      connectTimeoutMs: num(r.connectTimeoutMs, 150000),
      stableAfterMs: num(r.stableAfterMs, 30000),
    };
    this.hooks = opts.hooks || {};

    this.state = STATES.STOPPED;
    this.generation = 0;          // identity of the current bot instance
    this.bot = null;              // current bot instance (or null)
    this.attempt = 0;             // consecutive failed connection attempts
    this.lastError = null;        // last disconnect/error info
    this.lastDisconnectReason = null;
    this.lastDisconnectTime = null;
    this.connectedSince = null;   // wall-clock ms of last successful spawn
    this.nextRetryIn = null;      // wall-clock ms timestamp when next attempt fires
    this.wasThrottled = false;    // legacy flag kept for dashboard parity

    this._reconnectTimer = null;  // THE one and only pending retry timer
    this._connectTimer = null;    // per-generation spawn watchdog
    this._stableTimer = null;     // per-generation stability confirmation timer
    this._endWatchdog = null;     // per-generation "end never arrived" watchdog
    this._settled = new Set();    // generations whose terminal handling already ran
  }

  /* ---------------- internal helpers ---------------- */

  _setState(next, info) {
    this.state = next;
    try {
      if (this.hooks.onStateChange) this.hooks.onStateChange(next, info || {});
    } catch (_) { /* never let a hook crash the manager */ }
  }

  _clearConnectTimer() {
    if (this._connectTimer) { clearTimeout(this._connectTimer); this._connectTimer = null; }
  }
  _clearStableTimer() {
    if (this._stableTimer) { clearTimeout(this._stableTimer); this._stableTimer = null; }
  }
  _clearEndWatchdog() {
    if (this._endWatchdog) { clearTimeout(this._endWatchdog); this._endWatchdog = null; }
  }
  // NOTE: deliberately separate from _clearConnectTimer — clearing a watchdog must
  // NEVER cancel a pending reconnect timer (that bug caused permanent lockouts).
  _clearReconnectTimer() {
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this.nextRetryIn = null;
  }

  _teardownBot(gen) {
    const b = this.bot;
    if (!b || gen !== this.generation) return;
    this.bot = null;
    try {
      // FIX: do NOT call b.removeAllListeners() here — index.js attaches its own
      // listeners (auto-auth, chat forwarding, gamemode detection) to the same
      // bot emitter, and wiping every listener can break protocol/socket cleanup.
      // Stale-event protection is provided by the generation check in each
      // handler plus the _settled set below, so no duplicate retry can occur
      // even if a dead socket still emits events after end().
      b.end && b.end("managerCleanup");
    } catch (_) { /* socket may already be dead */ }
  }

  _computeBackoffDelay() {
    const { baseDelayMs, maxDelayMs, minDelayMs, jitterRatio, throttlePenaltyMs } = this.retry;
    const n = Math.max(0, this.attempt - 1); // first scheduled retry waits ~baseDelay
    let delay = Math.min(Math.max(baseDelayMs * Math.pow(2, n), minDelayMs), maxDelayMs);
    if (this.wasThrottled) {
      this.wasThrottled = false;
      delay = Math.min(delay + throttlePenaltyMs, maxDelayMs);
      this._log("warn", `[Bot] Throttle detected - honoring extended delay (${Math.round(delay / 1000)}s)`);
    }
    const jitter = Math.floor(delay * jitterRatio * Math.random());
    return delay + jitter;
  }

  /* ---------------- core lifecycle ---------------- */

  start() {
    if (this.state === STATES.CONNECTING || this.state === STATES.ONLINE) {
      this._log("info", "[Bot] Already running - ignoring duplicate start");
      return;
    }
    if (this.state === STATES.SHUTTING_DOWN) {
      this._log("warn", "[Bot] Shutdown in progress - cannot start");
      return;
    }
    this._clearReconnectTimer();
    this._beginAttempt();
  }

  stop() {
    // Manual stop: cancel retries and disconnect cleanly. No auto-reconnect until start().
    this._log("info", "[Bot] Stopping (manual)");
    this._clearReconnectTimer();
    this._clearConnectTimer();
    this._clearStableTimer();
    this._clearEndWatchdog();
    this._teardownBot(this.generation);
    this._settled.add(this.generation);
    this.attempt = 0;
    this._setState(STATES.STOPPED, { reason: "manual-stop" });
  }

  _beginAttempt() {
    const gen = ++this.generation;
    this._settled.delete(gen);
    this._clearConnectTimer();
    this._clearStableTimer();
    this._clearEndWatchdog();
    this._setState(STATES.CONNECTING, { generation: gen, attempt: this.attempt });
    this._log("info", `[Bot] Creating bot instance (gen ${gen})`);

    let b;
    try {
      b = this._createFn();
    } catch (err) {
      // Synchronous creation failure (bad config, DNS-throwing libs, ...) — still retry.
      this._log("error", `[Bot] Failed to create bot: ${(err && err.message) || err}`);
      this._onTerminal(gen, { type: "create-error", message: String((err && err.message) || err) });
      return;
    }
    if (!b) {
      this._onTerminal(gen, { type: "create-error", message: "createFn returned no bot" });
      return;
    }
    this.bot = b;

    // ---- handlers attached ONCE per generation ----
    b.once && b.once("spawn", () => {
      if (gen !== this.generation) return; // stale event from an old instance
      this._clearConnectTimer();
      this._clearEndWatchdog();
      this.connectedSince = Date.now();
      this._setState(STATES.ONLINE, { generation: gen });
      this._log("info", "[Bot] [+] Spawned - waiting for stability confirmation");
      // Reset the failure counter ONLY after the connection proves itself stable.
      this._stableTimer = setTimeout(() => {
        this._stableTimer = null;
        if (gen !== this.generation || this.state !== STATES.ONLINE) return;
        if (this.attempt !== 0) this._log("info", "[Bot] Connection stable - retry counter reset");
        this.attempt = 0;
        this.lastError = null;
        try { if (this.hooks.onStable) this.hooks.onStable(b); } catch (e) {
          this._log("error", `[Bot] onStable hook error: ${e.message}`);
        }
      }, this.retry.stableAfterMs);
      try { if (this.hooks.onConnected) this.hooks.onConnected(b); } catch (e) {
        this._log("error", `[Bot] onConnected hook error: ${e.message}`);
      }
    });

    b.on && b.on("kicked", (reason, byServer) => {
      if (gen !== this.generation) return;
      const txt = typeof reason === "object" ? JSON.stringify(reason) : String(reason || "");
      const cat = classifyDisconnect(txt);
      if (cat === "throttle") this.wasThrottled = true;
      this.lastDisconnectReason = `Kicked: ${txt}`;
      this._log("warn", `[Bot] Kicked${byServer === false ? " (disconnect packet)" : ""}: ${txt} [category=${cat}]`);
      // 'end' normally follows immediately; watchdog covers servers that close silently.
      this._armEndWatchdog(gen, { type: "kicked", message: txt, category: cat });
    });

    b.on && b.on("error", (err) => {
      if (gen !== this.generation) return;
      const msg = (err && err.message) || String(err || "");
      const cat = classifyDisconnect(msg);
      if (cat === "throttle") this.wasThrottled = true;
      this.lastError = { type: "error", message: msg, category: cat, time: Date.now() };
      this._log("error", `[Bot] Error: ${msg} [category=${cat}]`);
      // minecraft-protocol usually emits end right after a fatal error;
      // if it doesn't, the watchdog settles this generation.
      this._armEndWatchdog(gen, { type: "error", message: msg, category: cat });
    });

    b.on && b.on("end", (reason) => {
      if (gen !== this.generation) return; // stale end from an old instance
      const txt = typeof reason === "object" ? JSON.stringify(reason) : String(reason || "");
      const cat = classifyDisconnect(txt) === "unknown"
        ? (this.lastError && this.lastError.category) || classifyDisconnect(this.lastDisconnectReason) || "unknown"
        : classifyDisconnect(txt);
      this._onTerminal(gen, { type: "end", message: txt || "unknown", category: cat });
    });

    // mineflayer's client emits 'reason' on some protocol paths; harmless if absent.
    b.on && b.on("reason", (packet) => {
      if (gen !== this.generation) return;
      try {
        const txt = JSON.stringify(packet);
        this._log("info", `[Bot] Server reason packet: ${txt}`);
      } catch (_) {}
    });

    // ---- connection watchdog: no spawn within timeout => abort THIS generation only ----
    this._connectTimer = setTimeout(() => {
      this._connectTimer = null;
      if (gen !== this.generation) return; // never touch a newer connection
      this._log("warn", "[Bot] Connection timeout - no spawn received in time");
      this._onTerminal(gen, { type: "timeout", message: "No spawn within connect timeout", category: "timeout" });
    }, this.retry.connectTimeoutMs);
  }

  _armEndWatchdog(gen, info) {
    // If 'end' does not arrive shortly after kicked/error, settle with what we have.
    if (this._endWatchdog) clearTimeout(this._endWatchdog);
    this._endWatchdog = setTimeout(() => {
      this._endWatchdog = null;
      if (gen !== this.generation) return;
      this._onTerminal(gen, { ...info, category: info.category || "network" });
    }, 5000);
  }

  _onTerminal(gen, info) {
    if (gen !== this.generation) return;       // stale event from replaced instance
    if (this._settled.has(gen)) return;        // already handled (kick+end+error storm)
    if (this.state === STATES.SHUTTING_DOWN || this.state === STATES.STOPPED) return;
    this._settled.add(gen);

    this._clearConnectTimer();
    this._clearStableTimer();
    this._clearEndWatchdog();
    this._teardownBot(gen);

    const wasOnline = this.state === STATES.ONLINE;
    if (wasOnline) {
      this.attempt = 0; // a real session ended -> next failure starts backoff fresh
    } else {
      this.attempt += 1; // failed attempt (never spawned, or spawned but timed out)
    }
    this.connectedSince = null;
    if (info && info.message) {
      this.lastDisconnectReason = this.lastDisconnectReason || `${info.type}: ${info.message}`;
      this.lastError = { ...info, time: Date.now() };
    }
    this.lastDisconnectTime = Date.now();

    try { if (this.hooks.onDisconnected) this.hooks.onDisconnected({ ...info, wasOnline }); } catch (_) {}

    this._scheduleRetry(info);
  }

  _scheduleRetry(info) {
    // Exactly one pending timer, always. Never stacks, never gets lost.
    if (this._reconnectTimer) {
      this._log("debug", "[Bot] Retry already scheduled - skipping duplicate");
      return;
    }
    const cat = (info && info.category) || "unknown";
    const PERMANENT = { auth: 5, version: 8, whitelist: 8, ban: 10, rejected: 4 };
    const cap = PERMANENT[cat];
    if (cap && this.attempt >= cap) {
      this._log("error",
        `[Bot] Repeated "${cat}" failures (${this.attempt}). This usually needs a settings/server fix, ` +
        `not more retries. Slowing down to max delay instead of flooding the server.`);
      if (this.hooks.onGiveUp) { try { this.hooks.onGiveUp(info); } catch (_) {} }
    }
    const delay = this._computeBackoffDelay();
    this.nextRetryIn = Date.now() + delay;
    this._setState(STATES.WAITING_TO_RECONNECT, { delay, attempt: this.attempt, category: cat });
    this._log("info", `[Bot] Reconnecting in ${Math.round(delay / 1000)}s (attempt #${this.attempt})`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.nextRetryIn = null;
      this._beginAttempt();
    }, delay);
  }

  /* ---------------- reporting ---------------- */

  getStatus() {
    return {
      state: this.state,
      connected: this.state === STATES.ONLINE,
      generation: this.generation,
      attempt: this.attempt,
      nextRetryIn: this.nextRetryIn,
      connectedSince: this.connectedSince,
      lastDisconnectReason: this.lastDisconnectReason,
      lastDisconnectTime: this.lastDisconnectTime,
      lastError: this.lastError,
      sessionUptimeSec: this.connectedSince
        ? Math.floor((Date.now() - this.connectedSince) / 1000)
        : 0,
    };
  }

  shutdown() {
    this.state = STATES.SHUTTING_DOWN;
    this._clearReconnectTimer();
    this._clearConnectTimer();
    this._clearStableTimer();
    this._clearEndWatchdog();
    this._teardownBot(this.generation);
  }

  /** For tests/cleanup: returns counts of live timers so leaks can be detected. */
  _liveTimers() {
    return [this._reconnectTimer, this._connectTimer, this._stableTimer, this._endWatchdog].filter(Boolean).length;
  }
}

function num(v, d) { return typeof v === "number" && isFinite(v) ? v : d; }
function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

module.exports = { ConnectionManager, STATES, classifyDisconnect };
