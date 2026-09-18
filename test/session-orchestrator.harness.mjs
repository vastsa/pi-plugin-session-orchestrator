import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
export const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const prefix = "session/collaboration/";
export const model = (key, extra = {}) => {
  const slash = key.indexOf("/");
  return {
    key, providerId: key.slice(0, slash), modelId: key.slice(slash + 1),
    providerName: key.slice(0, slash), label: key.slice(slash + 1),
    supportsReasoning: false, thinkingLevels: ["off"],
    availableForSubagents: false, isDefault: false, ...extra,
  };
};
export const clone = (value) => JSON.parse(JSON.stringify(value));
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

export function makeHarness({ initialSettings, models } = {}) {
  const source = new AsyncLocalStorage();
  const settings = clone(initialSettings || { version: 3, sessions: [], acceptances: [] });
  const sessions = new Map(["parent", "other", "existing", "peer"].map((id) => [id, {
    sessionId: id, title: id, status: "idle", modelKey: "existing/unchanged",
  }]));
  const messages = new Map();
  const calls = [];
  const registered = { tool: null, command: null };
  let counter = 0;
  let worker = 0;
  const harness = {
    settings, sessions, messages, calls, registered,
    models: models || [
      model("default/general", { isDefault: true }),
      model("allowed/claude-sonnet-4-6", { alias: "Review", availableForSubagents: true, supportsReasoning: true }),
    ],
    operations: ["spawn", "send", "list", "status", "result", "cancel"].map((name) => ({ id: prefix + name })).concat([{ id: "session/open" }]),
    modelReads: 0,
    writes: [],
    beforeInvoke: undefined,
  };
  function lookup(id) {
    if (!sessions.has(id)) throw Object.assign(new Error("session not found"), { code: "NOT_FOUND" });
    return sessions.get(id);
  }
  function latest(id) {
    return [...messages.values()].reverse().find((message) => message.targetSessionId === id);
  }
  function admit(sessionId, content, input, kind) {
    const sender = lookup(source.getStore()?.sessionId || "parent");
    const target = lookup(sessionId);
    const id = `message-${++counter}`;
    const message = {
      id, pluginId: "pi.session-orchestrator", sourceSessionId: sender.sessionId,
      sourceTitle: sender.title, targetSessionId: sessionId, targetTitle: target.title,
      kind, content, status: "queued", notifyOnCompletion: input.notifyOnCompletion !== false,
      turnId: `turn-${counter}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    messages.set(id, message);
    target.status = "queued";
    return { sessionId, messageId: id, status: message.status, turnId: message.turnId };
  }
  harness.pi = {
    plugin: {
      getSettings: async () => clone(settings),
      setSettings: async (partial) => {
        harness.writes.push(clone(partial));
        Object.assign(settings, clone(partial));
      },
    },
    commands: {
      register: async (command) => { registered.command = command; },
      unregister: async () => { registered.command = null; },
    },
    agent: {
      registerTool: async (tool) => { registered.tool = tool; },
      unregisterTool: async () => { registered.tool = null; },
    },
    models: { list: async () => { harness.modelReads += 1; return clone(harness.models); } },
    desktop: {
      listOperations: async () => clone(harness.operations),
      invoke: async (request) => {
        calls.push(clone(request));
        if (harness.beforeInvoke) {
          const override = await harness.beforeInvoke(request);
          if (override !== undefined) return override;
        }
        const input = request.args[0];
        const operation = request.operation;
        if (operation === "session/open") { lookup(input); return { ok: true }; }
        if (operation === prefix + "spawn") {
          const parent = lookup(source.getStore()?.sessionId || "parent");
          if (parent.createdBySession) throw Object.assign(new Error("workers cannot create more workers"), { code: "LIMIT_EXCEEDED" });
          const id = `worker-${++worker}`;
          sessions.set(id, {
            sessionId: id, title: input.title || input.task.slice(0, 80), status: "idle",
            modelKey: input.modelKey,
            createdBySession: { sessionId: parent.sessionId, title: parent.title },
          });
          return admit(id, input.task, input, "task");
        }
        if (operation === prefix + "send") return admit(input.sessionId, input.content, input, input.kind || "message");
        if (operation === prefix + "status") {
          const target = lookup(input.sessionId);
          const message = latest(input.sessionId);
          return clone({
            ...target, observedAt: new Date().toISOString(),
            ...(message ? {
              currentTask: {
                messageId: message.id, senderSession: { sessionId: message.sourceSessionId, title: message.sourceTitle },
                text: message.content, status: message.status, turnId: message.turnId, createdAt: message.createdAt,
              },
              ...(["completed", "failed", "cancelled", "interrupted"].includes(message.status) ? {
                result: { messageId: message.id, turnId: message.turnId, status: message.status, text: message.result, error: message.error },
              } : {}),
            } : {}),
            recentExchanges: [...messages.values()].reverse()
              .filter((entry) => entry.targetSessionId === input.sessionId || entry.sourceSessionId === input.sessionId)
              .slice(0, 5).map((entry) => ({
                messageId: entry.id, direction: entry.targetSessionId === input.sessionId ? "incoming" : "outgoing",
                peer: entry.targetSessionId === input.sessionId ? { sessionId: entry.sourceSessionId, title: entry.sourceTitle } : { sessionId: entry.targetSessionId, title: entry.targetTitle },
                kind: entry.kind, status: entry.status, preview: entry.content.slice(0, 200), createdAt: entry.createdAt,
              })),
          });
        }
        if (operation === prefix + "list") {
          return clone({ sessions: [...sessions.values()].map((entry) => ({
            sessionId: entry.sessionId,
            title: entry.title,
            status: entry.status,
            updatedAt: new Date().toISOString(),
            ...(entry.modelKey ? { modelKey: entry.modelKey } : {}),
            ...(entry.createdBySession ? { createdBySession: entry.createdBySession } : {}),
          })) });
        }
        if (operation === prefix + "result") {
          lookup(input.sessionId);
          const message = input.messageId ? messages.get(input.messageId) : input.turnId
            ? [...messages.values()].find((entry) => entry.turnId === input.turnId)
            : latest(input.sessionId);
          return clone({ ready: Boolean(message && ["completed", "failed", "cancelled", "interrupted"].includes(message.status)), ...(message ? { message } : {}) });
        }
        if (operation === prefix + "cancel") {
          const target = lookup(input.sessionId);
          for (const message of messages.values()) {
            if (message.targetSessionId === input.sessionId && (!input.messageId || input.messageId === message.id) &&
                ["queued", "running"].includes(message.status)) message.status = "cancelled";
          }
          target.status = "cancelled";
          return { sessionId: input.sessionId, cancelled: true, sessionRetained: true };
        }
        throw new Error(`unexpected operation ${operation}`);
      },
    },
  };
  harness.execute = (args, ctx = { sessionId: "parent" }) => source.run(ctx, () => registered.tool.execute(args, ctx));
  harness.complete = (messageId, result, status = "completed") => {
    const message = messages.get(messageId);
    assert.ok(message);
    Object.assign(message, { status, result });
    if (status !== "completed") message.error = "host recorded a terminal failure";
    sessions.get(message.targetSessionId).status = status;
  };
  return harness;
}

export async function loadHarness(t, options) {
  const harness = makeHarness(options);
  const previousPi = globalThis.pi;
  globalThis.pi = harness.pi;
  const mainPath = join(pluginRoot, "main.js");
  delete require.cache[require.resolve(mainPath)];
  const main = require(mainPath);
  harness.main = main;
  t.after(async () => {
    await main.onUnload();
    delete require.cache[require.resolve(mainPath)];
    if (previousPi === undefined) delete globalThis.pi;
    else globalThis.pi = previousPi;
  });
  await main.onLoad();
  return harness;
}
