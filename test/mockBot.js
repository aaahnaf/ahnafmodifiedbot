"use strict";

/**
 * Minimal EventEmitter-based Mineflayer-like bot used by the lifecycle tests.
 * It exposes the same surface the ConnectionManager relies on:
 *   spawn (once), kicked, error, end events + end()/quit() methods.
 */
const { EventEmitter } = require("events");

class MockBot extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.ended = false;
    this.quitCalled = false;
    this.spawned = false;
    this.entity = { position: { x: 1, y: 2, z: 3 } };
    this.version = "1.20.4";
  }
  simulateSpawn() {
    this.spawned = true;
    this.emit("spawn");
  }
  simulateKick(reason) {
    this.emit("kicked", reason, true);
  }
  simulateError(err) {
    this.emit("error", err instanceof Error ? err : new Error(String(err)));
  }
  simulateEnd(reason) {
    this.ended = true;
    this.emit("end", reason);
  }
  end(x) {
    this.ended = true; // manager cleanup calls this; do not re-emit 'end'
  }
  quit() {
    this.quitCalled = true;
  }
}

module.exports = { MockBot };
