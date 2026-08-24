import { describe, expect, it } from "vitest";
import type { CriterionState } from "./docket-types";
import { applyMergePlan, parseCriterionRef, planWaveMerge } from "./docket-wave";
import type { WaveFile, WaveVerification } from "./types";

const M = "console.observe.logs-tab";
const N = "console.apps.pod-table";

function crit(
  criterion: string,
  verdict: CriterionState["verdict"],
  over: Partial<CriterionState> = {}
): CriterionState {
  return { criterion, verdict, at: "2026-08-08T12:00:00.000Z", ...over };
}

function wave(verifications: WaveVerification[] = []): WaveFile {
  return {
    wave: "2026-08-baseline",
    title: "Baseline",
    status: "open",
    startedAt: "2026-08-01",
    scope: { areas: [], kinds: [], ids: [], exclude: [] },
    links: { previewCategoryIds: [], previewDecisions: [] },
    verifications,
  };
}

describe("parseCriterionRef", () => {
  it("splits a mechanic id from its AC label", () => {
    expect(parseCriterionRef(`${M}:AC2`)).toEqual({ mechanic: M, label: "AC2" });
  });

  it("returns null for free text, which is legal in an order", () => {
    expect(parseCriterionRef("Rental survives a Convex cold start")).toBeNull();
    expect(parseCriterionRef("not-a-mechanic:AC1")).toBeNull();
    expect(parseCriterionRef(`${M}:AC0`)).toBeNull();
    expect(parseCriterionRef(M)).toBeNull();
  });
});

describe("planWaveMerge — aggregation", () => {
  it("passes a mechanic only when every one of its criteria passed", () => {
    const plan = planWaveMerge(
      [
        crit(`${M}:AC1`, "pass", { evidence: "e2e/a.spec.ts", method: "e2e" }),
        crit(`${M}:AC2`, "pass", { evidence: "e2e/b.spec.ts", method: "e2e" }),
      ],
      wave()
    );
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]).toMatchObject({
      mechanic: M,
      status: "pass",
      evidence: "e2e/a.spec.ts, e2e/b.spec.ts",
    });
  });

  it("one failing AC fails the whole mechanic and names the label", () => {
    const plan = planWaveMerge(
      [
        crit(`${M}:AC1`, "pass", { evidence: "x", method: "e2e" }),
        crit(`${M}:AC3`, "fail", { method: "e2e" }),
      ],
      wave()
    );
    expect(plan.entries[0]).toMatchObject({ status: "fail", failedCriteria: ["AC3"] });
  });

  it("blocked outranks pass but yields to fail", () => {
    expect(
      planWaveMerge(
        [crit(`${M}:AC1`, "pass", { evidence: "x" }), crit(`${M}:AC2`, "blocked")],
        wave()
      ).entries[0]?.status
    ).toBe("blocked");
    expect(
      planWaveMerge([crit(`${M}:AC1`, "blocked"), crit(`${M}:AC2`, "fail")], wave()).entries[0]
        ?.status
    ).toBe("fail");
  });

  it("is n-a only when every criterion is n-a", () => {
    expect(planWaveMerge([crit(`${M}:AC1`, "n-a")], wave()).entries[0]?.status).toBe("n-a");
    expect(
      planWaveMerge([crit(`${M}:AC1`, "n-a"), crit(`${M}:AC2`, "pass", { evidence: "x" })], wave())
        .entries[0]?.status
    ).toBe("pass");
  });

  it("takes the most deliberate method of the group", () => {
    const plan = planWaveMerge(
      [
        crit(`${M}:AC1`, "pass", { evidence: "x", method: "e2e" }),
        crit(`${M}:AC2`, "pass", { evidence: "y", method: "manual" }),
      ],
      wave()
    );
    expect(plan.entries[0]?.method).toBe("manual");
  });

  it("groups several mechanics and sorts them", () => {
    const plan = planWaveMerge(
      [crit(`${M}:AC1`, "pass", { evidence: "x" }), crit(`${N}:AC1`, "pass", { evidence: "y" })],
      wave()
    );
    expect(plan.entries.map((e) => e.mechanic)).toEqual([N, M]);
  });
});

describe("planWaveMerge — the standing-verdict rule", () => {
  it("refuses to overwrite a manual verdict with an e2e result", () => {
    const existing: WaveVerification = {
      mechanic: M,
      status: "pass",
      method: "manual",
      evidence: "checked by hand",
      verifiedBy: "hn-air",
      verifiedAt: "2026-08-01",
    };
    const plan = planWaveMerge([crit(`${M}:AC1`, "fail", { method: "e2e" })], wave([existing]));
    expect(plan.entries[0]?.skipped).toBe("standing-verdict");
    expect(
      applyMergePlan(wave([existing]), plan, { verifiedBy: "d", date: "2026-08-08" })
        .verifications[0]
    ).toEqual(existing);
  });

  it("lets a manual verdict from the run overwrite anything", () => {
    const existing: WaveVerification = {
      mechanic: M,
      status: "pass",
      method: "agent",
      evidence: "old",
      verifiedBy: "someone",
      verifiedAt: "2026-08-01",
    };
    const plan = planWaveMerge([crit(`${M}:AC1`, "fail", { method: "manual" })], wave([existing]));
    expect(plan.entries[0]?.skipped).toBeUndefined();
    const next = applyMergePlan(wave([existing]), plan, { verifiedBy: "d", date: "2026-08-08" });
    expect(next.verifications[0]).toMatchObject({ status: "fail", method: "manual" });
  });

  it("does overwrite a pending entry, standing or not", () => {
    const existing: WaveVerification = {
      mechanic: M,
      status: "pending",
      method: "manual",
      verifiedBy: "someone",
      verifiedAt: "2026-08-01",
    };
    const plan = planWaveMerge(
      [crit(`${M}:AC1`, "pass", { evidence: "x", method: "e2e" })],
      wave([existing])
    );
    expect(plan.entries[0]?.skipped).toBeUndefined();
  });
});

describe("planWaveMerge — unmapped criteria", () => {
  it("reports free-text criteria rather than dropping them silently", () => {
    const plan = planWaveMerge(
      [crit("Rental survives a cold start", "pass", { evidence: "x" })],
      wave(),
      ["Rental survives a cold start", `${M}:AC1`]
    );
    expect(plan.entries).toHaveLength(0);
    expect(plan.unmapped).toEqual(["Rental survives a cold start"]);
  });
});

describe("applyMergePlan", () => {
  it("appends a new entry and updates an existing one", () => {
    const start = wave([
      {
        mechanic: N,
        status: "pending",
        method: "e2e",
        verifiedBy: "x",
        verifiedAt: "2026-08-01",
      },
    ]);
    const plan = planWaveMerge(
      [crit(`${M}:AC1`, "pass", { evidence: "a" }), crit(`${N}:AC1`, "pass", { evidence: "b" })],
      start
    );
    const next = applyMergePlan(start, plan, { verifiedBy: "docket:r1", date: "2026-08-08" });
    expect(next.verifications).toHaveLength(2);
    expect(next.verifications.find((v) => v.mechanic === N)).toMatchObject({
      status: "pass",
      verifiedBy: "docket:r1",
      verifiedAt: "2026-08-08",
    });
  });

  it("does not mutate the wave it was given", () => {
    const start = wave();
    const plan = planWaveMerge([crit(`${M}:AC1`, "pass", { evidence: "a" })], start);
    applyMergePlan(start, plan, { verifiedBy: "d", date: "2026-08-08" });
    expect(start.verifications).toHaveLength(0);
  });
});
