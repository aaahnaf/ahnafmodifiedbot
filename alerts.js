'use strict';

/**
 * alertQueue — Discord webhook alerts with coalescing (R6) and a plain chat
 * send queue with minimum spacing (B3). No new dependencies: timers + arrays.
 */

const https = require('https');
const http = require('http');

class AlertQueue {
  /**
   * @param {object} opts
   * @param {(payload:string)=>Promise<void>} opts.send raw sender (POST to webhook)
   * @param {number} [opts.rateWindowMs=5000] messages inside this window coalesce
   *        into one combined post instead of being dropped.
   * @param {()=>number} [opts.now]
   */
  constructor (opts = {}) {
    this.send = opts.send;
    this.rateWindowMs = opts.rateWindowMs ?? 5000;
    this.maxPerMessage = opts.maxPerMessage ?? 10;
    this.now = opts.now || (() => Date.now());
    this._pending = [];
    this._timer = null;
    this._lastSentAt = -Infinity;
    this.sent = []; // record for tests/inspection
  }

  push (text) {
    const t = String(text);
    if (!t) return;
    this._pending.push(t);
    const sinceLast = this.now() - this._lastSentAt;
    const wait = this._pending.length === 1
      ? Math.max(0, this.rateWindowMs - sinceLast)
      : Math.max(0, this.rateWindowMs - (this.now() - this._flushStartedAt));
    if (!this._timer) {
      this._flushStartedAt = this.now();
      this._timer = setTimeout(() => this._flush(), wait);
      if (this._timer.unref) this._timer.unref();
    }
  }

  async _flush () {
    this._timer = null;
    const batch = this._pending.splice(0, this.maxPerMessage);
    if (!batch.length) return;
    const body = batch.length === 1 ? batch[0] : batch.map((m, i) => `${i + 1}. ${m}`).join('\n');
    this._lastSentAt = this.now();
    try {
      await this.send(body);
      this.sent.push({ at: this.now(), body });
    } catch (_) { /* alerting must never crash the bot; log line already exists */ }
    if (this._pending.length) this.push(''); // send remainder as next batch
  }

  flushNow () {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    return this._flush();
  }
}

/** Single outbound chat pipeline: everything goes through here (B3). */
class ChatQueue {
  /**
   * @param {(msg:string)=>void} deliver
   * @param {number} [minSpacingMs=1200]
   */
  constructor (deliver, minSpacingMs = 1200) {
    this.deliver = deliver;
    this.minSpacingMs = minSpacingMs;
    this._queue = [];
    this._lastSentAt = -Infinity;
    this._timer = null;
    this._drain = this._drain.bind(this);
  }

  add (msg) {
    const t = String(msg || '').trim();
    if (!t) return;
    this._queue.push(t);
    if (!this._timer) this._drain();
  }

  _drain () {
    this._timer = null;
    if (!this._queue.length) return;
    const now = Date.now();
    const wait = Math.max(0, this.minSpacingMs - (now - this._lastSentAt));
    if (wait > 0) {
      this._timer = setTimeout(this._drain, wait);
      if (this._timer.unref) this._timer.unref();
      return;
    }
    const msg = this._queue.shift();
    this._lastSentAt = now;
    try { this.deliver(msg); } catch (_) {}
    if (this._queue.length) this._timer = setTimeout(this._drain, this.minSpacingMs);
    if (this._timer && this._timer.unref) this._timer.unref();
  }
}

/**
 * Minimal webhook poster kept from the original design: timeout + Content-Length.
 * @returns {Promise<void>}
 */
function postWebhook (url, content) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const lib = u.protocol === 'http:' ? http : https;
    const payload = JSON.stringify({ content: String(content).slice(0, 1900) });
    const req = lib.request(u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 10000,
    }, (res) => {
      res.resume(); // drain so the socket can be released (B7 lesson)
      res.on('end', resolve);
    });
    req.on('timeout', () => req.destroy(new Error('webhook timeout')));
    req.on('error', reject);
    req.end(payload);
  });
}

module.exports = { AlertQueue, ChatQueue, postWebhook };
