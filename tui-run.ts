/**
 * Driving the dashboard: gather, watch, redraw.
 *
 * `tui.ts` is pure and knows how the screen looks. This half knows how to find
 * out what is true, and it is deliberately the thin one — everything here is
 * an existing engine called with an explicit `repoRoot`.
 *
 * Two refresh triggers, because they answer different questions. A filesystem
 * watch catches "you just edited a mechanic", which needs to feel instant. A
 * slow timer catches "an agent in another terminal moved a run" and the npm
 * version check, neither of which touches a file this process is watching.
 *
 * A gather that throws must never take the screen down. This is the process
 * left open in the corner; if it dies at 2am because a config was
 * half-written, its whole value is gone. Failures land in `problems` and are
 * rendered as issues.
 */

import { type FSWatcher, watch } from "node:fs";
import path from "node:path";
import { probeAll } from "./agents";
import { readEvents } from "./docket-events";
import { listRunIds, loadOrder, runsRoot } from "./docket-order";
import { reduceRun } from "./docket-state";
import type { RunState } from "./docket-types";
import { pathExists } from "./fsutil";
import { findGaps } from "./gaps";
import { appPath, clearLayoutCache } from "./layout";
import { buildManifest, emitManifest, onboardedApps } from "./manifest";
import {
  type AppSnapshot,
  ansi,
  applyAction,
  keyToAction,
  paneLength,
  renderDashboard,
  type Snapshot,
  type ViewState,
} from "./tui";
import { loadWaves, summarizeWave } from "./waves";

/** Fallbacks for a terminal that reports no size at all. */
export function terminalSize(out: { columns?: number; rows?: number }): {
  columns: number;
  rows: number;
} {
  const columns =
    Number.isFinite(out.columns) && (out.columns ?? 0) > 0 ? (out.columns as number) : 80;
  const rows = Number.isFinite(out.rows) && (out.rows ?? 0) > 0 ? (out.rows as number) : 24;
  return { columns, rows };
}

const FAST_REFRESH_MS = 400;
const SLOW_REFRESH_MS = 15_000;
const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;

export interface TuiOptions {
  repoRoot: string;
  version: string;
  /** Skip the registry call — for tests, and for anyone offline. */
  checkUpdates?: boolean;
}

// ---------------------------------------------------------------------------
// gathering
// ---------------------------------------------------------------------------

export async function gatherApp(app: string, repoRoot: string): Promise<AppSnapshot> {
  const base: AppSnapshot = {
    app,
    mechanics: 0,
    unclaimed: 0,
    untestedP0: 0,
    drafts: 0,
    openWaves: 0,
    failingInWaves: 0,
    drifted: false,
  };
  try {
    const { manifest, errors } = await buildManifest(app, repoRoot);
    // `check: true` diffs without writing. The dashboard must never mutate the
    // repo as a side effect of being open — a tool that silently rewrites your
    // manifest while you read it is a tool you cannot leave running.
    const emit = await emitManifest(manifest, { repoRoot, check: true });
    const { waves } = await loadWaves(app, repoRoot);
    const open = waves.filter((w) => w.status === "open");

    return {
      ...base,
      mechanics: manifest.mechanics.length,
      unclaimed: Object.values(manifest.coverage).reduce((n, b) => n + b.unclaimed.length, 0),
      untestedP0: manifest.mechanics.filter(
        (m) => m.priority === "p0" && m.tests.length === 0 && m.verify !== "manual-only"
      ).length,
      drafts: manifest.mechanics.filter((m) => m.status === "draft").length,
      openWaves: open.length,
      failingInWaves: open.reduce(
        (n, w) => n + summarizeWave(w, manifest.mechanics).counts.fail,
        0
      ),
      drifted: emit.changed,
      ...(errors.length > 0 ? { error: errors[0] } : {}),
    };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

async function gatherRuns(repoRoot: string): Promise<RunState[]> {
  if (!(await pathExists(runsRoot(repoRoot)))) return [];
  const ids = await listRunIds(repoRoot);
  const out: RunState[] = [];
  for (const id of ids) {
    try {
      const order = await loadOrder(repoRoot, id);
      const { events, malformed } = await readEvents(repoRoot, id);
      out.push(reduceRun(order, events, { malformed }));
    } catch {
      // One unreadable run must not blank the board.
    }
  }
  return out;
}

export async function gather(options: TuiOptions, previous?: Snapshot): Promise<Snapshot> {
  clearLayoutCache();
  const problems: string[] = [];

  let apps: string[] = [];
  try {
    apps = await onboardedApps(options.repoRoot);
  } catch (err) {
    problems.push(`config: ${err instanceof Error ? err.message : err}`);
  }

  const [appSnaps, runs, providers] = await Promise.all([
    Promise.all(apps.map((a) => gatherApp(a, options.repoRoot))),
    gatherRuns(options.repoRoot).catch((err) => {
      problems.push(`runs: ${err instanceof Error ? err.message : err}`);
      return [] as RunState[];
    }),
    // Providers change rarely; reuse the previous answer rather than spawning
    // `which` five times every 400ms.
    previous?.providers?.length ? Promise.resolve(previous.providers) : probeAll(),
  ]);

  const gaps = (
    await Promise.all(
      apps.map((a) =>
        findGaps(a, options.repoRoot).catch((err) => {
          problems.push(`${a}: ${err instanceof Error ? err.message : err}`);
          return [];
        })
      )
    )
  ).flat();

  return {
    repoRoot: options.repoRoot,
    apps: appSnaps,
    gaps,
    runs,
    openProposals: runs.reduce(
      (n, r) => n + (r.proposals ?? []).filter((p) => p.status === "open").length,
      0
    ),
    providers,
    updateAvailable: previous?.updateAvailable,
    lastRefresh: new Date(),
    refreshing: false,
    problems,
  };
}

/**
 * Is there a newer release?
 *
 * Fails silent by design: an offline machine, a proxy, or a registry outage
 * must not put a red error on a dashboard about something nobody asked for.
 */
export async function checkForUpdate(
  current: string
): Promise<{ current: string; latest: string } | undefined> {
  try {
    const res = await fetch("https://registry.npmjs.org/@hansenexus/mechanics/latest", {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return undefined;
    const latest = ((await res.json()) as { version?: string }).version;
    return latest && latest !== current ? { current, latest } : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// the loop
// ---------------------------------------------------------------------------

export async function runTui(options: TuiOptions): Promise<void> {
  const out = process.stdout;
  if (!out.isTTY) {
    throw new Error(
      "mechanics tui needs a terminal. For a non-interactive view use `mechanics gaps --json` " +
        "or `mechanics run report --out=<file>`."
    );
  }

  let view: ViewState = { pane: "overview", cursor: 0 };
  let snap: Snapshot = {
    repoRoot: options.repoRoot,
    apps: [],
    gaps: [],
    runs: [],
    openProposals: 0,
    providers: [],
    lastRefresh: new Date(),
    refreshing: true,
    problems: [],
  };

  const draw = () => {
    // `??` is not enough: a PTY with no window size reports 0, not undefined,
    // and `rows: 0` renders an empty screen that looks exactly like a hang.
    const { columns, rows } = terminalSize(out);
    const lines = renderDashboard(snap, view, { columns, rows });
    // Clear to end of line after every row, so a shorter frame cannot leave
    // the tail of a longer one behind.
    out.write(ansi.home + lines.map((l) => `${l}${ansi.clearLine}`).join(`${ansi.reset}\n`));
  };

  let refreshing = false;
  let queued = false;
  const refresh = async () => {
    if (refreshing) {
      queued = true;
      return;
    }
    refreshing = true;
    snap = { ...snap, refreshing: true };
    draw();
    try {
      snap = await gather(options, snap);
    } catch (err) {
      snap = {
        ...snap,
        refreshing: false,
        problems: [`refresh failed: ${err instanceof Error ? err.message : err}`],
      };
    }
    // The cursor may now point past the end of a shorter list.
    view = { ...view, cursor: Math.min(view.cursor, Math.max(0, paneLength(snap, view.pane) - 1)) };
    refreshing = false;
    draw();
    if (queued) {
      queued = false;
      void refresh();
    }
  };

  // --- terminal setup ------------------------------------------------------
  out.write(ansi.altScreen + ansi.hideCursor + ansi.clear);
  const restore = () => {
    out.write(ansi.showCursor + ansi.mainScreen);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  };
  // Every exit path restores the screen. A TUI that leaves the terminal in the
  // alternate buffer with the cursor hidden is one people kill and never open
  // again.
  process.on("exit", restore);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));

  const watchers: FSWatcher[] = [];
  const timers: NodeJS.Timeout[] = [];
  const stop = () => {
    for (const w of watchers) w.close();
    for (const t of timers) clearInterval(t);
    restore();
    process.exit(0);
  };

  // --- watching ------------------------------------------------------------
  let debounce: NodeJS.Timeout | null = null;
  const onChange = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void refresh(), FAST_REFRESH_MS);
  };

  const apps = await onboardedApps(options.repoRoot).catch(() => [] as string[]);
  const targets = [
    ...apps.map((a) => path.join(options.repoRoot, appPath(a, options.repoRoot, "mechanics"))),
    path.join(options.repoRoot, ".docket"),
  ];
  for (const dir of targets) {
    if (!(await pathExists(dir))) continue;
    try {
      watchers.push(watch(dir, { recursive: true }, onChange));
    } catch {
      // Recursive watch is unsupported on some platforms; the slow timer still
      // covers it, just less promptly.
    }
  }
  timers.push(setInterval(() => void refresh(), SLOW_REFRESH_MS));

  if (options.checkUpdates !== false) {
    const check = async () => {
      const found = await checkForUpdate(options.version);
      if (found) {
        snap = { ...snap, updateAvailable: found };
        draw();
      }
    };
    void check();
    timers.push(setInterval(() => void check(), UPDATE_CHECK_MS));
  }

  // --- keys ----------------------------------------------------------------
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    const action = keyToAction(chunk);
    if (!action) return;
    if (action.type === "quit") return stop();
    if (action.type === "refresh") {
      void refresh();
      return;
    }
    if (action.type === "fix" || action.type === "scan") {
      // Deliberately does not run anything. The dashboard is a place to see
      // what is true; running a fix from it would mean a keystroke mutating
      // the repo behind a full-screen redraw, with no diff and nowhere for the
      // output to go. It prints the command instead.
      view = {
        ...view,
        message:
          action.type === "fix"
            ? `run it in another shell:  mechanics gaps --app=${snap.apps[0]?.app ?? "<slug>"} --fix`
            : "run it in another shell:  mechanics scan --interactive",
      };
      draw();
      return;
    }
    view = applyAction(view, action, snap);
    draw();
  });

  out.on("resize", draw);
  await refresh();
}
