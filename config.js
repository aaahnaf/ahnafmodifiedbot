'use strict';

/**
 * config.js — load, validate and normalize settings (B5, S2).
 *
 * Why: index.js used to read config.modules.* etc. without checks; a missing
 * section threw inside the onConnected hook and silently disabled every module.
 * Now everything is normalized with defaults here, environment overrides are
 * applied once, and an invalid file exits at startup with a clear message.
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  bot: {
    username: 'AfkBot',
    server: 'localhost',
    port: 25565,
    version: false,
    auth: 'offline',
  },
  modules: {
    'anti-afk': true,
    'auto-eat': false,
    combat: false,
    'avoid-mobs': false,
    'circle-walk': false,
    greeting: false,
    'chat-messages': false,
    'console-commands': true,
    'auto-auth': false,
  },
  connection: {
    connectTimeoutMs: 20000,
    stableAfterMs: 30000,
    baseDelayMs: 1000,
    maxDelayMs: 300000,
    jitter: 0.2,
    giveUpAfterMs: 0,
  },
  health: { graceSeconds: 300 },
  watchdog: { intervalSeconds: 30, eventLoopLagMs: 5000, lagConsecutiveChecks: 3 },
  restart: { maxMemoryMb: 512, intervalHours: 0 },
  alerts: { offlineMinutes: 10, flappingThreshold: 5, flappingWindowMinutes: 10 },
  utils: {
    packetSilenceSeconds: 90,
    autoReconnect: true,
    'auto-auth': { password: '', command: '/login {password}' },
  },
  combat: { targetNames: [] },
  chat: {
    allowedUsers: [],
    greetingCooldownGlobalSeconds: 30,
    greetingCooldownPerUserSeconds: 300,
  },
  autoEat: { healthThreshold: 14 },
};

function isObj (v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/** Deep merge where `over` wins; arrays replace instead of merging. */
function merge (base, over) {
  const out = Object.assign({}, base);
  for (const k of Object.keys(over || {})) {
    const v = over[k];
    if (isObj(v) && isObj(base[k])) out[k] = merge(base[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

class ConfigError extends Error {}

function expectNum (cfg, keyPath, min, max) {
  const [sec, key] = keyPath.split('.');
  const v = cfg[sec] && cfg[sec][key];
  if (v === undefined) return;
  if (typeof v !== 'number' || Number.isNaN(v) || (min !== undefined && v < min) || (max !== undefined && v > max)) {
    throw new ConfigError(`settings.${keyPath} must be a number in [${min}, ${max === undefined ? '∞' : max}], got ${JSON.stringify(v)}`);
  }
}

function expectBool (cfg, keyPath) {
  const [sec, key] = keyPath.split('.');
  const v = cfg[sec] && cfg[sec][key];
  if (v !== undefined && typeof v !== 'boolean') {
    throw new ConfigError(`settings.${keyPath} must be true/false, got ${JSON.stringify(v)}`);
  }
}

function expectStr (cfg, keyPath) {
  const [sec, key] = keyPath.split('.');
  const v = cfg[sec] && cfg[sec][key];
  if (v !== undefined && typeof v !== 'string') {
    throw new ConfigError(`settings.${keyPath} must be a string`);
  }
}

function expectArr (cfg, keyPath) {
  const [sec, key] = keyPath.split('.');
  const v = cfg[sec] && cfg[sec][key];
  if (v !== undefined && !Array.isArray(v)) {
    throw new ConfigError(`settings.${keyPath} must be an array`);
  }
}

/** Accept both "kebab-case" (as delivered) and camelCase keys. */
function canonicalize (raw) {
  const out = {};
  for (const [section, val] of Object.entries(raw || {})) {
    let v = val;
    if (isObj(v)) {
      v = {};
      for (const [k, kk] of Object.entries(val)) {
        const camel = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        v[camel] = kk;
      }
    }
    out[section] = v;
  }
  // nested auto-auth lives under utils in the delivered file
  if (out.utils && out.utils.autoAuth) out.utils['auto-auth'] = out.utils.autoAuth;
  return out;
}

function applyEnv (cfg) {
  // Secrets come from the environment; env wins over the file (S2).
  if (process.env.AUTH_PASSWORD) cfg.utils['auto-auth'].password = process.env.AUTH_PASSWORD;
  if (process.env.BOT_USERNAME) cfg.bot.username = process.env.BOT_USERNAME;
  if (process.env.MC_SERVER) cfg.bot.server = process.env.MC_SERVER;
  if (process.env.MC_PORT) cfg.bot.port = Number(process.env.MC_PORT);
  if (process.env.MC_VERSION) cfg.bot.version = process.env.MC_VERSION;
  return cfg;
}

function validate (cfg) {
  expectStr(cfg, 'bot.username');
  expectStr(cfg, 'bot.server');
  expectNum(cfg, 'bot.port', 1, 65535);
  expectNum(cfg, 'connection.connectTimeoutMs', 1000, 600000);
  expectNum(cfg, 'connection.stableAfterMs', 1000, 3600000);
  expectNum(cfg, 'connection.baseDelayMs', 100, 600000);
  expectNum(cfg, 'connection.maxDelayMs', 1000, 86400000);
  expectNum(cfg, 'connection.jitter', 0, 0.9);
  expectNum(cfg, 'connection.giveUpAfterMs', 0, 604800000);
  expectNum(cfg, 'health.graceSeconds', 0, 86400);
  expectNum(cfg, 'watchdog.intervalSeconds', 5, 3600);
  expectNum(cfg, 'watchdog.eventLoopLagMs', 500, 600000);
  expectNum(cfg, 'restart.maxMemoryMb', 32, 1048576);
  expectNum(cfg, 'restart.intervalHours', 0, 8760);
  expectNum(cfg, 'alerts.offlineMinutes', 1, 1440);
  expectNum(cfg, 'utils.packetSilenceSeconds', 0, 3600);
  expectBool(cfg, 'modules.anti-afk');
  expectBool(cfg, 'modules.combat');
  expectBool(cfg, 'modules.greeting');
  expectBool(cfg, 'modules.console-commands');
  expectBool(cfg, 'modules.auto-auth');
  expectBool(cfg, 'utils.autoReconnect');
  expectArr(cfg, 'combat.targetNames');
  expectArr(cfg, 'chat.allowedUsers');
  if (cfg.utils['auto-auth'].password !== undefined && typeof cfg.utils['auto-auth'].password !== 'string') {
    throw new ConfigError('settings.utils.auto-auth.password must be a string (prefer env AUTH_PASSWORD)');
  }
  if (!cfg.bot.username || !/^[A-Za-z0-9_]{1,16}$/.test(cfg.bot.username)) {
    throw new ConfigError(`settings.bot.username "${cfg.bot.username}" is not a valid Minecraft name`);
  }
  if (!cfg.bot.server) throw new ConfigError('settings.bot.server is required');
  return cfg;
}

/**
 * @param {string} [p] path; default env SETTINGS_PATH or ./settings.json
 * @param {{exitOnInvalid?: boolean}} [opts]
 */
function loadConfig (p, opts = {}) {
  const file = p || process.env.SETTINGS_PATH || path.join(__dirname, 'settings.json');
  let raw = {};
  if (fs.existsSync(file)) {
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      const msg = `settings file ${file} is not valid JSON: ${err.message}`;
      if (opts.exitOnInvalid !== false) die(msg);
      throw new ConfigError(msg);
    }
  } else if (p || process.env.SETTINGS_PATH) {
    // An explicitly requested file that does not exist is a mistake worth failing on.
    const msg = `settings file not found: ${file}`;
    if (opts.exitOnInvalid !== false) die(msg);
    throw new ConfigError(msg);
  }
  const cfg = validate(applyEnv(merge(DEFAULTS, canonicalize(raw))));
  cfg._source = file;
  return cfg;
}

function die (msg) {
  console.error(`[config] FATAL: ${msg}`);
  process.exit(1);
}

module.exports = { loadConfig, merge, validate, canonicalize, DEFAULTS, ConfigError };
