/**
 * Which run does this session belong to?
 *
 * Hooks fire with no idea what work order is in flight, so binding has to be
 * inferred. Three sources, in descending order of confidence:
 *
 *   1. `agent.sessionId` in order.yaml — an explicit `run attach`, exact.
 *   2. `git.branch` — the repo's one-branch-per-work-order convention, which
 *      makes the common case need no attach step at all.
 *   3. `.docket/current` — a per-checkout pointer for anything the first two
 *      cannot express (a run spanning branches, a detached HEAD).
 *
 * Finished runs are deliberately NOT filtered out here. Doing so would mean
 * reading every event log on every hook invocation, and it is unnecessary: a
 * heartbeat appended to a finished run cannot change its state, because
 * `done` outranks everything in the liveness rule.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { listRunIds, orderPath, runsRoot } from "./docket-order";
import { DOCKET_DIR, RUN_ID_RE } from "./docket-types";

export type ResolveContext = {
  sessionId?: string;
  branch?: string;
};

export type ResolvedRun = {
  run: string;
  /** How the binding was made — surfaced so a wrong guess is debuggable. */
  via: "session" | "branch" | "pointer";
};

export function pointerPath(repoRoot: string): string {
  return path.join(repoRoot, DOCKET_DIR, "current");
}

/** Cheapest possible negative answer: most checkouts have no `.docket/` at
 * all, and a hook on every tool call must cost one stat in that case. */
export async function hasDocket(repoRoot: string): Promise<boolean> {
  try {
    await fs.access(runsRoot(repoRoot));
    return true;
  } catch {
    return false;
  }
}

/** Read just the two fields binding needs — the full schema is not worth
 * parsing here, and a malformed order must not break an unrelated session. */
async function readBinding(
  repoRoot: string,
  runId: string
): Promise<{ sessionId?: string; branch?: string }> {
  try {
    const raw = await fs.readFile(orderPath(repoRoot, runId), "utf8");
    const doc = parseYaml(raw) as Record<string, unknown> | null;
    const agent = doc?.agent as Record<string, unknown> | undefined;
    const git = doc?.git as Record<string, unknown> | undefined;
    return {
      sessionId: typeof agent?.sessionId === "string" ? agent.sessionId : undefined,
      branch: typeof git?.branch === "string" ? git.branch : undefined,
    };
  } catch {
    return {};
  }
}

export async function resolveActiveRun(
  repoRoot: string,
  ctx: ResolveContext
): Promise<ResolvedRun | null> {
  if (!(await hasDocket(repoRoot))) return null;

  const ids = await listRunIds(repoRoot);
  let branchMatch: string | undefined;

  for (const id of ids) {
    const binding = await readBinding(repoRoot, id);
    if (ctx.sessionId && binding.sessionId === ctx.sessionId) return { run: id, via: "session" };
    // Newest-first iteration means the first branch hit is the most recent
    // run on that branch, which is the one still being worked on.
    if (!branchMatch && ctx.branch && binding.branch === ctx.branch) branchMatch = id;
  }
  if (branchMatch) return { run: branchMatch, via: "branch" };

  try {
    const pointer = (await fs.readFile(pointerPath(repoRoot), "utf8")).trim();
    if (RUN_ID_RE.test(pointer)) return { run: pointer, via: "pointer" };
  } catch {
    // no pointer — fall through
  }
  return null;
}

/** Bind a run to this session, so hooks stop having to guess. */
export async function attachSession(
  repoRoot: string,
  runId: string,
  sessionId: string
): Promise<void> {
  const target = orderPath(repoRoot, runId);
  const raw = await fs.readFile(target, "utf8");
  const doc = parseYaml(raw) as Record<string, unknown>;
  const agent = (doc.agent as Record<string, unknown> | undefined) ?? {};
  doc.agent = { ...agent, harness: agent.harness ?? "claude-code", sessionId };
  const { stringify } = await import("yaml");
  await fs.writeFile(target, stringify(doc, { lineWidth: 0 }), "utf8");
}

export function heartbeatMarkerPath(repoRoot: string, runId: string): string {
  return path.join(runsRoot(repoRoot), runId, ".heartbeat");
}

/**
 * True when the last heartbeat is older than `windowMs`. Throttling via a
 * marker file's mtime keeps the common hook path to one stat — appending an
 * event on every tool call would add measurable latency to every session in
 * the repo, which is not a trade a background signal gets to make.
 */
export async function heartbeatDue(
  repoRoot: string,
  runId: string,
  windowMs: number,
  now = Date.now()
): Promise<boolean> {
  try {
    const stat = await fs.stat(heartbeatMarkerPath(repoRoot, runId));
    return now - stat.mtimeMs >= windowMs;
  } catch {
    return true;
  }
}

export async function touchHeartbeat(repoRoot: string, runId: string): Promise<void> {
  await fs.writeFile(heartbeatMarkerPath(repoRoot, runId), "", "utf8");
}

/**
 * Drop the throttle so the next tool call is guaranteed to emit. Called when a
 * run goes idle: only a later event clears `idle`, and a human who answers
 * within the throttle window would otherwise leave the board claiming the run
 * is idle while the agent is demonstrably working.
 */
export async function clearHeartbeat(repoRoot: string, runId: string): Promise<void> {
  await fs.rm(heartbeatMarkerPath(repoRoot, runId), { force: true });
}
