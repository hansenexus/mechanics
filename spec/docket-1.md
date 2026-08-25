# docket/1 — Agent Work Order Protocol

**Status:** implemented and in use. Version `docket/1`.
**Reference implementation:** `@hansenexus/mechanics` (`mechanics run …`).
**Conformance vectors:** [`docket-1.vectors.json`](./docket-1.vectors.json) — see
*Conformance* below.

**License.** The reference implementation is MIT. **This document is
additionally licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)**,
so another implementation may lift its wording, tables and examples with
attribution and without asking. A protocol nobody may quote is a protocol
nobody implements.

`mechanics` is the tool; `docket` is the protocol it speaks. They version
separately: the tool may release as often as it likes without touching this
number.

## What this is

A file format for **work orders executed by agents**, and an append-only event
log describing their progress. It answers three questions that no agent harness
answers today:

1. What is this run *supposed* to achieve, in checkable terms?
2. What is it doing *right now* — working, waiting for a human, or stuck?
3. What was *decided* along the way, and who needs to know?

It is deliberately a **file format, not a service**. No daemon, no database, no
account. A conforming implementation is a program that appends JSON lines to a
file. Everything else — dashboards, TUIs, gates, dispatchers — is a reader.

## Design invariants

1. **Append-only.** Events are never mutated or deleted. Corrections are new
   events.
2. **Derived state is disposable.** Any snapshot (`state.json`, an index, a
   dashboard) must be fully reconstructible from the event log. No state exists
   only in memory.
3. **Unknown event types are ignored, never rejected.** This is what lets a
   newer producer write to an older consumer's log. Forward compatibility is a
   requirement, not a nicety.
4. **Facts and judgments have different producers.** A harness hook may assert
   *that something happened*. Only an agent or a human may assert *that a
   criterion is met*. An implementation that lets hooks mark criteria green is
   non-conforming — it will lie.
5. **A `pass` verdict requires evidence.** No exceptions, no default.
6. **Nothing in this protocol blocks anyone.** Claims expire, they do not lock.
   In a file-based, eventually-consistent system, a lock is a lie.

## Directory layout

```
.docket/
├── runs/
│   ├── index.json                  # derived
│   └── <run-id>/
│       ├── order.yaml              # the work order
│       ├── events.jsonl            # the log — the only source of truth
│       ├── state.json              # derived, gitignored
│       └── evidence/
│           ├── screens/<phase>/<slug>.webp
│           └── logs/<name>.txt
└── decisions/
    └── <decision-id>.md            # decision records
```

`run-id`: `YYYY-MM-DD-<kebab-slug>` — sortable and human-readable.

Committed: `order.yaml`, `events.jsonl`, `evidence/`, `decisions/`.
Not committed: `state.json`, `index.json`.

## The work order

```yaml
run: 2026-08-08-locker-rental
title: Smart-locker rental end-to-end
scope:
  app: lockers
  specs: [lockers.rental.rent-flow, lockers.rental.return-flow]
exitCriteria:
  - lockers.rental.rent-flow:AC1
  - lockers.rental.rent-flow:AC3
  - "Rental survives a cold start"      # free-form is legal
phases: [scope, implement, verify, review, land]
git:
  branch: feat/locker-rental
  worktree: .claude/worktrees/feat-locker-rental
  forge: forgejo
  pr: 47
assignee: alex
```

**Exit criteria may be structured references or free strings.** A structured
reference (`<spec-id>:AC<n>`) resolves against a behavior-spec corpus and gives
the reader a linkable, verifiable target. A free string still tracks. This is
what lets the protocol be adopted on day one by a repo with no spec corpus,
and grow richer as specs arrive.

## Events

One JSON object per line. Required on every event:

| Field | Type | Meaning |
|---|---|---|
| `proto` | string | `"docket/1"` |
| `ts` | RFC 3339 | UTC, millisecond precision |
| `run` | string | run id |
| `seq` | integer | strictly increasing per run, gap-free |
| `type` | string | see below |
| `actor` | object | who emitted this |

### Actor

```json
{"kind":"agent","harness":"claude-code","session":"9f21c0","identity":"alex"}
{"kind":"hook","harness":"claude-code","session":"9f21c0"}
{"kind":"subagent","harness":"claude-code","session":"9f21c0",
 "parent":"9f21c0","agentType":"code-reviewer","label":"verify:auth"}
{"kind":"human","identity":"alex"}
{"kind":"ci","identity":"ci-runner-2"}
```

`kind` is one of `agent | subagent | hook | human | ci`. `identity` should be
stable across machines (a forge username works). **Subagents carry `parent`**,
which is what lets a reader nest a fan-out under the session that spawned it.

### Event types

**Lifecycle**

| `type` | Payload | Notes |
|---|---|---|
| `run.created` | `order` (inline copy or path) | first event, `seq: 1` |
| `run.started` | — | work begins |
| `run.finished` | `result: shipped\|abandoned\|blocked` | terminal |
| `phase.entered` | `phase` | |
| `phase.exited` | `phase` | |

**Progress**

| `type` | Payload | Notes |
|---|---|---|
| `criterion.evaluated` | `criterion`, `verdict: pass\|fail\|blocked\|n-a`, `method: e2e\|agent\|manual`, `evidence` | `pass` **requires** `evidence` |
| `evidence.attached` | `kind: screenshot\|log\|diff\|url`, `path`, `phase` | |
| `gate.blocked` | `reason`, `needs: human\|input\|dependency` | the "waiting for you" signal |
| `session.heartbeat` | — | liveness; throttle to ≤1/30s |
| `session.idle` | `reason` | no turn in flight; **not** a claim that anyone is blocked |

**Collaboration**

| `type` | Payload | Notes |
|---|---|---|
| `run.claimed` | `until` (RFC 3339) | a lease, not a lock |
| `run.released` | `reason` | explicit unclaim |
| `handoff.requested` | `to`, `reason` | the run directory is the payload |
| `decision.recorded` | `decision` (id), `title` | see Decision records |
| `note.added` | `body` | free-form, for humans |
| `proposal.raised` | `proposal` (id), `kind`, `subject`, `patch` | a suggestion; does **not** block |
| `proposal.accepted` | `proposal` | `actor.kind` MUST be `human` |
| `proposal.rejected` | `proposal`, `reason` | any actor |

**External**

| `type` | Payload | Notes |
|---|---|---|
| `git.linked` | `branch`, `pr`, `sha` | |
| `ci.status` | `state`, `checks[]` | written by a poller |

### Derived state

A conforming reader computes at least:

- **`liveness`** — evaluated in this priority order, first match wins:

  | State | Condition |
  |---|---|
  | `done` | `run.finished` arrived |
  | `waiting` | a `gate.blocked` is still outstanding |
  | `idle` | a `session.idle` is still outstanding, within the idle window (default 8h) |
  | `working` | any event landed within the staleness window (default 120s) |
  | `stalled` | otherwise |

  A block is outstanding until a **progress event** arrives. Every event type
  is a progress event *except* `session.heartbeat`, `session.idle` and
  `ci.status`. This distinction is not cosmetic: a heartbeat after a
  `gate.blocked` proves the session is alive, which says nothing about whether
  the human answered. A reader that lets a heartbeat clear the block will
  report a run as working while it sits waiting on someone, which is the exact
  failure this protocol exists to prevent. `session.idle` is excluded for a
  sharper reason still: an agent that asks a question ends its turn
  immediately afterwards, so the idle event lands milliseconds after the very
  gate it must not erase.

  A `session.idle` is outstanding until **any** later event arrives — a bare
  heartbeat included. The asymmetry with `gate.blocked` is deliberate and load
  bearing. A block is a claim about the *human*, so agent activity cannot
  refute it; idleness is a claim about the *agent*, so any subsequent event
  refutes it, because a tool ran.

  Idleness decays. A clean turn end is not a crash and must not be rendered as
  one, but a run nobody returned to is precisely the forgotten work order a
  board exists to surface — so after the idle window it becomes `stalled`,
  which means what it always meant: nothing is happening and nobody said why.
  Readers that would rather keep such runs visible as `idle` forever may set
  the window to infinity; the default assumes a working day.

- **`progress`** — met criteria over total, where "met" means the latest
  `criterion.evaluated` for that criterion has verdict `pass` or `n-a`. Only
  criteria named in the order count toward the total; anything else that was
  evaluated is still reported but cannot inflate progress.
- **`claim`** — the latest `run.claimed` whose `until` has not elapsed, unless
  a later `run.released` exists.

Unknown event types still refresh `lastEventAt`: an event this reader cannot
interpret is nonetheless evidence that something is alive.

This five-way distinction is the point of the whole layer. A run that has
silently died, a run that is thinking, a run that is waiting on you, and a run
whose turn simply ended look identical without it — which is the situation
every agent harness leaves you in today. The last two are the pair that is
easiest to get wrong: collapse them and either every finished turn screams for
attention, or every crash hides behind "probably just idle".

## Proposals

A **proposal** is a suggestion an agent makes about the work, carrying an
optional patch under the run's `evidence/proposals/`. It is deliberately not a
`gate.blocked`, and the distinction is load bearing in two directions:

- `gate.blocked` is an inability to proceed and a claim about a HUMAN, so it
  renders as `waiting`. A proposal stops nothing — the run keeps moving while
  someone considers it. Rendering both as `waiting` makes the word mean two
  things on one board.
- Any progress event clears `blocked`. A proposal wearing a gate would be
  silently resolved by the next unrelated note, which is the worst kind of
  failure: the board would say resolved and nobody would have looked.

Status is derived latest-wins per `proposal` id, the same rule verdicts follow.

**Only a human may accept.** Raising a proposal is a suggestion and any actor
may make one; rejecting is declining a suggestion and grades nothing. Accepting
asserts the suggestion was right, which is the same act as marking work green,
and invariant 4 puts that with a person. `ci` is refused alongside the agent
kinds deliberately — a job that auto-accepts is that failure wearing a hat.

*An honest limit.* A local implementation typically infers `human` from the
absence of an agent session variable, so a process that unsets it is
indistinguishable from a person. This rule removes the default path; it is not
a security boundary, and an implementation should not claim otherwise. The
durable defence is that a proposal and its resolution are committed files
somebody reviews.

## Decision records

`.docket/decisions/<id>.md` — an ADR whose job is to *reach the next agent*,
not to sit in a folder.

```yaml
---
status: accepted            # proposed | accepted | superseded | rejected
date: 2026-08-08
decidedBy: [alex, "claude-code:9f21c0"]
run: 2026-08-08-locker-rental
affects:
  specs: [lockers.rental.rent-flow]
  paths: ["src/lockers/**"]
supersedes: 2026-06-locker-retry
---
## Context
## Decision          ← one imperative sentence
## Rationale         ← including the alternatives that were rejected
## Consequences      ← what is now required or forbidden
```

The id is path-derived (filename), never stored in frontmatter — same rule as
spec ids, so one convention covers both.

### Why `affects` is the whole design

`affects.paths` is a resolvable claim, exactly like a spec's `paths`. That makes
decisions **retrievable by the thing an agent is about to touch**, which is the
only retrieval key that works without the agent knowing what to ask for.

Three delivery channels, in descending order of reliability:

1. **Context injection by hook.** A `PreToolUse` hook resolves `affects.paths`
   against the file the agent is about to edit and injects the matching
   decisions. **Subagents get this automatically**, because hooks fire on their
   tool calls too — no manual context passing from the parent.
2. **Query by MCP.** `decisions({path | spec | query})` — for "why is this like
   this".
3. **Human surfaces.** Run timeline, board, and the PR comment.

### Lifecycle rules

- Supersession replaces deletion. `supersedes` forms a chain; a superseded
  record stays readable.
- A validator **errors** when an `accepted` record's `affects.paths` matches no
  files — a decision pointing at deleted code is stale and must be superseded
  or rejected. This is what stops the folder from rotting.
- **Conflict detection:** when two open runs record decisions whose `affects`
  overlap, a reader flags it. Two agents deciding contradictory things about
  one subsystem is the characteristic multi-agent failure; overlapping globs
  make it cheap to catch.

## Presence and claims — what is honestly possible

**Same machine, parallel sessions.** A local presence file plus heartbeats gives
real-time collision detection. This works today.

**Across machines, no server.** Claims and heartbeats can be pushed to a
dedicated non-branch ref (`refs/docket/presence`) — no PR noise, no working-tree
conflicts, refreshed by `git fetch`. Latency is one fetch interval. This is the
recommended default.

**Real-time across machines** requires a relay. It is explicitly **out of scope
for v1** and must always remain optional; an implementation that requires a
server to show a board is non-conforming.

State this limitation in the UI rather than papering over it. A board that shows
stale cross-machine presence as if it were live is worse than one that labels it
"as of last fetch".

## A complete log

The smallest run that ships. Payload keys sit beside the base fields — that is
the wire format; splitting them out is a reader's convenience, not the file's
shape.

```jsonl
{"proto":"docket/1","ts":"2026-01-05T09:00:00.000Z","run":"2026-01-05-locker-rental","seq":1,"type":"run.created","actor":{"kind":"human","identity":"alex"},"title":"Smart-locker rental end-to-end"}
{"proto":"docket/1","ts":"2026-01-05T09:00:01.000Z","run":"2026-01-05-locker-rental","seq":2,"type":"phase.entered","actor":{"kind":"agent","harness":"claude-code","session":"9f21c0"},"phase":"implement"}
{"proto":"docket/1","ts":"2026-01-05T09:14:00.000Z","run":"2026-01-05-locker-rental","seq":3,"type":"gate.blocked","actor":{"kind":"agent","session":"9f21c0"},"reason":"which retention window applies to abandoned rentals?","needs":"human"}
{"proto":"docket/1","ts":"2026-01-05T09:14:00.400Z","run":"2026-01-05-locker-rental","seq":4,"type":"session.idle","actor":{"kind":"hook","harness":"claude-code","session":"9f21c0"},"reason":"turn ended"}
{"proto":"docket/1","ts":"2026-01-05T10:02:00.000Z","run":"2026-01-05-locker-rental","seq":5,"type":"decision.recorded","actor":{"kind":"human","identity":"alex"},"decision":"2026-01-abandoned-rental-window","title":"Abandoned rentals expire after 48h"}
{"proto":"docket/1","ts":"2026-01-05T10:40:00.000Z","run":"2026-01-05-locker-rental","seq":6,"type":"criterion.evaluated","actor":{"kind":"agent","session":"9f21c0"},"criterion":"lockers.rental.rent-flow:AC1","verdict":"pass","method":"e2e","evidence":"e2e/rent.spec.ts"}
{"proto":"docket/1","ts":"2026-01-05T10:41:00.000Z","run":"2026-01-05-locker-rental","seq":7,"type":"run.finished","actor":{"kind":"human","identity":"alex"},"result":"shipped"}
```

Read that log at `09:14:30` and the run is **waiting** — the `session.idle` at
seq 4 does not clear the gate at seq 3. Read it at `10:02:30` and it is
**working**: the human answered, and `decision.recorded` is a progress event.
Read it after seq 7 and it is **done**, regardless of anything before it.

## Conformance

A **producer** conforms if it writes well-formed lines with a monotonic `seq`,
never mutates existing lines, and never emits `criterion.evaluated` from an
`actor.kind` of `hook`.

A **consumer** conforms if it ignores unknown event types, reconstructs all
state from the log, and never presents a `pass` without its evidence.

### Vectors

[`docket-1.vectors.json`](./docket-1.vectors.json) is the executable form of
this section: each case is an order, the exact JSONL lines of a log, an instant
to read it at, and the state a conforming reader must derive. Every case
carries a `why` — a failure should say what broke and why it matters, not just
which assertion tripped.

Only the asserted keys are checked, so a reader deriving richer state is still
conforming. The reference implementation runs the same file
(`docket-conformance.test.ts`), which is what keeps the vectors honest: a
vector nobody executes is a claim, not a test.

The cases cover what is easiest to get wrong and worst to get wrong silently —
the block/idle asymmetry, idle decay, `pass` without evidence,
latest-verdict-wins, undeclared criteria, unknown event types, claim expiry,
the empty log, and — for the proposal types, which are themselves an additive
extension — that a reader predating them still derives correct liveness and
progress from a log containing them.

### Version bumps

Additive event types and payload fields do **not** bump the version. Removing a
field, changing a field's meaning, or adding a required field bumps to
`docket/2`.

## Naming note

`docket` — a list of work awaiting action. Settled 2026-08-08 over `ratchet`,
`leitstand`, `convoy` and `hangar`, and against `foreman`, `waypoint`,
`semaphore`, `ledger` and `rally`, which are taken.

The name appears in exactly two places — the `proto` field and the `.docket/`
directory — so a rename would stay a find-replace.
