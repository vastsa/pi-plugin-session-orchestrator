import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clone, deferred, delay, loadHarness, model, pluginRoot, prefix } from "./session-orchestrator.harness.mjs";

const manifest = JSON.parse(readFileSync(join(pluginRoot, "manifest.json"), "utf8"));
const rejectsCode = (code) => (error) => error.code === code;

test("manifest and registration share the bounded reviewed tool schema", async (t) => {
  const h = await loadHarness(t);
  assert.equal(manifest.version, "0.6.0");
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, "pi.session-orchestrator");
  assert.deepEqual(manifest.permissions, ["agent.tool.register", "desktop.control", "models.list"]);
  const descriptor = manifest.contributes.agentTools[0];
  assert.deepEqual(h.registered.tool.schema, descriptor.schema);
  assert.equal(h.registered.tool.description, descriptor.description);
  assert.equal(descriptor.risk, "high");
  assert.deepEqual(descriptor.schema.properties.action.enum,
    ["spawn", "send", "supervise", "status", "wait", "result", "accept", "cancel", "list", "models"]);
  for (const locale of ["en", "zh-CN"]) {
    assert.ok(manifest.i18n[locale].description);
    assert.ok(manifest.i18n[locale].safetyNotes);
  }
  assert.equal(descriptor.schema.properties.timeoutMs.maximum, 45_000);
  assert.equal(descriptor.schema.properties.note.maxLength, 4_096);
  assert.equal(descriptor.schema.additionalProperties, false);
  assert.match(manifest.engines.piDesktop, /^>=0\.14\.7/);

  assert.equal("ui" in manifest, false);
  assert.equal("commands" in manifest.contributes, false);
  assert.equal(h.registered.command, null);
});


test("parallel spawn uses atomic host deliveries, model eligibility and original Session IDs", async (t) => {
  const h = await loadHarness(t);
  let active = 0;
  let maximum = 0;
  h.beforeInvoke = async ({ operation }) => {
    if (operation !== prefix + "spawn") return;
    maximum = Math.max(maximum, ++active);
    await delay(10);
    active -= 1;
  };
  const spawned = await Promise.all(["Frontend", "Electron", "Rust"].map((title) =>
    h.execute({ action: "spawn", task: `Review ${title}`, title })));
  assert.ok(maximum >= 2);
  assert.equal(new Set(spawned.map((entry) => entry.sessionId)).size, 3);
  for (const entry of spawned) {
    assert.equal(entry.status, "queued");
    assert.ok(entry.messageId);
    assert.equal(entry.requestedModel, "allowed/claude-sonnet-4-6");
    assert.equal(entry.modelSelection, "delegation");
    assert.equal("workerId" in entry, false);
    assert.equal(h.messages.get(entry.messageId).sourceSessionId, "parent");
  }
  const creates = h.calls.filter((call) => call.operation === prefix + "spawn");
  assert.equal(creates.length, 3);
  assert.ok(creates.every((call) => call.args[0].modelKey === "allowed/claude-sonnet-4-6"));
  assert.ok(creates.every((call) => !('confirm' in call) && !('sourceSessionId' in call.args[0])));
  assert.equal(h.calls.some((call) => ["session/create", "session/get", "agent/prompt"].includes(call.operation)), false);
  assert.equal(h.settings.sessions.length, 3);
  assert.equal(h.settings.sessions.some((entry) => "status" in entry || "report" in entry), false);
  const callCount = h.calls.length;
  await delay(30);
  assert.equal(h.calls.length, callCount, "automatic notifications require no plugin polling");
});

test("any existing session supports bidirectional messages without reselecting models", async (t) => {
  const h = await loadHarness(t);
  const first = await h.execute({ action: "send", sessionId: "existing", message: "Research", kind: "task", idempotencyKey: "retry-one" });
  const reply = await h.execute({ action: "send", sessionId: "parent", message: "Progress", notifyOnCompletion: false }, { sessionId: "existing" });
  assert.equal(h.messages.get(first.messageId).sourceSessionId, "parent");
  assert.equal(h.messages.get(reply.messageId).sourceSessionId, "existing");
  assert.equal(h.messages.get(reply.messageId).notifyOnCompletion, false);
  assert.equal(h.sessions.get("existing").modelKey, "existing/unchanged");
  assert.equal(h.modelReads, 0);
  assert.equal(h.calls.at(-1).args[0].notifyOnCompletion, false);
  await assert.rejects(h.execute({ action: "send", sessionId: "existing", message: "Change it", model: "default/general" }), rejectsCode("INVALID_ARGUMENT"));
  await assert.rejects(h.execute({ action: "send", sessionId: "existing", message: "Forged completion", kind: "completion" }), rejectsCode("INVALID_ARGUMENT"));
  assert.equal(h.calls.filter((entry) => entry.operation === prefix + "spawn").length, 0);
});

test("list discovers independent top-level sessions without turning plugin history into authority", async (t) => {
  const h = await loadHarness(t);
  const listed = await h.execute({ action: "list" });
  assert.ok(listed.sessions.some((entry) => entry.sessionId === "other"));
  assert.ok(listed.sessions.some((entry) => entry.sessionId === "peer"));
  assert.equal(listed.sessions.find((entry) => entry.sessionId === "other").createdBySession, undefined);

  const spawned = await h.execute({ action: "spawn", task: "Create a linked session", title: "Linked" });
  const refreshed = await h.execute({ action: "list" });
  const linked = refreshed.sessions.find((entry) => entry.sessionId === spawned.sessionId);
  assert.deepEqual(linked.createdBySession, { sessionId: "parent", title: "parent" });
  assert.equal(refreshed.workers[0].sessionId, spawned.sessionId);
});

test("model catalog changes are observed before each new spawn", async (t) => {
  const h = await loadHarness(t);
  const catalog = await h.execute({ action: "models" });
  assert.equal(catalog.defaultModel, "default/general");
  assert.equal(catalog.automaticCandidates[0].alias, "Review");
  const first = await h.execute({ action: "spawn", task: "Inspect", model: "Review" });
  h.models = [model("new/default", { isDefault: true })];
  const second = await h.execute({ action: "spawn", task: "Inspect again" });
  assert.equal(first.requestedModel, "allowed/claude-sonnet-4-6");
  assert.equal(second.requestedModel, "new/default");
  assert.equal(second.modelSelection, "default");
  const before = h.calls.length;
  await assert.rejects(h.execute({ action: "spawn", task: "Impossible", model: "missing" }), rejectsCode("MODEL_NOT_FOUND"));
  assert.equal(h.calls.length, before);
});

test("the host creation limit remains authoritative while workers can reply", async (t) => {
  const h = await loadHarness(t);
  const spawned = await h.execute({ action: "spawn", task: "Independent research" });
  await assert.rejects(h.execute({ action: "spawn", task: "Nested expansion" }, { sessionId: spawned.sessionId }), rejectsCode("LIMIT_EXCEEDED"));
  const reply = await h.execute({ action: "send", sessionId: "parent", message: "My findings" }, { sessionId: spawned.sessionId });
  assert.equal(reply.sessionId, "parent");
});

test("status and result use host outcomes and never accept intermediate failure output", async (t) => {
  const h = await loadHarness(t);
  const receipt = await h.execute({ action: "send", sessionId: "existing", message: "Investigate" });
  h.complete(receipt.messageId, "An intermediate assistant progress paragraph", "failed");
  const status = await h.execute({ action: "status", sessionIds: ["existing"] });
  assert.equal(status.workers[0].status, "failed");
  assert.equal(status.workers[0].currentTask.senderSession.sessionId, "parent");
  const result = await h.execute({ action: "result", sessionId: "existing" });
  assert.equal(result.message.status, "failed");
  assert.equal(result.worker.report, undefined);
  assert.match(result.worker.error, /terminal failure/);
  await assert.rejects(h.execute({ action: "accept", sessionId: "existing" }), rejectsCode("WORKER_NOT_READY"));
  assert.deepEqual(h.settings.acceptances, []);
});

test("specific message and turn selectors keep completed results separate from new work", async (t) => {
  const h = await loadHarness(t);
  const first = await h.execute({ action: "send", sessionId: "existing", message: "First task" });
  h.complete(first.messageId, "Verified first result");
  const accepted = await h.execute({ action: "accept", sessionId: "existing", messageId: first.messageId, note: "Checked evidence" });
  assert.equal(accepted.acceptances[0].messageId, first.messageId);
  const second = await h.execute({ action: "send", sessionId: "existing", message: "Follow-up in the same context" });
  assert.notEqual(second.messageId, first.messageId);
  const firstResult = await h.execute({ action: "result", sessionId: "existing", turnId: first.turnId });
  assert.equal(firstResult.worker.report, "Verified first result");
  const latest = await h.execute({ action: "result", sessionId: "existing" });
  assert.equal(latest.message.id, second.messageId);
  assert.equal(latest.ready, false);
  assert.equal(latest.worker.report, undefined);
  const status = await h.execute({ action: "status", sessionId: "existing" });
  assert.equal(status.workers[0].acceptanceStatus, "pending");
  assert.equal(h.settings.acceptances[0].messageId, first.messageId);
  assert.equal(h.sessions.size, 4, "follow-up must not create another session");
});

test("a concurrent follow-up cannot redirect acceptance to the new delivery", async (t) => {
  const h = await loadHarness(t);
  const first = await h.execute({ action: "send", sessionId: "existing", message: "First" });
  h.complete(first.messageId, "Final first result");
  const observed = deferred();
  const release = deferred();
  h.beforeInvoke = async ({ operation }) => {
    if (operation === prefix + "result") {
      const message = clone(h.messages.get(first.messageId));
      observed.resolve();
      await release.promise;
      return { ready: true, message };
    }
  };
  const accepting = h.execute({ action: "accept", sessionId: "existing" });
  await observed.promise;
  const second = await h.execute({ action: "send", sessionId: "existing", message: "Second" });
  release.resolve();
  const accepted = await accepting;
  assert.equal(accepted.acceptances[0].messageId, first.messageId);
  assert.equal(h.settings.acceptances.some((entry) => entry.messageId === second.messageId), false);
});

test("cancel addresses the original Session ID without a relationship guard", async (t) => {
  const h = await loadHarness(t);
  const receipt = await h.execute({ action: "send", sessionId: "existing", message: "Long task" });
  const cancelled = await h.execute({ action: "cancel", sessionId: "existing" });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.sessionRetained, true);
  assert.equal(h.messages.get(receipt.messageId).status, "cancelled");
  assert.equal(h.calls.filter((entry) => entry.operation === prefix + "cancel").length, 1);
  assert.ok(h.sessions.has("existing"));
  assert.equal(h.calls.some((entry) => entry.operation.includes("delete")), false);
});


test("wait observes its whole deadline even when a host status read never settles", async (t) => {
  const h = await loadHarness(t);
  const blocked = deferred();
  h.beforeInvoke = ({ operation }) => operation === prefix + "status" ? blocked.promise : undefined;
  const began = performance.now();
  const waited = await h.execute({ action: "wait", sessionIds: ["existing"], timeoutMs: 25 });
  assert.equal(waited.timedOut, true);
  assert.ok(performance.now() - began < 400, "wait must not wait for the five-second read budget");
  assert.equal(waited.workers[0].sessionId, "existing");
  blocked.resolve({ sessionId: "existing", status: "idle", recentExchanges: [] });
});

test("AbortSignal cancels during host reads, including a late terminal response", async (t) => {
  const h = await loadHarness(t);
  const blocked = deferred();
  const entered = deferred();
  h.beforeInvoke = ({ operation }) => {
    if (operation === prefix + "status") { entered.resolve(); return blocked.promise; }
  };
  const controller = new AbortController();
  const waiting = h.execute({ action: "wait", sessionIds: ["existing"] }, { sessionId: "parent", signal: controller.signal });
  await entered.promise;
  controller.abort();
  await assert.rejects(waiting, rejectsCode("ABORTED"));
  blocked.resolve({ sessionId: "existing", status: "completed", recentExchanges: [] });
});

test("explicit wait returns host reports and specific receipts without copying transcripts", async (t) => {
  const h = await loadHarness(t);
  const first = await h.execute({ action: "send", sessionId: "existing", message: "Review" });
  h.complete(first.messageId, "Final verified report");
  const waited = await h.execute({ action: "wait", sessionIds: ["existing"] });
  assert.equal(waited.timedOut, false);
  assert.equal(waited.workers[0].report, "Final verified report");
  assert.equal("messages" in waited.workers[0], false);
  await h.execute({ action: "send", sessionId: "existing", message: "New task" });
  const exact = await h.execute({ action: "wait", sessionId: "existing", messageId: first.messageId });
  assert.equal(exact.workers[0].messageId, first.messageId);
  assert.equal(exact.timedOut, false);
});

test("wait pins each observed terminal delivery before a concurrent follow-up arrives", async (t) => {
  const h = await loadHarness(t);
  const first = await h.execute({ action: "send", sessionId: "existing", message: "First" });
  h.complete(first.messageId, "First final result");
  let second;
  h.beforeInvoke = async ({ operation, args }) => {
    if (operation === prefix + "result") {
      assert.equal(args[0].messageId, first.messageId);
      second = await h.execute({ action: "send", sessionId: "existing", message: "New task" });
    }
  };
  const waited = await h.execute({ action: "wait", sessionIds: ["existing"] });
  assert.equal(waited.timedOut, false);
  assert.equal(waited.workers[0].messageId, first.messageId);
  assert.equal(waited.workers[0].report, "First final result");
  assert.equal(h.messages.get(second.messageId).status, "queued");
});

test("unload cancels pending reads, and late responses cannot contaminate a reloaded instance", async (t) => {
  const h = await loadHarness(t);
  const blocked = deferred();
  const entered = deferred();
  h.beforeInvoke = ({ operation }) => {
    if (operation === prefix + "status") { entered.resolve(); return blocked.promise; }
  };
  const waiting = h.execute({ action: "wait", sessionIds: ["existing"] });
  const rejected = assert.rejects(waiting, rejectsCode("ABORTED"));
  await entered.promise;
  await h.main.onUnload();
  await rejected;
  h.beforeInvoke = undefined;
  await h.main.onLoad();
  blocked.resolve({ sessionId: "existing", status: "completed", recentExchanges: [] });
  await delay(5);
  const status = await h.execute({ action: "status", sessionId: "existing" });
  assert.equal(status.workers[0].status, "idle");
  assert.equal(h.settings.sessions.length, 0);
});

test("older hosts fail with a capability error before any untracked creation", async (t) => {
  const h = await loadHarness(t);
  h.operations = [{ id: "session/create" }, { id: "agent/prompt" }];
  await assert.rejects(h.execute({ action: "spawn", task: "Must not start" }), (error) =>
    error.code === "UNSUPPORTED" && /Update PI-Desktop/.test(error.message));

  assert.equal(h.calls.length, 0);
  assert.equal(h.modelReads, 0);
});

test("successful host receipts survive optional reference persistence failure", async (t) => {
  const h = await loadHarness(t);
  h.pi.plugin.setSettings = async () => { throw new Error("settings disk unavailable"); };
  const result = await h.execute({ action: "send", sessionId: "existing", message: "Persist in the host" });
  assert.equal(result.accepted, true);
  assert.ok(result.messageId);
  assert.match(result.warning, /not saved/);
  assert.equal(h.calls.filter((entry) => entry.operation === prefix + "send").length, 1);
  assert.equal(h.settings.sessions.length, 0);
  // The failed optional write is still surfaced by flush; restore it with a successful later update.
  h.pi.plugin.setSettings = async (partial) => Object.assign(h.settings, clone(partial));
  await h.execute({ action: "result", sessionId: "existing" });
});

test("supervise preserves successful receipts when one independent delivery fails", async (t) => {
  const h = await loadHarness(t);
  h.beforeInvoke = ({ operation, args }) => {
    if (operation === prefix + "send" && args[0].sessionId === "peer") {
      throw Object.assign(new Error("permission denied by host"), { code: "PERMISSION_DENIED" });
    }
  };
  const result = await h.execute({ action: "supervise", sessionIds: ["existing", "peer"], message: "Shared review feedback" });
  assert.equal(result.accepted, false);
  assert.equal(result.workers.length, 1);
  assert.equal(result.workers[0].sessionId, "existing");
  assert.ok(result.workers[0].messageId);
  assert.equal(result.failures[0].code, "PERMISSION_DENIED");
});

test("migration preserves legacy Session IDs but ignores old execution and acceptance guesses", async (t) => {
  const h = await loadHarness(t, { initialSettings: {
    version: 2, workers: [{ workerSessionId: "existing", parentSessionId: "parent", title: "Old worker",
      createdAt: new Date().toISOString(), task: "Old task", status: "completed", report: "Stale report", acceptanceStatus: "accepted" }],
  } });
  assert.equal(h.settings.version, 3);
  assert.equal(h.settings.sessions[0].sessionId, "existing");
  assert.deepEqual(h.settings.workers, []);
  const listed = await h.execute({ action: "list" });
  assert.equal(listed.workers[0].status, "idle");
  assert.equal(listed.workers[0].acceptanceStatus, "pending");
  const result = await h.execute({ action: "result", workerId: "existing" });
  assert.equal(result.ready, false);
  assert.equal(result.worker.report, undefined);
  await h.main.onUnload();
  await h.main.onLoad();
  assert.equal((await h.execute({ action: "list" })).workers[0].sessionId, "existing");
});

test("pruning recent references never prevents addressing a known real Session ID", async (t) => {
  const sessions = Array.from({ length: 257 }, (_, index) => ({ sessionId: index === 0 ? "existing" : `old-${index}`, title: "Old reference", referencedBy: ["parent"] }));
  const h = await loadHarness(t, { initialSettings: { version: 3, sessions, acceptances: [] } });
  const sent = await h.execute({ action: "send", sessionId: "existing", message: "Still addressable" }, { sessionId: "other" });
  assert.equal(sent.sessionId, "existing");
  assert.equal(h.settings.sessions.length, 256);
  assert.equal(h.messages.get(sent.messageId).sourceSessionId, "other");
});

test("conflicting legacy aliases, invalid inputs, and mismatched host results fail closed", async (t) => {
  const h = await loadHarness(t);
  await assert.rejects(h.execute({ action: "send", sessionId: "existing", workerId: "peer", message: "Conflict" }), rejectsCode("INVALID_ARGUMENT"));
  await assert.rejects(h.execute({ action: "status", sessionIds: ["existing"], workerIds: ["peer"] }), rejectsCode("INVALID_ARGUMENT"));
  await assert.rejects(h.execute({ action: "wait", sessionIds: [], timeoutMs: 25 }), rejectsCode("INVALID_ARGUMENT"));
  await assert.rejects(h.execute({ action: "spawn", task: "" }), rejectsCode("INVALID_ARGUMENT"));
  await assert.rejects(h.execute({ action: "send", sessionId: "existing", message: "Bad option", notifyOnCompletion: "yes" }), rejectsCode("INVALID_ARGUMENT"));
  assert.equal(h.calls.length, 0);
  h.beforeInvoke = ({ operation }) => operation === prefix + "result"
    ? { ready: true, message: { id: "wrong", targetSessionId: "peer", status: "completed", result: "Other session" } } : undefined;
  await assert.rejects(h.execute({ action: "result", sessionId: "existing" }), rejectsCode("INTERNAL"));
});
