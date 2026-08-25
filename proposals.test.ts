/**
 * Proposals end to end, and the refusal that makes them worth having.
 *
 * `docket-events.test.ts` proves `appendEvent` refuses a non-human accept.
 * This proves the refusal survives being wrapped: `acceptProposal` must not
 * write the edit and then discover it was not allowed to.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readEvents } from "./docket-events";
import { writeOrder } from "./docket-order";
import { reduceRun } from "./docket-state";
import type { Actor } from "./docket-types";
import type { Gap } from "./gaps";
import { clearLayoutCache } from "./layout";
import {
  acceptProposal,
  listProposals,
  proposalId,
  raiseProposals,
  rejectProposal,
} from "./proposals";

const AGENT: Actor = { kind: "agent", harness: "claude-code", session: "s1" };
const HUMAN: Actor = { kind: "human", identity: "alex" };
const RUN = "2026-08-08-fixture";

let repo: string;

beforeEach(async () => {
  repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mechanics-proposals-")));
  await fs.writeFile(
    path.join(repo, "mechanics.config.yaml"),
    "apps:\n  - slug: demo\n    dir: .\n    adapters: []\n",
    "utf8"
  );
  await writeOrder(repo, {
    run: RUN,
    title: "Fixture",
    exitCriteria: ["a:AC1"],
    phases: ["scope"],
  });
});

afterEach(async () => {
  clearLayoutCache();
  await fs.rm(repo, { recursive: true, force: true });
});

function gap(over: Partial<Gap> = {}): Gap {
  return {
    key: "unclaimed-surface:demo:route:/login",
    gap: "unclaimed-surface",
    lane: "propose",
    app: "demo",
    subject: "/login",
    title: 'unclaimed route "/login"',
    detail: "A surface nothing documents.",
    suggestion: "Claim it from the area that owns it.",
    severity: "p1",
    ...over,
  };
}

async function status(id: string): Promise<string | undefined> {
  const { events } = await readEvents(repo, RUN);
  const state = reduceRun(
    { run: RUN, title: "Fixture", exitCriteria: ["a:AC1"], phases: ["scope"] },
    events
  );
  return state.proposals.find((p) => p.proposal === id)?.status;
}

describe("raiseProposals", () => {
  it("writes a committed record and one event per gap", async () => {
    const { raised } = await raiseProposals(repo, RUN, [gap()], AGENT);
    expect(raised).toHaveLength(1);

    const [record] = await listProposals(repo, RUN);
    expect(record?.subject).toBe("/login");
    expect(record?.raisedBy).toBe("agent");
    // No status on disk: it lives in the log, and a second copy is a second
    // source of truth that goes stale.
    expect(record).not.toHaveProperty("status");
    expect(await status(proposalId(gap()))).toBe("open");
  });

  it("is idempotent — a re-scan must not queue the same suggestion twice", async () => {
    await raiseProposals(repo, RUN, [gap()], AGENT);
    const second = await raiseProposals(repo, RUN, [gap()], AGENT);
    expect(second.raised).toEqual([]);
    expect(second.skipped).toEqual([proposalId(gap())]);
    expect(await listProposals(repo, RUN)).toHaveLength(1);
  });

  it("refuses to invent a run — opening a work order is a decision", async () => {
    await expect(raiseProposals(repo, "2026-01-01-nope", [gap()], AGENT)).rejects.toThrow(
      /no run .* run new/s
    );
  });
});

describe("proposalId", () => {
  it("stays unique when normalising throws the subject away", () => {
    // "/" reduces to nothing and "/a/b" and "/a-b" reduce to the same token.
    // A collision would silently merge two proposals, so a reviewer would see
    // one suggestion and never learn about the other.
    const ids = ["/", "", "/a/b", "/a-b", "x".repeat(200), `${"y".repeat(200)}z`].map((subject) =>
      proposalId(
        gap({ subject: subject || "none", key: `unclaimed-surface:demo:route:${subject}` })
      )
    );
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  it("is stable across calls, which is what keeps raising idempotent", () => {
    expect(proposalId(gap())).toBe(proposalId(gap()));
  });
});

describe("acceptProposal", () => {
  it("refuses a non-human actor", async () => {
    await raiseProposals(repo, RUN, [gap()], AGENT);
    await expect(acceptProposal(repo, RUN, proposalId(gap()), AGENT)).rejects.toThrow(
      /only a human may accept/
    );
  });

  it("writes nothing when the actor is refused", async () => {
    // The event is appended BEFORE the edit on purpose. If that order were
    // reversed the refusal would be decorative: the file would already have
    // changed by the time anyone objected.
    const withOp = gap({
      lane: "auto",
      op: {
        kind: "add-paths",
        file: "mechanics/area/thing.md",
        mechanic: "demo.area.thing",
        paths: ["src/a.ts"],
      },
    });
    await raiseProposals(repo, RUN, [withOp], AGENT);
    const target = path.join(repo, "mechanics", "area", "thing.md");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "---\ntitle: T\n---\n", "utf8");

    await expect(
      acceptProposal(repo, RUN, proposalId(withOp), AGENT, { apply: true })
    ).rejects.toThrow(/only a human may accept/);
    expect(await fs.readFile(target, "utf8")).toBe("---\ntitle: T\n---\n");
  });

  it("records a human acceptance, and applies nothing without --apply", async () => {
    await raiseProposals(repo, RUN, [gap()], AGENT);
    const res = await acceptProposal(repo, RUN, proposalId(gap()), HUMAN);
    expect(res.written).toEqual([]);
    expect(await status(proposalId(gap()))).toBe("accepted");
  });
});

describe("rejectProposal", () => {
  it("lets any actor decline — declining a suggestion grades nothing", async () => {
    await raiseProposals(repo, RUN, [gap()], AGENT);
    await rejectProposal(repo, RUN, proposalId(gap()), "not a real surface", AGENT);
    expect(await status(proposalId(gap()))).toBe("rejected");
  });

  it("requires a reason — silence is not an answer", async () => {
    await raiseProposals(repo, RUN, [gap()], AGENT);
    await expect(rejectProposal(repo, RUN, proposalId(gap()), "  ", HUMAN)).rejects.toThrow(
      /requires a reason/
    );
  });

  it("takes the latest resolution, because the log is append-only", async () => {
    await raiseProposals(repo, RUN, [gap()], AGENT);
    await acceptProposal(repo, RUN, proposalId(gap()), HUMAN);
    await rejectProposal(repo, RUN, proposalId(gap()), "landed another way", HUMAN);
    expect(await status(proposalId(gap()))).toBe("rejected");
  });
});
