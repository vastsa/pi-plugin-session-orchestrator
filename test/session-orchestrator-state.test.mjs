import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { clone, deferred, pluginRoot } from "./session-orchestrator.harness.mjs";

const require = createRequire(import.meta.url);
const { createReferenceStore } = require(join(pluginRoot, "state.js"));

test("settings read failures never replace durable metadata with an empty snapshot", async () => {
  let writes = 0;
  await assert.rejects(createReferenceStore({
    getSettings: async () => { throw new Error("read unavailable"); },
    setSettings: async () => { writes += 1; },
  }), /read unavailable/);
  assert.equal(writes, 0);
});

test("legacy migration keeps both Session ID shapes and discards report guesses", async () => {
  let saved;
  const store = await createReferenceStore({
    getSettings: async () => ({ version: 2, workers: [
      { workerSessionId: "legacy", parentSessionId: "parent", title: "Old", report: "stale", status: "completed" },
      { sessionId: "canonical", parentSessionId: "parent", title: "Canonical", acceptanceStatus: "accepted" },
      null,
    ] }),
    setSettings: async (value) => { saved = clone(value); },
  });
  assert.deepEqual(store.list("parent").map((entry) => entry.sessionId), ["canonical", "legacy"]);
  assert.equal(saved.version, 3);
  assert.deepEqual(saved.workers, []);
  assert.ok(saved.sessions.every((entry) => !("status" in entry) && !("report" in entry)));
  assert.deepEqual(saved.acceptances, []);
});

test("serial writes publish references only after persistence and recover from a failed earlier write", async () => {
  const first = deferred();
  const entered = deferred();
  const writes = [];
  let attempts = 0;
  const store = await createReferenceStore({
    getSettings: async () => ({ version: 3, sessions: [], acceptances: [] }),
    setSettings: async (value) => {
      attempts += 1;
      if (attempts === 1) { entered.resolve(); await first.promise; }
      writes.push(clone(value));
    },
  });
  const failed = store.remember("first", "parent", "First");
  const rejection = assert.rejects(failed, /disk failure/);
  await entered.promise;
  const succeeding = store.remember("second", "parent", "Second");
  assert.deepEqual(store.list(), []);
  first.reject(new Error("disk failure"));
  await rejection;
  await succeeding;
  await store.flush();
  assert.deepEqual(store.list().map((entry) => entry.sessionId), ["second"]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].sessions[0].sessionId, "second");
});

test("bounded reference history and exact-message notes remain independent", async () => {
  let saved;
  const sessions = Array.from({ length: 256 }, (_, index) => ({ sessionId: `session-${index}`, title: "Session", referencedBy: ["parent"] }));
  const store = await createReferenceStore({
    getSettings: async () => ({ version: 3, sessions, acceptances: [] }),
    setSettings: async (value) => { saved = clone(value); },
  });
  await store.accept([{ sessionId: "session-0", messageId: "delivery-0", acceptedBySessionId: "parent", note: "Reviewed" }]);
  await store.remember("latest", "parent", "Latest");
  assert.equal(saved.sessions.length, 256);
  assert.equal(store.list().some((entry) => entry.sessionId === "session-0"), false);
  assert.equal(store.accepted("session-0", "delivery-0", "parent").note, "Reviewed");
  assert.equal(store.accepted("session-0", "delivery-new", "parent"), undefined);
  assert.equal(store.accepted("session-0", "delivery-0", "other"), undefined);
});
