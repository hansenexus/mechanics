/**
 * Proposals: what an agent suggests, and what a human does with it.
 *
 * A gap in the `propose` lane cannot be closed mechanically, so the honest
 * move is to write it down where somebody will see it and let them decide.
 * That "somewhere" is a docket run, because a run is already the thing that
 * knows what work is in flight, is already append-only, and is already
 * rendered on a board and in a report.
 *
 * Two artifacts, and the split matters:
 *
 *   The EVENT (`proposal.raised` / `.accepted` / `.rejected`) is the timeline.
 *   It is append-only, so status is derived latest-wins and a correction is a
 *   new event rather than an edit.
 *
 *   The RECORD (`.docket/proposals/<run>/<id>.yaml`) is the content — the
 *   suggestion, and the exact edit being offered when there is one. It is
 *   committed, so a proposal and its resolution land in a diff somebody
 *   reviews. That review, not any local check, is the real boundary: the
 *   human-only refusal in `appendEvent` removes the default path and nothing
 *   more, and this module does not pretend otherwise.
 *
 * Accepting a proposal that carries an op re-runs it through `applyAutoFix`,
 * so the same guards apply — including the rollback. An accepted proposal is
 * not a licence to skip them.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { appendEvent } from "./docket-events";
import { runDir } from "./docket-order";
import type { Actor } from "./docket-types";
import { applyAutoFix } from "./fix";
import type { Gap } from "./gaps";
import { formatZodError } from "./schema";

const autoOpSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("add-paths"),
      file: z.string().min(1),
      mechanic: z.string().min(1),
      paths: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("narrow-ignore"),
      file: z.string().min(1),
      surfaceKind: z.string().min(1),
      glob: z.string().min(1),
      literals: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("annotate-spec"),
      file: z.string().min(1),
      mechanic: z.string().min(1),
    })
    .strict(),
]);

/**
 * Immutable content only. There is deliberately **no status field**: status
 * lives in the event log, and a second copy on disk is a second source of
 * truth that goes stale the first time somebody edits one and not the other.
 */
export const proposalRecordSchema = z
  .object({
    proposal: z.string().min(1),
    run: z.string().min(1),
    app: z.string().min(1),
    gap: z.string().min(1),
    subject: z.string().min(1),
    title: z.string().min(1),
    detail: z.string().min(1),
    suggestion: z.string().min(1),
    severity: z.enum(["p0", "p1", "p2"]),
    raisedBy: z.string().min(1),
    raisedAt: z.string().min(1),
    /** The exact edit offered, when the gap had a mechanical one. */
    op: autoOpSchema.optional(),
  })
  .strict();

export type ProposalRecord = z.infer<typeof proposalRecordSchema>;

export function proposalsDir(repoRoot: string, runId: string): string {
  return path.join(repoRoot, ".docket", "proposals", runId);
}

export function proposalPath(repoRoot: string, runId: string, id: string): string {
  return path.join(proposalsDir(repoRoot, runId), `${id}.yaml`);
}

/**
 * A gap key is `class:app:subject` and a subject can hold slashes, dots and
 * wildcards. Flattened to one filename-safe token so a proposal is addressable
 * from a shell without quoting gymnastics.
 *
 * The trailing digest is not decoration. Normalising throws characters away,
 * so distinct subjects can collapse to the same token — `"/"` reduces to
 * nothing at all, and anything past 80 characters is truncated. A collision
 * would silently merge two proposals into one, which is the failure mode that
 * matters: a reviewer would see one suggestion and never learn about the
 * other. The digest is derived from the full gap key, so it stays stable
 * across runs and keeps `raiseProposals` idempotent.
 */
export function proposalId(gap: Gap): string {
  const slug = `${gap.gap}-${gap.subject}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return `${slug || gap.gap}-${digest(gap.key)}`;
}

/** Short, stable, non-cryptographic — this only has to avoid collisions. */
function digest(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).padStart(7, "0").slice(0, 7);
}

export async function readProposal(
  repoRoot: string,
  runId: string,
  id: string
): Promise<ProposalRecord> {
  const file = proposalPath(repoRoot, runId, id);
  const parsed = proposalRecordSchema.safeParse(YAML.parse(await fs.readFile(file, "utf8")));
  if (!parsed.success) {
    throw new Error(`${file}: ${formatZodError(parsed.error).join("; ")}`);
  }
  return parsed.data;
}

export async function listProposals(repoRoot: string, runId: string): Promise<ProposalRecord[]> {
  const dir = proposalsDir(repoRoot, runId);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: ProposalRecord[] = [];
  for (const name of names.filter((n) => n.endsWith(".yaml")).sort()) {
    out.push(await readProposal(repoRoot, runId, name.replace(/\.yaml$/, "")));
  }
  return out;
}

export interface RaiseResult {
  raised: ProposalRecord[];
  /** Already on the run — re-raising would duplicate something under review. */
  skipped: string[];
}

/**
 * Write one proposal per gap, and one `proposal.raised` event each.
 *
 * Idempotent by proposal id, which is why gap keys are deterministic: running
 * `mechanics fix --propose` twice must not put the same suggestion in front of
 * a reviewer twice.
 */
export async function raiseProposals(
  repoRoot: string,
  runId: string,
  gaps: Gap[],
  actor: Actor,
  now = new Date()
): Promise<RaiseResult> {
  if (!(await pathIsDir(runDir(repoRoot, runId)))) {
    throw new Error(
      `mechanics: no run "${runId}" — open one with \`mechanics run new --title="…"\` first. ` +
        "Opening a work order is a decision, so this will not do it for you."
    );
  }

  const existing = new Set((await listProposals(repoRoot, runId)).map((p) => p.proposal));
  const dir = proposalsDir(repoRoot, runId);
  await fs.mkdir(dir, { recursive: true });

  const raised: ProposalRecord[] = [];
  const skipped: string[] = [];

  for (const gap of gaps) {
    const id = proposalId(gap);
    if (existing.has(id)) {
      skipped.push(id);
      continue;
    }
    existing.add(id);
    const record: ProposalRecord = {
      proposal: id,
      run: runId,
      app: gap.app,
      gap: gap.gap,
      subject: gap.subject,
      title: gap.title,
      detail: gap.detail,
      suggestion: gap.suggestion,
      severity: gap.severity,
      raisedBy: actor.identity ?? actor.kind,
      raisedAt: now.toISOString(),
      ...(gap.op ? { op: gap.op } : {}),
    };
    await fs.writeFile(proposalPath(repoRoot, runId, id), YAML.stringify(record), "utf8");
    await appendEvent(repoRoot, runId, {
      type: "proposal.raised",
      actor,
      payload: { proposal: id, kind: gap.gap, subject: gap.subject },
    });
    raised.push(record);
  }
  return { raised, skipped };
}

export interface AcceptResult {
  proposal: ProposalRecord;
  /** Files written, when the proposal carried an op and `apply` was asked for. */
  written: string[];
  revertedBecause?: string;
}

/**
 * Accept one proposal.
 *
 * The human-only check lives in `appendEvent`, not here, and the event is
 * appended BEFORE any edit: if the actor is not allowed to accept, nothing
 * should have been written. Doing the edit first and the event second would
 * make the refusal decorative.
 */
export async function acceptProposal(
  repoRoot: string,
  runId: string,
  id: string,
  actor: Actor,
  options: { apply?: boolean } = {}
): Promise<AcceptResult> {
  const proposal = await readProposal(repoRoot, runId, id);
  await appendEvent(repoRoot, runId, {
    type: "proposal.accepted",
    actor,
    payload: { proposal: id, subject: proposal.subject },
  });

  if (!options.apply || !proposal.op) return { proposal, written: [] };

  // Straight back through the auto lane, guards and rollback included. A human
  // saying "yes" is agreement with the suggestion, not a waiver of the checks
  // that make the suggestion safe to apply.
  const res = await applyAutoFix(
    { app: proposal.app, ops: [proposal.op], deferred: [] },
    repoRoot,
    {}
  );
  return { proposal, written: res.written, revertedBecause: res.revertedBecause };
}

export async function rejectProposal(
  repoRoot: string,
  runId: string,
  id: string,
  reason: string,
  actor: Actor
): Promise<ProposalRecord> {
  if (!reason.trim()) {
    throw new Error("mechanics: rejecting a proposal requires a reason — silence is not an answer");
  }
  const proposal = await readProposal(repoRoot, runId, id);
  await appendEvent(repoRoot, runId, {
    type: "proposal.rejected",
    actor,
    payload: { proposal: id, reason },
  });
  return proposal;
}

async function pathIsDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}
