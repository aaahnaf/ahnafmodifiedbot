'use strict';

/**
 * Behavior rules used by index.js modules, extracted so they are unit-testable
 * without a live bot (B1, B2, B3, B4, B8).
 */

// ---------------------------------------------------------------------------
// B1: combat / avoid-mobs entity selection
// ---------------------------------------------------------------------------

// Entities that must never be attacked or fled from even though minecraft-data
// labels them hostile (or "mob"): friendly/golem/utility/passive-lookalikes.
const ENTITY_DENYLIST = new Set([
  'iron_golem', 'snow_golem', 'allay', 'villager', 'wandering_trader',
  'armor_stand', 'painting', 'item_frame', 'glow_item_frame',
  'boat', 'chest_boat', 'oak_boat', 'spruce_boat', 'birch_boat', 'jungle_boat',
  'acacia_boat', 'dark_oak_boat', 'minecart', 'chest_minecart', 'furnace_minecart',
  'hopper_minecart', 'tnt_minecart', 'command_block_minecart', 'player',
  // Piglin-brutes style neutral mobs that retaliate hard; not worth the fight.
  'enderman', 'zombified_piglin', 'piglin', 'piglin_brute',
]);

/**
 * Pick attack/flee targets. Uses `hostile` (the real mob type in modern
 * minecraft-data); `mob` only matches a handful of special entities.
 * @param {object[]} entities bot.entities array
 * @param {{allowNames?: string[]}} [opts]
 */
function selectTargets (entities, opts = {}) {
  const allow = Array.isArray(opts.allowNames) && opts.allowNames.length
    ? new Set(opts.allowNames) : null;
  return (entities || []).filter((e) => {
    if (!e || !e.name) return false;
    if (ENTITY_DENYLIST.has(e.name)) return false;
    if (allow) return allow.has(e.name);
    return e.type === 'hostile';
  });
}

// ---------------------------------------------------------------------------
// B2: auto-auth state machine matchers
// ---------------------------------------------------------------------------

const AUTH_PROMPT_RE = /\/(register|login)\b/i;
const AUTH_PROMPT_EXTRA = [
  /please (?:log ?in|register|authenticate)/i,
  /use \/auth/i,
  /you need to (?:log ?in|register|authenticate)/i,
  /type \/register/i,
  /register with/i,
  /log in with/i,
];
const AUTH_SUCCESS_RE = /(logged(?:ing)? in successfully|successfully logged in|authenticated|welcome back|has joined\.)|(you are now logged in)/i;
const AUTH_ALREADY_REGISTERED_RE = /already registered|already have an account|you are already registered/i;
const AUTH_NEED_REGISTER_RE = /(not registered|please register|first time|use \/register|need to register)/i;
const AUTH_WRONG_CREDENTIALS_RE = /(wrong password|invalid (?:password|credentials)|incorrect password|session expired|time.?out while logging|you are not logged in)/i;

/** Does this chat line ask the player to log in or register? */
function isAuthPrompt (msg) {
  const t = String(msg || '');
  if (AUTH_PROMPT_RE.test(t)) return true;
  return AUTH_PROMPT_EXTRA.some((re) => re.test(t));
}

function authOutcomeOf (msg) {
  const t = String(msg || '');
  if (AUTH_ALREADY_REGISTERED_RE.test(t)) return 'already-registered';
  if (AUTH_SUCCESS_RE.test(t)) return 'success';
  if (AUTH_NEED_REGISTER_RE.test(t)) return 'need-register';
  if (AUTH_WRONG_CREDENTIALS_RE.test(t)) return 'failure';
  return null;
}

/**
 * Small state machine: idle -> sending -> (success | retry | switch-command).
 * Retries up to `maxTries` times with `retryMs` spacing (the caller owns timers).
 */
class AuthStateMachine {
  constructor ({ maxTries = 3, firstCommand = 'register' } = {}) {
    this.maxTries = maxTries;
    this.command = firstCommand; // 'register' | 'login'
    this.state = 'idle';         // idle | sending | done | failed
    this.tries = 0;
    this.outcome = null;
  }

  reset () {
    this.state = 'idle';
    this.tries = 0;
    this.outcome = null;
  }

  /** Called when a prompt is seen. Returns the command to send or null. */
  onPrompt () {
    if (this.state === 'done' || this.state === 'failed') return null;
    if (this.tries >= this.maxTries) { this.state = 'failed'; this.outcome = 'no-response'; return null; }
    this.tries += 1;
    this.state = 'sending';
    return this.command;
  }

  /** Called for every chat line after sending. Returns the outcome or null. */
  onResponse (msg) {
    const o = authOutcomeOf(msg);
    if (!o) return null;
    if (o === 'success') { this.state = 'done'; this.outcome = 'success'; return 'success'; }
    if (o === 'already-registered' && this.command === 'register') {
      this.command = 'login'; // switch and let caller resend via onPrompt()
      return 'switch';
    }
    if (o === 'need-register' && this.command === 'login') {
      this.command = 'register';
      return 'switch';
    }
    if (this.tries >= this.maxTries) { this.state = 'failed'; this.outcome = o; return 'failed'; }
    return 'retry';
  }
}

// ---------------------------------------------------------------------------
// B3/B4: chat helpers
// ---------------------------------------------------------------------------

const GREETING_RE = /\b(hi|hello|hey)\b/i;

/** Word-boundary greeting test ("this is great" must NOT match). */
function isGreeting (msg) {
  return GREETING_RE.test(String(msg || ''));
}

class Cooldown {
  constructor ({ globalMs = 30000, perUserMs = 5 * 60000 } = {}) {
    this.globalMs = globalMs;
    this.perUserMs = perUserMs;
    this.lastGlobal = 0;
    this.perUser = new Map();
  }

  /** True if a reply may be sent now; records the send. */
  allow (user, now = Date.now()) {
    if (now - this.lastGlobal < this.globalMs) return false;
    const last = this.perUser.get(user) || 0;
    if (now - last < this.perUserMs) return false;
    this.lastGlobal = now;
    this.perUser.set(user, now);
    // keep the map bounded (months of uptime, many players)
    if (this.perUser.size > 1000) {
      const cutoff = now - this.perUserMs;
      for (const [k, v] of this.perUser) if (v < cutoff) this.perUser.delete(k);
    }
    return true;
  }
}

/** B4: !tp-style admin chat commands are allowed only for listed users. */
function canRunChatCommand (senderName, allowedUsers) {
  const list = Array.isArray(allowedUsers) ? allowedUsers : [];
  if (list.length === 0) return false; // default off
  return list.some((u) => String(u).toLowerCase() === String(senderName || '').toLowerCase());
}

// ---------------------------------------------------------------------------
// B8: auto-eat food filter
// ---------------------------------------------------------------------------

const HARMFUL_FOODS = new Set([
  'rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish',
  'raw_chicken', 'chorus_fruit',
]);

function isSafeFood (itemName, foodPoints) {
  if (!(foodPoints > 0)) return false;
  return !HARMFUL_FOODS.has(String(itemName || ''));
}

module.exports = {
  ENTITY_DENYLIST,
  selectTargets,
  isAuthPrompt,
  authOutcomeOf,
  AuthStateMachine,
  isGreeting,
  Cooldown,
  canRunChatCommand,
  isSafeFood,
};
