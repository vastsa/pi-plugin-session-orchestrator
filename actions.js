"use strict";

const {
  MAX_SELECTED_SESSIONS,
  POLL_INTERVAL_MS,
  PREFIX,
  TERMINAL_STATUSES,
  contextSessionId,
  deliveryOptions,
  optionalText,
  selectedSessionIds,
  targetSessionId,
  taskError,
  text,
  waitTimeout,
} = require("./runtime.js");
const { MAX_ACCEPTANCE_NOTE_CHARS } = require("./state.js");
const { catalog, selectModel } = require("./models.js");

function resultSelector(args, sessionId) {
  const messageId = optionalText(args.messageId, "messageId");
  const turnId = optionalText(args.turnId, "turnId");
  return { sessionId, ...(messageId ? { messageId } : {}), ...(turnId ? { turnId } : {}) };
}

function resultWorker(sessionId, result) {
  const message = result.message;
  return {
    sessionId,
    status: message?.status || "idle",
    ...(message ? { messageId: message.id, task: String(message.content || "").slice(0, 240), title: message.targetTitle } : {}),
    ...(message?.turnId ? { turnId: message.turnId } : {}),
    ...(message?.status === "completed" && message.result ? { report: message.result } : {}),
    ...(message?.error ? { error: message.error } : {}),
  };
}

function createActions(runtime) {
  const store = runtime.store;

  function withAcceptance(summary, owner) {
    const messageId = summary.currentTask?.messageId || summary.result?.messageId;
    const accepted = messageId ? store.accepted(summary.sessionId, messageId, owner) : undefined;
    return {
      ...summary,
      acceptanceStatus: accepted ? "accepted" : "pending",
      ...(accepted ? { acceptance: accepted } : {}),
    };
  }

  async function readStatus(sessionId, options) {
    const value = await runtime.call("status", { sessionId }, options);
    if (!value || value.sessionId !== sessionId || typeof value.status !== "string") {
      throw taskError("INTERNAL", "Host returned an invalid session status");
    }
    return value;
  }

  async function readResult(selector, options) {
    const value = await runtime.call("result", selector, options);
    if (!value || typeof value.ready !== "boolean" ||
        (value.ready && !value.message) ||
        (value.message && (typeof value.message.id !== "string" || !value.message.id ||
          !["queued", "running", ...TERMINAL_STATUSES].includes(value.message.status))) ||
        (value.message?.result !== undefined && typeof value.message.result !== "string") ||
        (value.ready && !TERMINAL_STATUSES.has(value.message?.status)) ||
        (value.message && value.message.targetSessionId !== selector.sessionId) ||
        (selector.messageId && value.message && value.message.id !== selector.messageId) ||
        (selector.turnId && value.message && value.message.turnId !== selector.turnId)) {
      throw taskError("INTERNAL", "Host returned a result for a different session delivery");
    }
    return value;
  }

  function validateDelivery(value) {
    if (!value || typeof value.sessionId !== "string" || typeof value.messageId !== "string" ||
        typeof value.status !== "string") throw taskError("INTERNAL", "Host did not return a delivery receipt");
    return value;
  }

  async function spawn(args, ctx) {
    const owner = contextSessionId(ctx);
    const task = text(args.task, "task", 65_536);
    const title = optionalText(args.title, "title", 80);
    const options = deliveryOptions(args);
    await runtime.ensureOperation(PREFIX + "spawn", { signal: ctx.signal });
    const selected = selectModel(await runtime.models({ signal: ctx.signal }), args.model);
    const receipt = validateDelivery(await runtime.call("spawn", {
      task,
      ...(title ? { title } : {}),
      modelKey: selected.model.key,
      ...options,
    }, { signal: ctx.signal, read: false }));
    const warning = await runtime.remember(receipt.sessionId, owner, title || task.slice(0, 80));
    return {
      action: "spawn", ...receipt, accepted: true,
      requestedModel: selected.model.key, modelSelection: selected.selection,
      ...(warning ? { warning } : {}),
    };
  }

  async function send(args, ctx) {
    const owner = contextSessionId(ctx);
    const sessionId = targetSessionId(args);
    const content = text(args.message, "message", 65_536);
    if (args.model !== undefined) throw taskError("INVALID_ARGUMENT", "send reuses the session's existing model; model is only valid for spawn");
    if (args.kind !== undefined && !["task", "message"].includes(args.kind)) {
      throw taskError("INVALID_ARGUMENT", "kind must be task or message");
    }
    const receipt = validateDelivery(await runtime.call("send", {
      sessionId, content, ...(args.kind ? { kind: args.kind } : {}), ...deliveryOptions(args),
    }, { signal: ctx.signal, read: false }));
    if (receipt.sessionId !== sessionId) throw taskError("INTERNAL", "Host returned a delivery for a different session");
    const warning = await runtime.remember(sessionId, owner);
    return { action: "send", ...receipt, accepted: true, ...(warning ? { warning } : {}) };
  }

  async function status(args, ctx, action = "status") {
    const owner = contextSessionId(ctx);
    await runtime.ensureOperation(PREFIX + "status", { signal: ctx.signal });
    const ids = selectedSessionIds(args) || store.list(owner, MAX_SELECTED_SESSIONS).map((entry) => entry.sessionId);
    const workers = await Promise.all(ids.map((id) => readStatus(id, { signal: ctx.signal })));
    return { action, workers: workers.map((entry) => withAcceptance(entry, owner)) };
  }

  async function list(args, ctx) {
    const owner = contextSessionId(ctx);
    await runtime.ensureOperation(PREFIX + "list", { signal: ctx.signal });
    const value = await runtime.call("list", {}, { signal: ctx.signal });
    if (!value || !Array.isArray(value.sessions) || value.sessions.length > 100 || value.sessions.some((entry) => (
      !entry || typeof entry.sessionId !== "string" || !entry.sessionId ||
      typeof entry.title !== "string" || typeof entry.status !== "string"
    ))) {
      throw taskError("INTERNAL", "Host returned an invalid session directory");
    }
    // Keep the legacy workers field for callers that used list() as a recent
    // reference status read. The host-backed sessions field is the authority
    // for discovering independent top-level sessions.
    const ids = store.list(owner, MAX_SELECTED_SESSIONS).map((entry) => entry.sessionId);
    const workers = await Promise.all(ids.map((id) => readStatus(id, { signal: ctx.signal })));
    return {
      action: "list",
      sessions: value.sessions,
      workers: workers.map((entry) => withAcceptance(entry, owner)),
    };
  }

  async function result(args, ctx) {
    const owner = contextSessionId(ctx);
    const sessionId = targetSessionId(args);
    const value = await readResult(resultSelector(args, sessionId), { signal: ctx.signal });
    const warning = await runtime.remember(sessionId, owner, value.message?.targetTitle);
    return {
      action: "result", ...value,
      worker: resultWorker(sessionId, value),
      ...(warning ? { warning } : {}),
    };
  }

  async function wait(args, ctx) {
    const owner = contextSessionId(ctx);
    const ids = selectedSessionIds(args, true);
    if ((args.messageId || args.turnId) && ids.length !== 1) {
      throw taskError("INVALID_ARGUMENT", "A specific messageId or turnId requires one sessionId");
    }
    const deadline = Date.now() + waitTimeout(args.timeoutMs);
    const options = { signal: ctx.signal, deadline };
    let workers = ids.map((sessionId) => ({ sessionId, status: "unknown" }));
    try {
      while (true) {
        runtime.assertActive(ctx.signal);
        if (args.messageId || args.turnId) {
          const value = await readResult(resultSelector(args, ids[0]), options);
          workers = [resultWorker(ids[0], value)];
          if (value.message && TERMINAL_STATUSES.has(value.message.status)) {
            return { action: "wait", timedOut: false, workers, results: [value] };
          }
        } else {
          workers = await Promise.all(ids.map((id) => readStatus(id, options)));
          runtime.assertActive(ctx.signal);
          if (workers.every((entry) => TERMINAL_STATUSES.has(entry.status) || entry.status === "idle")) {
            const results = await Promise.all(workers.map((entry) => {
              const messageId = entry.currentTask?.messageId || entry.result?.messageId;
              return readResult({ sessionId: entry.sessionId, ...(messageId ? { messageId } : {}) }, options);
            }));
            runtime.assertActive(ctx.signal);
            return {
              action: "wait", timedOut: false,
              workers: workers.map((entry, index) => ({
                ...withAcceptance(entry, owner), ...resultWorker(entry.sessionId, results[index]),
              })),
              results,
            };
          }
        }
        await runtime.sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())), options);
      }
    } catch (error) {
      if (error.code !== "WAIT_TIMEOUT") throw error;
      return { action: "wait", timedOut: true, workers };
    }
  }

  async function supervise(args, ctx) {
    contextSessionId(ctx);
    const ids = selectedSessionIds(args, true);
    if (ids.length > 4) throw taskError("LIMIT_EXCEEDED", "Select at most four sessions for supervise");
    text(args.message, "message", 65_536);
    deliveryOptions(args);
    if (args.idempotencyKey) throw taskError("INVALID_ARGUMENT", "Use send with a distinct idempotencyKey for each session");
    const settled = await Promise.allSettled(ids.map((sessionId) => send({ ...args, sessionId, workerId: undefined }, ctx)));
    const workers = [];
    const failures = [];
    settled.forEach((entry, index) => {
      if (entry.status === "fulfilled") {
        const { action, ...receipt } = entry.value;
        workers.push(receipt);
      } else {
        failures.push({ sessionId: ids[index], code: entry.reason?.code || "UNKNOWN", message: String(entry.reason?.message || entry.reason) });
      }
    });
    return { action: "supervise", accepted: failures.length === 0, workers, ...(failures.length ? { failures } : {}) };
  }

  async function accept(args, ctx) {
    const owner = contextSessionId(ctx);
    const ids = selectedSessionIds(args, true);
    if ((args.messageId || args.turnId) && ids.length !== 1) {
      throw taskError("INVALID_ARGUMENT", "A specific messageId or turnId requires one sessionId");
    }
    const note = optionalText(args.note, "note", MAX_ACCEPTANCE_NOTE_CHARS);
    const results = await Promise.all(ids.map((sessionId) => readResult(resultSelector(args, sessionId), { signal: ctx.signal })));
    if (results.some((entry) => !entry.ready || entry.message?.status !== "completed" || !entry.message.result?.trim())) {
      throw taskError("WORKER_NOT_READY", "Only a completed host delivery with a final report can be accepted");
    }
    runtime.assertActive(ctx.signal);
    const acceptedAt = new Date().toISOString();
    const acceptances = results.map((entry, index) => ({
      sessionId: ids[index], messageId: entry.message.id, acceptedBySessionId: owner,
      acceptedAt, ...(note ? { note } : {}),
    }));
    await store.accept(acceptances);
    return {
      action: "accept", accepted: true, acceptances,
      workers: results.map((entry, index) => ({ ...resultWorker(ids[index], entry), acceptanceStatus: "accepted", acceptance: acceptances[index] })),
    };
  }

  async function cancel(args, ctx) {
    contextSessionId(ctx);
    const sessionId = targetSessionId(args);
    const messageId = optionalText(args.messageId, "messageId");
    const cancelled = await runtime.call("cancel", {
      sessionId, ...(messageId ? { messageId } : {}),
    }, { signal: ctx.signal, read: false });
    return { action: "cancel", ...cancelled };
  }

  async function execute(args, ctx) {
    runtime.assertActive(ctx?.signal);
    if (!args || typeof args !== "object" || Array.isArray(args)) throw taskError("INVALID_ARGUMENT", "SessionTask arguments must be an object");
    const action = text(args.action, "action", 32);
    switch (action) {
      case "spawn": return spawn(args, ctx);
      case "send": return send(args, ctx);
      case "status": return status(args, ctx);
      case "list": return list(args, ctx);
      case "result": return result(args, ctx);
      case "wait": return wait(args, ctx);
      case "supervise": return supervise(args, ctx);
      case "accept": return accept(args, ctx);
      case "cancel": return cancel(args, ctx);
      case "models": {
        contextSessionId(ctx);
        const models = catalog(await runtime.models({ signal: ctx.signal }));
        return { action, models, automaticCandidates: models.filter((row) => row.availableForSubagents), defaultModel: models.find((row) => row.isDefault)?.key || null };
      }
      default: throw taskError("INVALID_ARGUMENT", `Unsupported SessionTask action: ${action}`);
    }
  }

  return { execute };
}


module.exports = { createActions };
