/**
 * The gap rules, asserted as predicates.
 *
 * The point of `planGaps` being pure is that "clearly matches" and
 * "unambiguously tests" stop being adjectives and become conditions a test can
 * fail. Each `auto` rule below is checked in BOTH directions: the case that
 * earns the lane, and the neighbouring case that must not.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import { findGaps, type Gap, type GapInput, planGaps } from "./gaps";
import type { AppMechanicsConfig, ManifestMechanic, MechanicsManifest } from "./types";

const PERCH = path.join(__dirname, "examples", "perch");

function mechanic(over: Partial<ManifestMechanic> = {}): ManifestMechanic {
  return {
    id: "demo.area.thing",
    title: "Thing",
    kind: "user-facing",
    area: "area",
    status: "active",
    priority: "p1",
    roles: ["viewer"],
    claims: {},
    paths: [],
    nonFunctional: [],
    destructive: false,
    criteria: ["AC1"],
    edgeCaseCount: 0,
    errorStateCount: 0,
    tests: [],
    source: "mechanics/area/thing.md",
    aliases: [],
    verify: "manual-only",
    ...over,
  };
}

function manifest(over: Partial<MechanicsManifest> = {}): MechanicsManifest {
  return {
    appSlug: "demo",
    generatedAt: "2026-01-01T00:00:00.000Z",
    surfaces: [],
    areas: [],
    mechanics: [],
    coverage: {},
    testCoverage: { withTests: 0, manualOnly: 0, untested: 0 },
    ...over,
  } as MechanicsManifest;
}

function config(ignore: Record<string, string[]> = {}): AppMechanicsConfig {
  return {
    testGlobs: ["e2e/**/*.spec.ts"],
    e2eRunner: "bun-script",
    coverage: { enforce: "warn", ignore },
  } as AppMechanicsConfig;
}

function input(over: Partial<GapInput> = {}): GapInput {
  return {
    app: "demo",
    manifest: manifest(),
    config: config(),
    inventory: { kinds: [], items: {} },
    provenance: {},
    waves: [],
    appFiles: [],
    corpusDir: "mechanics",
    ...over,
  };
}

const find = (gaps: Gap[], cls: string) => gaps.filter((g) => g.gap === cls);

describe("narrow-ignore: mechanical because it freezes today's behaviour", () => {
  const base = (over: Partial<GapInput> = {}) =>
    input({
      config: config({ worker: ["src/workers/_*.ts"] }),
      inventory: {
        kinds: [{ kind: "worker", label: "worker" }],
        items: { worker: ["src/workers/_debug.ts", "src/workers/_scratch.ts"] },
      },
      ...over,
    });

  it("collapses a wildcard to the literals it matches today", () => {
    const [gap] = find(planGaps(base()), "broad-ignore");
    expect(gap?.lane).toBe("auto");
    expect(gap?.op).toEqual({
      kind: "narrow-ignore",
      file: "mechanics/_config.yaml",
      surfaceKind: "worker",
      glob: "src/workers/_*.ts",
      literals: ["src/workers/_debug.ts", "src/workers/_scratch.ts"],
    });
  });

  it("refuses when a match is also claimed — narrowing would move it between buckets", () => {
    const gaps = base({
      manifest: manifest({
        mechanics: [mechanic({ claims: { worker: ["src/workers/_debug.ts"] } })],
      }),
    });
    expect(find(planGaps(gaps), "broad-ignore")[0]?.lane).toBe("propose");
  });

  it("refuses when the literal list would be too long to read", () => {
    const many = Array.from({ length: 9 }, (_, i) => `src/workers/_w${i}.ts`);
    const gaps = base({
      inventory: { kinds: [{ kind: "worker", label: "worker" }], items: { worker: many } },
    });
    expect(find(planGaps(gaps), "broad-ignore")[0]?.lane).toBe("propose");
  });

  it("reports a glob that matches nothing as stale, and never as auto", () => {
    const gaps = planGaps(
      input({
        config: config({ worker: ["src/gone/*.ts"] }),
        inventory: {
          kinds: [{ kind: "worker", label: "worker" }],
          items: { worker: ["src/workers/a.ts"] },
        },
      })
    );
    const [stale] = find(gaps, "stale-ignore");
    expect(stale?.lane).toBe("propose");
    expect(stale?.op).toBeUndefined();
  });

  it("leaves a literal ignore alone — there is nothing to narrow", () => {
    const gaps = planGaps(
      input({
        config: config({ worker: ["src/workers/_debug.ts"] }),
        inventory: {
          kinds: [{ kind: "worker", label: "worker" }],
          items: { worker: ["src/workers/_debug.ts"] },
        },
      })
    );
    expect(find(gaps, "broad-ignore")).toEqual([]);
    expect(find(gaps, "stale-ignore")).toEqual([]);
  });
});

describe("annotate-spec: auto only when the file can mean one mechanic", () => {
  const withSpec = (mechanics: ManifestMechanic[], files: string[]) =>
    planGaps(
      input({
        manifest: manifest({ mechanics }),
        appFiles: files,
      })
    );

  it("links a spec whose stem names exactly one untested mechanic", () => {
    const gaps = withSpec(
      [mechanic({ id: "demo.area.mute-alerts", verify: undefined })],
      ["e2e/mute-alerts.spec.ts"]
    );
    const [gap] = find(gaps, "unlinked-spec");
    expect(gap?.lane).toBe("auto");
    expect(gap?.op).toEqual({
      kind: "annotate-spec",
      file: "e2e/mute-alerts.spec.ts",
      mechanic: "demo.area.mute-alerts",
    });
  });

  it("refuses when two areas share the slug — the file could mean either", () => {
    const gaps = withSpec(
      [
        mechanic({ id: "demo.alerts.mute", verify: undefined }),
        mechanic({ id: "demo.digest.mute", source: "mechanics/digest/mute.md", verify: undefined }),
      ],
      ["e2e/mute.spec.ts"]
    );
    expect(find(gaps, "unlinked-spec")).toEqual([]);
    // Both still surface as untested; they just are not auto-linkable.
    expect(find(gaps, "untested-behaviour")).toHaveLength(2);
  });

  it("ignores a file that is not a declared spec", () => {
    const gaps = withSpec([mechanic({ id: "demo.area.mute", verify: undefined })], ["src/mute.ts"]);
    expect(find(gaps, "unlinked-spec")).toEqual([]);
  });

  it("leaves manual-only mechanics out of the untested list entirely", () => {
    const gaps = withSpec([mechanic({ verify: "manual-only" })], []);
    expect(find(gaps, "untested-behaviour")).toEqual([]);
  });
});

describe("add-paths: auto only when provenance answers for every claim", () => {
  const m = (over: Partial<ManifestMechanic> = {}) =>
    mechanic({ claims: { route: ["/pricing"] }, ...over });

  it("writes the literal files a mechanic's claims resolve to", () => {
    const gaps = planGaps(
      input({
        manifest: manifest({ mechanics: [m()] }),
        provenance: { route: { "/pricing": ["src/app/pricing/page.tsx"] } },
      })
    );
    const [gap] = find(gaps, "missing-claim-path");
    expect(gap?.lane).toBe("auto");
    expect(gap?.op).toEqual({
      kind: "add-paths",
      file: "mechanics/area/thing.md",
      mechanic: "demo.area.thing",
      paths: ["src/app/pricing/page.tsx"],
    });
  });

  it("refuses when any claim resolves to no known file", () => {
    const gaps = planGaps(
      input({
        manifest: manifest({ mechanics: [m({ claims: { route: ["/pricing", "/generated"] } })] }),
        provenance: { route: { "/pricing": ["src/app/pricing/page.tsx"] } },
      })
    );
    // Absence in provenance means UNKNOWN, never "no files" — guessing here is
    // how an unestablished fact gets written into the corpus and blessed.
    expect(find(gaps, "missing-claim-path")[0]?.lane).toBe("propose");
  });

  it("refuses when another mechanic claims the same surface", () => {
    const gaps = planGaps(
      input({
        manifest: manifest({
          mechanics: [m(), m({ id: "demo.area.other", source: "mechanics/area/other.md" })],
        }),
        provenance: { route: { "/pricing": ["src/app/pricing/page.tsx"] } },
      })
    );
    for (const gap of find(gaps, "missing-claim-path")) expect(gap.lane).toBe("propose");
  });

  it("leaves a mechanic that already declares paths alone", () => {
    const gaps = planGaps(
      input({
        manifest: manifest({ mechanics: [m({ paths: ["src/app/pricing/**"] })] }),
        provenance: { route: { "/pricing": ["src/app/pricing/page.tsx"] } },
      })
    );
    expect(find(gaps, "missing-claim-path")).toEqual([]);
  });
});

describe("the propose-only classes stay propose-only", () => {
  it("never offers to author a mechanic for an unclaimed surface", () => {
    const gaps = planGaps(
      input({
        manifest: manifest({
          surfaces: [{ kind: "route", label: "route" }],
          coverage: { route: { total: 1, claimed: 0, ignored: 0, unclaimed: ["/login"] } },
        }),
      })
    );
    const [gap] = find(gaps, "unclaimed-surface");
    expect(gap?.lane).toBe("propose");
    expect(gap?.op).toBeUndefined();
  });

  it("never offers to promote a draft", () => {
    const gaps = planGaps(
      input({ manifest: manifest({ mechanics: [mechanic({ status: "draft" })] }) })
    );
    const [gap] = find(gaps, "draft-debt");
    expect(gap?.lane).toBe("propose");
    expect(gap?.op).toBeUndefined();
  });

  it("emits no auto op for any propose-lane gap, whatever the class", () => {
    const gaps = planGaps(
      input({
        manifest: manifest({
          surfaces: [{ kind: "route", label: "route" }],
          coverage: { route: { total: 1, claimed: 0, ignored: 0, unclaimed: ["/login"] } },
          mechanics: [mechanic({ status: "draft", verify: undefined })],
        }),
        config: config({ route: ["/gone/*"] }),
        inventory: { kinds: [{ kind: "route", label: "route" }], items: { route: ["/login"] } },
      })
    );
    for (const gap of gaps) {
      if (gap.lane === "propose") expect(gap.op, gap.key).toBeUndefined();
      else expect(gap.op, gap.key).toBeDefined();
    }
  });
});

describe("ordering", () => {
  it("is deterministic, so a re-scan is not a diff", () => {
    const i = input({
      manifest: manifest({
        mechanics: [
          mechanic({ id: "demo.b.two", priority: "p0", verify: undefined }),
          mechanic({ id: "demo.a.one", verify: undefined }),
        ],
      }),
    });
    const first = planGaps(i);
    expect(planGaps(i)).toEqual(first);
    expect(first[0]?.severity).toBe("p0");
  });
});

describe("against examples/perch", () => {
  it("names exactly the four gaps the example means to have", async () => {
    // The same four `examples.test.ts` pins on the CLI output. If the findings
    // engine and `check` ever disagree about what is unclaimed, one of them is
    // lying to whoever reads it.
    const gaps = await findGaps("perch", PERCH);
    expect(
      find(gaps, "unclaimed-surface")
        .map((g) => g.subject)
        .sort()
    ).toEqual(["/", "/api/webhooks/stripe", "/login", "monitors.exportCsv"]);
  });

  it("ranks the two untested p0 behaviours first", async () => {
    const gaps = await findGaps("perch", PERCH);
    expect(gaps.slice(0, 2).every((g) => g.severity === "p0")).toBe(true);
  });

  it("finds no missing paths, because every perch mechanic declares them", async () => {
    const gaps = await findGaps("perch", PERCH);
    expect(find(gaps, "missing-claim-path")).toEqual([]);
  });
});
