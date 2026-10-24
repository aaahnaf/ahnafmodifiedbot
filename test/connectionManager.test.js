"use strict";

/**
 * Automated connection-lifecycle tests for ConnectionManager.
 * Run with:  npm test   (node --test)
 *
 * These use MOCKED Mineflayer-like bots and short delays — they never touch a
 * real Minecraft server. They prove the manager's state machine, backoff,
 * stale-event protection, and timer hygiene; they do NOT prove that a real
 * server accepts the connection.
 */
const test = require("node:test");
const assert = require("node:assert");
const { ConnectionManager, STATES, classifyDisconnect } = require("../connectionManager");
const { MockBot } = require("./mockBot");

const FAST_RETRY = {
  baseDelayMs: 50,
  minDelayMs: 10,
  maxDelayMs: 200,
  jitterRatio: 0,           // deterministic delays for assertions
  throttlePenaltyMs: 100,
  connectTimeoutMs: 80,
  stableAfterMs: 40,
  endWatchdogMs: 60,        // production default is 5000ms; tests shrink it
};

function makeManager(extra = {}) {
  const created = [];
  const m = new ConnectionManager({
    createFn: () => {
      const b = new MockBot(`bot${created.length + 1}`);
      created.push(b);
      return b;
    },
    retry: { ...FAST_RETRY, ...(extra.retry || {}) },
    log: () => {},
    hooks: extra.hooks || {},
  });
  return { m, created };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- */
test("1. initial connection succeeds -> ONLINE", async () => {
  const { m, created } = makeManager();
  m.start();
  assert.equal(m.state, STATES.CONNECTING);
  assert.equal(created.length, 1);
  created[0].simulateSpawn();
  assert.equal(m.state, STATES.ONLINE);
  assert.equal(m.getStatus().connected, true);
  await sleep(60); // stability timer fires
  assert.equal(m.attempt, 0);
  m.shutdown();
});

test("2. initial failure then successful retry", async () => {
  const { m, created } = makeManager();
  m.start();
  created[0].simulateEnd("server closed");
  assert.equal(m.state, STATES.WAITING_TO_RECONNECT);
  assert.equal(m.attempt, 1);
  await sleep(120); // reconnect timer fires -> gen 2
  assert.equal(created.length, 2);
  created[1].simulateSpawn();
  assert.equal(m.state, STATES.ONLINE);
  m.shutdown();
});

test("3. kicked followed by end schedules exactly ONE reconnect", async () => {
  let connectedHooks = 0;
  const { m, created } = makeManager({ hooks: { onConnected: () => connectedHooks++ } });
  try {
    m.start();
    created[0].simulateSpawn();
    await sleep(60); // become stable so attempt resets
    created[0].simulateKick("You are AFK");
    created[0].simulateEnd("kicked");
    // Deterministic wait: the manager settles gen1 and starts gen2 within a
    // bounded number of watchdog/backoff ticks. Then give it ample extra time
    // so that ANY duplicate retry would definitely have created another bot.
    await m.waitForReconnecting(2000);
    await sleep(400); // plenty of time for a duplicate attempt if one existed
    assert.equal(created.length, 2, "exactly one retry bot was created");
    assert.equal(m.state, STATES.CONNECTING); // gen2 is live and awaiting spawn
    created[1].simulateSpawn();                // prove gen2 is functional
    assert.equal(m.state, STATES.ONLINE);
    assert.equal(connectedHooks, 2);
  } finally {
    m.shutdown();
  }
});

test("4. end without kicked still reconnects", async () => {
  const { m, created } = makeManager();
  m.start();
  created[0].simulateSpawn();
  assert.equal(m.state, STATES.ONLINE); // synchronous spawn handler -> ONLINE
  created[0].simulateEnd("Connection reset by peer");
  assert.equal(m.state, STATES.WAITING_TO_RECONNECT);
  assert.equal(classifyDisconnect(m.lastError.message), "network");
  await sleep(120);
  assert.equal(created.length, 2);
  m.shutdown();
});

test("5. error WITHOUT end is settled by the end-watchdog", async () => {
  const { m, created } = makeManager({ retry: { connectTimeoutMs: 100000 } });
  try {
    m.start();
    created[0].simulateError(new Error("ETIMEDOUT connect"));
    assert.equal(m.state, STATES.CONNECTING); // waiting for end...
    await sleep(300);                         // ...watchdog settles at ~60ms (production: 5s)
    // The watchdog has settled gen1 and scheduled exactly one retry; with the
    // fast test config that retry may already have begun (CONNECTING again).
    // What must be true either way: we are NOT stuck in the old generation's
    // CONNECTING state without a pending-or-live reconnect path.
    assert.ok(
      m.state === STATES.WAITING_TO_RECONNECT || m.state === STATES.CONNECTING,
      `expected WAITING_TO_RECONNECT or CONNECTING, got ${m.state}`);
    if (m.state === STATES.CONNECTING) assert.equal(created.length, 2); // retry already fired
    assert.ok(m.attempt >= 1);
    assert.equal(m.lastError.category, "network");
  } finally {
    m.shutdown();
  }
});

test("6. connection timeout before spawn aborts that generation only", async () => {
  const { m, created } = makeManager();
  try {
    m.start();
    // never spawn gen 1
    await sleep(150); // connectTimeoutMs=80 fires
    assert.equal(m.state, STATES.WAITING_TO_RECONNECT);
    assert.equal(m.lastError.category, "timeout");
    await m.waitForReconnecting(2000); // deterministic: gen2 attempt has begun
    assert.equal(created.length, 2);
    created[1].simulateSpawn();
    assert.equal(m.state, STATES.ONLINE);
  } finally {
    m.shutdown();
  }
});

test("7. old bot 'end' after replacement cannot kill the newer connection", async () => {
  const { m, created } = makeManager();
  m.start();
  created[0].simulateEnd("bye");            // gen1 terminal -> retry scheduled
  await sleep(120);                          // gen2 created
  assert.equal(created.length, 2);
  created[1].simulateSpawn();
  const stateBefore = m.state;
  created[0].simulateEnd("late stale end"); // stale event from dead gen
  created[0].emit("kicked", "stale kick");
  assert.equal(m.state, stateBefore);       // unchanged - stale ignored
  assert.equal(m.generation, 2);
  m.shutdown();
});

test("8. rapid-fire disconnect events schedule only one retry", async () => {
  const { m, created } = makeManager();
  try {
    m.start();
    created[0].simulateSpawn();
    created[0].simulateError(new Error("ECONNRESET"));
    created[0].simulateKick("kick storm");
    created[0].simulateEnd("end storm");
    created[0].simulateEnd("double end");
    // Deterministic: wait until gen2 attempt has actually begun, then give a
    // large extra window so any duplicate retry would definitely show up as an
    // extra bot. The assertion is unchanged - one settle, one retry, one bot.
    await m.waitForReconnecting(2000);
    await sleep(400);
    assert.equal(created.length, 2, "one retry only despite event storm");
  } finally {
    m.shutdown();
  }
});

test("9. server offline for several cycles, then returns", async () => {
  const { m, created } = makeManager({ retry: { baseDelayMs: 20, maxDelayMs: 100 } });
  try {
    m.start();
    // three consecutive failures
    for (let i = 0; i < 3; i++) {
      await m.waitForReconnecting(2000); // deterministic: new attempt live
      created[created.length - 1].simulateEnd("ECONNREFUSED");
    }
    assert.ok(m.attempt >= 3, "failure counter grows while server down");
    await m.waitForReconnecting(2000);   // the recovery attempt
    created[created.length - 1].simulateSpawn();
    await sleep(60);
    assert.equal(m.state, STATES.ONLINE);
    assert.equal(m.attempt, 0, "counter reset after stable session");
  } finally {
    m.shutdown();
  }
});

test("10. manual stop cancels pending reconnect and prevents retries", async () => {
  const { m, created } = makeManager();
  m.start();
  created[0].simulateEnd("gone");
  assert.equal(m.state, STATES.WAITING_TO_RECONNECT);
  m.stop();
  assert.equal(m.state, STATES.STOPPED);
  assert.equal(m._liveTimers(), 0, "no timers left after stop");
  await sleep(200);
  assert.equal(created.length, 1, "no retry bot created after stop");
});

test("11. start works again after manual stop", async () => {
  const { m, created } = makeManager();
  m.start();
  created[0].simulateSpawn();
  m.stop();
  m.start();
  assert.equal(m.state, STATES.CONNECTING);
  assert.equal(created.length, 2);
  created[1].simulateSpawn();
  assert.equal(m.state, STATES.ONLINE);
  m.shutdown();
});

test("12. repeated start() calls never create duplicate instances", async () => {
  const { m, created } = makeManager();
  m.start();
  m.start();
  m.start();
  created[0].simulateSpawn();
  m.start(); // while ONLINE
  await sleep(60);
  m.start(); // while WAITING would be handled too
  assert.equal(created.length, 1);
  m.shutdown();
});

test("13. shutdown clears ALL timers", async () => {
  const { m, created } = makeManager();
  m.start();
  created[0].simulateSpawn();
  assert.ok(m._liveTimers() > 0); // connect watchdog cleared, stable timer live
  m.shutdown();
  assert.equal(m.state, STATES.SHUTTING_DOWN);
  assert.equal(m._liveTimers(), 0);
  await sleep(150);
  assert.equal(created.length, 1, "nothing fires after shutdown");
});

test("14. stable session produces no voluntary disconnects / extra bots", async () => {
  const { m, created } = makeManager({ retry: { connectTimeoutMs: 300, stableAfterMs: 40 } });
  m.start();
  created[0].simulateSpawn();
  await sleep(500); // longer than the connect timeout: must NOT be aborted
  assert.equal(m.state, STATES.ONLINE);
  assert.equal(created.length, 1);
  assert.equal(m.attempt, 0);
  m.shutdown();
});

test("15. exponential backoff grows and caps at maxDelay", () => {
  const { m } = makeManager({ retry: { baseDelayMs: 100, maxDelayMs: 800, minDelayMs: 10, jitterRatio: 0 } });
  const delays = [];
  for (let a = 1; a <= 6; a++) {
    m.attempt = a;
    delays.push(m._computeBackoffDelay());
  }
  assert.deepEqual(delays, [100, 200, 400, 800, 800, 800]);
  m.shutdown();
});

test("16. throttle detection extends the next delay once", () => {
  const { m } = makeManager({ retry: { baseDelayMs: 100, maxDelayMs: 1000, minDelayMs: 10, jitterRatio: 0, throttlePenaltyMs: 300 } });
  m.wasThrottled = true;
  m.attempt = 1;
  const d1 = m._computeBackoffDelay();
  assert.equal(d1, 400);          // 100 + 300 penalty
  assert.equal(m.wasThrottled, false);
  const d2 = m._computeBackoffDelay();
  assert.equal(d2, 100);          // penalty consumed
  m.shutdown();
});

test("17. permanent failures (auth/ban/whitelist/version) slow to max, keep retrying", async () => {
  const { m, created } = makeManager({ retry: { baseDelayMs: 20, maxDelayMs: 100, connectTimeoutMs: 100000 } });
  m.start();
  for (let i = 0; i < 6; i++) {
    await sleep(130);
    created[created.length - 1].simulateKick("Invalid username or password");
    created[created.length - 1].simulateEnd({ reason: "Invalid username or password" });
  }
  assert.equal(m.lastError.category, "auth");
  assert.equal(m.state, STATES.WAITING_TO_RECONNECT, "still retries, capped - does not flood");
  assert.ok(m.attempt >= 6);
  m.shutdown();
});

test("18. synchronous createFn failure enters the retry system", async () => {
  let n = 0;
  const m = new ConnectionManager({
    createFn: () => {
      n++;
      if (n === 1) throw new Error("bad config");
      const b = new MockBot("ok");
      return b;
    },
    retry: FAST_RETRY,
    log: () => {},
  });
  m.start();
  assert.equal(m.state, STATES.WAITING_TO_RECONNECT);
  await sleep(120);
  const bot = m.bot;
  assert.ok(bot);
  bot.simulateSpawn();
  assert.equal(m.state, STATES.ONLINE);
  m.shutdown();
});

test("19. classifyDisconnect covers all required categories", () => {
  assert.equal(classifyDisconnect("Invalid session"), "auth");
  assert.equal(classifyDisconnect("You are whitelisted? no"), "whitelist");
  assert.equal(classifyDisconnect("You are banned"), "ban");
  assert.equal(classifyDisconnect("Outdated client! This server requires 1.20.5"), "version");
  assert.equal(classifyDisconnect("Server full"), "rejected");
  assert.equal(classifyDisconnect("wait before reconnecting you are connecting too fast"), "throttle");
  assert.equal(classifyDisconnect("ECONNRESET"), "network");
  assert.equal(classifyDisconnect(""), "unknown");
});

test("20. getStatus reports accurate dashboard fields", async () => {
  const { m, created } = makeManager();
  m.start();
  created[0].simulateSpawn();
  await sleep(60);
  const st = m.getStatus();
  assert.equal(st.state, STATES.ONLINE);
  assert.equal(st.connected, true);
  assert.equal(st.generation, 1);
  assert.ok(st.sessionUptimeSec >= 0);
  m.shutdown();
});
