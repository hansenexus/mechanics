import { describe, expect, it } from "vitest";
import type { ManifestMechanic, WaveFile } from "./types";
import { applySpecResults, planVerify, setVerification } from "./verify";

function mech(overrides: Partial<ManifestMechanic> & { id: string }): ManifestMechanic {
  return {
    title: overrides.id,
    kind: "user-facing",
    area: overrides.id.split(".")[1] ?? "core",
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
    source: `apps/app/mechanics/core/${overrides.id.split(".")[2]}.md`,
    aliases: [],
    ...overrides,
  };
}

function wave(overrides: Partial<WaveFile> = {}): WaveFile {
  return {
    wave: "w1",
    title: "Wave 1",
    status: "open",
    startedAt: "2026-07-01",
    scope: { areas: [], kinds: [], ids: [], exclude: [] },
    links: { previewCategoryIds: [], previewDecisions: [] },
    verifications: [],
    ...overrides,
  };
}

const LINK = {
  spec: "apps/app/e2e/a.spec.ts",
  runner: "bun-script" as const,
  via: "annotation" as const,
};

describe("planVerify", () => {
  it("partitions into e2e (grouped by spec) / agent / manual with destructive always manual", () => {
    const mechanics = [
      mech({ id: "app.core.tested-a", tests: [LINK] }),
      mech({ id: "app.core.tested-b", tests: [LINK] }),
      mech({ id: "app.core.ui-only" }),
      mech({ id: "app.core.danger", tests: [LINK], destructive: true }),
      mech({ id: "app.core.backend", kind: "system" }),
    ];
    const plan = planVerify(mechanics, wave());
    expect(plan.e2e).toHaveLength(1);
    expect(plan.e2e[0]?.mechanicIds).toEqual(["app.core.tested-a", "app.core.tested-b"]);
    expect(plan.agent.map((m) => m.id)).toEqual(["app.core.ui-only"]);
    expect(plan.manual.map((m) => m.id).sort()).toEqual(["app.core.backend", "app.core.danger"]);
  });

  it("skips standing manual/agent verdicts and honors --resume and --only", () => {
    const mechanics = [
      mech({ id: "app.core.a", tests: [LINK] }),
      mech({ id: "app.core.b", tests: [LINK] }),
    ];
    const w = wave({
      verifications: [
        { mechanic: "app.core.a", status: "pass", method: "manual", evidence: "seen" },
        { mechanic: "app.core.b", status: "fail", method: "e2e" },
      ],
    });
    const plan = planVerify(mechanics, w);
    expect(plan.skipped).toEqual(["app.core.a"]);
    expect(plan.e2e[0]?.mechanicIds).toEqual(["app.core.b"]);

    const resumed = planVerify(mechanics, w, { resume: true });
    expect(resumed.skipped.sort()).toEqual(["app.core.a", "app.core.b"]);

    const only = planVerify(mechanics, w, { only: ["app.core.b"] });
    expect(only.e2e[0]?.mechanicIds).toEqual(["app.core.b"]);
  });

  it("excludes deprecated mechanics via scope resolution", () => {
    const mechanics = [mech({ id: "app.core.old", status: "deprecated", tests: [LINK] })];
    const plan = planVerify(mechanics, wave());
    expect(plan.e2e).toHaveLength(0);
  });
});

describe("applySpecResults", () => {
  it("records pass/fail with evidence and ANDs across specs", () => {
    const w = wave();
    const merged = applySpecResults(
      w,
      [
        { spec: "apps/app/e2e/a.spec.ts", ok: true, mechanicIds: ["app.core.x"], outputTail: "" },
        {
          spec: "apps/app/e2e/b.spec.ts",
          ok: false,
          mechanicIds: ["app.core.x"],
          outputTail: "boom",
        },
      ],
      { verifiedBy: "mechanics-cli", date: "2026-07-20" }
    );
    const entry = merged.verifications.find((v) => v.mechanic === "app.core.x");
    expect(entry?.status).toBe("fail");
    expect(entry?.method).toBe("e2e");
    expect(entry?.evidence).toContain("a.spec.ts");
    expect(entry?.note).toContain("boom");
  });

  it("never overwrites a standing manual verdict", () => {
    const w = wave({
      verifications: [
        {
          mechanic: "app.core.x",
          status: "pass",
          method: "manual",
          evidence: "human-checked",
          verifiedAt: "2026-07-01",
        },
      ],
    });
    const merged = applySpecResults(
      w,
      [{ spec: "apps/app/e2e/a.spec.ts", ok: false, mechanicIds: ["app.core.x"], outputTail: "x" }],
      { verifiedBy: "mechanics-cli", date: "2026-07-20" }
    );
    const entry = merged.verifications.find((v) => v.mechanic === "app.core.x");
    expect(entry?.status).toBe("pass");
    expect(entry?.method).toBe("manual");
    expect(entry?.evidence).toBe("human-checked");
  });
});

describe("setVerification", () => {
  it("upserts and may overwrite anything (deliberate human action)", () => {
    const w = wave({
      verifications: [{ mechanic: "app.core.x", status: "pass", method: "e2e", evidence: "spec" }],
    });
    const next = setVerification(w, {
      mechanic: "app.core.x",
      status: "fail",
      method: "agent",
      evidence: "screenshot.png",
      verifiedBy: "me",
      date: "2026-07-20",
      failedCriteria: ["AC2"],
    });
    const entry = next.verifications.find((v) => v.mechanic === "app.core.x");
    expect(entry?.status).toBe("fail");
    expect(entry?.method).toBe("agent");
    expect(entry?.failedCriteria).toEqual(["AC2"]);
    expect(w.verifications[0]?.status).toBe("pass"); // input untouched
  });
});
