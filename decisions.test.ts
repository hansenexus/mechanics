/**
 * Decision records, and the two rules that make the folder worth keeping.
 *
 * The staleness ERROR and the conflict flag are the whole point of the layer,
 * so they get the most tests: an ADR folder that nobody validates rots into
 * confident, committed, wrong context — which is worse than no folder at all.
 *
 * The pure functions (`parseDecision`, `renderDecision`, `validateDecisions`,
 * `findDecisionConflicts`, `selectDecisions`) are exercised without a
 * filesystem wherever possible. That is deliberate: this repo has shipped two
 * template bugs that lived in `cli.ts` where no test could reach them.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkDecisions,
  type DecisionInput,
  type DecisionRecord,
  decisionSource,
  findDecisionConflicts,
  listDecisions,
  parseDecision,
  renderDecision,
  selectDecisions,
  validateDecisions,
  writeDecision,
} from "./decisions";
import { appendEvent } from "./docket-events";
import { writeOrder } from "./docket-order";
import type { Actor } from "./docket-types";

const HUMAN: Actor = { kind: "human", identity: "alex" };

function input(over: Partial<DecisionInput> = {}): DecisionInput {
  return {
    id: "2026-08-abandoned-rental-window",
    status: "accepted",
    date: "2026-08-08",
    decidedBy: ["alex", "claude-code:9f21c0"],
    run: "2026-08-08-locker-rental",
    affects: { specs: ["lockers.rental.rent-flow"], paths: ["src/lockers/**"] },
    sections: {
      Context: "Abandoned rentals pile up and nobody had said for how long.",
      Decision: "Expire abandoned rentals after 48 hours. Sweep hourly.",
      Rationale: "72h was rejected because the locker bank fills over a weekend.",
      Consequences: "The sweeper is now required; manual release is forbidden.",
    },
    ...over,
  };
}

/** A parsed record, straight from the renderer — the shape on disk. */
function record(over: Partial<DecisionInput> = {}): DecisionRecord {
  const spec = input(over);
  const parsed = parseDecision(renderDecision(spec), decisionSource(spec.id));
  expect(parsed.errors).toEqual([]);
  if (!parsed.record) throw new Error("fixture failed to parse");
  return parsed.record;
}

describe("parseDecision", () => {
  it("derives the id from the filename and keeps the four sections", () => {
    const d = record();
    expect(d.id).toBe("2026-08-abandoned-rental-window");
    expect(d.source).toBe(".docket/decisions/2026-08-abandoned-rental-window.md");
    expect(Object.keys(d.sections)).toEqual(["Context", "Decision", "Rationale", "Consequences"]);
    expect(d.headline).toBe("Expire abandoned rentals after 48 hours.");
    expect(d.supersedes).toEqual([]);
  });

  it("refuses an id in frontmatter — the filename is the only source", () => {
    const raw = renderDecision(input()).replace("status:", "id: something-else\nstatus:");
    const { record: rec, errors } = parseDecision(raw, decisionSource("x-y"));
    expect(rec).toBeNull();
    expect(errors.join("\n")).toContain("the id is the filename");
  });

  it("rejects an unknown frontmatter key rather than dropping it", () => {
    const raw = renderDecision(input()).replace("status:", "affect: typo\nstatus:");
    const { record: rec, errors } = parseDecision(raw, decisionSource("x-y"));
    expect(rec).toBeNull();
    expect(errors.join("\n")).toContain("Unrecognized key");
  });

  it("rejects a status outside the four", () => {
    const raw = renderDecision(input()).replace("status: accepted", "status: maybe");
    const { errors } = parseDecision(raw, decisionSource("x-y"));
    expect(errors.join("\n")).toContain("frontmatter status");
  });

  it("names every missing section in one pass, not just the first", () => {
    const raw =
      "---\nstatus: proposed\ndate: 2026-08-08\ndecidedBy: [alex]\n---\n\n## Context\n\nhi\n";
    const { record: rec, errors } = parseDecision(raw, decisionSource("x-y"));
    expect(rec).toBeNull();
    expect(errors.join("\n")).toContain('missing required section "## Decision"');
    expect(errors.join("\n")).toContain('missing required section "## Rationale"');
    expect(errors.join("\n")).toContain('missing required section "## Consequences"');
  });

  it("flags sections out of order and unknown headings", () => {
    const raw = renderDecision(input())
      .replace("## Rationale", "## Consequences")
      .replace("## Consequences\n\nThe sweeper", "## Rationale\n\nThe sweeper")
      .concat("\n## Appendix\n\nnope\n");
    const { errors } = parseDecision(raw, decisionSource("x-y"));
    expect(errors.join("\n")).toContain("out of order");
    expect(errors.join("\n")).toContain('unknown section "## Appendix"');
  });

  it("rejects a filename that is not a kebab id", () => {
    const { record: rec, errors } = parseDecision(renderDecision(input()), "Not An Id.md");
    expect(rec).toBeNull();
    expect(errors.join("\n")).toContain("the id IS the name");
  });

  it("normalises a single `supersedes` string to an array", () => {
    expect(record({ supersedes: "2026-06-locker-retry" }).supersedes).toEqual([
      "2026-06-locker-retry",
    ]);
    expect(record({ supersedes: ["a-one", "b-two"] }).supersedes).toEqual(["a-one", "b-two"]);
  });
});

describe("renderDecision", () => {
  it("never writes the id into frontmatter", () => {
    const text = renderDecision(input());
    const frontmatter = text.split("---")[1] ?? "";
    expect(frontmatter).not.toContain("2026-08-abandoned-rental-window");
    expect(frontmatter).not.toContain("id:");
  });

  it("round-trips through the parser unchanged", () => {
    const first = renderDecision(input({ supersedes: "2026-06-locker-retry" }));
    const parsed = parseDecision(first, decisionSource("x-y"));
    expect(parsed.record).not.toBeNull();
    const d = parsed.record as DecisionRecord;
    expect(
      renderDecision({
        id: "x-y",
        status: d.status,
        date: d.date,
        decidedBy: d.decidedBy,
        run: d.run,
        affects: d.affects,
        supersedes: d.supersedes,
        sections: d.sections,
      })
    ).toBe(first);
  });

  it("refuses to write a record with an empty section or a bad id", () => {
    expect(() => renderDecision(input({ id: "Not An Id" }))).toThrow(/kebab-case/);
    expect(() => renderDecision(input({ date: "08-08-2026" }))).toThrow(/YYYY-MM-DD/);
    expect(() => renderDecision(input({ decidedBy: [] }))).toThrow(/who decided/);
    expect(() =>
      renderDecision(input({ sections: { ...input().sections, Rationale: "  " } }))
    ).toThrow(/"## Rationale"/);
  });
});

describe("validateDecisions — the staleness rule", () => {
  const FILES = ["src/lockers/rent.ts", "src/other/thing.ts"];

  it("errors when an accepted record's paths match nothing", () => {
    const errors = validateDecisions(
      [record({ affects: { specs: [], paths: ["src/gone/**"] } })],
      FILES
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("matches no files");
    expect(errors[0]).toContain("supersede it or reject it");
  });

  it("is silent when the paths still resolve", () => {
    expect(validateDecisions([record()], FILES)).toEqual([]);
  });

  it("holds only `accepted` to it — a proposal may point at code not yet written", () => {
    const dead = { specs: [], paths: ["src/gone/**"] };
    for (const status of ["proposed", "superseded", "rejected"] as const) {
      expect(validateDecisions([record({ status, affects: dead })], FILES)).toEqual([]);
    }
  });

  it("does not punish a decision for claiming no paths at all", () => {
    // Spec-scoped only: there is no resolvable claim, so nothing can be stale.
    expect(
      validateDecisions([record({ affects: { specs: ["lockers.rental"], paths: [] } })], FILES)
    ).toEqual([]);
  });
});

describe("validateDecisions — supersession", () => {
  const FILES = ["src/lockers/rent.ts"];

  it("errors when `supersedes` names a record that is not there", () => {
    const errors = validateDecisions([record({ supersedes: "2026-06-gone" })], FILES);
    expect(errors.join("\n")).toContain("supersession replaces deletion");
  });

  it("errors when a superseded record is still marked accepted", () => {
    const old = record({ id: "a-old" });
    const next = record({ id: "b-new", supersedes: "a-old" });
    const errors = validateDecisions([old, next], FILES);
    expect(errors.join("\n")).toContain("set status: superseded");
  });

  it("is satisfied once the predecessor's status is updated", () => {
    const old = record({ id: "a-old", status: "superseded" });
    const next = record({ id: "b-new", supersedes: "a-old" });
    expect(validateDecisions([old, next], FILES)).toEqual([]);
  });

  it("catches a record that supersedes itself", () => {
    const errors = validateDecisions([record({ id: "a-one", supersedes: "a-one" })], FILES);
    expect(errors.join("\n")).toContain("supersedes itself");
  });
});

describe("findDecisionConflicts", () => {
  const FILES = ["src/lockers/rent.ts", "src/billing/charge.ts"];
  const OPEN = ["2026-08-08-run-a", "2026-08-09-run-b"];

  const a = record({ id: "a-window", run: "2026-08-08-run-a" });
  const b = record({
    id: "b-window",
    run: "2026-08-09-run-b",
    affects: { specs: [], paths: ["src/lockers/rent.ts"] },
  });

  it("flags two open runs deciding about the same files", () => {
    const [conflict, ...rest] = findDecisionConflicts([a, b], { openRuns: OPEN, files: FILES });
    expect(rest).toEqual([]);
    expect(conflict?.runs).toEqual(["2026-08-08-run-a", "2026-08-09-run-b"]);
    expect(conflict?.decisions).toEqual(["a-window", "b-window"]);
    expect(conflict?.overlap.paths).toEqual(["src/lockers/rent.ts"]);
  });

  it("flags a spec claimed at two granularities", () => {
    const broad = record({
      id: "a-broad",
      run: "2026-08-08-run-a",
      affects: { specs: ["lockers.rental"], paths: [] },
    });
    const narrow = record({
      id: "b-narrow",
      run: "2026-08-09-run-b",
      affects: { specs: ["lockers.rental.rent-flow"], paths: [] },
    });
    const [conflict] = findDecisionConflicts([broad, narrow], { openRuns: OPEN, files: FILES });
    expect(conflict?.overlap.specs).toEqual(["lockers.rental"]);
  });

  it("does not flag one run refining its own decision", () => {
    const same = record({ id: "b-window", run: "2026-08-08-run-a" });
    expect(findDecisionConflicts([a, same], { openRuns: OPEN, files: FILES })).toEqual([]);
  });

  it("does not flag a run that is no longer open", () => {
    expect(findDecisionConflicts([a, b], { openRuns: ["2026-08-08-run-a"], files: FILES })).toEqual(
      []
    );
  });

  it("does not flag a pair where one supersedes the other — that IS the resolution", () => {
    const resolver = record({
      id: "b-window",
      run: "2026-08-09-run-b",
      supersedes: "a-window",
      affects: { specs: [], paths: ["src/lockers/rent.ts"] },
    });
    expect(findDecisionConflicts([a, resolver], { openRuns: OPEN, files: FILES })).toEqual([]);
  });

  it("does not flag a superseded or rejected record — it no longer speaks", () => {
    const dead = record({ id: "b-window", run: "2026-08-09-run-b", status: "rejected" });
    expect(findDecisionConflicts([a, dead], { openRuns: OPEN, files: FILES })).toEqual([]);
  });

  it("still fires on identical globs when the file list resolves nothing", () => {
    const x = record({
      id: "a-one",
      run: "2026-08-08-run-a",
      affects: { specs: [], paths: ["src/new/**"] },
    });
    const y = record({
      id: "b-two",
      run: "2026-08-09-run-b",
      affects: { specs: [], paths: ["src/new/**"] },
    });
    const [conflict] = findDecisionConflicts([x, y], { openRuns: OPEN, files: [] });
    expect(conflict?.overlap.paths).toEqual(["src/new/**"]);
  });

  it("ignores decisions with no run at all", () => {
    const orphan = record({ id: "b-two", run: undefined });
    expect(findDecisionConflicts([a, orphan], { openRuns: OPEN, files: FILES })).toEqual([]);
  });
});

describe("selectDecisions", () => {
  const live = record({ id: "a-live" });
  const old = record({
    id: "b-old",
    status: "superseded",
    affects: { specs: ["lockers.rental"], paths: ["src/lockers/**"] },
  });
  const all = [live, old];

  it("retrieves by the file an agent is about to touch", () => {
    expect(selectDecisions(all, { path: "src/lockers/rent.ts" }).map((d) => d.id)).toEqual([
      "a-live",
    ]);
    expect(selectDecisions(all, { path: "src/billing/charge.ts" })).toEqual([]);
  });

  it("matches a spec above or below the claimed one", () => {
    expect(selectDecisions(all, { spec: "lockers.rental" }).map((d) => d.id)).toEqual(["a-live"]);
    expect(selectDecisions(all, { spec: "billing.invoice" })).toEqual([]);
  });

  it("searches the body, case-insensitively", () => {
    expect(selectDecisions(all, { query: "SWEEPER" }).map((d) => d.id)).toEqual(["a-live"]);
  });

  it("ANDs its filters rather than unioning them", () => {
    expect(selectDecisions(all, { path: "src/lockers/rent.ts", query: "nothing here" })).toEqual(
      []
    );
  });

  it("hides history until it is asked for", () => {
    expect(selectDecisions(all).map((d) => d.id)).toEqual(["a-live"]);
    expect(selectDecisions(all, { includeSuperseded: true }).map((d) => d.id)).toEqual([
      "a-live",
      "b-old",
    ]);
  });
});

describe("on disk", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mechanics-decisions-")));
    await fs.mkdir(path.join(repo, "src", "lockers"), { recursive: true });
    await fs.writeFile(path.join(repo, "src", "lockers", "rent.ts"), "export {};\n", "utf8");
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("writes to `.docket/decisions/<id>.md` and reads back", async () => {
    const written = await writeDecision(repo, input());
    expect(written.endsWith(".docket/decisions/2026-08-abandoned-rental-window.md")).toBe(true);
    const { decisions, errors } = await listDecisions(repo);
    expect(errors).toEqual([]);
    expect(decisions.map((d) => d.id)).toEqual(["2026-08-abandoned-rental-window"]);
  });

  it("treats a missing folder as empty, not as an error", async () => {
    expect(await listDecisions(repo)).toEqual({ decisions: [], errors: [] });
  });

  it("collects a broken record's errors instead of hiding the good ones", async () => {
    await writeDecision(repo, input({ id: "a-good" }));
    await fs.writeFile(
      path.join(repo, ".docket", "decisions", "b-broken.md"),
      "---\nstatus: nope\n---\n",
      "utf8"
    );
    const { decisions, errors } = await listDecisions(repo);
    expect(decisions.map((d) => d.id)).toEqual(["a-good"]);
    expect(errors.join("\n")).toContain("b-broken.md");
  });

  it("checkDecisions resolves paths against the real tree", async () => {
    await writeDecision(repo, input({ id: "a-live" }));
    await writeDecision(
      repo,
      input({ id: "b-stale", affects: { specs: [], paths: ["src/deleted/**"] } })
    );
    const { errors, warnings } = await checkDecisions(repo);
    expect(warnings).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("b-stale");
  });

  it("checkDecisions is free when there is nothing recorded", async () => {
    expect(await checkDecisions(repo)).toEqual({
      decisions: [],
      errors: [],
      warnings: [],
      conflicts: [],
    });
  });

  it("finds a real conflict between two runs that are actually open", async () => {
    for (const run of ["2026-08-08-run-a", "2026-08-09-run-b"]) {
      await writeOrder(repo, { run, title: run, exitCriteria: [], phases: ["scope"] });
      await appendEvent(repo, run, { type: "run.created", actor: HUMAN, payload: { title: run } });
    }
    await writeDecision(repo, input({ id: "a-window", run: "2026-08-08-run-a" }));
    await writeDecision(repo, input({ id: "b-window", run: "2026-08-09-run-b" }));

    const open = await checkDecisions(repo);
    expect(open.errors).toEqual([]);
    expect(open.conflicts).toHaveLength(1);
    expect(open.warnings[0]).toContain("one of them is probably wrong");

    // Landing one of them ends the contention, without touching a record.
    await appendEvent(repo, "2026-08-09-run-b", {
      type: "run.finished",
      actor: HUMAN,
      payload: { result: "shipped" },
    });
    expect((await checkDecisions(repo)).conflicts).toEqual([]);
  });
});
