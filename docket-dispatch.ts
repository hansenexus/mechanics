/**
 * `mechanics run dispatch` — open a work order and give it somewhere to live:
 * an isolated worktree, a branch, optionally a draft PR, optionally an agent.
 *
 * Deliberately thin. This creates the *place* for interactive, project-bound
 * work and then gets out of the way. It is not a scheduler and must never
 * become one — recurring and server-side playbooks belong to whatever daemon
 * already runs them, which reports into the same board by emitting events
 * through the CLI.
 *
 * ## Two roots, and why they differ
 *
 * The **run directory** lands in the checkout you dispatch *from*, not in the
 * new worktree. That is the trade: a run committed alongside its branch would
 * travel with the work, but the board would then only ever see one run at a
 * time. A command centre that shows one job is not a command centre, so the
 * dispatching checkout is the hub and every run lands in its `.docket/`.
 *
 * The **worktree** lands under the PRIMARY checkout. Both roots were the same
 * value until this run dispatched itself from a worktree and got
 * `.claude/worktrees/feat/a/.claude/worktrees/feat/b` — a worktree nested
 * inside a worktree, which `git worktree list` shows and nothing else expects.
 * `git rev-parse --git-common-dir` names the shared `.git` from any worktree,
 * so its parent is the primary regardless of where you stand.
 *
 * ## What happens without an explicit flag
 *
 * Only local, reversible things: a worktree, a branch, an order file. Pushing
 * a branch, opening a pull request and launching an agent that will commit are
 * each gated behind their own flag. Dispatch is a convenience, and convenience
 * is not consent to publish.
 */

import path from "node:path";
import { appendEvent } from "./docket-events";
import type { ForgeAdapter } from "./docket-forge";
import { renderPrBody } from "./docket-forge";
import { deriveRunId, runDir, slugify, writeOrder } from "./docket-order";
import { DEFAULT_PHASES, type DocketOrder } from "./docket-types";

export type DispatchInput = {
  title: string;
  today: string;
  base: string;
  branch?: string;
  runId?: string;
  app?: string;
  criteria: string[];
  phases?: string[];
  wave?: string;
  /**
   * Forge issue this run exists to close (#424 PR3). Recorded as
   * `links.issue` in the order and rendered as `Closes #N` into the draft PR
   * body, so the squash-merge closes the issue and boards can join
   * card -> run.
   */
  issue?: number;
  withPush: boolean;
  withPr: boolean;
  withAgent: boolean;
  /**
   * Git remote the branch is pushed to and the PR is opened against.
   * Defaults to `origin`, which is only right for repos whose origin IS the
   * primary forge. When origin is a read-only mirror and the primary lives on
   * a second remote, resolve with `pickPushRemote` so a dispatch never
   * publishes to the mirror.
   */
  remote?: string;
  /**
   * Absolute path to the PRIMARY checkout — where `.claude/worktrees/` lives.
   * Resolve it with `findPrimaryRoot`; omitting it means "I am the primary",
   * which is true for a plain checkout and false for every worktree.
   */
  primaryRoot: string;
};

export type DispatchStep = {
  id: "worktree" | "order" | "push" | "pr" | "agent";
  label: string;
  /** True when the step leaves this machine or starts something that commits.
   * Every one of these is opt-in. */
  gated: boolean;
};

export type DispatchPlan = {
  runId: string;
  branch: string;
  /** Repo-relative, as recorded in the order file. */
  worktree: string;
  /** Absolute, under the primary checkout — what actually gets created. */
  worktreePath: string;
  base: string;
  /** Where gated push/PR steps publish to — see DispatchInput.remote. */
  remote: string;
  order: DocketOrder;
  steps: DispatchStep[];
};

/**
 * The remote dispatch publishes to: always `origin`.
 *
 * This used to sniff for a remote named `forge` and prefer it, from the
 * forge-primary period when `origin` was the GitHub CI mirror and a branch
 * there was a policy violation. GitHub became primary again on 2026-08-18 and
 * the push-mirror was deleted, but the `forge` remote was deliberately KEPT on
 * every checkout — forge is still a live bot-facing API. So the old sniff now
 * matches everywhere and would quietly publish every dispatch branch and PR to
 * the plane nobody reviews.
 *
 * `run` and `repoRoot` stay in the signature: callers pass them, and the
 * decision belongs here rather than being inlined at the call site, so
 * per-repo topology can come back without touching docket-cli.
 *
 * `docket-forge.ts` picks the API dialect from the remote's host
 * (`forgeKindFor`), so returning `origin` also switches PR creation to the
 * GitHub endpoint with no further change.
 */
export async function pickPushRemote(
  _run: (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<string>,
  _repoRoot: string
): Promise<string> {
  return "origin";
}

/** `feat/export-csv-flow` from a title, when the caller did not name one. */
export function deriveBranch(title: string): string {
  return `feat/${slugify(title, 40) || "work"}`;
}

/** Pure: no filesystem, no network. `--dry-run` prints exactly this. */
export function planDispatch(input: DispatchInput): DispatchPlan {
  const remote = input.remote ?? "origin";
  const branch = input.branch ?? deriveBranch(input.title);
  const runId = input.runId ?? deriveRunId(input.title, input.today);
  // Matches the repo's existing convention so `git worktree list` stays
  // readable and the isolation rules keep applying.
  const worktree = path.join(".claude", "worktrees", branch);
  const worktreePath = path.resolve(input.primaryRoot, worktree);

  const order: DocketOrder = {
    run: runId,
    title: input.title,
    ...(input.app ? { scope: { app: input.app, specs: [] } } : {}),
    exitCriteria: input.criteria,
    phases: input.phases?.length ? input.phases : [...DEFAULT_PHASES],
    ...(input.wave ? { wave: input.wave } : {}),
    git: { branch, worktree },
    ...(input.issue !== undefined ? { links: { issue: input.issue } } : {}),
  };

  const steps: DispatchStep[] = [
    {
      id: "worktree",
      label: `git worktree add -b ${branch} ${worktreePath} ${input.base}`,
      gated: false,
    },
    { id: "order", label: `write .docket/runs/${runId}/order.yaml`, gated: false },
  ];
  // A PR implies the branch exists on the remote; asking for one and getting a
  // push refusal would be a pointless failure mode.
  if (input.withPush || input.withPr) {
    steps.push({ id: "push", label: `git push -u ${remote} ${branch}`, gated: true });
  }
  if (input.withPr) steps.push({ id: "pr", label: "open a draft pull request", gated: true });
  if (input.withAgent) steps.push({ id: "agent", label: "launch a headless agent", gated: true });
  return { runId, branch, worktree, worktreePath, base: input.base, remote, order, steps };
}

export type DispatchDeps = {
  /**
   * Where `.docket/` lives — the checkout being dispatched from. NOT where the
   * worktree goes; that is `plan.worktreePath`, under the primary.
   */
  repoRoot: string;
  /** Injected so the plan can be executed against a fake in tests. */
  run(cmd: string, args: string[], opts?: { cwd?: string }): Promise<string>;
  forge?: ForgeAdapter;
  launchAgent?(input: { worktree: string; prompt: string; runId: string }): Promise<void>;
  actorIdentity?: string;
};

/**
 * The primary checkout, from anywhere inside the repo.
 *
 * `--git-common-dir` is the shared `.git` — a directory in the primary, and
 * what a linked worktree's `.git` FILE points at. Its parent is therefore the
 * primary working tree from any worktree. A bare or otherwise unusual repo
 * whose common dir is not named `.git` falls back to the caller's root rather
 * than guessing at a parent that may not be a working tree at all.
 */
export async function findPrimaryRoot(
  run: (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<string>,
  repoRoot: string
): Promise<string> {
  try {
    const out = await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: repoRoot,
    });
    const common = out.trim();
    if (!common) return repoRoot;
    return path.basename(common) === ".git" ? path.dirname(common) : repoRoot;
  } catch {
    return repoRoot;
  }
}

export type DispatchResult = {
  runId: string;
  branch: string;
  worktreePath: string;
  pr?: { number: number; url: string };
  done: string[];
};

export function agentPrompt(plan: DispatchPlan): string {
  const criteria = plan.order.exitCriteria.length
    ? plan.order.exitCriteria.map((c) => `  - ${c}`).join("\n")
    : "  (none declared — clarify them before implementing)";
  return [
    plan.order.title,
    "",
    "Exit criteria — the work is done when every one of these is demonstrably met:",
    criteria,
    "",
    "Report progress into the run as you go:",
    `  bun mechanics run event --run=${plan.runId} --type=phase.entered --phase=<phase>`,
    `  bun mechanics run event --run=${plan.runId} --type=criterion.evaluated \\`,
    "      --criterion=<id> --verdict=pass --method=e2e --evidence=<path>",
    `  bun mechanics run event --run=${plan.runId} --type=gate.blocked --reason="…" --needs=human`,
    "",
    "If you find something worth changing that is not yours to decide, propose it",
    "rather than doing it or dropping it:",
    `  bun mechanics gaps --app=<slug> --propose --run=${plan.runId}`,
    "",
    "A pass verdict requires evidence. If you are blocked, say so with gate.blocked",
    "rather than going quiet — a silent run is indistinguishable from a dead one.",
    "You may raise and reject proposals; you may not accept your own. The CLI",
    "refuses it, and that refusal is the point rather than an obstacle.",
  ].join("\n");
}

export async function executeDispatch(
  plan: DispatchPlan,
  deps: DispatchDeps
): Promise<DispatchResult> {
  const done: string[] = [];
  const worktreePath = plan.worktreePath;
  const actor = {
    kind: "human" as const,
    identity: deps.actorIdentity,
  };

  // Absolute target: a relative one resolves against whichever checkout git
  // runs in, which is exactly the nesting bug.
  await deps.run("git", ["worktree", "add", "-b", plan.branch, worktreePath, plan.base], {
    cwd: deps.repoRoot,
  });
  done.push("worktree");

  await writeOrder(deps.repoRoot, plan.order);
  await appendEvent(deps.repoRoot, plan.runId, {
    type: "run.created",
    actor,
    payload: { title: plan.order.title },
  });
  await appendEvent(deps.repoRoot, plan.runId, {
    type: "git.linked",
    actor,
    payload: { branch: plan.branch },
  });
  done.push("order");

  const wants = new Set(plan.steps.map((s) => s.id));

  if (wants.has("push")) {
    await deps.run("git", ["push", "-u", plan.remote, plan.branch], { cwd: worktreePath });
    done.push("push");
  }

  let pr: DispatchResult["pr"];
  if (wants.has("pr")) {
    if (!deps.forge) throw new Error("docket: no forge adapter — cannot open a pull request");
    pr = await deps.forge.openDraftPr({
      title: plan.order.title,
      body: renderPrBody({
        runId: plan.runId,
        title: plan.order.title,
        criteria: plan.order.exitCriteria,
        ...(plan.order.links?.issue !== undefined ? { closesIssue: plan.order.links.issue } : {}),
      }),
      head: plan.branch,
      // `<remote>/master` is a local tracking ref; the PR base is the branch.
      base: plan.base.startsWith(`${plan.remote}/`)
        ? plan.base.slice(plan.remote.length + 1)
        : plan.base,
    });
    await appendEvent(deps.repoRoot, plan.runId, {
      type: "git.linked",
      actor,
      payload: { branch: plan.branch, pr: pr.number },
    });
    done.push("pr");
  }

  if (wants.has("agent")) {
    if (!deps.launchAgent) throw new Error("docket: no agent launcher configured");
    await deps.launchAgent({
      worktree: worktreePath,
      prompt: agentPrompt(plan),
      runId: plan.runId,
    });
    await appendEvent(deps.repoRoot, plan.runId, { type: "run.started", actor });
    done.push("agent");
  }

  return { runId: plan.runId, branch: plan.branch, worktreePath, pr, done };
}

export function describePlan(plan: DispatchPlan): string {
  const lines = [
    `run     ${plan.runId}`,
    `branch  ${plan.branch}  (off ${plan.base})`,
    `worktree ${plan.worktreePath}`,
    "",
    "steps:",
  ];
  for (const step of plan.steps) {
    lines.push(`  ${step.gated ? "!" : "·"} ${step.label}`);
  }
  if (plan.order.exitCriteria.length === 0) {
    lines.push("", "  no exit criteria — the run has no definition of done yet");
  }
  const gated = plan.steps.filter((s) => s.gated);
  if (gated.length === 0) {
    lines.push("", "  local only: nothing is pushed, published, or started");
  }
  return lines.join("\n");
}

/** `run dispatch` uses this only when the run directory is missing — never
 * re-runs a dispatch over an existing run. */
export function runExistsPath(repoRoot: string, runId: string): string {
  return runDir(repoRoot, runId);
}
