'use strict';

/**
 * ConnectionManager — the single reconnect mechanism for the bot.
 *
 * States: STOPPED, CONNECTING, ONLINE, WAITING_TO_RECONNECT, SHUTTING_DOWN.
 *
 * Design (keep it): every connect attempt gets a "generation" context holding
 * its own bot and listeners. Events from a stale generation are ignored, there
 * is exactly one retry timer at any time, and stop()/shutdown() settle the
 * current generation without spawning new ones.
 */

const STATES = {
  STOPPED: 'STOPPED',
  CONNECTING: 'CONNECTING',
  ONLINE: 'ONLINE',
  WAITING_TO_RECONNECT: 'WAITING_TO_RECONNECT',
  SHUTTING_DOWN: 'SHUTTING_DOWN',
};

const DEFAULTS = {
  connectTimeoutMs: 20000,
  stableAfterMs: 30000,
  baseDelayMs: 1000,
  maxDelayMs: 300000,
  jitter: 0.2,
  giveUpAfterMs: 0, // 0 = never give up
  // Flapping alert: N sessions shorter than stableAfterMs within windowMs.
  flapThreshold: 5,
  flapWindowMs: 10 * 60 * 1000,
};

class ConnectionManager {
  /**
   * @param {object} opts
   * @param {object} opts.settings normalized config (config.js output)
   * @param {(ctx)=>object} opts.createBot factory returning a mineflayer-like bot
   * @param {object} [opts.hooks] onConnecting, onConnected(bot), onDisconnected(info),
   *                             onFlapping(info), onGiveUp(info), log(level,msg)
   */
  constructor (opts) {
    const o = opts || {};
    if (typeof o.createBot !== 'function') throw new Error('ConnectionManager requires createBot');
    this.settings = Object.assign({}, DEFAULTS, o.settings || {});
    this.hooks = Object.assign({
      onConnecting: () => {},
      onConnected: () => {},
      onDisconnected: () => {},
      onFlapping: () => {},
      onGiveUp: () => {},
      log: () => {},
    }, o.hooks || {});
    this._createBot = o.createBot;

    this.state = STATES.STOPPED;
    this.generation = 0;
    this.attempt = 0;
    this.lastError = null;
    this.lastDisconnect = null;
    this.onlineSince = null;
    this._ctx = null;          // active generation context
    this._retryTimer = null;
    this._firstFailureAt = null;
    this._shortSessions = [];  // timestamps of sessions shorter than stableAfterMs
    this._flapAlerted = false;
    this._botCount = 0;        // how many bots this manager created (test hook)
  }

  _log (level, msg) {
    try { this.hooks.log(level, msg); } catch (_) { /* logging must never break the loop */ }
  }

  _setState (next) {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    this._log('info', `state ${prev} -> ${next}`);
  }

  _liveTimers () {
    let n = 0;
    if (this._retryTimer) n++;
    if (this._ctx) {
      if (this._ctx.connectTimer) n++;
      if (this._ctx.stableTimer) n++;
    }
    return n;
  }

  getStatus () {
    let nextRetryIn = null;
    if (this._retryTimer && this._retryAt) nextRetryIn = Math.max(0, this._retryAt - Date.now());
    return {
      state: this.state,
      generation: this.generation,
      attempt: this.attempt,
      online: this.state === STATES.ONLINE,
      onlineSince: this.onlineSince,
      sessionUptimeMs: this.onlineSince ? Date.now() - this.onlineSince : null,
      lastDisconnect: this.lastDisconnect,
      lastError: this.lastError,
      nextRetryIn,
    };
  }

  start () {
    if (this.state === STATES.CONNECTING || this.state === STATES.ONLINE) return;
    if (this.state === STATES.SHUTTING_DOWN) return;
    this._clearRetry();
    this.attempt = 0;
    this._firstFailureAt = null;
    this._connect();
  }

  stop () {
    // Set the state first so any settle path (including hooks fired while the
    // live generation is torn down) sees STOPPED and refuses to schedule a retry.
    this._setState(STATES.STOPPED);
    this._clearRetry();
    this._settleCtx(null, { reason: 'stopped by operator', category: 'stop' });
  }

  shutdown () {
    // Same ordering as stop(); routed through _setState so transitions stay observable.
    this._setState(STATES.SHUTTING_DOWN);
    this._clearRetry();
    this._settleCtx(null, { reason: 'shutting down', category: 'shutdown' });
  }

  _clearRetry () {
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
      this._retryAt = null;
    }
  }

  _connect () {
    if (this.state === STATES.STOPPED || this.state === STATES.SHUTTING_DOWN) return;
    const gen = ++this.generation;
    const ctx = {
      gen,
      bot: null,
      spawned: false,
      settled: false,
      startedAt: Date.now(),
      connectTimer: null,
      stableTimer: null,
      listeners: [],
    };
    this._ctx = ctx;
    this._setState(STATES.CONNECTING);
    this._log('info', `gen ${gen}: connecting (attempt ${this.attempt})`);

    let bot;
    try {
      bot = this._createBot(ctx);
    } catch (err) {
      // createBot failed synchronously: no listeners were attached, so settle
      // manually instead of _settleCtx (which would dereference ctx.bot).
      this.lastError = String(err && err.message || err);
      this._log('error', `gen ${gen}: createBot threw: ${this.lastError}`);
      if (this._ctx === ctx) this._ctx = null;
      ctx.settled = true;
      this.lastDisconnect = { at: Date.now(), generation: gen, reason: this.lastError, category: 'error' };
      this.attempt += 1;
      if (!this._firstFailureAt) this._firstFailureAt = ctx.startedAt;
      if (this.state === STATES.STOPPED || this.state === STATES.SHUTTING_DOWN) return;
      this._scheduleRetry();
      return;
    }
    this._botCount++;
    ctx.bot = bot;
    try { this.hooks.onConnecting(bot, ctx); } catch (e) { this._log('error', `onConnecting hook threw: ${e.message}`); }

    const on = (ev, fn) => {
      bot.on(ev, (...args) => {
        // Stale-event protection: ignore anything from an older generation.
        if (ctx.settled || this._ctx !== ctx) return;
        try { fn(...args); } catch (e) { this._log('error', `handler for ${ev} threw: ${e.message}`); }
      });
      ctx.listeners.push([ev, fn]);
    };

    on('spawn', () => {
      ctx.spawned = true;
      ctx.spawnedAt = Date.now();
      this._setState(STATES.ONLINE);
      this.onlineSince = Date.now();
      this.lastError = null;
      this._log('info', `gen ${ctx.gen}: spawned (session may still be unstable)`);
      try { this.hooks.onConnected(ctx.bot, ctx); } catch (e) { this._log('error', `onConnected hook threw: ${e.message}`); }
      ctx.stableTimer = setTimeout(() => {
        ctx.stableTimer = null;
        if (ctx.settled || this._ctx !== ctx) return;
        // A session that survived stableAfterMs counts as healthy: reset backoff.
        this.attempt = 0;
        this._firstFailureAt = null;
        this.noteHealthy();
        this._log('info', `gen ${ctx.gen}: session stable for ${this.settings.stableAfterMs}ms, backoff reset`);
      }, this.settings.stableAfterMs);
    });

    on('end', (reason) => {
      const info = normalizeEnd(reason);
      this._settleCtx(ctx, info);
    });

    on('kicked', (reason, loggedIn) => {
      // Second mineflayer argument is `loggedIn`, not "byServer".
      const text = parseReason(reason);
      this._settleCtx(ctx, {
        reason: text,
        category: 'kicked',
        wasLoggedIn: !!loggedIn,
      });
    });

    on('error', (err) => {
      const msg = String(err && err.message || err);
      const code = err && err.code;
      this.lastError = msg;
      this._log('warn', `gen ${ctx.gen}: error ${code || ''} ${msg}`);
      // minecraft-protocol emits error then end for most socket failures;
      // only settle here if no end follows (e.g. login errors).
      ctx.pendingError = { reason: `${code ? code + ': ' : ''}${msg}`, category: classifyErrorCode(code, msg) };
      ctx.errorTimer = setTimeout(() => {
        ctx.errorTimer = null;
        if (!ctx.settled && this._ctx === ctx && ctx.pendingError) {
          this._settleCtx(ctx, ctx.pendingError);
        }
      }, 250);
    });

    ctx.connectTimer = setTimeout(() => {
      ctx.connectTimer = null;
      if (ctx.settled || this._ctx !== ctx) return;
      this._log('warn', `gen ${ctx.gen}: connect timeout after ${this.settings.connectTimeoutMs}ms`);
      this.lastError = 'connect timeout';
      try { if (ctx.bot && typeof ctx.bot.quit === 'function') ctx.bot.quit(); else if (ctx.bot) ctx.bot.disconnect(); } catch (_) {}
      this._settleCtx(ctx, { reason: 'connect timeout', category: 'timeout' });
    }, this.settings.connectTimeoutMs);
  }

  /**
   * Settle a generation: clear its timers/listeners, record the disconnect, run
   * the onDisconnected hook, then decide whether to retry.
   */
  _settleCtx (ctx, info) {
    if (!ctx) ctx = this._ctx;
    if (!ctx || ctx.settled) return;
    ctx.settled = true;
    const wasLive = this._ctx === ctx;
    if (wasLive) this._ctx = null;

    if (ctx.connectTimer) { clearTimeout(ctx.connectTimer); ctx.connectTimer = null; }
    if (ctx.stableTimer) { clearTimeout(ctx.stableTimer); ctx.stableTimer = null; }
    if (ctx.errorTimer) { clearTimeout(ctx.errorTimer); ctx.errorTimer = null; }
    for (const [ev, fn] of ctx.listeners) { try { ctx.bot.removeListener(ev, fn); } catch (_) {} }
    ctx.listeners = [];
    try { if (ctx.bot && !ctx.bot.disabled) ctx.bot.disconnect && ctx.bot.disconnect(); } catch (_) {}

    const now = Date.now();
    // Session length is measured from this generation's own spawn time, not the
    // shared onlineSince: a stop() that settles an older generation must not
    // mis-measure or clobber the live one.
    const sessionMs = ctx.spawned && ctx.spawnedAt ? now - ctx.spawnedAt : null;
    this.lastDisconnect = Object.assign({ at: now, generation: ctx.gen }, info || {});
    if (wasLive) this.onlineSince = null;

    // R1: measure session length. A session shorter than stableAfterMs is a
    // failure even though the bot did spawn; otherwise a login plugin that
    // kicks us just under the stable window keeps attempt stuck at 0 forever.
    const shortSession = ctx.spawned && sessionMs !== null && sessionMs < this.settings.stableAfterMs;
    if (!ctx.spawned || shortSession) {
      this.attempt += 1;
      if (!this._firstFailureAt) this._firstFailureAt = ctx.startedAt || now;
    }
    if (shortSession) this._recordShortSession(now);

    // Give-up check uses wall-clock time since the first failure of this streak.
    if (this.settings.giveUpAfterMs > 0 && this._firstFailureAt &&
        now - this._firstFailureAt > this.settings.giveUpAfterMs) {
      // Park in WAITING first: onGiveUp may call stop()/shutdown() and those are
      // only honored (no retry scheduled) from a non-terminal state.
      this._setState(STATES.WAITING_TO_RECONNECT);
      this._log('error', 'giving up after repeated failures');
      try { this.hooks.onGiveUp(this.lastDisconnect); } catch (e) { this._log('error', `onGiveUp hook threw: ${e.message}`); }
      if (this.state === STATES.STOPPED || this.state === STATES.SHUTTING_DOWN) return;
      // Nothing asked us to stop: keep retrying at the capped delay.
      this._scheduleRetry();
      return;
    }

    try { this.hooks.onDisconnected(this.lastDisconnect); } catch (e) { this._log('error', `onDisconnected hook threw: ${e.message}`); }

    // R2: hooks may call stop()/shutdown(). Re-check before scheduling a retry
    // so a hook-driven stop is never undone by the retry path.
    if (this.state === STATES.STOPPED || this.state === STATES.SHUTTING_DOWN) {
      this._log('info', 'retry skipped: state changed inside disconnect handling');
      return;
    }
    this._scheduleRetry();
  }

  _recordShortSession (now) {
    const w = this.settings.flapWindowMs;
    this._shortSessions.push(now);
    while (this._shortSessions.length && now - this._shortSessions[0] > w) this._shortSessions.shift();
    if (!this._flapAlerted && this._shortSessions.length >= this.settings.flapThreshold) {
      this._flapAlerted = true;
      this._log('warn', `flapping detected: ${this._shortSessions.length} short sessions in ${Math.round(w / 60000)}min`);
      try { this.hooks.onFlapping({ count: this._shortSessions.length, windowMs: w }); } catch (e) { this._log('error', `onFlapping hook threw: ${e.message}`); }
    }
  }

  /** Reset the flapping detector once a long healthy session is observed. */
  noteHealthy () {
    this._shortSessions = [];
    this._flapAlerted = false;
  }

  _scheduleRetry () {
    // R2: refuse to schedule retries when stopped or shutting down.
    if (this.state === STATES.STOPPED || this.state === STATES.SHUTTING_DOWN) return;
    this._clearRetry();
    const s = this.settings;
    const exp = Math.min(s.maxDelayMs, s.baseDelayMs * Math.pow(2, Math.max(0, this.attempt - 1)));
    const jitter = 1 + (Math.random() * 2 - 1) * s.jitter;
    const delay = Math.max(0, Math.round(exp * jitter));
    this._setState(STATES.WAITING_TO_RECONNECT);
    this._retryAt = Date.now() + delay;
    this._log('info', `retrying in ${delay}ms (attempt ${this.attempt})`);
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._retryAt = null;
      if (this.state === STATES.STOPPED || this.state === STATES.SHUTTING_DOWN) return;
      this._connect();
    }, delay);
  }
}

function parseReason (reason) {
  if (!reason) return 'kicked';
  if (typeof reason === 'string') {
    try { return flattenChat(JSON.parse(reason)); } catch (_) { return reason; }
  }
  return flattenChat(reason);
}

function flattenChat (c) {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(flattenChat).join(' ');
  let out = c.text != null ? String(c.text) : (c.translate ? String(c.translate) : '');
  if (c.with) out += ' ' + c.with.map(flattenChat).join(' ');
  return out.trim();
}

function normalizeEnd (reason) {
  if (reason && typeof reason === 'object') {
    return {
      reason: String(reason.reason || reason.message || JSON.stringify(reason)),
      category: reason.category || 'socket',
      raw: reason,
    };
  }
  return { reason: String(reason || 'connection ended'), category: 'socket' };
}

function classifyErrorCode (code, msg) {
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'ETIMEDOUT' || /timed out/i.test(msg)) return 'timeout';
  if (code === 'ECONNRESET') return 'reset';
  if (/version|protocol/i.test(msg)) return 'version';
  return 'error';
}

module.exports = { ConnectionManager, STATES, parseReason, flattenChat };
