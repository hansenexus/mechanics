/**
 * The dashboard you leave open.
 *
 * Everything else in this tool answers a question and exits. This one is for
 * the other mode of working: a terminal in the corner that tells you when the
 * corpus drifted, when a p0 behaviour lost its test, when an agent's run went
 * quiet, and when there are proposals waiting on you. The value is not that it
 * shows more — `coverage`, `gaps` and `run list` already show all of it — it is
 * that nobody has to remember to ask.
 *
 * Split the way the rest of the repo is: `renderDashboard` is pure, takes a
 * snapshot and a terminal size, and returns lines. The driver below does the
 * watching, the polling and the key handling. That is what makes the layout
 * testable at all — a full-screen TUI whose only test is "a human looked at
 * it" is a TUI that breaks silently on a narrow terminal.
 *
 * Raw ANSI rather than a widget library, for the same reason `report --html`
 * is one file with no build step: the package has four runtime dependencies
 * and this is not worth a fifth plus a reconciler.
 */

import type { Availability } from "./agents";
import type { RunState } from "./docket-types";
import type { Gap } from "./gaps";

// ---------------------------------------------------------------------------
// snapshot
// ---------------------------------------------------------------------------

export interface AppSnapshot {
  app: string;
  mechanics: number;
  /** Surfaces the app ships that nothing claims. */
  unclaimed: number;
  untestedP0: number;
  drafts: number;
  openWaves: number;
  failingInWaves: number;
  /** True when the committed manifest no longer matches the tree. */
  drifted: boolean;
  error?: string;
}

export interface Snapshot {
  repoRoot: string;
  apps: AppSnapshot[];
  gaps: Gap[];
  runs: RunState[];
  openProposals: number;
  providers: Availability[];
  /** A newer published version, when the registry said so. */
  updateAvailable?: { current: string; latest: string };
  lastRefresh: Date;
  refreshing: boolean;
  /** Anything that broke while gathering — shown, never swallowed. */
  problems: string[];
}

export type Pane = "overview" | "gaps" | "proposals" | "runs";

export interface ViewState {
  pane: Pane;
  /** Index of the highlighted row in the active pane. */
  cursor: number;
  /** Status line message, e.g. the result of a keypress. */
  message?: string;
}

// ---------------------------------------------------------------------------
// issues — the reason the thing is open
// ---------------------------------------------------------------------------

export interface Issue {
  severity: "high" | "medium" | "low";
  text: string;
}

/**
 * What is wrong right now, worst first.
 *
 * Ordering is by how quietly the thing fails, not by how loud it looks. Drift
 * is first because a stale manifest means every other number on the screen is
 * describing a tree that no longer exists — the dashboard would be confidently
 * wrong, which is worse than being blank. A stalled run is next because a run
 * nobody came back to looks identical to one still working.
 */
export function collectIssues(snap: Snapshot): Issue[] {
  const out: Issue[] = [];

  for (const app of snap.apps) {
    if (app.error) out.push({ severity: "high", text: `${app.app}: ${app.error}` });
    if (app.drifted) {
      out.push({
        severity: "high",
        text: `${app.app}: manifest is stale — every number here describes an older tree`,
      });
    }
  }
  for (const p of snap.problems) out.push({ severity: "high", text: p });

  const stalled = snap.runs.filter((r) => r.liveness === "stalled");
  for (const r of stalled) {
    out.push({ severity: "high", text: `run ${r.run} stalled — nobody came back to it` });
  }
  const waiting = snap.runs.filter((r) => r.liveness === "waiting");
  for (const r of waiting) {
    out.push({
      severity: "medium",
      text: `run ${r.run} is waiting on you: ${r.blocked?.reason ?? "(no reason given)"}`,
    });
  }

  for (const app of snap.apps) {
    if (app.failingInWaves > 0) {
      out.push({
        severity: "high",
        text: `${app.app}: ${app.failingInWaves} failing verification(s) in an open wave`,
      });
    }
    if (app.untestedP0 > 0) {
      out.push({
        severity: "medium",
        text: `${app.app}: ${app.untestedP0} p0 behaviour(s) with no test`,
      });
    }
    if (app.unclaimed > 0) {
      out.push({
        severity: "low",
        text: `${app.app}: ${app.unclaimed} unclaimed surface(s)`,
      });
    }
  }

  if (snap.openProposals > 0) {
    out.push({
      severity: "medium",
      text: `${snap.openProposals} proposal(s) waiting on a human — mechanics run review`,
    });
  }
  if (snap.updateAvailable) {
    out.push({
      severity: "low",
      text: `mechanics ${snap.updateAvailable.latest} is out (you have ${snap.updateAvailable.current})`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

const ESC = "[";
export const ansi = {
  clear: `${ESC}2J${ESC}H`,
  home: `${ESC}H`,
  hideCursor: `${ESC}?25l`,
  showCursor: `${ESC}?25h`,
  altScreen: `${ESC}?1049h`,
  mainScreen: `${ESC}?1049l`,
  reset: `${ESC}0m`,
  clearLine: `${ESC}K`,
};

const paint = (code: string, on: boolean) => (s: string) =>
  on && s ? `${ESC}${code}m${s}${ESC}0m` : s;

export interface RenderOptions {
  columns: number;
  rows: number;
  colour?: boolean;
}

/**
 * The whole screen, as lines.
 *
 * Returns exactly `rows` lines, each at most `columns` wide once escapes are
 * discounted — a pane that overflows either wraps and shifts everything below
 * it, or scrolls the header off. Both look like a crash.
 */
export function renderDashboard(snap: Snapshot, view: ViewState, opts: RenderOptions): string[] {
  const colour = opts.colour ?? true;
  const dim = paint("2", colour);
  const bold = paint("1", colour);
  const red = paint("31", colour);
  const green = paint("32", colour);
  const yellow = paint("33", colour);
  const invert = paint("7", colour);

  const w = Math.max(40, opts.columns);
  const lines: string[] = [];

  // header
  const age = Math.round((Date.now() - snap.lastRefresh.getTime()) / 1000);
  const status = snap.refreshing ? "refreshing…" : `updated ${age}s ago`;
  lines.push(rule(bold(" mechanics "), status, w, dim));

  const issues = collectIssues(snap);
  const body = Math.max(3, opts.rows - 4);

  if (view.pane === "overview") {
    lines.push(...overviewPane(snap, issues, body, w, { dim, red, green, yellow, bold }));
  } else if (view.pane === "gaps") {
    lines.push(
      ...listPane(
        snap.gaps.map(
          (g) => `${g.lane === "auto" ? green("fix") : yellow("ask")} ${g.severity} ${g.title}`
        ),
        view.cursor,
        body,
        w,
        invert,
        dim,
        "no gaps — the corpus claims everything it ships"
      )
    );
  } else if (view.pane === "proposals") {
    const rows = snap.runs.flatMap((r) =>
      (r.proposals ?? [])
        .filter((p) => p.status === "open")
        .map((p) => `${dim(r.run)} ${p.subject ?? p.proposal}`)
    );
    lines.push(...listPane(rows, view.cursor, body, w, invert, dim, "no proposals are waiting"));
  } else {
    const rows = snap.runs.map((r) => {
      const mark =
        r.liveness === "stalled"
          ? red("stalled")
          : r.liveness === "waiting"
            ? yellow("waiting")
            : r.liveness === "done"
              ? dim("done")
              : green(r.liveness);
      return `${mark.padEnd(20)} ${r.run}  ${dim(`${r.progress.met}/${r.progress.total}`)}`;
    });
    lines.push(...listPane(rows, view.cursor, body, w, invert, dim, "no runs on the board"));
  }

  // footer
  lines.push(rule("", "", w, dim));
  lines.push(footer(view.pane, w, { dim, invert }));
  if (view.message) lines.push(clip(`  ${view.message}`, w));

  // Exactly `rows` lines. Padding rather than truncating the tail keeps the
  // footer on screen when a pane is short.
  while (lines.length < opts.rows) lines.splice(lines.length - (view.message ? 2 : 1), 0, "");
  return lines.slice(0, opts.rows);
}

/**
 * The status bar, assembled so that the most important key survives.
 *
 * Built by adding hints only while they fit, with `[q] quit` placed FIRST so
 * it cannot be the one that falls off the end. A full-screen program that
 * clips its own way out at 40 columns leaves you guessing at ctrl-c, and the
 * naive `join then clip` did exactly that.
 */
function footer(
  pane: Pane,
  w: number,
  c: { dim: (s: string) => string; invert: (s: string) => string }
): string {
  const hints = ["[q] quit", "[o/g/p/r] pane", "[↑↓] move", "[f] fix", "[s] scan"];
  let text = "";
  for (const hint of hints) {
    const next = text ? `${text}  ${hint}` : hint;
    if (visibleLength(next) > w - 2) break;
    text = next;
  }

  // Tabs are a nicety: which pane you are on is already obvious from the
  // content, so they only appear once the keymap is safely in.
  const labels = (["overview", "gaps", "proposals", "runs"] as Pane[]).map((p) =>
    p === pane ? c.invert(` ${p} `) : c.dim(` ${p} `)
  );
  const tabs = labels.join("");
  const withTabs = `${tabs}  ${c.dim(text)}`;
  return clip(visibleLength(withTabs) <= w ? withTabs : `  ${c.dim(text)}`, w);
}

function overviewPane(
  snap: Snapshot,
  issues: Issue[],
  budget: number,
  w: number,
  c: Record<string, (s: string) => string>
): string[] {
  const out: string[] = [];
  const nameW = Math.max(4, ...snap.apps.map((a) => a.app.length));

  for (const app of snap.apps.slice(0, Math.max(1, Math.floor(budget / 2)))) {
    const bits = [
      `${String(app.mechanics).padStart(3)} mech`,
      app.unclaimed > 0
        ? (c.yellow?.(`${app.unclaimed} unclaimed`) ?? "")
        : (c.dim?.("0 unclaimed") ?? ""),
      app.untestedP0 > 0 ? (c.red?.(`${app.untestedP0} p0 untested`) ?? "") : "",
      app.openWaves > 0 ? `${app.openWaves} wave open` : "",
      app.drifted ? (c.red?.("DRIFT") ?? "") : "",
    ].filter(Boolean);
    out.push(clip(`  ${app.app.padEnd(nameW)}  ${bits.join("  ")}`, w));
  }
  if (snap.apps.length === 0) out.push(clip(c.dim?.("  no onboarded apps here") ?? "", w));

  out.push("");
  out.push(clip(c.dim?.(`  issues (${issues.length})`) ?? "", w));
  const room = budget - out.length;
  for (const issue of issues.slice(0, Math.max(0, room))) {
    const mark =
      issue.severity === "high"
        ? (c.red?.("!") ?? "!")
        : issue.severity === "medium"
          ? (c.yellow?.("~") ?? "~")
          : (c.dim?.("·") ?? "·");
    out.push(clip(`  ${mark} ${issue.text}`, w));
  }
  if (issues.length === 0) out.push(clip(c.green?.("  nothing is wrong right now") ?? "", w));
  if (issues.length > room && room > 0) {
    out.push(clip(c.dim?.(`  … ${issues.length - room} more`) ?? "", w));
  }
  return out.slice(0, budget);
}

function listPane(
  rows: string[],
  cursor: number,
  budget: number,
  w: number,
  invert: (s: string) => string,
  dim: (s: string) => string,
  empty: string
): string[] {
  if (rows.length === 0) return [clip(dim(`  ${empty}`), w)];
  // Scroll so the cursor stays on screen rather than clamping it to the top,
  // which would make a long list unnavigable past the first screenful.
  const start = Math.max(0, Math.min(cursor - Math.floor(budget / 2), rows.length - budget));
  return rows.slice(Math.max(0, start), Math.max(0, start) + budget).map((row, i) => {
    const at = Math.max(0, start) + i;
    const line = clip(`  ${row}`, w);
    return at === cursor ? invert(line) : line;
  });
}

/** A titled horizontal rule that fills exactly `w` visible columns. */
function rule(left: string, right: string, w: number, dim: (s: string) => string): string {
  const used = visibleLength(left) + visibleLength(right);
  const fill = Math.max(0, w - used - 2);
  return clip(`${left}${dim("─".repeat(fill))} ${dim(right)} `, w);
}

/** Trim to `w` visible columns, ignoring escape sequences. */
export function clip(s: string, w: number): string {
  if (visibleLength(s) <= w) return s;
  let out = "";
  let seen = 0;
  let i = 0;
  while (i < s.length && seen < w) {
    if (s[i] === "") {
      const end = s.indexOf("m", i);
      if (end === -1) break;
      out += s.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    out += s[i];
    seen++;
    i++;
  }
  return `${out}${ansi.reset}`;
}

export function visibleLength(s: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the job
  return s.replace(/\[[0-9;?]*[a-zA-Z]/g, "").length;
}

// ---------------------------------------------------------------------------
// keys
// ---------------------------------------------------------------------------

export type Action =
  | { type: "pane"; pane: Pane }
  | { type: "move"; delta: number }
  | { type: "refresh" }
  | { type: "fix" }
  | { type: "scan" }
  | { type: "quit" }
  | null;

/** One place that knows the keymap, so the footer and the handler cannot drift. */
export function keyToAction(key: string): Action {
  switch (key) {
    case "q":
    case "": // ctrl-c
      return { type: "quit" };
    case "o":
      return { type: "pane", pane: "overview" };
    case "g":
      return { type: "pane", pane: "gaps" };
    case "p":
      return { type: "pane", pane: "proposals" };
    case "r":
      return { type: "pane", pane: "runs" };
    case "f":
      return { type: "fix" };
    case "s":
      return { type: "scan" };
    case "\r":
    case " ":
      return { type: "refresh" };
    case "[A":
    case "k":
      return { type: "move", delta: -1 };
    case "[B":
    case "j":
      return { type: "move", delta: 1 };
    default:
      return null;
  }
}

/** Rows in the active pane, so the cursor cannot run past the end. */
export function paneLength(snap: Snapshot, pane: Pane): number {
  switch (pane) {
    case "gaps":
      return snap.gaps.length;
    case "proposals":
      return snap.runs.reduce(
        (n, r) => n + (r.proposals ?? []).filter((p) => p.status === "open").length,
        0
      );
    case "runs":
      return snap.runs.length;
    default:
      return 0;
  }
}

export function applyAction(view: ViewState, action: Action, snap: Snapshot): ViewState {
  if (!action) return view;
  if (action.type === "pane") return { pane: action.pane, cursor: 0 };
  if (action.type === "move") {
    const max = Math.max(0, paneLength(snap, view.pane) - 1);
    return { ...view, cursor: Math.max(0, Math.min(max, view.cursor + action.delta)) };
  }
  return view;
}
