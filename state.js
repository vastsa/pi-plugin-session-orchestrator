"use strict";

const MAX_RECENT_SESSIONS = 256;
const MAX_ACCEPTANCES = 256;
const MAX_ACCEPTANCE_NOTE_CHARS = 4_096;

function bounded(value, limit) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function reference(value) {
  if (!value || typeof value !== "object") return null;
  const sessionId = bounded(value.sessionId || value.workerSessionId, 256);
  if (!sessionId) return null;
  const owners = Array.isArray(value.referencedBy)
    ? value.referencedBy
    : [value.parentSessionId];
  return {
    sessionId,
    title: bounded(value.title, 160) || sessionId,
    referencedBy: [...new Set(owners.map((id) => bounded(id, 256)).filter(Boolean))].slice(-16),
    updatedAt: bounded(value.updatedAt || value.createdAt, 64) || new Date().toISOString(),
  };
}

function acceptance(value) {
  if (!value || typeof value !== "object") return null;
  const sessionId = bounded(value.sessionId, 256);
  const messageId = bounded(value.messageId, 256);
  const acceptedBySessionId = bounded(value.acceptedBySessionId, 256);
  if (!sessionId || !messageId || !acceptedBySessionId) return null;
  return {
    sessionId,
    messageId,
    acceptedBySessionId,
    acceptedAt: bounded(value.acceptedAt, 64) || new Date().toISOString(),
    ...(value.note ? { note: bounded(value.note, MAX_ACCEPTANCE_NOTE_CHARS) } : {}),
  };
}

/** References and review notes are UI history, never session authorization or execution state. */
async function createReferenceStore(api = pi.plugin) {
  const settings = (await api.getSettings()) || {};
  let sessions = new Map();
  const loaded = settings.version === 3 ? settings.sessions : settings.workers;
  for (const raw of Array.isArray(loaded) ? loaded : []) {
    const entry = reference(raw);
    if (entry) sessions.set(entry.sessionId, entry);
  }
  sessions = new Map([...sessions].slice(-MAX_RECENT_SESSIONS));
  let acceptances = (Array.isArray(settings.acceptances) ? settings.acceptances : [])
    .map(acceptance).filter(Boolean).slice(-MAX_ACCEPTANCES);
  let writes = Promise.resolve();

  function payload(nextSessions, nextAcceptances) {
    return {
      version: 3,
      sessions: [...nextSessions.values()],
      acceptances: nextAcceptances,
      // Retire stale 0.3 execution snapshots without discarding their Session IDs.
      workers: [],
    };
  }

  function change(mutate) {
    const operation = writes.catch(() => undefined).then(async () => {
      const draft = {
        sessions: new Map(sessions),
        acceptances: [...acceptances],
      };
      mutate(draft);
      draft.sessions = new Map([...draft.sessions].slice(-MAX_RECENT_SESSIONS));
      draft.acceptances = draft.acceptances.slice(-MAX_ACCEPTANCES);
      await api.setSettings(payload(draft.sessions, draft.acceptances));
      sessions = draft.sessions;
      acceptances = draft.acceptances;
    });
    writes = operation;
    return operation;
  }

  if (settings.version !== 3) await api.setSettings(payload(sessions, acceptances));

  return {
    list(owner, limit = MAX_RECENT_SESSIONS) {
      return [...sessions.values()].reverse()
        .filter((entry) => !owner || entry.referencedBy.includes(owner))
        .slice(0, limit)
        .map((entry) => ({ ...entry, referencedBy: [...entry.referencedBy] }));
    },
    remember(sessionId, owner, title) {
      return change((draft) => {
        const previous = draft.sessions.get(sessionId);
        const next = reference({
          sessionId,
          title: title || previous?.title,
          referencedBy: [...(previous?.referencedBy || []), owner],
          updatedAt: new Date().toISOString(),
        });
        draft.sessions.delete(sessionId);
        draft.sessions.set(sessionId, next);
      });
    },
    accept(entries) {
      return change((draft) => {
        for (const raw of entries) {
          const entry = acceptance(raw);
          if (!entry) throw new Error("Invalid message acceptance");
          draft.acceptances = draft.acceptances.filter((item) =>
            item.messageId !== entry.messageId ||
            item.acceptedBySessionId !== entry.acceptedBySessionId);
          draft.acceptances.push(entry);
        }
      });
    },
    accepted(sessionId, messageId, owner) {
      const entry = acceptances.find((item) => item.sessionId === sessionId &&
        item.messageId === messageId && item.acceptedBySessionId === owner);
      return entry ? { ...entry } : undefined;
    },
    flush: () => writes,
  };
}

module.exports = {
  MAX_RECENT_SESSIONS,
  MAX_ACCEPTANCE_NOTE_CHARS,
  createReferenceStore,
};
