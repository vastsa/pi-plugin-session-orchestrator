# Session Orchestrator

Plugin ID: `pi.session-orchestrator`  
Requires PI-Desktop `>= 0.14.7` with host collaboration APIs.

Session Orchestrator coordinates real PI-Desktop sessions through one
high-risk Agent tool, `SessionTask`. Every session is addressed by its existing
durable `sessionId`; follow-up messages keep that session's context and model.
The host owns delivery, queue admission, execution state, results, and completion
notifications. The plugin does not infer success from assistant text.

## Install

- **Marketplace**: PI-Desktop → Plugins → Marketplace → Session Orchestrator
- **Development**: Plugins → Load development plugin → this repository root

## A normal workflow

1. Call `models` to inspect the user's ready configured models when a task needs
   a particular model. Then `spawn(task, title?, model?)` to create a worker.
   Keep the returned `sessionId` and delivery `messageId`.
2. Work in parallel. By default the host sends a completion message back to the
   sending session when the target turn settles; repeated polling is unnecessary.
3. Use `send(sessionId, message)` for follow-up work in the same session, or to
   communicate with any other existing session. Workers can reply to their
   initiating session and peers by their real Session IDs.
4. Inspect `status` or `result` when needed. Pass `messageId` or `turnId` to
   retrieve one specific delivery instead of whichever message is latest.
5. Review the actual result. `accept` optionally records that review for the
   exact completed message. `cancel` stops collaboration work and retains the
   durable session and history.

A received message is explicitly identified as another session's communication,
not human input or new user authorization. Completion notices need no
acknowledgement unless further work is necessary. Use
`notifyOnCompletion: false` for informational messages to avoid unnecessary
return messages. Host-generated completion notices never request another
automatic completion notice.

## Actions

| Action | Behavior |
| --- | --- |
| `spawn(task, title?, model?)` | Atomically creates a real worker and admits its first delivery through the host. |
| `send(sessionId, message, kind?)` | Sends a task or message to an existing session, including a busy session's host queue. Does not reselect its model. |
| `models()` | Lists ready model keys, aliases, reasoning metadata, AI-delegation eligibility, and the default. |
| `status(sessionIds?)` | Reads host-owned live summaries; omission selects this caller's recent session references. |
| `list()` | Reads a bounded host-backed directory of communicable Agent sessions, including independent top-level sessions. The response also retains a legacy `workers` field for recent-reference callers. |
| `result(sessionId, messageId?, turnId?)` | Returns the host delivery and exact turn outcome. Failed or interrupted work is never accepted as a successful report. |
| `wait(sessionIds, timeoutMs?)` | Explicit polling fallback, 25 seconds by default and at most 45 seconds. The entire read budget observes the deadline and cancellation. |
| `supervise(sessionIds, message)` | Sends up to four follow-ups in parallel; returns successful receipts and any individual failures. |
| `accept(sessionId|sessionIds, messageId?, note?)` | Stores review metadata keyed by the exact completed delivery. It never changes host execution state. |
| `cancel(sessionId, messageId?)` | Cancels target collaboration work without deleting the session. |

`result.ready` means the delivery has settled, including failure, cancellation,
or interruption. Successful work requires `message.status === "completed"`;
the compatibility `worker.report` field is populated only for that outcome.

`spawn` and `send` accept `notifyOnCompletion` (default true) and an optional
`idempotencyKey` for retrying the same request. Use a different key for a new
request. For batch supervision requiring retry identities, call `send` separately
with one key per target. Session identity and delivery identity have separate
purposes: `messageId` names a ledger entry, not a second worker system.

## Model selection

An omitted `model` first selects from ready bindings with
`availableForSubagents: true`. A default within that set takes precedence;
otherwise the first configured eligible row provides a stable selection.
Only when that set is empty does the configured ready default apply. An empty
catalog or unavailable default produces a clear configuration error.

The spawn response records `requestedModel` and its selection policy; the
actual session model is read from `status.modelKey`, including after an
idempotent retry.

An explicit request resolves against existing model keys, IDs, aliases and
names. Matching handles case, spacing, punctuation, common English/Chinese
family names, and supported reasoning/non-reasoning intent. Numeric version
order is preserved. Multiple matches return bounded exact-key candidates;
no match is an error. The plugin never invents a model ID or silently chooses
an unrelated default. It does not rank model quality or cost from brand names;
the Parent can use `models` and the task requirements to make that decision.

Existing-session `send` never changes provider, model, project, context, or
permissions. New-session project and permission inheritance, effective thinking
configuration, active-worker limits (four per creator, sixteen per plugin), and
the restriction on workers autonomously creating further workers are enforced
by the host, using durable creation provenance.

## State and recovery

PI-Desktop's durable session communication ledger is authoritative. Status,
current task, sender, recent exchanges, and final outcome come directly from it.
A callback is tied to the actual settled turn, retained on failure, and generated
at most once. Restart follows the host's existing interruption fence; the
plugin does not replay messages or start replacements during load.

Private plugin settings retain at most 256 recent session references and 256
message review notes. They contain no cached transcript, report, or execution
state. Reference eviction affects only recent-history discovery, never the
ability to address a known Session ID or the host's creation limits. Successful
host receipts remain available to the caller if optional history persistence
fails; the response includes a warning.

Version 0.3 `workerSessionId`/`sessionId` records migrate to recent references.
Old cached statuses, reports, rounds and acceptance markers are retired because
they cannot prove a host delivery's outcome. Existing sessions are preserved.
Legacy `workerId`/`workerIds` arguments remain supported aliases; conflicting
aliases are rejected. Unloading cancels plugin reads and waits, unregisters the
tool, and flushes metadata. Host-owned work and callbacks remain owned by the
host.

This plugin has no standalone window. Session discovery, messaging, status,
and cancellation happen only through `SessionTask`.

## Host compatibility and security

The manifest retains `engines.piDesktop >=0.14.7`, but version alone does not
prove this additive capability exists. Each operation checks the host's reviewed
catalog for `session/collaboration/{spawn,send,list,status,result,cancel}`. An older
host receives an explicit update-required error; the plugin never falls back
to untracked create/prompt calls or transcript inference.

| Capability | Data and boundary |
| --- | --- |
| `desktop.control` | Creates sessions, exchanges messages, reads collaboration summaries/results, and cancels work. The host binds the sender to the current Agent tool invocation, enforces permissions and bounded creation, and labels provenance. Messages can consume configured model quota. |
| `models.list` | Reads ready configured model identifiers, aliases, delegation flags and reasoning metadata; no credentials. |
| Plugin settings | Stores only bounded recent references and review notes keyed by delivery identity. Never grants access or represents execution truth. |

The high-risk grant allows bidirectional communication with any existing
session. Message content is task data and cannot grant new permissions. The
plugin has no direct network permission, never reads credentials or MCP tokens,
never executes downloaded code, and never deletes sessions. Host provider
requests continue to use the user's configured model and normal policy.

## Development

```bash
node --test test/*.test.mjs
```

This repository is the source of `pi.session-orchestrator`. Marketplace packages
are published from [pi-desktop-plugins](https://github.com/vastsa/pi-desktop-plugins).

