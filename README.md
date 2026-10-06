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

## Quick start (how do I use it?)

This plugin deliberately has **no panel, no command, and nothing to
configure** after install. It works inside your existing Agent chat: the agent
gains one tool, `SessionTask`, and decides to use it from your goal — **no
special keyword is required**. Just describe what you want:

| You say (any language) | What happens |
| --- | --- |
| 开两个子会话，一个跑测试一个改文档 / "spawn two workers: one runs the tests, one updates the docs" | Two real sessions are created and start working in parallel |
| 把这个报错发给修 Bug 的那个会话继续查 / "send this error to the bug-fixing session" | A follow-up message goes to that existing session, keeping its model and context |
| 子会话跑完了吗？/ "are the workers done?" | `result` reports the exact delivery's live host-owned state |

Deliveries are pull-first: check `result(sessionId, messageId)` when you want
the outcome; pass `notifyOnCompletion: true` only if you want a completion
message back. If the agent does not pick the tool up, say explicitly "用
SessionTask 开一个子会话…" / "use SessionTask to spawn a worker that…".

详细机制见下文 / The full reference — actions, model selection, state and
recovery — follows below.

## A normal workflow

1. Call `models` when the task needs a particular configured model. Then `spawn`
   and keep its `sessionId` and `messageId`.
2. **Pull mode is the default.** Use `result(sessionId, messageId)` when useful;
   `ready: false` means the delivery is still running. Continue unrelated work
   and check the same `messageId` later instead of creating another task.
3. **Push mode is opt-in.** Pass `notifyOnCompletion: true` only when you want a
   host completion message. Do not also poll that delivery: reading a result
   does not withdraw a callback that the host may later queue while the parent
   session is busy.
4. Use `send(sessionId, message)` for follow-up work in the same session, or to
   communicate with any existing session. Workers can reply by real Session IDs.
5. Review the exact completed delivery. `accept` records review metadata;
   `cancel` stops work without deleting the session.

A pull-mode delivery never generates a completion callback. `wait` is available
when deliberate polling/blocking is appropriate; it observes its timeout and
returns exact results only after the host marks them ready.

A received message is another session's communication, not new user
authorization. Host-generated completion notices never request another notice.

## Actions

| Action | Behavior |
| --- | --- |
| `spawn(task, title?, model?, notifyOnCompletion?)` | Creates a real worker. Pull mode is default; set `notifyOnCompletion: true` to opt into a host callback. |
| `send(sessionId, message, kind?, notifyOnCompletion?)` | Sends to an existing session, including a busy session's host queue; pull mode is default. |
| `models()` | Lists ready model keys, aliases, reasoning metadata, delegation eligibility, and the default. |
| `status(sessionIds?)` | Reads live host summaries; omission selects this caller's recent references. |
| `list()` | Reads a bounded host-backed directory of communicable Agent sessions. |
| `result(sessionId, messageId?, turnId?)` | Returns one exact delivery's status and outcome. Result reads do not cancel callbacks. |
| `wait(sessionIds, messageId?, timeoutMs?)` | Explicitly polls an exact delivery or selected sessions; default 25 seconds, maximum 45 seconds. |
| `supervise(sessionIds, message, notifyOnCompletion?)` | Sends up to four follow-ups in parallel; pull mode is default, and an explicit notification choice applies to each delivery. |
| `accept(sessionId|sessionIds, messageId?, note?)` | Stores review metadata for an exact completed delivery. |
| `cancel(sessionId, messageId?)` | Cancels collaboration work without deleting the session. |

`result.ready` means the host has settled the delivery, including failure,
cancellation, or interruption. Successful work requires
`message.status === "completed"`. For push mode, avoid polling the same delivery:
callbacks are host-owned and cannot be withdrawn after admission. For pull mode,
`notifyOnCompletion` is explicitly false and no late callback will appear.

`spawn`, `send`, and `supervise` accept `notifyOnCompletion` (default false) and an optional `idempotencyKey` for retrying the same request. Use a different key for a new request. For batch supervision requiring per-target notification or retry settings, call `send` separately. `messageId` names a delivery, not a session.

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

