import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendEvent, eventsPath, readEvents } from "./docket-events";
import { deriveRunId, parseOrder, writeOrder } from "./docket-order";
import type { Actor } from "./docket-types";

const AGENT: Actor = { kind: "agent", harness: "claude-code", session: "s1" };
const HOOK: Actor = { kind: "hook", harness: "claude-code", session: "s1" };
const RUN = "2026-08-08-fixture";

let repo: string;

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "docket-"));
  await writeOrder(repo, {
    run: RUN,
    title: "Fixture",
    exitCriteria: ["a:AC1"],
    phases: ["scope", "land"],
  });
});

afterEach(async () => {
  await fs.rm(repo, { recursive: true, force: true });
});

describe("appendEvent", () => {
  it("allocates gap-free sequence numbers", async () => {
    await appendEvent(repo, RUN, { type: "run.started", actor: AGENT });
    await appendEvent(repo, RUN, {
      type: "phase.entered",
      actor: AGENT,
      payload: { phase: "scope" },
    });
    const { events } = await readEvents(repo, RUN);
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("keeps sequence gap-free under concurrent writers", async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        appendEvent(repo, RUN, { type: "session.heartbeat", actor: AGENT, payload: { i } })
      )
    );
    const { events, malformed } = await readEvents(repo, RUN);
    expect(malformed).toBe(0);
    expect(events.map((e) => e.seq).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
  });

  it("writes payload keys at the top level, next to the base fields", async () => {
    await appendEvent(repo, RUN, {
      type: "gate.blocked",
      actor: AGENT,
      payload: { reason: "need a key", needs: "human" },
    });
    const raw = await fs.readFile(eventsPath(repo, RUN), "utf8");
    const line = JSON.parse(raw.trim());
    expect(line.reason).toBe("need a key");
    expect(line.proto).toBe("docket/1");
    expect(line.payload).toBeUndefined();
  });

  it("refuses criterion.evaluated from a hook", async () => {
    await expect(
      appendEvent(repo, RUN, {
        type: "criterion.evaluated",
        actor: HOOK,
        payload: { criterion: "a:AC1", verdict: "pass", evidence: "x" },
      })
    ).rejects.toThrow(/hook may not emit/);
  });

  it("refuses a pass without evidence", async () => {
    await expect(
      appendEvent(repo, RUN, {
        type: "criterion.evaluated",
        actor: AGENT,
        payload: { criterion: "a:AC1", verdict: "pass" },
      })
    ).rejects.toThrow(/requires evidence/);
  });
});

describe("readEvents", () => {
  it("returns nothing for a run with no log yet", async () => {
    expect(await readEvents(repo, RUN)).toEqual({ events: [], malformed: 0 });
  });

  it("survives a truncated trailing line and keeps the good events", async () => {
    await appendEvent(repo, RUN, { type: "run.started", actor: AGENT });
    await fs.appendFile(eventsPath(repo, RUN), '{"proto":"docket/1","ts":"2026-08', "utf8");
    const { events, malformed } = await readEvents(repo, RUN);
    expect(events).toHaveLength(1);
    expect(malformed).toBe(1);
  });

  it("rejects a line missing base fields as malformed", async () => {
    await fs.writeFile(eventsPath(repo, RUN), '{"type":"run.started"}\n', "utf8");
    const { events, malformed } = await readEvents(repo, RUN);
    expect(events).toHaveLength(0);
    expect(malformed).toBe(1);
  });
});

describe("order", () => {
  it("round-trips through YAML", async () => {
    const raw = await fs.readFile(path.join(repo, ".docket", "runs", RUN, "order.yaml"), "utf8");
    expect(parseOrder(raw).title).toBe("Fixture");
  });

  it("rejects an unknown key instead of dropping it silently", () => {
    expect(() => parseOrder("run: 2026-08-08-x\ntitle: X\nowner: me\n")).toThrow(/owner/);
  });

  it("rejects a run id that is not date-prefixed", () => {
    expect(() => parseOrder("run: locker-flow\ntitle: X\n")).toThrow(/YYYY-MM-DD/);
  });

  it("derives a sortable run id from a title", () => {
    expect(deriveRunId("Smart-Locker Ausleihe!", "2026-08-08")).toBe(
      "2026-08-08-smart-locker-ausleihe"
    );
  });

  it("folds umlauts in the run id too, so ids stay readable in German", () => {
    expect(deriveRunId("Locker Rückgabe prüfen", "2026-08-08")).toBe(
      "2026-08-08-locker-ruckgabe-prufen"
    );
  });
});
