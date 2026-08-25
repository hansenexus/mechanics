/**
 * Closing a gap with a model, when the gap is not mechanical.
 *
 * `fix.ts` handles the gaps with exactly one correct answer. Everything else
 * needs judgment, and judgment is what a model is for — so this is the second
 * half of the same pipeline: take a `propose`-lane gap, give a provider enough
 * context to act, and let it change the tree.
 *
 * The two provider kinds reach the same place by different roads. A harness
 * (`claude`, `codex`, `qwen`) is handed the brief and edits the worktree with
 * its own tools. A bare model (`ollama`, `lmstudio`) cannot open a file, so it
 * answers in the edit protocol and `applyEdits` makes the change. Either way
 * the result is verified and reverted as a unit if it made things worse.
 *
 * **What this does not do, on purpose:** record a verdict, accept a proposal,
 * or close a wave. Editing a thousand files is work. Saying the work is good
 * is grading, and the two refusals in `docket-events.ts` keep that with a
 * person. Giving a provider full reach over the tree does not require giving
 * it the last word on whether the tree is right.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  type Availability,
  applyEdits,
  EDIT_PROTOCOL,
  type ProviderSpec,
  parseEditPlan,
  runProvider,
} from "./agents";
import type { Gap } from "./gaps";

export interface AgentFixOptions {
  repoRoot: string;
  app: string;
  spec: ProviderSpec;
  /** Verification run after the edits; return a message to trigger a revert. */
  verify?: () => Promise<string | null>;
  dryRun?: boolean;
  timeoutMs?: number;
  /** Cap on files quoted into the prompt. Context is not free on a local model. */
  maxContextFiles?: number;
}

export interface AgentFixResult {
  gap: Gap;
  provider: string;
  /** Free text from a harness, or the model's `summary`. */
  summary: string;
  written: string[];
  refused: Array<{ reason: string; path: string }>;
  revertedBecause?: string;
  /**
   * `changed`  — edits landed.
   * `declined` — the provider looked and said no change was warranted. Valid.
   * `unusable` — the reply could not be read as an edit plan. NOT the same as
   *              declining: reporting it as "nothing to do" would quietly drop
   *              the gap and nobody would look at it again.
   * `reverted` — edits landed and verification put them back.
   */
  outcome: "changed" | "declined" | "unusable" | "reverted";
}

const CONTEXT_BUDGET_BYTES = 24_000;

/**
 * The brief.
 *
 * Deliberately states what the gap IS and what "done" looks like, rather than
 * naming an edit: a prompt that dictates the change is a worse version of
 * `fix.ts`, and the reason this gap reached a model is that nobody could write
 * the rule down.
 */
export function buildFixPrompt(gap: Gap, context: string, kind: "harness" | "model"): string {
  const brief = [
    `Close one documentation gap in the "${gap.app}" mechanics corpus.`,
    "",
    `Gap:        ${gap.title}`,
    `Class:      ${gap.gap}`,
    `Subject:    ${gap.subject}`,
    `Why:        ${gap.detail}`,
    `Suggestion: ${gap.suggestion}`,
    "",
    "A mechanic is one markdown file describing ONE user-observable behaviour:",
    "frontmatter (title, kind, status, priority, roles, claims, paths) then",
    "## Story, ## Acceptance Criteria (labelled **AC1**, **AC2**, …),",
    "## Edge Cases, ## Error States — all four sections required.",
    "",
    "Rules that are not negotiable:",
    "- New mechanics land as `status: draft`. A human promotes them.",
    "- Never add or widen an `ignore` glob to make a gap disappear.",
    "- Never record a verification verdict.",
    "- Describe behaviour you can see in the code. If you cannot tell what a",
    "  surface does, say so and change nothing — a confident invention is worse",
    "  than an open gap, because it stops anyone looking again.",
  ];
  if (context) brief.push("", "Context from the repo:", context);
  brief.push(
    "",
    kind === "model"
      ? EDIT_PROTOCOL
      : "Make the change in this worktree. Reply with one line saying what you did."
  );
  return brief.join("\n");
}

/**
 * Quote the files a provider needs to answer honestly.
 *
 * A harness can go and read the tree itself, so it gets a file list. A bare
 * model cannot, so it gets contents — capped, because a local 7B with 24k of
 * context spent on `node_modules` paths has none left for the answer.
 */
export async function gatherContext(
  repoRoot: string,
  gap: Gap,
  kind: "harness" | "model",
  maxFiles = 6
): Promise<string> {
  const candidates = candidateFiles(gap).slice(0, maxFiles);
  if (candidates.length === 0) return "";
  if (kind === "harness") {
    return ["Files worth reading first:", ...candidates.map((f) => `  ${f}`)].join("\n");
  }

  const parts: string[] = [];
  let budget = CONTEXT_BUDGET_BYTES;
  for (const rel of candidates) {
    let body: string;
    try {
      body = await fs.readFile(path.join(repoRoot, rel), "utf8");
    } catch {
      continue;
    }
    if (body.length > budget) body = `${body.slice(0, budget)}\n… (truncated)`;
    budget -= body.length;
    parts.push(`--- ${rel} ---\n${body}`);
    if (budget <= 0) break;
  }
  return parts.join("\n\n");
}

/**
 * The MAY-NEVER list, applied to what a model asked for.
 *
 * `assertNoForbiddenOp` guards the mechanical lane. This is its counterpart
 * for the model lane, and it is not theoretical: the first real run of this
 * pipeline against a local model produced an edit whose own summary was
 * "Promote perch.status-page.custom-domain from draft to active". It failed
 * only because the path it guessed did not exist. Nothing was stopping it.
 *
 * Full autonomy over the tree is the point — a provider may write mechanics,
 * write specs, restructure app code. These four are not that. Each one is a
 * claim that work is good, and that claim belongs to a person:
 *
 *   1. a wave file        — that is where verdicts live
 *   2. `status: active`   — promoting a draft is the review
 *   3. `coverage.ignore`  — the one move that makes a gap disappear
 *   4. `coverage.enforce` — the ratchet itself
 */
export function forbiddenEdit(
  edit: { op: string; path: string; replace?: string; content?: string },
  before: string | null
): string | null {
  const rel = edit.path.replace(/\\/g, "/");
  const after = edit.op === "create" ? (edit.content ?? "") : (edit.replace ?? "");

  if (/(^|\/)mechanics\/waves\//.test(rel) || /(^|\/)waves\/[^/]+\.yaml$/.test(rel)) {
    return "refusing to edit a wave file — verdicts are a human's (docket/1 invariant 4)";
  }
  if (
    /\bstatus:\s*active\b/.test(after) &&
    (before === null || /\bstatus:\s*draft\b/.test(before))
  ) {
    return "refusing to set status: active — promoting a draft is the review, and that is a person's";
  }
  if (/\bignore:/.test(after) && !(before ?? "").includes(after.trim())) {
    return "refusing to touch coverage.ignore — hiding a gap is the one move that makes this decoration";
  }
  if (/\benforce:\s*(warn|error)\b/.test(after) && !(before ?? "").includes(after.trim())) {
    return "refusing to change coverage.enforce — the ratchet is a deliberate human step";
  }
  return null;
}

/** Files a gap plausibly concerns, from the gap alone — no guessing at prose. */
function candidateFiles(gap: Gap): string[] {
  const out: string[] = [];
  if (gap.op && "file" in gap.op) out.push(gap.op.file);
  // A glob-declared surface IS a path, so an unclaimed one names its own file.
  if (gap.gap === "unclaimed-surface" && /[/.]/.test(gap.subject) && !gap.subject.startsWith("/")) {
    out.push(gap.subject);
  }
  return [...new Set(out)];
}

/**
 * Hand one gap to a provider and take the result, or take none of it.
 */
export async function agentFixGap(gap: Gap, options: AgentFixOptions): Promise<AgentFixResult> {
  const kind = options.spec.kind;
  const context = await gatherContext(options.repoRoot, gap, kind, options.maxContextFiles);
  const prompt = buildFixPrompt(gap, context, kind);

  const reply = await runProvider(options.spec, prompt, {
    cwd: options.repoRoot,
    timeoutMs: options.timeoutMs,
  });

  if (kind === "harness") {
    // A harness edited the tree itself; there is no plan to apply. Verify
    // anyway — the guard belongs to the pipeline, not to the provider.
    const problem = options.verify ? await options.verify() : null;
    return {
      gap,
      provider: options.spec.name,
      summary: reply.text.trim().split("\n").filter(Boolean).at(-1) ?? "(no output)",
      written: [],
      refused: [],
      outcome: problem ? "reverted" : reply.text.trim().length === 0 ? "declined" : "changed",
      ...(problem ? { revertedBecause: problem } : {}),
    };
  }

  const plan = parseEditPlan(reply.text);
  if (!plan) {
    // Not the same as "no edits": the model said something this cannot read,
    // and pretending that means "nothing to do" would quietly drop the gap.
    return {
      gap,
      provider: options.spec.name,
      summary: `no usable edit plan in the reply (${firstLine(reply.text)})`,
      written: [],
      refused: [],
      outcome: "unusable",
    };
  }

  const res = await applyEdits(options.repoRoot, plan, {
    verify: options.verify,
    dryRun: options.dryRun,
    guard: forbiddenEdit,
  });
  return {
    gap,
    provider: options.spec.name,
    summary: plan.summary,
    written: res.written,
    refused: res.refused.map((r) => ({ reason: r.reason, path: r.edit.path })),
    outcome: res.revertedBecause ? "reverted" : plan.edits.length === 0 ? "declined" : "changed",
    ...(res.revertedBecause ? { revertedBecause: res.revertedBecause } : {}),
  };
}

/** A reply's first meaningful line, for an error message that fits on screen. */
function firstLine(text: string): string {
  return (
    text
      .trim()
      .split("\n")
      .find((l) => l.trim()) ?? "(empty)"
  ).slice(0, 100);
}

/** One line per provider, for `mechanics agents`. */
export function describeAvailability(a: Availability): string {
  const models = a.models?.length
    ? ` — ${a.models.slice(0, 3).join(", ")}${a.models.length > 3 ? ` (+${a.models.length - 3})` : ""}`
    : "";
  return `${a.name} (${a.kind}) ${a.available ? "ready" : "unavailable"}: ${a.detail}${models}`;
}
