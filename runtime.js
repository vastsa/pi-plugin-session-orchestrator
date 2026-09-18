"use strict";

const PREFIX = "session/collaboration/";
const READ_TIMEOUT_MS = 5_000;
const MAX_SELECTED_SESSIONS = 16;
const MAX_WAIT_TIMEOUT_MS = 45_000;
const WAIT_TIMEOUT_MS = 25_000;
const POLL_INTERVAL_MS = 1_000;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

function taskError(code, message, details) {
  return Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
}

function text(value, field, limit = 256) {
  if (typeof value !== "string" || !value.trim()) {
    throw taskError("INVALID_ARGUMENT", `${field} must be a non-empty string`);
  }
  if (value.trim().length > limit) {
    throw taskError("LIMIT_EXCEEDED", `${field} exceeds ${limit} characters`);
  }
  return value.trim();
}

function optionalText(value, field, limit = 256) {
  return value === undefined || value === null || value === ""
    ? undefined : text(value, field, limit);
}

function targetSessionId(args) {
  const id = optionalText(args?.sessionId, "sessionId");
  const legacy = optionalText(args?.workerId, "workerId");
  if (id && legacy && id !== legacy) {
    throw taskError("INVALID_ARGUMENT", "sessionId and workerId must identify the same session");
  }
  return id || legacy || text(undefined, "sessionId");
}

function selectedSessionIds(args, required = false) {
  function normalize(value) {
    if (!Array.isArray(value)) throw taskError("INVALID_ARGUMENT", "sessionIds must be an array");
    const ids = [...new Set(value.map((id) => text(id, "sessionId")))];
    if (ids.length > MAX_SELECTED_SESSIONS) {
      throw taskError("LIMIT_EXCEEDED", `Select at most ${MAX_SELECTED_SESSIONS} sessions`);
    }
    return ids;
  }
  const ids = args.sessionIds !== undefined ? normalize(args.sessionIds) : undefined;
  const legacy = args.workerIds !== undefined ? normalize(args.workerIds) : undefined;
  if (ids && legacy && JSON.stringify(ids) !== JSON.stringify(legacy)) {
    throw taskError("INVALID_ARGUMENT", "sessionIds and workerIds must identify the same sessions");
  }
  const selected = ids || legacy ||
    ((args.sessionId !== undefined || args.workerId !== undefined) ? [targetSessionId(args)] : undefined);
  if (required && !selected?.length) throw taskError("INVALID_ARGUMENT", "sessionIds must not be empty");
  return selected;
}

function contextSessionId(ctx) {
  return text(ctx?.sessionId, "active sessionId");
}

function deliveryOptions(args) {
  if (args.notifyOnCompletion !== undefined && typeof args.notifyOnCompletion !== "boolean") {
    throw taskError("INVALID_ARGUMENT", "notifyOnCompletion must be a boolean");
  }
  const idempotencyKey = optionalText(args.idempotencyKey, "idempotencyKey");
  return {
    ...(args.notifyOnCompletion !== undefined ? { notifyOnCompletion: args.notifyOnCompletion } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

function waitTimeout(value) {
  if (value === undefined) return WAIT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_WAIT_TIMEOUT_MS) {
    throw taskError("INVALID_ARGUMENT", `timeoutMs must be between 1 and ${MAX_WAIT_TIMEOUT_MS}`);
  }
  return value;
}

/** One runtime owns its abort signal; an old invocation can never write into a reloaded runtime. */
function createRuntime(store, api = pi) {
  const lifecycle = new AbortController();
  let capabilities;

  function assertActive(signal) {
    if (lifecycle.signal.aborted || signal?.aborted) {
      throw taskError("ABORTED", "Session Orchestrator request was cancelled");
    }
  }

  function bounded(callback, { signal, deadline, timeoutMs = READ_TIMEOUT_MS } = {}) {
    assertActive(signal);
    const remaining = deadline === undefined ? timeoutMs : deadline - Date.now();
    const budget = Math.min(timeoutMs, remaining);
    const timeoutCode = deadline !== undefined && remaining <= timeoutMs ? "WAIT_TIMEOUT" : "TIMEOUT";
    if (budget <= 0) return Promise.reject(taskError(timeoutCode, "Session Orchestrator read timed out"));
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const signals = [...new Set([lifecycle.signal, signal].filter(Boolean))];
      const finish = (handler, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        for (const item of signals) item.removeEventListener("abort", abort);
        handler(value);
      };
      const abort = () => finish(reject, taskError("ABORTED", "Session Orchestrator request was cancelled"));
      for (const item of signals) item.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => finish(reject, taskError(timeoutCode, "Session Orchestrator read timed out")), budget);
      Promise.resolve().then(() => {
        assertActive(signal);
        return callback();
      }).then((value) => finish(resolve, value), (error) => finish(reject, error));
    });
  }

  async function ensureOperation(operation, options) {
    assertActive(options?.signal);
    if (!api.desktop?.invoke || !api.desktop?.listOperations) {
      throw taskError("UNSUPPORTED", "Update PI-Desktop to a build with Session Collaboration support");
    }
    if (!capabilities) {
      const operations = await bounded(() => api.desktop.listOperations(), options);
      capabilities = new Set((Array.isArray(operations) ? operations : []).map((entry) => entry.id));
    }
    if (!capabilities.has(operation)) {
      throw taskError("UNSUPPORTED", `Update PI-Desktop to a build with Session Collaboration support; missing ${operation}`);
    }
  }

  async function invoke(operation, input, options = {}) {
    await ensureOperation(operation, options);
    assertActive(options.signal);
    const request = () => api.desktop.invoke({ operation, args: [input] });
    // Writes retain the gateway's own deadline. A wait/read budget never cancels admitted work.
    const result = await bounded(request, { ...options, timeoutMs: options.read === false ? 110_000 : READ_TIMEOUT_MS });
    assertActive(options.signal);
    return result;
  }

  async function remember(sessionId, owner, title) {
    assertActive();
    try {
      await bounded(() => store.remember(sessionId, owner, title));
      return undefined;
    } catch (error) {
      if (error.code === "ABORTED") throw error;
      // The host delivery already succeeded; preserve its receipt even when optional UI history fails.
      return `Session reference was not saved: ${String(error?.message || error).slice(0, 300)}`;
    }
  }

  return {
    store,
    assertActive,
    bounded,
    ensureOperation,
    invoke,
    call: (action, input, options) => invoke(PREFIX + action, input, options),
    models: (options) => bounded(() => api.models.list(), options),
    remember,
    async sleep(ms, options) {
      let timer;
      try {
        await bounded(() => new Promise((resolve) => { timer = setTimeout(resolve, ms); }), {
          ...options, timeoutMs: ms + READ_TIMEOUT_MS,
        });
      } finally {
        clearTimeout(timer);
      }
    },
    dispose: () => lifecycle.abort(),
  };
}

module.exports = {
  MAX_SELECTED_SESSIONS,
  MAX_WAIT_TIMEOUT_MS,
  WAIT_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  PREFIX,
  TERMINAL_STATUSES,
  contextSessionId,
  createRuntime,
  deliveryOptions,
  optionalText,
  selectedSessionIds,
  targetSessionId,
  taskError,
  text,
  waitTimeout,
};
