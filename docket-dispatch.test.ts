import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentPrompt,
  type DispatchDeps,
  deriveBranch,
  executeDispatch,
  findPrimaryRoot,
  pickPushRemote,
  planDispatch,
} from "./docket-dispatch";
import { readEvents } from "./docket-events";
import { forgeKindFor, parseRemote, renderPrBody } from "./docket-forge";
import { loadOrder } from "./docket-order";

const PRIMARY = path.join(path.sep, "repos", "app");

const BASE = {
  title: "Smart-Locker Ausleihe",
  today: "2026-08-08",
  base: "origin/master",
  criteria: ["a:AC1", "a:AC2"],
  withPush: false,
  withPr: false,
  withAgent: false,
  primaryRoot: PRIMARY,
};

describe("parseRemote", () => {
  it("handles the scp-like form git actually writes", () => {
    expect(parseRemote("git@forge.example.com:acme/widgets.git")).toEqual({
      host: "forge.example.com",
      owner: "acme",
      repo: "widgets",
    });
  });

  it("handles ssh:// with a port", () => {
    expect(parseRemote("ssh://git@example.com:2222/acme/thing.git")).toEqual({
      host: "example.com",
      owner: "acme",
      repo: "thing",
    });
  });

  it("handles https with userinfo", () => {
    expect(parseRemote("https://user@github.com/acme/thing")).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "thing",
    });
  });

  it("returns null on something that is not a remote", () => {
    expect(parseRemote("not a url")).toBeNull();
  });

  it("treats anything but github.com as a self-hosted forge", () => {
    expect(forgeKindFor({ host: "github.com", owner: "a", repo: "b" })).toBe("github");
    expect(forgeKindFor({ host: "forge.example.com", owner: "a", repo: "b" })).toBe("forgejo");
  });
});

describe("renderPrBody", () => {
  it("renders exit criteria as an unchecked checklist", () => {
    const body = renderPrBody({ runId: "r1", title: "T", criteria: ["a:AC1", "a:AC2"] });
    expect(body).toContain("- [ ] a:AC1");
    expect(body).toContain("- [ ] a:AC2");
    expect(body).toContain("r1");
  });

  it("ticks the criteria already met", () => {
    const body = renderPrBody({
      runId: "r1",
      title: "T",
      criteria: ["a:AC1", "a:AC2"],
      met: new Set(["a:AC1"]),
    });
    expect(body).toContain("- [x] a:AC1");
    expect(body).toContain("- [ ] a:AC2");
  });

  it("says so plainly when there is no definition of done", () => {
    expect(renderPrBody({ runId: "r1", title: "T", criteria: [] })).toContain("None declared");
  });
});

describe("planDispatch", () => {
  it("derives a branch and a run id from the title", () => {
    const plan = planDispatch(BASE);
    expect(plan.branch).toBe("feat/smart-locker-ausleihe");
    expect(plan.runId).toBe("2026-08-08-smart-locker-ausleihe");
    expect(plan.worktree).toBe(path.join(".claude", "worktrees", "feat/smart-locker-ausleihe"));
    // The absolute path is resolved against the PRIMARY, never against the
    // checkout doing the dispatching.
    expect(plan.worktreePath).toBe(path.join(PRIMARY, plan.worktree));
  });

  it("plans only local steps by default — nothing leaves the machine", () => {
    const plan = planDispatch(BASE);
    expect(plan.steps.map((s) => s.id)).toEqual(["worktree", "order"]);
    expect(plan.steps.some((s) => s.gated)).toBe(false);
  });

  it("implies a push when a PR is requested", () => {
    const plan = planDispatch({ ...BASE, withPr: true });
    expect(plan.steps.map((s) => s.id)).toEqual(["worktree", "order", "push", "pr"]);
  });

  it("marks every outward step as gated", () => {
    const plan = planDispatch({ ...BASE, withPr: true, withAgent: true });
    const gated = plan.steps.filter((s) => s.gated).map((s) => s.id);
    expect(gated).toEqual(["push", "pr", "agent"]);
  });

  it("keeps a caller-supplied branch", () => {
    expect(planDispatch({ ...BASE, branch: "fix/thing" }).branch).toBe("fix/thing");
  });

  it("plans the push against the requested remote, not a hardcoded origin", () => {
    const plan = planDispatch({ ...BASE, remote: "forge", base: "forge/master", withPr: true });
    expect(plan.remote).toBe("forge");
    const push = plan.steps.find((s) => s.id === "push");
    expect(push?.label).toBe(`git push -u forge ${plan.branch}`);
  });
});

describe("pickPushRemote", () => {
  it("publishes to origin even when a forge remote exists", async () => {
    // The forge remote is still present on every checkout (forge is a live bot
    // API), so the old "prefer forge" sniff would now match everywhere and
    // publish dispatch branches to the plane nobody reviews.
    const remote = await pickPushRemote(async () => {
      throw new Error("git should not be consulted at all");
    }, "/repos/app");
    expect(remote).toBe("origin");
  });

  it("does not shell out", async () => {
    let called = false;
    await pickPushRemote(async () => {
      called = true;
      return "";
    }, "/repos/app");
    expect(called).toBe(false);
  });
});

describe("deriveBranch", () => {
  it("slugifies and truncates without a trailing dash", () => {
    expect(deriveBranch("Smart-Locker: Ausleihe & Rueckgabe!")).toBe(
      "feat/smart-locker-ausleihe-rueckgabe"
    );
    expect(deriveBranch("!!!")).toBe("feat/work");
  });

  it("folds umlauts instead of turning each one into a word break", () => {
    // "Rückgabe" must not become "r-ckgabe" — that mangles every German title.
    expect(deriveBranch("Locker Rückgabe")).toBe("feat/locker-ruckgabe");
    expect(deriveBranch("Größe prüfen")).toBe("feat/grosse-prufen");
    expect(deriveBranch("Café Ñandú")).toBe("feat/cafe-nandu");
  });
});

describe("agentPrompt", () => {
  it("names the criteria and the reporting commands", () => {
    const prompt = agentPrompt(planDispatch(BASE));
    expect(prompt).toContain("a:AC1");
    expect(prompt).toContain("criterion.evaluated");
    expect(prompt).toContain("gate.blocked");
    expect(prompt).toContain("pass verdict requires evidence");
  });

  it("flags a missing definition of done instead of pretending", () => {
    expect(agentPrompt(planDispatch({ ...BASE, criteria: [] }))).toContain("none declared");
  });
});

describe("findPrimaryRoot", () => {
  it("takes the parent of the shared .git, which a worktree also points at", async () => {
    const seen: Array<{ args: string[]; cwd?: string }> = [];
    const root = await findPrimaryRoot(async (_cmd, args, opts) => {
      seen.push({ args, cwd: opts?.cwd });
      return "/repos/app/.git\n";
    }, "/repos/app/.claude/worktrees/feat/x");
    expect(root).toBe("/repos/app");
    expect(seen[0]?.args).toContain("--git-common-dir");
    // Asked from where we stand — git resolves the common dir, we do not.
    expect(seen[0]?.cwd).toBe("/repos/app/.claude/worktrees/feat/x");
  });

  it("keeps the caller's root when the common dir is not a .git", async () => {
    // A bare repo: the parent of the common dir need not be a working tree at
    // all, so guessing would be worse than staying put.
    const root = await findPrimaryRoot(async () => "/srv/app.git\n", "/repos/app");
    expect(root).toBe("/repos/app");
  });

  it("keeps the caller's root when git fails outright", async () => {
    const root = await findPrimaryRoot(async () => {
      throw new Error("not a git repository");
    }, "/repos/app");
    expect(root).toBe("/repos/app");
  });
});

describe("executeDispatch", () => {
  let repo: string;
  let calls: string[][];

  const deps = (over: Partial<DispatchDeps> = {}): DispatchDeps => ({
    repoRoot: repo,
    run: async (cmd, args) => {
      calls.push([cmd, ...args]);
      return "";
    },
    ...over,
  });

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "docket-dispatch-"));
    calls = [];
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("creates the worktree and the order, and pushes nothing", async () => {
    const plan = planDispatch({ ...BASE, primaryRoot: repo });
    const result = await executeDispatch(plan, deps());

    expect(result.done).toEqual(["worktree", "order"]);
    expect(calls).toEqual([
      [
        "git",
        "worktree",
        "add",
        "-b",
        plan.branch,
        path.join(repo, plan.worktree),
        "origin/master",
      ],
    ]);
    expect(calls.some((c) => c.includes("push"))).toBe(false);

    const order = await loadOrder(repo, plan.runId);
    expect(order.git?.branch).toBe(plan.branch);
    expect(order.exitCriteria).toEqual(["a:AC1", "a:AC2"]);
  });

  it("puts the worktree in the PRIMARY checkout, not the one dispatching", async () => {
    // The bug this closes: dispatching from a worktree nested the new one
    // inside it. The run directory still belongs to the dispatching checkout —
    // the two roots are different answers to different questions.
    const primary = await fs.mkdtemp(path.join(os.tmpdir(), "docket-primary-"));
    try {
      const plan = planDispatch({ ...BASE, primaryRoot: primary });
      const result = await executeDispatch(plan, deps());

      expect(result.worktreePath).toBe(path.join(primary, plan.worktree));
      expect(result.worktreePath.startsWith(repo)).toBe(false);
      expect(calls[0]).toEqual([
        "git",
        "worktree",
        "add",
        "-b",
        plan.branch,
        path.join(primary, plan.worktree),
        "origin/master",
      ]);
      // …and the order file is still written into the dispatching checkout.
      await expect(loadOrder(repo, plan.runId)).resolves.toBeTruthy();
    } finally {
      await fs.rm(primary, { recursive: true, force: true });
    }
  });

  it("records run.created and git.linked so the board sees it immediately", async () => {
    const plan = planDispatch(BASE);
    await executeDispatch(plan, deps());
    const { events } = await readEvents(repo, plan.runId);
    expect(events.map((e) => e.type)).toEqual(["run.created", "git.linked"]);
    expect(events[1]?.payload.branch).toBe(plan.branch);
  });

  it("opens a draft PR and links it when asked", async () => {
    const plan = planDispatch({ ...BASE, withPr: true });
    let received: { title: string; body: string; base: string } | undefined;
    const result = await executeDispatch(
      plan,
      deps({
        forge: {
          kind: "forgejo",
          remote: { host: "h", owner: "o", repo: "r" },
          openDraftPr: async (input) => {
            received = input;
            return { number: 99, url: "https://h/o/r/pulls/99" };
          },
        },
      })
    );

    expect(result.pr).toEqual({ number: 99, url: "https://h/o/r/pulls/99" });
    expect(calls.some((c) => c.join(" ").includes("push -u origin"))).toBe(true);
    // `origin/master` is a local tracking ref; the PR base is the branch name.
    expect(received?.base).toBe("master");
    expect(received?.body).toContain("- [ ] a:AC1");

    const { events } = await readEvents(repo, plan.runId);
    expect(events.at(-1)?.payload.pr).toBe(99);
  });

  it("pushes to the plan's remote and strips that prefix off the PR base", async () => {
    // The forge-primary case: origin is the GitHub CI mirror, forge is the
    // Forgejo primary. Nothing may touch origin.
    const plan = planDispatch({ ...BASE, remote: "forge", base: "forge/master", withPr: true });
    let received: { base: string } | undefined;
    await executeDispatch(
      plan,
      deps({
        forge: {
          kind: "forgejo",
          remote: { host: "h", owner: "o", repo: "r" },
          openDraftPr: async (input) => {
            received = input;
            return { number: 7, url: "https://h/o/r/pulls/7" };
          },
        },
      })
    );
    expect(calls.some((c) => c.join(" ").includes("push -u forge"))).toBe(true);
    expect(calls.some((c) => c.join(" ").includes("push -u origin"))).toBe(false);
    expect(received?.base).toBe("master");
  });

  it("refuses to open a PR with no forge adapter rather than half-dispatching", async () => {
    const plan = planDispatch({ ...BASE, withPr: true });
    await expect(executeDispatch(plan, deps())).rejects.toThrow(/no forge adapter/);
  });

  it("only starts an agent when one was asked for", async () => {
    let launched = 0;
    const plan = planDispatch(BASE);
    await executeDispatch(plan, deps({ launchAgent: async () => void launched++ }));
    expect(launched).toBe(0);

    const withAgent = planDispatch({ ...BASE, withAgent: true, runId: "2026-08-08-other" });
    await executeDispatch(withAgent, deps({ launchAgent: async () => void launched++ }));
    expect(launched).toBe(1);
    const { events } = await readEvents(repo, "2026-08-08-other");
    expect(events.map((e) => e.type)).toContain("run.started");
  });
});
