'use strict';

/**
 * Logger — bounded in-memory ring of log lines plus optional rotating files.
 *
 * Why: the old version ignored `level`, stored time without a date, and lost
 * everything on restart. Now: honor level, write ISO timestamps, and when
 * LOG_DIR is set also append to a size-capped rotating file so months of
 * unattended runs leave evidence behind.
 */

const fs = require('fs');
const path = require('path');

const LEVELS = ['debug', 'info', 'warn', 'error'];

class RotatingFile {
  constructor (dir, baseName, maxBytes = 2 * 1024 * 1024, maxFiles = 5) {
    this.dir = dir;
    this.file = path.join(dir, baseName);
    this.maxBytes = maxBytes;
    this.maxFiles = maxFiles;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    try { this.size = fs.statSync(this.file).size; } catch (_) { this.size = 0; }
  }

  write (line) {
    const buf = line + '\n';
    if (this.size + Buffer.byteLength(buf) > this.maxBytes) this._rotate();
    try {
      fs.appendFileSync(this.file, buf);
      this.size += Buffer.byteLength(buf);
    } catch (_) { /* disk full / perms: never crash the bot for logging */ }
  }

  _rotate () {
    try {
      // drop oldest, shift the rest: app.log.4 -> .5, .3 -> .4, ... app.log -> .1
      for (let i = this.maxFiles - 1; i >= 1; i--) {
        const src = `${this.file}.${i}`;
        const dst = `${this.file}.${i + 1}`;
        if (i === this.maxFiles - 1) { try { fs.rmSync(dst, { force: true }); } catch (_) {} }
        try { if (fs.existsSync(src)) fs.renameSync(src, dst); } catch (_) {}
      }
      try { fs.renameSync(this.file, `${this.file}.1`); } catch (_) {}
      this.size = 0;
    } catch (_) {}
  }
}

class Logger {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxLines=300] in-memory ring size
   * @param {string} [opts.dir] file dir (env LOG_DIR wins over this)
   */
  constructor (opts = {}) {
    this.maxLines = opts.maxLines || 300;
    this.lines = []; // { ts: Date, level, text, html }
    const dir = process.env.LOG_DIR || opts.dir || null;
    this._file = dir ? new RotatingFile(dir, 'bot.log') : null;
  }

  addLog (msg, level = 'info') {
    const lv = LEVELS.includes(level) ? level : 'info';
    const text = String(msg);
    const now = new Date();
    const entry = { ts: now.toISOString(), level: lv, text };
    this.lines.push(entry);
    if (this.lines.length > this.maxLines) this.lines.shift();
    const line = `[${entry.ts}] [${lv.toUpperCase()}] ${text}`;
    if (this._file) this._file.write(line);
    else console.log(line);
    return entry;
  }

  debug (m) { return this.addLog(m, 'debug'); }
  info (m) { return this.addLog(m, 'info'); }
  warn (m) { return this.addLog(m, 'warn'); }
  error (m) { return this.addLog(m, 'error'); }

  /** Last n entries, newest first — used by the dashboard /logs page. */
  recent (n = 100) {
    return this.lines.slice(-n).reverse();
  }
}

module.exports = { Logger, RotatingFile, LEVELS };
