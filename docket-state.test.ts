import { describe, expect, it } from "vitest";
import { reduceRun } from "./docket-state";
import { type Actor, DOCKET_PROTO, type DocketEvent, type DocketOrder } from "./docket-types";

const AGENT: Actor = { kind: "agent", harness: "claude-code", session: "s1" };
const HOOK: Actor = { kind: "hook", harness: "claude-code", session: "s1" };

const T0 = "2026-08-08T12:00:00.000Z";
const NOW = new Date("2026-08-08T12:01:00.000Z");

function order(over: Partial<DocketOrder> = {}): DocketOrder {
  return {
    run: "2026-08-08-demo",
    title: "Demo",
    exitCriteria: ["app.area.slug:AC1", "app.area.slug:AC2"],
    phases: ["scope", "implement", "verify", "land"],
    ...over,
  };
}

let seq = 0;
function ev(type: string, payload: Record<string, unknown> = {}, over: Partial<DocketEvent> = {}) {
  seq++;
  return {
    proto: DOCKET_PROTO,
    ts: T0,
    run: "2026-08-08-demo",
    seq,
    type,
    actor: AGENT,
    payload,
    ...over,
  } satisfies DocketEvent;
}

describe("reduceRun — liveness", () => {
  it("is stalled with no events at all", () => {
    const s = reduceRun(order(), [], { now: NOW });
    expect(s.liveness).toBe("stalled");
    expect(s.lastEventAt).toBeNull();
  });

  it("is working while events land inside the staleness window", () => {
    const s = reduceRun(order(), [ev("run.started")], { now: NOW, stalenessMs: 120_000 });
    expect(s.liveness).toBe("working");
  });

  it("is stalled once the window elapses", () => {
    const s = reduceRun(order(), [ev("run.started")], { now: NOW, stalenessMs: 30_000 });
    expect(s.liveness).toBe("stalled");
  });

  it("is waiting after gate.blocked", () => {
    const s = reduceRun(
      order(),
      [ev("run.started"), ev("gate.blocked", { reason: "need a key", needs: "human" })],
      {
        now: NOW,
      }
    );
    expect(s.liveness).toBe("waiting");
    expect(s.blocked?.needs).toBe("human");
  });

  it("a heartbeat does NOT clear a block — being alive is not being unblocked", () => {
    const s = reduceRun(
      order(),
      [ev("gate.blocked", { reason: "need a key", needs: "human" }), ev("session.heartbeat")],
      { now: NOW }
    );
    expect(s.liveness).toBe("waiting");
  });

  it("a progress event does clear the block", () => {
    const s = reduceRun(
      order(),
      [ev("gate.blocked", { reason: "need a key" }), ev("phase.entered", { phase: "verify" })],
      { now: NOW }
    );
    expect(s.liveness).toBe("working");
    expect(s.blocked).toBeUndefined();
  });

  it("done outranks everything, including an outstanding block", () => {
    const s = reduceRun(
      order(),
      [ev("gate.blocked", { reason: "x" }), ev("run.finished", { result: "shipped" })],
      { now: NOW }
    );
    expect(s.liveness).toBe("done");
    expect(s.result).toBe("shipped");
  });
});

describe("reduceRun — idle", () => {
  it("an ended turn is idle, not stalled, long past the staleness window", () => {
    const s = reduceRun(
      order(),
      [ev("run.started"), ev("session.idle", { reason: "turn ended" })],
      {
        now: NOW,
        stalenessMs: 30_000,
      }
    );
    expect(s.liveness).toBe("idle");
    expect(s.idle?.reason).toBe("turn ended");
  });

  it("session.idle does NOT clear a block — the agent's turn ending is not an answer", () => {
    // The real sequence: an agent raises a gate, then its turn ends
    // milliseconds later. Treating idle as progress would unblock every gate
    // the instant it was raised.
    const s = reduceRun(
      order(),
      [ev("gate.blocked", { reason: "need a key", needs: "human" }), ev("session.idle")],
      { now: NOW }
    );
    expect(s.liveness).toBe("waiting");
    expect(s.blocked?.needs).toBe("human");
  });

  it("a bare heartbeat clears idle — unlike a block, a tool call refutes it", () => {
    const s = reduceRun(order(), [ev("session.idle"), ev("session.heartbeat")], {
      now: NOW,
      stalenessMs: 120_000,
    });
    expect(s.liveness).toBe("working");
    expect(s.idle).toBeUndefined();
  });

  it("idle decays to stalled once nobody comes back", () => {
    const s = reduceRun(order(), [ev("session.idle")], { now: NOW, idleStalenessMs: 30_000 });
    expect(s.liveness).toBe("stalled");
  });

  it("done outranks idle", () => {
    const s = reduceRun(order(), [ev("session.idle"), ev("run.finished", { result: "shipped" })], {
      now: NOW,
    });
    expect(s.liveness).toBe("done");
  });
});

describe("reduceRun — criteria", () => {
  it("counts pass and n-a as met, against the order's total", () => {
    const s = reduceRun(
      order(),
      [
        ev("criterion.evaluated", {
          criterion: "app.area.slug:AC1",
          verdict: "pass",
          evidence: "e2e/foo.spec.ts",
          method: "e2e",
        }),
        ev("criterion.evaluated", { criterion: "app.area.slug:AC2", verdict: "n-a" }),
      ],
      { now: NOW }
    );
    expect(s.progress).toEqual({ met: 2, total: 2 });
  });

  it("drops a pass without evidence, even if a writer smuggled it in", () => {
    const s = reduceRun(
      order(),
      [ev("criterion.evaluated", { criterion: "app.area.slug:AC1", verdict: "pass" })],
      { now: NOW }
    );
    expect(s.criteria).toHaveLength(0);
    expect(s.progress.met).toBe(0);
  });

  it("keeps only the latest verdict per criterion", () => {
    const s = reduceRun(
      order(),
      [
        ev("criterion.evaluated", { criterion: "app.area.slug:AC1", verdict: "fail" }),
        ev("criterion.evaluated", {
          criterion: "app.area.slug:AC1",
          verdict: "pass",
          evidence: "e2e/foo.spec.ts",
        }),
      ],
      { now: NOW }
    );
    expect(s.criteria).toHaveLength(1);
    expect(s.criteria[0]?.verdict).toBe("pass");
    expect(s.progress.met).toBe(1);
  });

  it("does not let a criterion outside the order inflate progress", () => {
    const s = reduceRun(
      order(),
      [
        ev("criterion.evaluated", {
          criterion: "app.area.other:AC9",
          verdict: "pass",
          evidence: "x",
        }),
      ],
      { now: NOW }
    );
    expect(s.criteria).toHaveLength(1);
    expect(s.progress).toEqual({ met: 0, total: 2 });
  });
});

describe("reduceRun — forward compatibility", () => {
  it("ignores an unknown event type but still counts it as activity", () => {
    const s = reduceRun(order(), [ev("run.vibed", { mood: "good" })], { now: NOW });
    expect(s.eventCount).toBe(1);
    expect(s.liveness).toBe("working");
  });

  it("survives a malformed payload without throwing", () => {
    const s = reduceRun(
      order(),
      [ev("criterion.evaluated", { criterion: 42, verdict: "banana" })],
      { now: NOW }
    );
    expect(s.criteria).toHaveLength(0);
  });
});

describe("reduceRun — collaboration", () => {
  it("tracks a claim and its release", () => {
    const claimed = reduceRun(order(), [ev("run.claimed", { until: "2026-08-08T13:00:00Z" })], {
      now: NOW,
    });
    expect(claimed.claim?.until).toBe("2026-08-08T13:00:00Z");
    const released = reduceRun(
      order(),
      [ev("run.claimed", { until: "2026-08-08T13:00:00Z" }), ev("run.released", {})],
      { now: NOW }
    );
    expect(released.claim).toBeUndefined();
  });

  it("records decisions and handoffs in order", () => {
    const s = reduceRun(
      order(),
      [
        ev("decision.recorded", { decision: "2026-08-export-idempotency", title: "Idempotent" }),
        ev("handoff.requested", { to: "casey", reason: "needs a design call" }),
      ],
      { now: NOW }
    );
    expect(s.decisions).toHaveLength(1);
    expect(s.handoff?.to).toBe("casey");
  });

  it("attributes a subagent verdict to its parent session", () => {
    const sub: Actor = {
      kind: "subagent",
      harness: "claude-code",
      session: "s1",
      parent: "s1",
      agentType: "code-reviewer",
    };
    const s = reduceRun(
      order(),
      [
        ev(
          "criterion.evaluated",
          { criterion: "app.area.slug:AC1", verdict: "pass", evidence: "review" },
          { actor: sub }
        ),
      ],
      { now: NOW }
    );
    expect(s.criteria[0]?.by?.kind).toBe("subagent");
    expect(s.criteria[0]?.by?.parent).toBe("s1");
  });

  it("still records a hook's factual events", () => {
    const s = reduceRun(
      order(),
      [ev("evidence.attached", { kind: "screenshot", path: "a.webp" }, { actor: HOOK })],
      { now: NOW }
    );
    expect(s.evidence).toHaveLength(1);
  });
});
