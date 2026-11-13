'use strict';

/**
 * Disconnect-reason classifier (B6).
 *
 * Why normalize first: modern servers send translation keys such as
 * "multiplayer.disconnect.server_full" — the underscores broke naive phrase
 * matching, so almost everything landed in `unknown` and alerts lost detail.
 */

const RULES = [
  // category, matcher on normalized text, minDelayMs (null = manager default)
  ['banned', /banned|permanent ban/i, null],
  ['whitelist', /whitelist/i, 60000],
  ['duplicate', /duplicate login|already connected|logged in from another location|already logged/i, 30000],
  ['full', /server full|is full|slots full|queue full/i, 15000],
  ['idle', /idling|idle timeout/i, null],
  ['spam', /spam|too many connections|connection throttled|rate.?limit/i, 300000],
  ['auth', /authme|log in using|please log in|you must register|session expired|invalid password|not authenticated|took too long to log in/i, null],
  ['server-closed', /server closed|shutting down|restarting|shutdown/i, 120000],
  ['version', /outdated|vanilla client|server supports|protocol|mismatched|unsupported version|version mismatch/i, null],
  ['kick', /kicked/i, null],
];

/** Lower-case and turn `_` and `.` into spaces before matching. */
function normalizeReason (text) {
  return String(text || '').toLowerCase().replace(/[_.]/g, ' ');
}

function classifyDisconnect (reason) {
  const norm = normalizeReason(reason);
  if (!norm.trim()) return { category: 'unknown', minDelayMs: null };
  for (const [category, re, minDelayMs] of RULES) {
    if (re.test(norm)) return { category, minDelayMs };
  }
  return { category: 'unknown', minDelayMs: null };
}

module.exports = { classifyDisconnect, normalizeReason };
