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
  // Vanilla protocol handshake rejections ("Outdated client!", "Outdated server!",
  // "Client ... out of date", "This server requires version X")
  if (s.includes("outdated") || s.includes("out of date") || s.includes("requires version") || s.includes("server requires"))
    return "version";
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
    s.includes("network") || s.includes("disconnected from server") || s.includes("ping timeout") ||
    // OS-level socket strings reported by minecraft-protocol on unexpected closure
    s.includes("connection reset") || s.includes("connection closed") || s.includes("ended by the other end") ||
    s.includes("socket hang up") || s.includes("remote host closed the connection") ||
    s.includes("forcibly closed") || s.includes("software cause: connection aborted")
  )
    return "network";
  return "unknown";
}

// Granularity used by the per-generation watchdog timer chains (connect +
// end-watchdog). Short ticks make the watchdogs reliably cancellable and
// generation-safe under both production and fast-timer test configurations.
const CT_TICK_MS = 25;

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
      // Grace period allowed for the protocol 'end' event to arrive after a
      // kicked/error event before the watchdog settles the generation itself.
      endWatchdogMs: num(r.endWatchdogMs, 5000),
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
    // Per-generation connection contexts (gen -> { bot, timers, flags }).
    // Every watchdog/timeout/stable timer lives inside its own context so a
    // stale callback from an old generation can never touch the current one.
    // Contexts are EVICTED once settled — this is what prevents the cascade
    // bug where a new generation's connect-timeout (which fires while the
    // previous gen's reconnect delay is still pending) wrongly cleared the
    // pending retry timer and started a duplicate attempt.
    this._ctxs = new Map();
    this._settled = new Set();    // generations whose terminal handling already ran
    this._terminalGen = 0;        // highest generation already settled/abandoned.
                                  // Every per-generation timer MUST check
                                  // `gen > this._terminalGen` before acting —
                                  // this is what prevents a settled generation's
                                  // stale connect-timeout/end-watchdog from
                                  // scheduling duplicate retries for newer gens.
  }

  /* ---------------- internal helpers ---------------- */

  _setState(next, info) {
    this.state = next;
    try {
      if (this.hooks.onStateChange) this.hooks.onStateChange(next, info || {});
    } catch (_) { /* never let a hook crash the manager */ }
  }

  // Clear every per-generation context timer (connect watchdog, stability
  // confirmation, end-watchdog) for ALL live generations. Used by stop/shutdown.
  _clearAllCtxTimers() {
    for (const ctx of this._ctxs.values()) this._clearCtxTimers(ctx);
  }
  // NOTE: deliberately separate from the context timers — clearing a watchdog must
  // NEVER cancel a pending reconnect timer (that bug caused permanent lockouts).
  _clearReconnectTimer() {
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this.nextRetryIn = null;
  }

  _teardownBot(gen) {
    const ctx = this._ctxs.get(gen);
    const b = ctx ? ctx.bot : this.bot;
    if (!b) return;
    if (gen !== this.generation) return;
    this.bot = null;
    try {
      // FIX: do NOT call b.removeAllListeners() here — index.js attaches its own
      // listeners (auto-auth, chat forwarding, gamemode detection) to the same
      // bot emitter, and wiping every listener can break protocol/socket cleanup.
      // Stale-event protection is provided by the per-ctx settled flag plus the
      // generation check in each handler, so no duplicate retry can occur even if
      // a dead socket still emits events after end().
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
    this._clearAllCtxTimers();
    this._teardownBot(this.generation);
    for (const ctx of this._ctxs.values()) ctx.settled = true;
    this._ctxs.clear();
    this._settled.add(this.generation);
    this._terminalGen = Math.max(this._terminalGen, this.generation);
    this.attempt = 0;
    this._setState(STATES.STOPPED, { reason: "manual-stop" });
  }

  _beginAttempt() {
    const gen = ++this.generation;
    this._settled.delete(gen);
    // FIX (tests 3/5/6/8/9): every generation owns its watchdog timers inside a
    // per-generation context object instead of shared manager-level handles.
    // The previous design had TWO cascading bugs:
    //   1. One global connect-timer handle overwritten by each new generation —
    //      a settled generation's timeout callback could fire while a newer gen
    //      was live and wrongly terminate it (duplicate retry storms).
    //   2. Settled contexts stayed in the map forever, so defensive clearing
    //      loops and leak counters saw stale entries.
    // Now: settled contexts are EVICTED from the map outright (their timers were
    // already cleared at settle time), only genuinely-live contexts have their
    // timers cancelled defensively, and _liveTimers() counts exactly what is
    // scheduled so leak checks stay accurate.
    for (const [g, c] of this._ctxs) {
      if (c.settled || g < gen) {
        this._clearCtxTimers(c);
        this._ctxs.delete(g);
      }
    }
    // A pending reconnect timer may still exist when start() is invoked while
    // WAITING_TO_RECONNECT (manual start takes priority over the backoff wait).
    // start() clears it explicitly before calling us; defensively ensure no
    // stray retry timer survives into the new attempt either.
    this._clearReconnectTimer();
    this._setState(STATES.CONNECTING, { generation: gen, attempt: this.attempt });
    this._log("info", `[Bot] Creating bot instance (gen ${gen})`);

    const ctx = {
      gen,
      bot: null,
      settled: false,
      spawned: false,
      connectTimer: null,
      stableTimer: null,
      endWatchdog: null,
    };
    this._ctxs.set(gen, ctx);

    let b;
    try {
      b = this._createFn();
    } catch (err) {
      // Synchronous creation failure (bad config, DNS-throwing libs, ...) — still retry.
      this._log("error", `[Bot] Failed to create bot: ${(err && err.message) || err}`);
      this._settleCtx(ctx, { type: "create-error", message: String((err && err.message) || err) });
      return;
    }
    if (!b) {
      this._settleCtx(ctx, { type: "create-error", message: "createFn returned no bot" });
      return;
    }
    this.bot = b;
    ctx.bot = b;

    // ---- handlers attached ONCE per generation (per-ctx state, no globals) ----
    b.once && b.once("spawn", () => {
      if (gen !== this.generation || ctx.settled) return; // stale event from an old instance
      if (ctx.connectTimer) { clearTimeout(ctx.connectTimer); ctx.connectTimer = null; }
      if (ctx.endWatchdog) { clearTimeout(ctx.endWatchdog); ctx.endWatchdog = null; }
      ctx.spawned = true;
      this.connectedSince = Date.now();
      this._setState(STATES.ONLINE, { generation: gen });
      this._log("info", "[Bot] [+] Spawned - waiting for stability confirmation");
      // Reset the failure counter ONLY after the connection proves itself stable.
      // FIX (test 6 — flaky under load): single long setTimeouts drift when the
      // event loop is busy (the Node test runner runs all tests in one process).
      // A tick chain with an absolute deadline fires at most CT_TICK_MS late and
      // never earlier, so stability confirmation stays deterministic.
      ctx.stableDeadline = Date.now() + this.retry.stableAfterMs;
      const armStableTick = () => {
        if (ctx.settled || gen !== this.generation) return;
        const tickMs = Math.min(CT_TICK_MS, this.retry.stableAfterMs);
        ctx.stableTimer = setTimeout(() => {
          ctx.stableTimer = null;
          if (gen !== this.generation || ctx.settled) return;
          if (this.state !== STATES.ONLINE) return;
          if (Date.now() < ctx.stableDeadline) { armStableTick(); return; }
          if (this.attempt !== 0) this._log("info", "[Bot] Connection stable - retry counter reset");
          this.attempt = 0;
          this.lastError = null;
          try { if (this.hooks.onStable) this.hooks.onStable(b); } catch (e) {
            this._log("error", `[Bot] onStable hook error: ${e.message}`);
          }
        }, tickMs);
      };
      armStableTick();
      try { if (this.hooks.onConnected) this.hooks.onConnected(b); } catch (e) {
        this._log("error", `[Bot] onConnected hook error: ${e.message}`);
      }
    });

    b.on && b.on("kicked", (reason, byServer) => {
      if (gen !== this.generation || ctx.settled) return;
      const txt = typeof reason === "object" ? JSON.stringify(reason) : String(reason || "");
      const cat = classifyDisconnect(txt);
      if (cat === "throttle") this.wasThrottled = true;
      this.lastDisconnectReason = `Kicked: ${txt}`;
      this._log("warn", `[Bot] Kicked${byServer === false ? " (disconnect packet)" : ""}: ${txt} [category=${cat}]`);
      // 'end' normally follows immediately; watchdog covers servers that close silently.
      this._armEndWatchdog(ctx, { type: "kicked", message: txt, category: cat });
    });

    b.on && b.on("error", (err) => {
      if (gen !== this.generation || ctx.settled) return;
      const msg = (err && err.message) || String(err || "");
      const cat = classifyDisconnect(msg);
      if (cat === "throttle") this.wasThrottled = true;
      this.lastError = { type: "error", message: msg, category: cat, time: Date.now() };
      this._log("error", `[Bot] Error: ${msg} [category=${cat}]`);
      // minecraft-protocol usually emits end right after a fatal error;
      // if it doesn't, the watchdog settles this generation.
      this._armEndWatchdog(ctx, { type: "error", message: msg, category: cat });
    });

    b.on && b.on("end", (reason) => {
      if (gen !== this.generation || ctx.settled) return; // stale end from an old instance
      const txt = typeof reason === "object" ? JSON.stringify(reason) : String(reason || "");
      const cat = classifyDisconnect(txt) === "unknown"
        ? (this.lastError && this.lastError.category) || classifyDisconnect(this.lastDisconnectReason) || "network"
        : classifyDisconnect(txt);
      // An 'end' with no recognizable reason at all is treated as a network
      // disconnect (unexpected socket closure), never "unknown".
      this._settleCtx(ctx, { type: "end", message: txt || "unknown", category: cat === "unknown" ? "network" : cat });
    });

    // mineflayer's client emits 'reason' on some protocol paths; harmless if absent.
    b.on && b.on("reason", (packet) => {
      if (gen !== this.generation || ctx.settled) return;
      try {
        const txt = JSON.stringify(packet);
        this._log("info", `[Bot] Server reason packet: ${txt}`);
      } catch (_) {}
    });

    // ---- connection watchdog: no spawn within timeout => abort THIS context only ----
    // The timer lives in ctx; when the context settles (end/kick/error/timeout/
    // stop/shutdown) the handle is cleared outright, so a settled generation can
    // never have its timeout fire later and interfere with a newer attempt.
    //
    // FIX (test 6 — root cause): the previous code used ONE setTimeout for the
    // entire connectTimeoutMs window. A single long timer cannot be cancelled
    // while it is already executing on the event loop, and under Node's test
    // runner real-time timers of this size were not firing reliably at all
    // (the generation stayed CONNECTING forever). Now the watchdog is a chain
    // of short ticks (<=25ms each). Every tick re-validates its OWN generation
    // against `gen !== this.generation || ctx.settled` before doing anything,
    // so:
    //   - an old generation's chain stops itself immediately once superseded or
    //     settled (it can never terminate a newer bot),
    //   - a live slow-spawn attempt accumulates elapsed time across ticks and
    //     fires exactly once at connectTimeoutMs,
    //   - cancellation is instant via clearTimeout + gen/settled checks.
    const armConnectTick = () => {
      if (ctx.settled || gen !== this.generation) return;
      ctx.connectDeadline = (ctx.connectDeadline || 0) || Date.now() + this.retry.connectTimeoutMs;
      const tickMs = Math.min(CT_TICK_MS, this.retry.connectTimeoutMs);
      ctx.connectTimer = setTimeout(() => {
        ctx.connectTimer = null;
        if (gen !== this.generation || ctx.settled) return; // stale chain — stop
        // CRITICAL: if this generation already SPAWNED, the socket handshake
        // completed successfully — the server is simply slow to send the chunk
        // that triggers 'spawn'. Killing the connection here would cause endless
        // reconnect loops against healthy-but-slow servers. The keep-alive layer
        // handles genuinely dead sockets; this watchdog only guards the
        // pre-login phase.
        if (ctx.spawned || this.state === STATES.ONLINE) {
          this._log("debug", "[Bot] Connect timeout elapsed after successful login - ignoring (slow world load)");
          return;
        }
        if (Date.now() < ctx.connectDeadline) { armConnectTick(); return; } // not elapsed yet
        this._log("warn", "[Bot] Connection timeout - no spawn received in time");
        this._settleCtx(ctx, { type: "timeout", message: "No spawn within connect timeout", category: "timeout" });
      }, tickMs);
    };
    armConnectTick();
  }

  _armEndWatchdog(ctx, info) {
    // If 'end' does not arrive shortly after kicked/error, settle with what we have.
    if (ctx.settled) return; // never arm a watchdog on an already-dead generation
    if (ctx.endWatchdog) clearTimeout(ctx.endWatchdog);
    // Same short-tick chain rationale as the connect watchdog (see above):
    // reliable under the test runner, instantly cancellable, generation-safe.
    const endDeadline = Date.now() + this.retry.endWatchdogMs;
    const armEndTick = () => {
      if (ctx.settled || ctx.gen !== this.generation) return;
      const tickMs = Math.min(CT_TICK_MS, this.retry.endWatchdogMs);
      ctx.endWatchdog = setTimeout(() => {
        ctx.endWatchdog = null;
        if (ctx.gen !== this.generation || ctx.settled) return; // stale chain — stop
        if (Date.now() < endDeadline) { armEndTick(); return; }
        this._settleCtx(ctx, { ...info, category: info.category || "network" });
      }, tickMs);
    };
    armEndTick();
  }

  _clearCtxTimers(ctx) {
    if (ctx.connectTimer) { clearTimeout(ctx.connectTimer); ctx.connectTimer = null; }
    if (ctx.stableTimer) { clearTimeout(ctx.stableTimer); ctx.stableTimer = null; }
    if (ctx.endWatchdog) { clearTimeout(ctx.endWatchdog); ctx.endWatchdog = null; }
  }

  _settleCtx(ctx, info) {
    // Single guarded terminal path for kick/end/error/timeout/create-failure.
    // Idempotent per generation: the FIRST qualifying event settles; every later
    // event (storm of kicks/errors/ends) returns immediately, so exactly one
    // reconnect is ever scheduled per generation.
    if (!ctx || ctx.settled) return;
    if (ctx.gen !== this.generation) return;              // replaced instance
    if (this.state === STATES.SHUTTING_DOWN || this.state === STATES.STOPPED) return;
    ctx.settled = true;
    this._settled.add(ctx.gen);
    this._terminalGen = Math.max(this._terminalGen, ctx.gen);
    this._clearCtxTimers(ctx);

    const b = ctx.bot;
    if (b && this.bot === b) {
      this.bot = null;
      try {
        // FIX: do NOT call b.removeAllListeners() — index.js attaches its own
        // listeners (auto-auth, chat forwarding, gamemode detection) to the same
        // emitter, and wiping them can break protocol/socket cleanup. Stale-event
        // protection comes from the per-ctx settled flag + generation checks.
        b.end && b.end("managerCleanup");
      } catch (_) { /* socket may already be dead */ }
    }

    const wasOnline = ctx.spawned && this.state === STATES.ONLINE;
    // FIX (tests 3/8 — duplicate-retry cascade): the previous code RESET the
    // failure counter here whenever a spawned session ended. That defeated the
    // only backstop against an endless retry storm: if a replacement bot fails
    // without ever spawning, its attempt must be counted on top of the one we
    // just had — otherwise every pre-spawn failure restarts at delay ~0 and the
    // manager hammers createBot in a tight loop (observed: 4 bots created from
    // ONE kick+end). Correct semantics: a completed session resets the counter
    // only once it proved itself STABLE (the stableTimer), which already does
    // `this.attempt = 0`. Settling merely records that the session ended.
    if (!wasOnline) {
      this.attempt += 1; // failed attempt (never spawned) — grow the backoff
    }
    this.connectedSince = null;
    if (info && info.message) {
      // FIX: always record the CURRENT terminal reason. The old code used
      // `||=` which kept a stale earlier message forever (e.g. test 5 asserted
      // lastError.category after a watchdog settle but saw the pre-settle value).
      this.lastDisconnectReason = `${info.type}: ${info.message}`;
      this.lastError = { ...info, time: Date.now() };
    }
    this.lastDisconnectTime = Date.now();

    try { if (this.hooks.onDisconnected) this.hooks.onDisconnected({ ...info, wasOnline }); } catch (_) {}

    // Evict the settled context immediately: its timers are cleared above, so
    // nothing about this generation can fire again, and leak accounting stays
    // exact. (Defensive eviction in _beginAttempt remains for stop/shutdown.)
    this._ctxs.delete(ctx.gen);

    this._scheduleRetry(info);
  }

  // Legacy entry point kept for compatibility with older callers/tests.
  _onTerminal(gen, info) {
    const ctx = this._ctxs.get(gen);
    if (!ctx) return;
    this._settleCtx(ctx, info);
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
    let delay = this._computeBackoffDelay();

    // FIX (tests 3/6/8/9/17 — root cause): the previous code clamped the retry
    // delay up to connectTimeoutMs ("if (delay < ct) delay = ct"). That was a
    // category error: connectTimeoutMs is the per-attempt SPAWN WATCHDOG
    // duration, not a floor on how long we wait before the next attempt. Each
    // new generation arms its own fresh watchdog when it starts, so waiting an
    // extra connectTimeoutMs between attempts buys nothing — it only stretched
    // every retry to the full timeout (so recovery tests never reached ONLINE
    // inside their windows) and opened a race window in which a settling
    // generation's stale watchdog could schedule a SECOND retry behind the
    // first, creating duplicate bot instances (tests 3 & 8).
    //
    // Duplicate-retry safety does NOT come from inflating the delay. It comes
    // from three structural guarantees, all enforced below:
    //   1. _settleCtx is idempotent per generation (ctx.settled flag) — the
    //      first qualifying event settles, every later event returns early.
    //   2. Settling clears that generation's timers AND evicts its context, so
    //      a settled gen can never fire a stale callback.
    //   3. _scheduleRetry keeps exactly ONE pending reconnect timer; a second
    //      concurrent settle is refused outright (no stacking).
    // So we use the pure exponential-backoff delay here, honoring min/max/jitter.

    this.nextRetryIn = Date.now() + delay;
    this._setState(STATES.WAITING_TO_RECONNECT, { delay, attempt: this.attempt, category: cat });
    this._log("info", `[Bot] Reconnecting in ${Math.round(delay / 1000)}s (attempt #${this.attempt})`);
    // FIX (tests 3/5/8 — timer drift under load): the retry wait is also a tick
    // chain with an absolute deadline. A single setTimeout(delay) can fire LATE
    // when the event loop is busy (Node's test runner shares one process), and
    // that late firing pushed recovery attempts past the tests' fixed sleep
    // windows. The chain never fires before the deadline and at most CT_TICK_MS
    // after it, so scheduling stays deterministic without weakening any test.
    const retryDeadline = Date.now() + delay;
    const armRetryTick = () => {
      const tickMs = Math.min(CT_TICK_MS, Math.max(1, delay));
      this._reconnectTimer = setTimeout(() => {
        if (!this._reconnectTimer) return; // cancelled by stop()/start()
        this._reconnectTimer = null;
        if (this.state === STATES.SHUTTING_DOWN || this.state === STATES.STOPPED) return;
        if (Date.now() < retryDeadline) { armRetryTick(); return; }
        this.nextRetryIn = null;
        this._beginAttempt();
      }, tickMs);
    };
    armRetryTick();
  }

  // Wait until the CURRENT generation settles and the next attempt actually
  // begins (state returns to CONNECTING). Used only by tests for deterministic
  // observation of multi-cycle flows; never used in production logic.
  waitForReconnecting(timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = setInterval(() => {
        if (this.state === STATES.CONNECTING) { clearInterval(poll); resolve(); return; }
        if (this.state === STATES.STOPPED || this.state === STATES.SHUTTING_DOWN) {
          clearInterval(poll); resolve(); return;
        }
        if (Date.now() - started > timeoutMs) { clearInterval(poll); reject(new Error("waitForReconnecting timed out")); }
      }, 10);
    });
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
    this._clearAllCtxTimers();
    this._teardownBot(this.generation);
    for (const ctx of this._ctxs.values()) ctx.settled = true;
  }

  /** For tests/cleanup: returns counts of live timers so leaks can be detected. */
  _liveTimers() {
    let n = this._reconnectTimer ? 1 : 0;
    for (const c of this._ctxs.values()) {
      if (c.connectTimer) n++;
      if (c.stableTimer) n++;
      if (c.endWatchdog) n++;
    }
    return n;
  }
}

function num(v, d) { return typeof v === "number" && isFinite(v) ? v : d; }
function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

module.exports = { ConnectionManager, STATES, classifyDisconnect };
