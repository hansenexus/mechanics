/**
 * Fold an event log into the state a board renders. Pure and total: same
 * events plus same `now` always yield the same state, which is what makes
 * `state.json` disposable and lets `rebuild` be safe to run at any moment.
 *
 * The liveness rule is the reason this layer exists. Without it a run that
 * silently died and a run that is thinking look identical — which is exactly
 * the situation mechanics leaves you in today. Five states, in priority
 * order:
 *
 *   done     — `run.finished` arrived
 *   waiting  — a `gate.blocked` is still outstanding (a heartbeat does NOT
 *              clear it: the session being alive says nothing about whether
 *              the human answered)
 *   idle     — the last event was `session.idle`: a turn ended cleanly and
 *              nothing is in flight
 *   working  — some event landed inside the staleness window
 *   stalled  — otherwise
 *
 * `blocked` and `idle` clear on opposite signals, and the asymmetry is the
 * whole point. A block is a claim about the *human*, so agent activity cannot
 * refute it — only a progress event does. Idleness is a claim about the
 * *agent*, so any later event refutes it, a bare heartbeat included: a tool
 * ran, therefore the agent is no longer idle.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { runDir } from "./docket-order";
import {
  type BlockedNeeds,
  type CriterionState,
  DEFAULT_IDLE_STALENESS_MS,
  DEFAULT_STALENESS_MS,
  type DocketEvent,
  type DocketOrder,
  type Liveness,
  NON_PROGRESS_EVENT_TYPES,
  type ProposalState,
  type ProposalStatus,
  type RunResult,
  type RunState,
  type Verdict,
  type VerifyMethod,
} from "./docket-types";

export type ReduceOptions = {
  now?: Date;
  stalenessMs?: number;
  /** How long `idle` survives before it decays to `stalled`. */
  idleStalenessMs?: number;
  /** Lines the reader could not parse; carried through for the board. */
  malformed?: number;
};

const VERDICTS: ReadonlySet<string> = new Set<Verdict>(["pass", "fail", "blocked", "n-a"]);
const METHODS: ReadonlySet<string> = new Set<VerifyMethod>(["e2e", "agent", "manual"]);
const RESULTS: ReadonlySet<string> = new Set<RunResult>(["shipped", "abandoned", "blocked"]);
const NEEDS: ReadonlySet<string> = new Set<BlockedNeeds>(["human", "input", "dependency"]);

function str(payload: Record<string, unknown>, key: string): string | undefined {
  const v = payload[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

export function reduceRun(
  order: DocketOrder,
  events: DocketEvent[],
  opts: ReduceOptions = {}
): RunState {
  const now = opts.now ?? new Date();
  const stalenessMs = opts.stalenessMs ?? DEFAULT_STALENESS_MS;
  const idleStalenessMs = opts.idleStalenessMs ?? DEFAULT_IDLE_STALENESS_MS;

  const state: RunState = {
    run: order.run,
    title: order.title,
    phases: order.phases,
    phase: null,
    criteria: [],
    progress: { met: 0, total: order.exitCriteria.length },
    liveness: "stalled",
    decisions: [],
    proposals: [],
    evidence: [],
    lastEventAt: null,
    eventCount: 0,
    malformed: opts.malformed ?? 0,
  };

  const latestByCriterion = new Map<string, CriterionState>();

  for (const ev of events) {
    // Unknown types still count as activity — a newer producer's event is
    // evidence of life even when this reader cannot interpret it.
    state.eventCount++;
    state.lastEventAt = ev.ts;
    if (!NON_PROGRESS_EVENT_TYPES.has(ev.type)) state.blocked = undefined;
    // Any event other than the idle marker itself proves the agent came back,
    // so idleness clears on all of them — including a bare heartbeat, which a
    // block deliberately survives. Last assignment wins; events are ordered.
    state.idle =
      ev.type === "session.idle" ? { at: ev.ts, reason: str(ev.payload, "reason") } : undefined;

    const p = ev.payload;
    switch (ev.type) {
      case "phase.entered": {
        const phase = str(p, "phase");
        if (phase) state.phase = phase;
        break;
      }
      case "criterion.evaluated": {
        const criterion = str(p, "criterion");
        const verdict = str(p, "verdict");
        if (!criterion || !verdict || !VERDICTS.has(verdict)) break;
        const evidence = str(p, "evidence");
        // Invariant 5, enforced on read as well: a pass without evidence is
        // not a pass. Writers are checked too, but a hand-edited log or a
        // third-party producer must not be able to slip one through.
        if (verdict === "pass" && !evidence) break;
        const method = str(p, "method");
        latestByCriterion.set(criterion, {
          criterion,
          verdict: verdict as Verdict,
          method: method && METHODS.has(method) ? (method as VerifyMethod) : undefined,
          evidence,
          at: ev.ts,
          by: ev.actor,
        });
        break;
      }
      case "evidence.attached": {
        const kind = str(p, "kind");
        const filePath = str(p, "path");
        if (kind && filePath) {
          state.evidence.push({ kind, path: filePath, phase: str(p, "phase"), at: ev.ts });
        }
        break;
      }
      case "gate.blocked": {
        const needs = str(p, "needs");
        state.blocked = {
          reason: str(p, "reason") ?? "(no reason given)",
          needs: needs && NEEDS.has(needs) ? (needs as BlockedNeeds) : "human",
          at: ev.ts,
        };
        break;
      }
      case "run.claimed": {
        const until = str(p, "until");
        if (until) state.claim = { by: ev.actor, until };
        break;
      }
      case "run.released":
        state.claim = undefined;
        break;
      case "handoff.requested": {
        const to = str(p, "to");
        if (to) state.handoff = { to, reason: str(p, "reason"), at: ev.ts };
        break;
      }
      case "decision.recorded": {
        const decision = str(p, "decision");
        if (decision) state.decisions.push({ decision, title: str(p, "title"), at: ev.ts });
        break;
      }
      // Latest-wins per proposal id, the same rule verdicts follow: append-only
      // means a correction is a NEW event, so a reader that keeps the first
      // one reports a proposal as open after it was resolved.
      case "proposal.raised":
      case "proposal.accepted":
      case "proposal.rejected": {
        const id = str(p, "proposal");
        if (!id) break;
        const status: ProposalStatus =
          ev.type === "proposal.accepted"
            ? "accepted"
            : ev.type === "proposal.rejected"
              ? "rejected"
              : "open";
        const prior = state.proposals.find((x) => x.proposal === id);
        const next: ProposalState = {
          proposal: id,
          kind: str(p, "kind") ?? prior?.kind,
          subject: str(p, "subject") ?? prior?.subject,
          patch: str(p, "patch") ?? prior?.patch,
          status,
          resolvedBy: status === "open" ? undefined : (ev.actor.identity ?? ev.actor.kind),
          at: ev.ts,
        };
        if (prior) state.proposals[state.proposals.indexOf(prior)] = next;
        else state.proposals.push(next);
        break;
      }
      case "git.linked": {
        const pr = typeof p.pr === "number" ? p.pr : state.git?.pr;
        state.git = { branch: str(p, "branch") ?? state.git?.branch, pr, sha: str(p, "sha") };
        break;
      }
      case "ci.status": {
        const ciState = str(p, "state");
        if (ciState) state.ci = { state: ciState, at: ev.ts };
        break;
      }
      case "run.finished": {
        const result = str(p, "result");
        state.result = result && RESULTS.has(result) ? (result as RunResult) : "abandoned";
        break;
      }
      default:
        break;
    }
  }

  state.criteria = [...latestByCriterion.values()].sort((a, b) =>
    a.criterion.localeCompare(b.criterion)
  );

  // Only criteria named in the order move the denominator. Anything else that
  // got evaluated is still listed — it just cannot inflate progress.
  state.progress.met = order.exitCriteria.filter((c) => {
    const v = latestByCriterion.get(c)?.verdict;
    return v === "pass" || v === "n-a";
  }).length;

  // A lease that has elapsed is not a claim. Keeping it would show a run as
  // held by a session that died hours ago — precisely the "a lock is a lie"
  // failure invariant 6 exists to prevent. Dropped on read rather than
  // requiring a `run.released`, because the process that would send one is
  // exactly the process that is gone.
  if (state.claim) {
    const until = Date.parse(state.claim.until);
    if (Number.isNaN(until) || until <= now.getTime()) state.claim = undefined;
  }

  state.liveness = computeLiveness(state, now, stalenessMs, idleStalenessMs);
  return state;
}

function computeLiveness(
  state: RunState,
  now: Date,
  stalenessMs: number,
  idleStalenessMs: number
): Liveness {
  if (state.result) return "done";
  if (state.blocked) return "waiting";
  if (!state.lastEventAt) return "stalled";
  const last = Date.parse(state.lastEventAt);
  if (Number.isNaN(last)) return "stalled";
  const age = now.getTime() - last;
  // A clean turn end is not a crash, so idle outranks the ordinary staleness
  // window — but only for as long as somebody could plausibly still return.
  // After that it is a forgotten run, which is what `stalled` means: nothing
  // is happening and nobody said why.
  if (state.idle) return age <= idleStalenessMs ? "idle" : "stalled";
  return age <= stalenessMs ? "working" : "stalled";
}

export function statePath(repoRoot: string, runId: string): string {
  return path.join(runDir(repoRoot, runId), "state.json");
}

/** Snapshot for readers that do not want to fold the log themselves. Always
 * regenerable — never treat it as a source of truth. */
export async function writeState(repoRoot: string, state: RunState): Promise<string> {
  const target = statePath(repoRoot, state.run);
  await fs.writeFile(target, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return target;
}
