/**
 * The dashboard layout, tested without a terminal.
 *
 * This is the whole reason `renderDashboard` is pure. A full-screen TUI whose
 * only test is "somebody looked at it once" breaks silently the first time
 * anyone runs it in an 80×24 terminal, and the failure mode — a pane that
 * overflows and scrolls the header away — looks exactly like a crash.
 */

import { describe, expect, it } from "vitest";
import type { RunState } from "./docket-types";
import type { Gap } from "./gaps";
import {
  applyAction,
  clip,
  collectIssues,
  keyToAction,
  paneLength,
  renderDashboard,
  type Snapshot,
  type ViewState,
  visibleLength,
} from "./tui";
import { terminalSize } from "./tui-run";

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    repoRoot: "/repo",
    apps: [],
    gaps: [],
    runs: [],
    openProposals: 0,
    providers: [],
    lastRefresh: new Date("2026-08-25T12:00:00Z"),
    refreshing: false,
    problems: [],
    ...over,
  };
}

const app = (over: Partial<Snapshot["apps"][number]> = {}) => ({
  app: "perch",
  mechanics: 25,
  unclaimed: 0,
  untestedP0: 0,
  drafts: 0,
  openWaves: 0,
  failingInWaves: 0,
  drifted: false,
  ...over,
});

const gap = (over: Partial<Gap> = {}): Gap => ({
  key: "k",
  gap: "unclaimed-surface",
  lane: "propose",
  app: "perch",
  subject: "/login",
  title: 'unclaimed route "/login"',
  detail: "d",
  suggestion: "s",
  severity: "p1",
  ...over,
});

const run = (over: Partial<RunState> = {}): RunState =>
  ({
    run: "2026-08-25-demo",
    title: "Demo",
    phases: [],
    phase: null,
    criteria: [],
    progress: { met: 0, total: 3 },
    liveness: "working",
    decisions: [],
    proposals: [],
    evidence: [],
    lastEventAt: null,
    eventCount: 0,
    malformed: 0,
    ...over,
  }) as RunState;

const VIEW: ViewState = { pane: "overview", cursor: 0 };
const SIZE = { columns: 80, rows: 24, colour: false };

// ---------------------------------------------------------------------------

describe("renderDashboard", () => {
  it("always fills exactly the terminal height", () => {
    // Too few lines leaves stale rows from the previous frame on screen; too
    // many scrolls the header off. Both read as a crash.
    for (const rows of [10, 24, 60]) {
      expect(renderDashboard(snapshot(), VIEW, { ...SIZE, rows })).toHaveLength(rows);
    }
  });

  it("never exceeds the terminal width, even with long content", () => {
    const snap = snapshot({
      apps: [app({ app: "a-very-long-application-name-that-keeps-going" })],
      problems: ["x".repeat(300)],
    });
    for (const columns of [40, 80, 120]) {
      for (const line of renderDashboard(snap, VIEW, { ...SIZE, columns })) {
        expect(visibleLength(line)).toBeLessThanOrEqual(columns);
      }
    }
  });

  it("shows the way out at every width — a full-screen program must not trap you", () => {
    // The tab labels shrink first and the keymap switches to a short form, but
    // `q` has to survive every one of those, or the only way out is guessing.
    for (const columns of [40, 60, 80, 100, 200]) {
      const screen = renderDashboard(snapshot(), VIEW, { ...SIZE, columns }).join("\n");
      expect(screen, `${columns} columns`).toMatch(/\[q\]\s*u?it|\[q\] quit/);
    }
  });

  it("shows a keymap that matches what the keys actually do", () => {
    // The footer and the handler read from the same table, so a key advertised
    // here is a key that works.
    const footer = renderDashboard(snapshot(), VIEW, { ...SIZE, columns: 100 }).join("\n");
    for (const key of ["o", "g", "p", "r", "f", "s", "q"]) {
      expect(keyToAction(key), `footer advertises [${key}]`).not.toBeNull();
    }
    expect(footer).toContain("[o/g/p/r]");
  });

  it("says plainly when nothing is wrong", () => {
    expect(renderDashboard(snapshot({ apps: [app()] }), VIEW, SIZE).join("\n")).toContain(
      "nothing is wrong right now"
    );
  });

  it("renders each pane without throwing on an empty snapshot", () => {
    for (const pane of ["overview", "gaps", "proposals", "runs"] as const) {
      const lines = renderDashboard(snapshot(), { pane, cursor: 0 }, SIZE);
      expect(lines).toHaveLength(SIZE.rows);
    }
  });

  it("scrolls a long list to keep the cursor visible", () => {
    // Clamping to the top instead would make everything past the first
    // screenful unreachable.
    const gaps = Array.from({ length: 200 }, (_, i) =>
      gap({ key: `k${i}`, subject: `/r${i}`, title: `unclaimed route "/r${i}"` })
    );
    const lines = renderDashboard(snapshot({ gaps }), { pane: "gaps", cursor: 150 }, SIZE);
    expect(lines.join("\n")).toContain("/r150");
  });
});

describe("collectIssues", () => {
  it("puts drift first — every other number describes an older tree", () => {
    const snap = snapshot({
      apps: [app({ drifted: true, unclaimed: 4, untestedP0: 2 })],
      openProposals: 3,
    });
    expect(collectIssues(snap)[0]?.text).toMatch(/manifest is stale/);
  });

  it("reports a stalled run, which looks identical to a working one", () => {
    const issues = collectIssues(snapshot({ runs: [run({ liveness: "stalled" })] }));
    expect(issues.some((i) => i.severity === "high" && /stalled/.test(i.text))).toBe(true);
  });

  it("carries the reason a run is waiting, not just that it is", () => {
    const issues = collectIssues(
      snapshot({
        runs: [
          run({
            liveness: "waiting",
            blocked: { reason: "which retention window?", needs: "human", at: "x" },
          }),
        ],
      })
    );
    expect(issues.some((i) => i.text.includes("which retention window?"))).toBe(true);
  });

  it("surfaces gather failures instead of swallowing them", () => {
    // This is the process left open in the corner. If it hides its own
    // breakage, everything it shows becomes untrustworthy.
    const issues = collectIssues(snapshot({ problems: ["config: bad yaml"] }));
    expect(issues[0]).toEqual({ severity: "high", text: "config: bad yaml" });
  });

  it("mentions an available update, quietly", () => {
    const issues = collectIssues(
      snapshot({ updateAvailable: { current: "0.1.1", latest: "0.2.0" } })
    );
    expect(issues.at(-1)).toMatchObject({ severity: "low" });
    expect(issues.at(-1)?.text).toContain("0.2.0");
  });

  it("is empty for a healthy repo", () => {
    expect(collectIssues(snapshot({ apps: [app()] }))).toEqual([]);
  });
});

describe("navigation", () => {
  it("cannot move the cursor past the end of a pane", () => {
    const snap = snapshot({ gaps: [gap(), gap({ key: "b" })] });
    let view: ViewState = { pane: "gaps", cursor: 0 };
    for (let i = 0; i < 10; i++) view = applyAction(view, { type: "move", delta: 1 }, snap);
    expect(view.cursor).toBe(1);
  });

  it("cannot move above the first row", () => {
    const snap = snapshot({ gaps: [gap()] });
    const view = applyAction({ pane: "gaps", cursor: 0 }, { type: "move", delta: -1 }, snap);
    expect(view.cursor).toBe(0);
  });

  it("resets the cursor when the pane changes", () => {
    // Carrying it over would land you on an unrelated row in a list of a
    // different length.
    const view = applyAction(
      { pane: "gaps", cursor: 7 },
      { type: "pane", pane: "runs" },
      snapshot()
    );
    expect(view).toEqual({ pane: "runs", cursor: 0 });
  });

  it("counts only OPEN proposals as rows", () => {
    const snap = snapshot({
      runs: [
        run({
          proposals: [
            { proposal: "a", status: "open", at: "x" },
            { proposal: "b", status: "accepted", at: "x" },
          ],
        }),
      ],
    });
    expect(paneLength(snap, "proposals")).toBe(1);
  });

  it("maps ctrl-c and q to quit", () => {
    expect(keyToAction("q")).toEqual({ type: "quit" });
    expect(keyToAction("")).toEqual({ type: "quit" });
  });

  it("ignores keys it does not know", () => {
    expect(keyToAction("z")).toBeNull();
  });
});

describe("terminalSize", () => {
  it("treats a zero-size terminal as unknown, not as zero", () => {
    // A PTY with no window size reports 0, not undefined, so `??` sails past
    // it — and `rows: 0` renders an empty screen that looks exactly like a
    // hang. Found by running the real thing under `script`.
    expect(terminalSize({ columns: 0, rows: 0 })).toEqual({ columns: 80, rows: 24 });
    expect(terminalSize({})).toEqual({ columns: 80, rows: 24 });
    expect(terminalSize({ columns: Number.NaN, rows: Number.NaN })).toEqual({
      columns: 80,
      rows: 24,
    });
  });

  it("uses a real size when there is one", () => {
    expect(terminalSize({ columns: 120, rows: 40 })).toEqual({ columns: 120, rows: 40 });
  });
});

describe("clip", () => {
  it("counts visible columns, not escape sequences", () => {
    const coloured = "[32mgreen[0m text here";
    expect(visibleLength(coloured)).toBe("green text here".length);
    expect(visibleLength(clip(coloured, 5))).toBeLessThanOrEqual(5);
  });

  it("leaves a short string alone", () => {
    expect(clip("hi", 10)).toBe("hi");
  });

  it("closes the escape state when it cuts mid-colour", () => {
    // Otherwise the colour bleeds into the rest of the terminal for the
    // lifetime of the session.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting an ANSI reset is the point
    expect(clip("[31mred text", 3)).toMatch(/\[0m$/);
  });
});
