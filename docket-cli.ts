/**
 * `bun mechanics run <sub>` — the run layer's command surface.
 *
 *   run new     --title=… [--app=…] [--criteria=a,b] [--phases=a,b] [--branch=…]
 *   run event   --run=… --type=… [--phase=…] [--criterion=…] [--verdict=…]
 *               [--method=…] [--evidence=…] [--reason=…] [--needs=…]
 *               [--decision=…] [--to=…] [--kind=…] [--path=…] [--by=…]
 *   run show    --run=…
 *   run list    [--watch] [--interval=2] [--all]
 *   run rebuild --run=… | --all
 *
 * `list` is the board: one line per run with phase, criteria met, PR and the
 * working / waiting / stalled distinction. `--watch` just redraws it on a
 * timer — deliberately no TUI dependency, so this works the moment it lands.
 */

import { appendEvent, readEvents } from "./docket-events";
import { deriveRunId, listRunIds, loadOrder, runDir, writeOrder } from "./docket-order";
import { attachSession, resolveActiveRun } from "./docket-resolve";
import { reduceRun, writeState } from "./docket-state";
import {
  type Actor,
  DEFAULT_PHASES,
  type DocketOrder,
  RUN_ID_RE,
  type RunState,
} from "./docket-types";
import { REPO_ROOT } from "./fsutil";

type Flags = Record<string, string | true>;

function parseFlags(argv: string[]): { sub: string; flags: Flags } {
  const [sub = "", ...rest] = argv;
  const flags: Flags = {};
  for (const arg of rest) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq === -1) flags[arg.slice(2)] = true;
    else flags[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return { sub, flags };
}

function flag(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

function list(flags: Flags, key: string): string[] {
  const v = flag(flags, key);
  return v
    ? v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

function fail(msg: string): never {
  console.error(`[docket] ${msg}`);
  process.exit(1);
}

/**
 * Who is writing. A Claude Code session exports `CLAUDE_CODE_SESSION_ID`; the
 * CLI run by a person from a terminal is a human. `--by` overrides for CI and
 * for scripted producers.
 */
function currentActor(flags: Flags): Actor {
  return currentCliActor(flag(flags, "by"));
}

/**
 * Exported so the corpus CLI derives the actor the same way rather than
 * inventing a second answer. Which matters more than usual here: an actor
 * inferred two ways is an actor that can be `agent` in one command and
 * `human` in another, and the proposal-acceptance refusal turns on exactly
 * that field.
 */
export function currentCliActor(by?: string): Actor {
  const session = process.env.CLAUDE_CODE_SESSION_ID;
  if (by === "hook") return { kind: "hook", harness: "claude-code", session };
  if (by === "ci") return { kind: "ci", identity: process.env.CI_JOB ?? "ci" };
  if (session) return { kind: "agent", harness: "claude-code", session };
  return { kind: "human", identity: by ?? process.env.USER };
}

export async function runDocketCli(argv: string[]): Promise<void> {
  const { sub, flags } = parseFlags(argv);
  switch (sub) {
    case "new":
      await cmdNew(flags);
      break;
    case "event":
      await cmdEvent(flags);
      break;
    case "show":
      await cmdShow(flags);
      break;
    case "list":
      await cmdList(flags);
      break;
    case "rebuild":
      await cmdRebuild(flags);
      break;
    case "finish":
      await cmdFinish(flags);
      break;
    case "merge-wave":
      await cmdMergeWave(flags);
      break;
    case "dispatch":
      await cmdDispatch(flags);
      break;
    case "serve":
      await cmdServe(flags);
      break;
    case "report":
      await cmdReport(flags);
      break;
    case "attach":
      await cmdAttach(flags);
      break;
    case "proposals":
      await cmdProposals(flags);
      break;
    case "accept":
      await cmdAccept(flags);
      break;
    case "reject":
      await cmdReject(flags);
      break;
    case "which":
      await cmdWhich(flags);
      break;
    default:
      usage();
      process.exit(sub ? 1 : 0);
  }
}

/**
 * Close a run and, unless told otherwise, fold its verdicts into the wave.
 * Merging on finish is the point: a wave that only fills when somebody
 * remembers to run `verify` is a wave that goes stale.
 */
async function cmdFinish(flags: Flags): Promise<void> {
  const runId = flag(flags, "run") ?? fail("run finish: --run is required");
  const result = flag(flags, "result") ?? "shipped";
  if (!["shipped", "abandoned", "blocked"].includes(result)) {
    fail(`run finish: --result must be shipped|abandoned|blocked (got "${result}")`);
  }

  await appendEvent(REPO_ROOT, runId, {
    type: "run.finished",
    actor: currentActor(flags),
    payload: { result },
  });
  console.log(`[docket] ${runId} finished (${result})`);

  if (flags["no-wave"] === true) return;
  if (result !== "shipped") {
    console.log("[docket] not shipped — wave left untouched");
    return;
  }
  await mergeWave(runId, { dryRun: false, quietIfNoWave: true, by: flag(flags, "by") });
}

async function cmdMergeWave(flags: Flags): Promise<void> {
  const runId = flag(flags, "run") ?? fail("run merge-wave: --run is required");
  await mergeWave(runId, {
    dryRun: flags["dry-run"] === true,
    quietIfNoWave: false,
    by: flag(flags, "by"),
  });
}

async function mergeWave(
  runId: string,
  opts: { dryRun: boolean; quietIfNoWave: boolean; by?: string }
): Promise<void> {
  const order = await loadOrder(REPO_ROOT, runId);
  const app = order.scope?.app;
  if (!order.wave || !app) {
    if (!opts.quietIfNoWave) {
      fail(
        `run merge-wave: ${runId} needs both scope.app and wave in order.yaml ` +
          `(have app=${app ?? "—"}, wave=${order.wave ?? "—"})`
      );
    }
    return;
  }

  const { loadWave } = await import("./waves");
  const wave = await loadWave(app, order.wave, REPO_ROOT);
  if (!wave) fail(`run merge-wave: no wave "${order.wave}" for app ${app}`);

  const state = await loadState(runId);
  const { applyMergePlan, describeMergePlan, planWaveMerge } = await import("./docket-wave");
  const plan = planWaveMerge(state.criteria, wave, order.exitCriteria);
  console.log(describeMergePlan(plan, order.wave, app));

  if (opts.dryRun) {
    console.log("\n[docket] dry run — the wave file was not touched");
    return;
  }
  const applied = plan.entries.filter((e) => !e.skipped);
  if (applied.length === 0) {
    console.log("\n[docket] nothing to write");
    return;
  }

  const { writeWave } = await import("./verify");
  const next = applyMergePlan(wave, plan, {
    verifiedBy: opts.by ?? `docket:${runId}`,
    date: new Date().toISOString().slice(0, 10),
  });
  console.log(`\n[docket] wrote ${await writeWave(app, next, REPO_ROOT)}`);
}

async function cmdDispatch(flags: Flags): Promise<void> {
  const title = flag(flags, "title") ?? fail("run dispatch: --title is required");
  const issueRaw = flag(flags, "issue");
  const issue = issueRaw === undefined ? undefined : Number(issueRaw);
  if (issue !== undefined && (!Number.isInteger(issue) || issue <= 0)) {
    fail("run dispatch: --issue must be a positive integer");
  }
  const { describePlan, executeDispatch, findPrimaryRoot, planDispatch, agentPrompt } =
    await import("./docket-dispatch");

  // Resolved before planning: the worktree path is part of the plan, and a dry
  // run that prints a different command than it would execute is a small lie.
  const deps = await buildDispatchDeps(flags.pr === true);
  const primaryRoot = await findPrimaryRoot(deps.run, REPO_ROOT);

  const plan = planDispatch({
    title,
    primaryRoot,
    today: new Date().toISOString().slice(0, 10),
    base: flag(flags, "base") ?? `${deps.remote}/master`,
    remote: deps.remote,
    branch: flag(flags, "branch"),
    runId: flag(flags, "id"),
    app: flag(flags, "app"),
    criteria: list(flags, "criteria"),
    phases: list(flags, "phases"),
    wave: flag(flags, "wave"),
    ...(issue !== undefined ? { issue } : {}),
    withPush: flags.push === true,
    withPr: flags.pr === true,
    withAgent: flags.agent === true,
  });

  console.log(describePlan(plan));
  if (primaryRoot !== REPO_ROOT) {
    console.log(
      `\n[docket] dispatching from a worktree — the worktree lands in the primary checkout,` +
        `\n         the run directory stays here in ${REPO_ROOT}/.docket`
    );
  }

  if (flags["dry-run"] === true) {
    console.log("\n[docket] dry run — nothing was created");
    return;
  }

  const { promises: fsp } = await import("node:fs");
  const target = runDir(REPO_ROOT, plan.runId);
  if (
    await fsp
      .access(target)
      .then(() => true)
      .catch(() => false)
  ) {
    fail(`run dispatch: ${plan.runId} already exists — pass --id=<other> or pick a new title`);
  }

  try {
    const result = await executeDispatch(plan, deps);
    console.log(`\n[docket] ${result.done.join(" → ")}`);
    console.log(`[docket] cd ${result.worktreePath}`);
    if (result.pr) console.log(`[docket] draft PR #${result.pr.number} — ${result.pr.url}`);
    if (!result.done.includes("agent")) {
      console.log("\n[docket] to drive it yourself, start a session there with:\n");
      console.log(
        agentPrompt(plan)
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n")
      );
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function buildDispatchDeps(needsForge: boolean) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);

  const run = async (cmd: string, args: string[], opts?: { cwd?: string }) => {
    const { stdout } = await exec(cmd, args, { cwd: opts?.cwd ?? REPO_ROOT });
    return stdout;
  };

  const { pickPushRemote } = await import("./docket-dispatch");
  const remote = await pickPushRemote(run, REPO_ROOT);

  let forge: Awaited<ReturnType<typeof makeForge>> | undefined;
  if (needsForge) forge = await makeForge(run, remote);

  return {
    repoRoot: REPO_ROOT,
    run,
    remote,
    forge,
    actorIdentity: process.env.USER,
    launchAgent: async ({ worktree, prompt }: { worktree: string; prompt: string }) => {
      const { spawn } = await import("node:child_process");
      try {
        await exec("which", ["claude"]);
      } catch {
        throw new Error(
          "docket: `claude` is not on PATH — drop --agent and start a session yourself"
        );
      }
      // Detached: the agent outlives this command, which is the point of
      // dispatching rather than running the work inline.
      const child = spawn("claude", ["-p", prompt], {
        cwd: worktree,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    },
  };
}

async function makeForge(run: (c: string, a: string[]) => Promise<string>, remoteName: string) {
  const { createForgeAdapter, parseRemote } = await import("./docket-forge");
  const url = (await run("git", ["remote", "get-url", remoteName])).trim();
  const remote = parseRemote(url);
  if (!remote) throw new Error(`docket: cannot parse the ${remoteName} remote (${url})`);
  return createForgeAdapter(remote);
}

async function cmdServe(flags: Flags): Promise<void> {
  const port = Number(flag(flags, "port") ?? 4747);
  const { startServer } = await import("./docket-serve");
  const server = startServer({ repoRoot: REPO_ROOT, port });
  console.log(`[docket] board on ${server.url}  (ctrl-c to stop)`);
  process.on("SIGINT", () => {
    server.stop();
    process.exit(0);
  });
  // Hold the process open; Bun.serve alone does not.
  await new Promise(() => {});
}

/** The same page as `serve`, frozen into one file — attach it to a PR or open
 * it months later. Identical markup, so the report cannot drift from the
 * board. */
async function cmdReport(flags: Flags): Promise<void> {
  const out = flag(flags, "out") ?? ".docket/report.html";
  const { writeReport } = await import("./docket-serve");
  console.log(`[docket] wrote ${await writeReport(REPO_ROOT, out)}`);
}

/** Bind a run to this session so the hooks stop inferring from the branch. */
async function cmdAttach(flags: Flags): Promise<void> {
  const runId = flag(flags, "run") ?? fail("run attach: --run is required");
  const session =
    flag(flags, "session") ??
    process.env.CLAUDE_CODE_SESSION_ID ??
    fail("run attach: no CLAUDE_CODE_SESSION_ID — pass --session=<id>");
  await attachSession(REPO_ROOT, runId, session);
  console.log(`[docket] ${runId} attached to session ${session.slice(0, 8)}`);
}

// ---------------------------------------------------------------------------
// proposals
// ---------------------------------------------------------------------------

async function cmdProposals(flags: Flags): Promise<void> {
  const runId = flag(flags, "run") ?? fail("run proposals: --run is required");
  const { listProposals } = await import("./proposals");
  const records = await listProposals(REPO_ROOT, runId);
  if (records.length === 0) {
    console.log(`[docket] ${runId}: no proposals`);
    return;
  }
  // Status comes from the LOG, never from the record — the record is content,
  // and a second copy of status on disk is a second thing to keep true.
  const state = await proposalStatuses(runId);
  for (const r of records) {
    const status = state.get(r.proposal) ?? "open";
    const mark = status === "open" ? "…" : status === "accepted" ? "✓" : "✗";
    console.log(`  ${mark} ${r.proposal}`);
    console.log(`      ${r.title}`);
    console.log(`      ${r.suggestion}${r.op ? `  [applies: ${r.op.kind}]` : ""}`);
  }
}

async function cmdAccept(flags: Flags): Promise<void> {
  const runId = flag(flags, "run") ?? fail("run accept: --run is required");
  const id = flag(flags, "proposal") ?? fail("run accept: --proposal is required");
  const { acceptProposal } = await import("./proposals");
  const actor = currentActor(flags);

  // The refusal is the most important message this command can print, so it
  // reads as a decision rather than a crash. A stack trace here would look
  // like the tool broke, and the next move would be to work around it.
  if (actor.kind !== "human") {
    fail(
      `run accept: only a human may accept a proposal — you are "${actor.kind}".\n` +
        "         Accepting asserts the suggestion was right, which is the same act as\n" +
        "         marking work green. Ask a person to run this, or reject it with a reason."
    );
  }

  const res = await acceptProposal(REPO_ROOT, runId, id, actor, {
    apply: flags.apply === true,
  });
  if (res.revertedBecause) {
    console.error(`[docket] ${id}: accepted, but the edit was reverted — ${res.revertedBecause}`);
    process.exit(1);
  }
  console.log(`[docket] accepted ${id}`);
  for (const f of res.written) console.log(`  wrote ${f}`);
}

async function cmdReject(flags: Flags): Promise<void> {
  const runId = flag(flags, "run") ?? fail("run reject: --run is required");
  const id = flag(flags, "proposal") ?? fail("run reject: --proposal is required");
  const reason = flag(flags, "reason") ?? fail("run reject: --reason is required");
  const { rejectProposal } = await import("./proposals");
  await rejectProposal(REPO_ROOT, runId, id, reason, currentActor(flags));
  console.log(`[docket] rejected ${id}`);
}

/** Proposal id → derived status, read back out of the event log. */
async function proposalStatuses(runId: string): Promise<Map<string, string>> {
  const order = await loadOrder(REPO_ROOT, runId);
  const { events } = await readEvents(REPO_ROOT, runId);
  return new Map(reduceRun(order, events).proposals.map((p) => [p.proposal, p.status]));
}

/** What the hooks would resolve right now — the debugging surface for a
 * binding that guessed wrong. */
async function cmdWhich(flags: Flags): Promise<void> {
  const branch = flag(flags, "branch") ?? (await gitBranch());
  const resolved = await resolveActiveRun(REPO_ROOT, {
    sessionId: flag(flags, "session") ?? process.env.CLAUDE_CODE_SESSION_ID,
    branch,
  });
  if (!resolved) {
    console.log(`[docket] no run bound (branch ${branch ?? "?"}) — hooks would no-op`);
    return;
  }
  console.log(`[docket] ${resolved.run}  (via ${resolved.via})`);
}

async function gitBranch(): Promise<string | undefined> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  try {
    const { stdout } = await promisify(execFile)("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: REPO_ROOT,
    });
    const out = stdout.trim();
    return out && out !== "HEAD" ? out : undefined;
  } catch {
    return undefined;
  }
}

async function cmdNew(flags: Flags): Promise<void> {
  const title = flag(flags, "title") ?? fail("run new: --title is required");
  const today = new Date().toISOString().slice(0, 10);
  const runId = flag(flags, "id") ?? deriveRunId(title, today);
  if (!RUN_ID_RE.test(runId)) fail(`run new: invalid run id "${runId}"`);

  const app = flag(flags, "app");
  const phases = list(flags, "phases");
  const order: DocketOrder = {
    run: runId,
    title,
    ...(app ? { scope: { app, specs: list(flags, "specs") } } : {}),
    exitCriteria: list(flags, "criteria"),
    phases: phases.length ? phases : [...DEFAULT_PHASES],
    ...(flag(flags, "wave") ? { wave: flag(flags, "wave") } : {}),
    ...(flag(flags, "branch") ? { git: { branch: flag(flags, "branch") } } : {}),
  };

  await writeOrder(REPO_ROOT, order);
  await appendEvent(REPO_ROOT, runId, {
    type: "run.created",
    actor: currentActor(flags),
    payload: { title },
  });
  console.log(`[docket] created ${runId}`);
  console.log(`         ${runDir(REPO_ROOT, runId)}`);
  if (order.exitCriteria.length === 0) {
    console.log("         no exit criteria yet — add them to order.yaml before dispatching");
  }
}

async function cmdEvent(flags: Flags): Promise<void> {
  const runId = flag(flags, "run") ?? fail("run event: --run is required");
  const type = flag(flags, "type") ?? fail("run event: --type is required");

  const payload: Record<string, unknown> = {};
  for (const key of [
    "phase",
    "criterion",
    "verdict",
    "method",
    "evidence",
    "reason",
    "needs",
    "decision",
    "title",
    "to",
    "kind",
    "path",
    "branch",
    "sha",
    "state",
    "result",
    "until",
    "body",
    "proposal",
    "subject",
    "patch",
  ]) {
    const v = flag(flags, key);
    if (v !== undefined) payload[key] = v;
  }
  const pr = flag(flags, "pr");
  if (pr) payload.pr = Number(pr);

  try {
    const ev = await appendEvent(REPO_ROOT, runId, {
      type,
      actor: currentActor(flags),
      payload,
    });
    console.log(`[docket] ${runId} #${ev.seq} ${ev.type}`);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function loadState(runId: string): Promise<RunState> {
  const order = await loadOrder(REPO_ROOT, runId);
  const { events, malformed } = await readEvents(REPO_ROOT, runId);
  return reduceRun(order, events, { malformed });
}

async function cmdShow(flags: Flags): Promise<void> {
  const runId = flag(flags, "run") ?? fail("run show: --run is required");
  const state = await loadState(runId);

  console.log(`${state.title}`);
  console.log(`${state.run}  ${statusLabel(state)}`);
  console.log("");
  console.log(`phase      ${state.phase ?? "(none)"}  of  ${state.phases.join(" → ")}`);
  console.log(`criteria   ${bar(state)} ${state.progress.met}/${state.progress.total}`);
  if (state.git?.pr) console.log(`pr         #${state.git.pr}`);
  if (state.claim)
    console.log(`claimed    ${actorLabel(state.claim.by)} until ${state.claim.until}`);
  if (state.blocked)
    console.log(`blocked    ${state.blocked.reason} (needs ${state.blocked.needs})`);
  if (state.handoff) console.log(`handoff    → ${state.handoff.to}`);

  if (state.criteria.length) {
    console.log("");
    for (const c of state.criteria) {
      const mark = c.verdict === "pass" ? "✓" : c.verdict === "n-a" ? "–" : "✗";
      const ev = c.evidence ? `  ${c.evidence}` : "";
      console.log(`  ${mark} ${c.criterion}  [${c.verdict}${c.method ? `/${c.method}` : ""}]${ev}`);
    }
  }
  if (state.decisions.length) {
    console.log("");
    for (const d of state.decisions) console.log(`  decision  ${d.decision}`);
  }
  if (state.proposals.length) {
    console.log("");
    for (const p of state.proposals) {
      const mark = p.status === "open" ? "…" : p.status === "accepted" ? "✓" : "✗";
      console.log(`  ${mark} proposal  ${p.proposal}${p.subject ? `  ${p.subject}` : ""}`);
    }
  }
  if (state.malformed) {
    console.log("");
    console.log(
      `  ${state.malformed} unparseable line(s) in events.jsonl — likely a killed writer`
    );
  }
}

async function cmdList(flags: Flags): Promise<void> {
  const watch = flags.watch === true || flag(flags, "watch") !== undefined;
  const intervalMs = Number(flag(flags, "interval") ?? 2) * 1000;

  const render = async () => {
    const ids = await listRunIds(REPO_ROOT);
    const states: RunState[] = [];
    for (const id of ids) {
      try {
        states.push(await loadState(id));
      } catch (err) {
        console.error(`[docket] skipping ${id}: ${err instanceof Error ? err.message : err}`);
      }
    }
    const open = flags.all === true ? states : states.filter((s) => !s.result);
    if (watch) process.stdout.write("\x1b[2J\x1b[H");
    printBoard(open, states.length);
  };

  await render();
  if (!watch) return;
  const timer = setInterval(() => {
    void render();
  }, intervalMs);
  process.on("SIGINT", () => {
    clearInterval(timer);
    process.stdout.write("\n");
    process.exit(0);
  });
}

async function cmdRebuild(flags: Flags): Promise<void> {
  const ids = flags.all === true ? await listRunIds(REPO_ROOT) : [flag(flags, "run") ?? ""];
  if (!ids[0]) fail("run rebuild: pass --run=<id> or --all");
  for (const id of ids) {
    const state = await loadState(id);
    await writeState(REPO_ROOT, state);
    console.log(`[docket] rebuilt ${id} (${state.eventCount} events)`);
  }
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

const SYMBOL: Record<string, string> = {
  working: "●",
  waiting: "◐",
  idle: "◌",
  stalled: "✕",
  done: "○",
};

function bar(state: RunState): string {
  const cells = 5;
  const total = state.progress.total;
  const filled = total === 0 ? 0 : Math.round((state.progress.met / total) * cells);
  return "▰".repeat(filled) + "▱".repeat(cells - filled);
}

function statusLabel(state: RunState): string {
  if (state.result) return `done (${state.result})`;
  if (state.liveness === "waiting") return `waiting — ${state.blocked?.needs ?? "human"}`;
  if (state.liveness === "idle") return `idle — ${state.idle?.reason ?? "turn ended"}`;
  return state.liveness;
}

function actorLabel(actor: Actor): string {
  return actor.identity ?? actor.session?.slice(0, 8) ?? actor.kind;
}

function age(iso: string | null, now = Date.now()): string {
  if (!iso) return "—";
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/** Truncation always leaves a trailing space, otherwise a long run id runs
 * straight into the next column and the board becomes unreadable. */
function pad(s: string, width: number): string {
  if (s.length >= width) return `${s.slice(0, width - 1)} `;
  return s + " ".repeat(width - s.length);
}

function printBoard(states: RunState[], totalKnown: number): void {
  if (states.length === 0) {
    console.log('[docket] no open runs — `bun mechanics run new --title="…"` starts one');
    return;
  }
  console.log(
    `${pad("RUN", 34)}${pad("PHASE", 12)}${pad("CRITERIA", 14)}${pad("PR", 7)}${pad("STATE", 20)}AGE`
  );
  for (const s of states) {
    const pr = s.git?.pr ? `#${s.git.pr}` : "—";
    console.log(
      `${SYMBOL[s.liveness] ?? "?"} ${pad(s.run, 32)}${pad(s.phase ?? "—", 12)}` +
        `${pad(`${bar(s)} ${s.progress.met}/${s.progress.total}`, 14)}${pad(pr, 7)}` +
        `${pad(statusLabel(s), 20)}${age(s.lastEventAt)}`
    );
  }
  const hidden = totalKnown - states.length;
  if (hidden > 0) console.log(`\n${hidden} finished run(s) hidden — pass --all to include them`);
}

function usage(): void {
  console.log(`mechanics run — docket/1 work orders

  run new     --title="…" [--app=<slug>] [--criteria=a,b] [--phases=a,b]
              [--specs=a,b] [--wave=<w>] [--branch=<b>] [--id=<run-id>]
  run event   --run=<id> --type=<t> [--phase=…] [--criterion=…] [--verdict=…]
              [--method=e2e|agent|manual] [--evidence=…] [--reason=…]
              [--needs=human|input|dependency] [--decision=…] [--to=…]
              [--kind=…] [--path=…] [--pr=<n>] [--by=hook|ci|<name>]
  run show    --run=<id>
  run list    [--watch] [--interval=<s>] [--all]
  run rebuild --run=<id> | --all
  run finish  --run=<id> [--result=shipped|abandoned|blocked] [--no-wave]
              Close it; a shipped run folds its verdicts into its wave
  run merge-wave --run=<id> [--dry-run]     Re-run that fold on its own
  run dispatch --title="…" [--branch=<b>] [--base=<ref>] [--criteria=a,b] [--app=<s>]
              [--issue=<n>] [--push] [--pr] [--agent] [--dry-run]
              Worktree + branch + order. Push, PR and agent are opt-in.
              --issue links a forge issue: order carries links.issue and the
              draft PR body opens with Closes #<n>.
  run serve   [--port=<n>]                  Live board at 127.0.0.1:4747
  run report  [--out=<path>]                Same page, frozen into one file
  run attach  --run=<id> [--session=<id>]   Bind this session, so hooks stop guessing
  run which   [--branch=<b>]                What the hooks would resolve right now
`);
}
