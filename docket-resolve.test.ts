import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadOrder, writeOrder } from "./docket-order";
import {
  attachSession,
  clearHeartbeat,
  hasDocket,
  heartbeatDue,
  pointerPath,
  resolveActiveRun,
  touchHeartbeat,
} from "./docket-resolve";

let repo: string;

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "docket-resolve-"));
});

afterEach(async () => {
  await fs.rm(repo, { recursive: true, force: true });
});

async function seed(run: string, over: { branch?: string; sessionId?: string } = {}) {
  await writeOrder(repo, {
    run,
    title: run,
    exitCriteria: [],
    phases: ["scope", "land"],
    ...(over.branch ? { git: { branch: over.branch } } : {}),
    ...(over.sessionId ? { agent: { harness: "claude-code", sessionId: over.sessionId } } : {}),
  });
}

describe("hasDocket", () => {
  it("is false on a checkout with no runs — the cheap path every session takes", async () => {
    expect(await hasDocket(repo)).toBe(false);
  });

  it("is true once a run exists", async () => {
    await seed("2026-08-08-a");
    expect(await hasDocket(repo)).toBe(true);
  });
});

describe("resolveActiveRun", () => {
  it("returns null when nothing matches, so hooks no-op", async () => {
    await seed("2026-08-08-a", { branch: "feat/other" });
    expect(await resolveActiveRun(repo, { branch: "feat/mine" })).toBeNull();
  });

  it("prefers an explicit session binding over a branch match", async () => {
    await seed("2026-08-08-by-branch", { branch: "feat/x" });
    await seed("2026-08-09-by-session", { branch: "feat/other", sessionId: "sess-1" });
    const r = await resolveActiveRun(repo, { sessionId: "sess-1", branch: "feat/x" });
    expect(r).toEqual({ run: "2026-08-09-by-session", via: "session" });
  });

  it("falls back to the branch when no session is bound", async () => {
    await seed("2026-08-08-a", { branch: "feat/x" });
    const r = await resolveActiveRun(repo, { sessionId: "sess-unknown", branch: "feat/x" });
    expect(r).toEqual({ run: "2026-08-08-a", via: "branch" });
  });

  it("picks the newest run when several share a branch", async () => {
    await seed("2026-08-01-old", { branch: "feat/x" });
    await seed("2026-08-08-new", { branch: "feat/x" });
    const r = await resolveActiveRun(repo, { branch: "feat/x" });
    expect(r?.run).toBe("2026-08-08-new");
  });

  it("uses the pointer file last", async () => {
    await seed("2026-08-08-a", { branch: "feat/other" });
    await fs.writeFile(pointerPath(repo), "2026-08-08-a\n", "utf8");
    const r = await resolveActiveRun(repo, { branch: "feat/nothing" });
    expect(r).toEqual({ run: "2026-08-08-a", via: "pointer" });
  });

  it("ignores a pointer that is not a valid run id", async () => {
    await seed("2026-08-08-a", { branch: "feat/other" });
    await fs.writeFile(pointerPath(repo), "../../etc/passwd\n", "utf8");
    expect(await resolveActiveRun(repo, { branch: "feat/nothing" })).toBeNull();
  });

  it("survives a malformed order.yaml instead of breaking the session", async () => {
    await seed("2026-08-08-good", { branch: "feat/x" });
    await fs.mkdir(path.join(repo, ".docket", "runs", "2026-08-08-bad"), { recursive: true });
    await fs.writeFile(
      path.join(repo, ".docket", "runs", "2026-08-08-bad", "order.yaml"),
      "this: [is: not: valid",
      "utf8"
    );
    const r = await resolveActiveRun(repo, { branch: "feat/x" });
    expect(r?.run).toBe("2026-08-08-good");
  });
});

describe("attachSession", () => {
  it("writes the session id without disturbing the rest of the order", async () => {
    await seed("2026-08-08-a", { branch: "feat/x" });
    await attachSession(repo, "2026-08-08-a", "sess-9");
    const order = await loadOrder(repo, "2026-08-08-a");
    expect(order.agent?.sessionId).toBe("sess-9");
    expect(order.git?.branch).toBe("feat/x");
    expect(order.phases).toEqual(["scope", "land"]);
  });
});

describe("heartbeat throttle", () => {
  it("is due when no marker exists yet", async () => {
    await seed("2026-08-08-a");
    expect(await heartbeatDue(repo, "2026-08-08-a", 30_000)).toBe(true);
  });

  it("is not due immediately after a touch", async () => {
    await seed("2026-08-08-a");
    await touchHeartbeat(repo, "2026-08-08-a");
    expect(await heartbeatDue(repo, "2026-08-08-a", 30_000)).toBe(false);
  });

  it("is due again once the window has passed", async () => {
    await seed("2026-08-08-a");
    await touchHeartbeat(repo, "2026-08-08-a");
    expect(await heartbeatDue(repo, "2026-08-08-a", 30_000, Date.now() + 31_000)).toBe(true);
  });

  it("clearing makes the next call due — a run that went idle must emit on resume", async () => {
    await seed("2026-08-08-a");
    await touchHeartbeat(repo, "2026-08-08-a");
    await clearHeartbeat(repo, "2026-08-08-a");
    expect(await heartbeatDue(repo, "2026-08-08-a", 30_000)).toBe(true);
  });

  it("clearing a run that never had a marker is not an error", async () => {
    await seed("2026-08-08-a");
    await expect(clearHeartbeat(repo, "2026-08-08-a")).resolves.toBeUndefined();
  });
});
