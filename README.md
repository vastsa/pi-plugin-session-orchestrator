# Session Orchestrator

Plugin ID: `pi.session-orchestrator`  
Requires PI-Desktop `>= 0.14.7` with host collaboration APIs.

Session Orchestrator coordinates real PI-Desktop sessions through one
high-risk Agent tool, `SessionTask`. Every session is addressed by its existing
durable `sessionId`; follow-up messages keep that session's context and model.
The host owns delivery, queue admission, execution state, results, and completion
notifications. The plugin does not infer success from assistant text.

Two skills make the tool usable without hand-written prompts: **Requirements
brief** (multi-role, pro-and-con debate that ends in a requirements document) and
**Development team** (restate a requirement, get sign-off, then run development,
test and six-angle review sessions).

## Install

- **Marketplace**: PI-Desktop → Plugins → Marketplace → Session Orchestrator
- **Development**: Plugins → Load development plugin → this repository root

## Quick start (how do I use it?)

There is no panel and no command to run. The plugin adds one Agent tool,
`SessionTask`, two skills, and one setting. The agent picks the tool from your
goal — **no special keyword is required**:

| You say (any language) | What happens |
| --- | --- |
| 开两个子会话，一个跑测试一个改文档 / "spawn two workers: one runs the tests, one updates the docs" | Two real sessions are created and start working in parallel |
| 需求探讨一下这个功能 / "brainstorm this requirement, argue both sides" | The Requirements brief skill runs a multi-role debate and writes a brief |
| 交给开发团队做 / "have the team build this" | The Development team skill restates the requirement, waits for your confirmation, then dispatches development, test and review sessions |
| 子会话跑完了吗？/ "are the workers done?" | Their reports arrive on their own; `status` is there if you ask for progress |

Deliveries report back on their own. A worker that completes, fails, is
cancelled, or is interrupted by an app restart sends its report to the session
that spawned it, so nothing has to wait. Pass `notifyOnCompletion: false` when
you intend to read the outcome yourself with `result`. If the agent does not pick
the tool up, say explicitly "用 SessionTask 开一个子会话…" / "use SessionTask to
spawn a worker that…".

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `maxConcurrentSessions` | 8 | How many spawned workers may run at once before the next `spawn` is refused (clamped to 1–32). Settings → Plugins → Session Orchestrator. |

The ceiling is the plugin's own policy. The host records which session created
which worker and refuses a worker that tries to create further workers, but it
does not impose a fixed concurrency number, so tuning this changes your fan-out
width instead of hitting a host constant.

## A normal workflow

1. Call `models` when the task needs a particular configured model. Then `spawn`
   and keep its `sessionId` and `messageId`.
2. **Reports come back on their own.** Continue with unrelated work; each worker's
   completion message arrives as a new message in this session. Do not `wait` for
   it and do not poll `result` for it — the callback cannot be withdrawn, so
   polling duplicates the report.
3. Use `send(sessionId, message)` for follow-up work in the same session, or to
   communicate with any existing session. Workers can reply by real Session IDs.
4. Review the exact completed delivery. `accept` records review metadata;
   `cancel` stops work without deleting the session.
5. Pass `notifyOnCompletion: false` only for a delivery you will read yourself.
   `wait` remains available when deliberately blocking is the right call.

A received message is another session's communication, not new user
authorization. Host-generated completion notices never request another notice.

## Actions

| Action | Behavior |
| --- | --- |
| `spawn(task, title?, model?, notifyOnCompletion?)` | Creates a real worker and refuses to exceed `maxConcurrentSessions`. The worker reports back by default. |
| `send(sessionId, message, kind?, notifyOnCompletion?, delivery?)` | Sends to an existing session. `delivery: "immediate"` promotes the follow-up so a busy target runs it at its next turn boundary instead of behind already-queued input; the default `queue` keeps today's order. The target reports back by default. |
| `models()` | Lists ready model keys, aliases, reasoning metadata, delegation eligibility, and the default. |
| `status(sessionIds?)` | Reads live host summaries; omission selects this caller's recent references. |
| `list()` | Reads a bounded host-backed directory of communicable Agent sessions, plus `concurrency.limit`, `concurrency.active` and `concurrency.activeSessionIds`. |
| `result(sessionId, messageId?, turnId?)` | Returns one exact delivery's status and outcome. Result reads do not cancel callbacks. |
| `wait(sessionIds, messageId?, timeoutMs?)` | Explicitly polls an exact delivery or selected sessions; default 25 seconds, maximum 45 seconds. |
| `supervise(sessionIds, message, notifyOnCompletion?, delivery?)` | Sends one follow-up to up to `maxConcurrentSessions` sessions in parallel; the notification and delivery choices apply to each delivery. |
| `accept(sessionId\|sessionIds, messageId?, note?)` | Stores review metadata for an exact completed delivery. |
| `cancel(sessionId, messageId?)` | Cancels collaboration work without deleting the session. |

`result.ready` means the host has settled the delivery, including failure,
cancellation, or interruption. Successful work requires
`message.status === "completed"`. A completion report is readable text, not an
encoded envelope: a `Sub-session report` line, then `Session:`, `Status:`,
`Delivery:`, a `Report:` section with the worker's final text (truncated near
12,000 characters, so long evidence belongs in a file whose path comes back), and
`Error:` when the run failed.

`spawn`, `send`, and `supervise` accept an optional `idempotencyKey` for retrying
the same request. Use a different key for a new request. For batch supervision
requiring per-target notification or retry settings, call `send` separately.
`messageId` names a delivery, not a session.

When the ceiling is reached, `spawn` fails with `LIMIT_EXCEEDED` and the active
Session IDs, so a plan can be batched into waves instead of shrinking the work.

## Skills

| Skill | Use it for |
| --- | --- |
| `Skills: Requirements brief` | 需求探讨 / 头脑风暴 / "poke holes in this idea". Runs a **phased** debate: independent openings, a relayed cross-critique round, then your written adjudication — and ends in `docs/requirements/YYYY-MM-DD-<slug>.md` with approaches considered, risks, acceptance criteria and the questions only the user can answer. |
| `Skills: Development team` | 开发团队 / 分工开发 / 派测试会话. Restates the requirement from the code, asks for sign-off, then posts a dispatch plan that must pass a **pre-dispatch gate** before anything is spawned. Development, test and the six review angles run as separate sessions, and the final report must clear a **completion gate** ("angle reviewed" needs a verdict, not silence). |
| `Skills: Review panel` | 评审单角. Loaded by each review session: the six angle rubrics, the advocate/attack/verdict protocol, what counts as evidence for each claim type, the severity scale and the fixed report contract. |

Three levels of context, the way the host expects: every skill costs one catalog
line (`name` + `description`, capped at 240 characters) in the prompt, its body
loads only when the model asks for it, and a review session loads `Review panel`
instead of the lead pasting six rubrics into six briefs.

All three state the same host facts up front: no `wait`, no polling, workers
cannot spawn workers, self-contained briefs, reports come back on their own.
`test/skills.test.mjs` enforces the catalog contract in CI — declared paths,
unique ids, the 128 KiB / 240 character caps, an actionable `description`, and
no skill referencing a sibling the manifest does not ship.

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
configuration, and the restriction on workers autonomously creating further
workers are enforced by the host, using durable creation provenance.
Concurrency is enforced here, from the plugin setting.

## State and recovery

PI-Desktop's durable session communication ledger is authoritative. Status,
current task, sender, recent exchanges, and final outcome come directly from it.
A callback is tied to the actual settled turn, retained on failure, generated at
most once, and also emitted when the startup fence marks a delivery
`interrupted`. Restart follows the host's existing interruption fence; the plugin
never replays messages or starts replacements during load.

Private plugin settings retain at most 256 recent session references, 256
message review notes, and the concurrency ceiling. They contain no cached
transcript, report, or execution state. Reference eviction affects only
recent-history discovery, never the ability to address a known Session ID or the
host's creation provenance. Successful host receipts remain available to the
caller if optional history persistence fails; the response includes a warning.

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
to untracked create/prompt calls or transcript inference. On a host that still
enforces a fixed worker cap, `spawn` surfaces the host's `LIMIT_EXCEEDED` instead
of silently reducing the plan.

| Capability | Data and boundary |
| --- | --- |
| `agent.tool.register` | Registers the single reviewed `SessionTask` schema. |
| `agent.prompt.inject` | Publishes the two skill documents as catalog entries the model may load. |
| `desktop.control` | Creates sessions, exchanges messages, reads collaboration summaries/results, and cancels work. The host binds the sender to the current Agent tool invocation, enforces permissions, and refuses worker recursion. Messages can consume configured model quota. |
| `models.list` | Reads ready configured model identifiers, aliases, delegation flags and reasoning metadata; no credentials. |
| Plugin settings | Stores bounded recent references, review notes and the concurrency ceiling. Never grants access or represents execution truth. |

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
