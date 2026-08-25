/**
 * docket/1 — types for the run layer (work orders in flight).
 *
 * Mechanics answers "is this behaviour covered and verified"; a wave records
 * that answer *after* the CLI finishes. Neither shows what an agent is doing
 * right now, which is what makes dispatched work invisible while it matters.
 * A run closes that gap: an order with checkable exit criteria, plus an
 * append-only event log that any producer (hook, agent, CLI, CI) can write.
 *
 * Spec: `spec/docket-1.md`, with executable conformance vectors in
 * `spec/docket-1.vectors.json`. Two invariants live here rather than in prose:
 *
 * - Unknown event types are *ignored, never rejected* — a newer producer must
 *   be able to write into an older consumer's log. `KNOWN_EVENT_TYPES` is
 *   therefore a filter, not a validator.
 * - Facts and judgments have different producers. `actor.kind: "hook"` may
 *   never emit `criterion.evaluated`; a hook cannot know whether a criterion
 *   is met, and letting it claim otherwise makes the board lie.
 */

export const DOCKET_PROTO = "docket/1";

/** Repo-root directory holding all protocol data. */
export const DOCKET_DIR = ".docket";

/** `2026-08-08-export-csv-flow` — sortable and readable. */
export const RUN_ID_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*$/;

/** Default phase chain; an order may override it entirely. */
export const DEFAULT_PHASES = ["scope", "implement", "verify", "land"] as const;

/** No event within this window (and not finished) ⇒ the run is stalled. */
export const DEFAULT_STALENESS_MS = 120_000;

/**
 * How long an explicitly idle run stays `idle` before it decays to `stalled`.
 * Deliberately much larger than `DEFAULT_STALENESS_MS`: a human stepping away
 * from a session is normal and must not look like a crash, but a run nobody
 * came back to is exactly the forgotten work order a board exists to surface.
 * Eight hours puts it back on the board the next working day.
 */
export const DEFAULT_IDLE_STALENESS_MS = 8 * 60 * 60 * 1000;

export type ActorKind = "agent" | "subagent" | "hook" | "human" | "ci";

export type Actor = {
  kind: ActorKind;
  /** `claude-code`, `codex`, … */
  harness?: string;
  session?: string;
  /** Set on subagents: the session that spawned them, so timelines can nest. */
  parent?: string;
  agentType?: string;
  label?: string;
  /** Stable across machines — a forge username works. */
  identity?: string;
};

export type Verdict = "pass" | "fail" | "blocked" | "n-a";
export type VerifyMethod = "e2e" | "agent" | "manual";
export type RunResult = "shipped" | "abandoned" | "blocked";
export type BlockedNeeds = "human" | "input" | "dependency";
export type EvidenceKind = "screenshot" | "log" | "diff" | "url";

/** Derived, never stored: see `reduceRun`. */
export type Liveness = "working" | "waiting" | "idle" | "stalled" | "done";

export type EventType =
  | "run.created"
  | "run.started"
  | "run.finished"
  | "phase.entered"
  | "phase.exited"
  | "criterion.evaluated"
  | "evidence.attached"
  | "gate.blocked"
  | "session.heartbeat"
  | "session.idle"
  | "run.claimed"
  | "run.released"
  | "handoff.requested"
  | "decision.recorded"
  | "note.added"
  | "proposal.raised"
  | "proposal.accepted"
  | "proposal.rejected"
  | "git.linked"
  | "ci.status";

export const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set<EventType>([
  "run.created",
  "run.started",
  "run.finished",
  "phase.entered",
  "phase.exited",
  "criterion.evaluated",
  "evidence.attached",
  "gate.blocked",
  "session.heartbeat",
  "session.idle",
  "run.claimed",
  "run.released",
  "handoff.requested",
  "decision.recorded",
  "note.added",
  "proposal.raised",
  "proposal.accepted",
  "proposal.rejected",
  "git.linked",
  "ci.status",
]);

/**
 * Events that carry no progress signal. A heartbeat arriving after
 * `gate.blocked` means the session is alive, NOT that the block cleared —
 * so these never reset the blocked state.
 *
 * `session.idle` belongs here for a sharper reason: an agent that asks a
 * question ends its turn immediately afterwards, so the idle event lands
 * milliseconds after the `gate.blocked` it must not erase. Treating it as
 * progress would silently unblock every gate the moment it was raised.
 */
export const NON_PROGRESS_EVENT_TYPES: ReadonlySet<string> = new Set([
  "session.heartbeat",
  "session.idle",
  "ci.status",
]);

/**
 * One line of `events.jsonl`. On disk the payload keys sit at the top level
 * next to the base fields (that is the wire format); in memory they are split
 * out so consumers can pattern-match on `type` without colliding with `ts`,
 * `seq`, and friends.
 */
export type DocketEvent = {
  proto: string;
  ts: string;
  run: string;
  seq: number;
  type: string;
  actor: Actor;
  payload: Record<string, unknown>;
};

/** What a producer supplies; `proto`/`run`/`seq`/`ts` are filled in on append. */
export type DocketEventInput = {
  type: EventType | string;
  actor: Actor;
  payload?: Record<string, unknown>;
  /** Override the timestamp — only tests and importers should need this. */
  ts?: string;
};

export type DocketOrder = {
  run: string;
  title: string;
  scope?: { app?: string; specs?: string[] };
  /** AC references (`<spec-id>:AC<n>`) or free strings — both track. */
  exitCriteria: string[];
  phases: string[];
  /** Wave to merge verdicts into when the run ships. */
  wave?: string;
  git?: { branch?: string; worktree?: string; forge?: string; pr?: number };
  agent?: { harness?: string; sessionId?: string };
  assignee?: string;
  /**
   * What this run is FOR, outside the repo: today a forge issue number
   * (#424 PR3). The draft PR body carries `Closes #N` so the merge closes
   * the issue, and boards join card -> run through this field.
   */
  links?: { issue?: number };
};

export type CriterionState = {
  criterion: string;
  verdict: Verdict;
  method?: VerifyMethod;
  evidence?: string;
  at: string;
  by?: Actor;
};

export type ProposalStatus = "open" | "accepted" | "rejected";

export type ProposalState = {
  proposal: string;
  /** What the proposer suggests doing — free text, e.g. a gap class. */
  kind?: string;
  subject?: string;
  status: ProposalStatus;
  /** Run-relative path of the patch, when one was attached. */
  patch?: string;
  /** Who resolved it, once it is not `open`. */
  resolvedBy?: string;
  at: string;
};

export type RunState = {
  run: string;
  title: string;
  phases: string[];
  /** Latest `phase.entered`, or null before the first one. */
  phase: string | null;
  criteria: CriterionState[];
  /** `met` counts `pass` and `n-a`; `total` is the order's criterion count. */
  progress: { met: number; total: number };
  liveness: Liveness;
  result?: RunResult;
  blocked?: { reason: string; needs: BlockedNeeds; at: string };
  /** Latest `session.idle`, cleared by any later event. See `reduceRun`. */
  idle?: { at: string; reason?: string };
  claim?: { by: Actor; until: string };
  handoff?: { to: string; reason?: string; at: string };
  git?: { branch?: string; pr?: number; sha?: string };
  ci?: { state: string; at: string };
  decisions: { decision: string; title?: string; at: string }[];
  /**
   * Latest state per proposal id. Deliberately does NOT feed `liveness`: an
   * open proposal is not a block. `gate.blocked` means "I cannot proceed";
   * a proposal means "here is something you might take". Collapsing the two
   * would make `waiting` mean two different things on one board — and worse,
   * `reduceRun` clears `blocked` on any progress event, so a proposal wearing
   * a gate would be silently resolved by the next unrelated note.
   */
  proposals: ProposalState[];
  evidence: { kind: string; path: string; phase?: string; at: string }[];
  lastEventAt: string | null;
  eventCount: number;
  /** Lines that failed to parse — a truncated tail after a crash lands here. */
  malformed: number;
};
