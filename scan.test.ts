/**
 * Repo discovery, and the dedupe that makes the count mean anything.
 *
 * Fixtures are built at test time rather than committed: git will not track a
 * nested `.git` directory, and a committed `.git` FILE would confuse every
 * tool that walks this repo. So the trees below are constructed by hand —
 * which is fine, because the only thing that distinguishes a worktree from a
 * primary checkout on disk is whether `.git` is a file holding a `gitdir:`
 * line, and that is exactly what is under test.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { adopt, classifyGitDir, findCheckouts, resolveRoots, scan } from "./scan";

const made: string[] = [];

afterEach(async () => {
  await Promise.all(made.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mechanics-scan-")));
  made.push(dir);
  return dir;
}

async function primary(root: string, name: string, files: Record<string, string> = {}) {
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, ".git"), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const f = path.join(dir, rel);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, body, "utf8");
  }
  return dir;
}

async function worktree(root: string, name: string, primaryDir: string) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, ".git"),
    `gitdir: ${path.join(primaryDir, ".git", "worktrees", name)}\n`,
    "utf8"
  );
  return dir;
}

describe("classifyGitDir", () => {
  it("reads a linked worktree back to its primary checkout", async () => {
    const root = await tmp();
    const main = await primary(root, "proj");
    const wt = await worktree(root, "proj-feat-x", main);
    expect(classifyGitDir(wt)).toEqual({ kind: "worktree", primary: main });
    expect(classifyGitDir(main)).toEqual({ kind: "primary" });
  });

  it("declines to guess for a layout it does not recognise", async () => {
    // `--separate-git-dir` and submodules both produce a `.git` file whose
    // target is not `<primary>/.git/worktrees/<name>`. Inventing a primary
    // would invent a grouping, so these are reported separately instead.
    const root = await tmp();
    const dir = path.join(root, "odd");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, ".git"), "gitdir: /somewhere/else/.git\n", "utf8");
    expect(classifyGitDir(dir)).toEqual({ kind: "worktree-unknown" });
  });

  it("returns null where there is no checkout at all", async () => {
    expect(classifyGitDir(await tmp())).toBeNull();
  });
});

describe("findCheckouts", () => {
  it("stops at a checkout instead of descending into it", async () => {
    // A repo inside a repo is a submodule or a worktree, not a separate thing
    // to onboard — and descending would walk every vendored tree on disk.
    const root = await tmp();
    const main = await primary(root, "proj");
    await fs.mkdir(path.join(main, "vendor", "inner", ".git"), { recursive: true });
    const { dirs } = await findCheckouts([root], 3);
    expect(dirs).toEqual([main]);
  });

  it("honours the depth limit", async () => {
    const root = await tmp();
    await primary(root, path.join("a", "b", "deep"));
    expect((await findCheckouts([root], 1)).dirs).toEqual([]);
    expect((await findCheckouts([root], 3)).dirs).toHaveLength(1);
  });
});

describe("scan", () => {
  it("collapses worktrees into their primary — the whole point of the command", async () => {
    // The shape this was written for: one project accounting for eleven
    // directories. Counting them separately reports an estate that does not
    // exist, and reports the same repo as eleven onboarding candidates.
    const root = await tmp();
    const mono = await primary(root, "mono", { "mechanics.config.yaml": "apps: []\n" });
    for (let i = 0; i < 10; i++) await worktree(root, `mono-feat-${i}`, mono);
    await primary(root, "solo");

    const result = await scan({ roots: [root] });
    expect(result.repos.map((r) => r.name)).toEqual(["mono", "solo"]);
    expect(result.repos.find((r) => r.name === "mono")?.worktrees).toHaveLength(10);
    expect(result.repos.find((r) => r.name === "mono")?.onboarded).toBe(true);
    expect(result.repos.find((r) => r.name === "solo")?.onboarded).toBe(false);
  });

  it("keeps a worktree whose primary is outside the scanned roots", async () => {
    const outside = await tmp();
    const main = await primary(outside, "elsewhere");
    const root = await tmp();
    await worktree(root, "elsewhere-feat-x", main);

    const result = await scan({ roots: [root] });
    const entry = result.repos.find((r) => r.name === "elsewhere");
    expect(entry?.primaryPresent).toBe(false);
    expect(entry?.worktrees).toHaveLength(1);
  });

  it("treats apps/ with ONE app as a monorepo, and detects against the app", async () => {
    // This was wrong first time round: requiring two apps made a repo with one
    // `apps/<name>` beside fifteen `packages/*` fall through to `packages/`,
    // where detection ran against a library and reported a Next.js + Convex
    // app as having no recognisable surfaces at all.
    const root = await tmp();
    await primary(root, "one-app", {
      "apps/web/package.json": "{}",
      "apps/web/src/app/page.tsx": "export default () => null;",
      "apps/web/convex/things.ts": "export const list = query(() => {});",
      "packages/ui/package.json": "{}",
      "packages/utils/package.json": "{}",
    });
    const [entry] = (await scan({ roots: [root] })).repos;
    expect(entry?.apps).toEqual({ dir: "apps", slugs: ["web"] });
    expect(entry?.detection.adapters).toEqual(["convex", "nextjs-app-router"]);
    expect(entry?.status).toBe("ok");
  });

  it("unions adapters across every app, not just the first", async () => {
    const root = await tmp();
    await primary(root, "multi", {
      "apps/a/package.json": "{}",
      "apps/a/src/app/page.tsx": "x",
      "apps/b/package.json": "{}",
      "apps/b/convex/things.ts": "x",
    });
    const [entry] = (await scan({ roots: [root] })).repos;
    expect(entry?.detection.adapters).toEqual(["convex", "nextjs-app-router"]);
  });

  it("reports a repo no adapter matches as needing surfaces, not as blank", async () => {
    // Roughly half a real estate lands here — services, CLIs, anything not
    // Next.js or Convex. An empty cell reads as "nothing to do"; this is a
    // state with a next step, which is to declare surfaces by glob.
    const root = await tmp();
    await primary(root, "cli-tool", { "package.json": "{}", "src/main.py": "" });
    const [entry] = (await scan({ roots: [root] })).repos;
    expect(entry?.status).toBe("needs-surfaces");
    expect(entry?.detection.adapters).toEqual([]);
  });
});

describe("resolveRoots", () => {
  it("prefers explicit flags over the environment", () => {
    expect(resolveRoots(["/a"], "/cwd", { MECHANICS_SCAN_ROOTS: "/b" })).toEqual([
      path.resolve("/a"),
    ]);
  });

  it("falls back to the environment, splitting on the path delimiter", () => {
    const roots = resolveRoots([], "/cwd", {
      MECHANICS_SCAN_ROOTS: ["/a", "/b"].join(path.delimiter),
    });
    expect(roots).toEqual([path.resolve("/a"), path.resolve("/b")]);
  });

  it("never defaults to the home directory", async () => {
    // Nothing else in this tool reads homedir, and a command that enumerates
    // someone's whole disk on first run is a surprise. The default is the
    // parent of the current checkout and nothing wider.
    const root = await tmp();
    const main = await primary(root, "proj");
    expect(resolveRoots([], main, {})).toEqual([root]);
    expect(resolveRoots([], main, {})).not.toContain(os.homedir());
  });
});

describe("adopt", () => {
  it("refuses a linked worktree and names the primary to use instead", async () => {
    // `findRepoRoot` fences at any `.git`, so a config written into a worktree
    // cannot be inherited from the primary or vice versa. Scan is the only
    // place that knows the difference, which makes this its job to catch.
    const outside = await tmp();
    const main = await primary(outside, "elsewhere");
    const root = await tmp();
    await worktree(root, "elsewhere-feat-x", main);
    const result = await scan({ roots: [root] });

    await expect(adopt(result, { target: "elsewhere" })).rejects.toThrow(
      /only as a linked worktree/
    );
  });

  it("names the repos it did find when asked for one it did not", async () => {
    const root = await tmp();
    await primary(root, "alpha");
    const result = await scan({ roots: [root] });
    await expect(adopt(result, { target: "beta" })).rejects.toThrow(/found: alpha/);
  });

  it("writes nothing without --yes", async () => {
    const root = await tmp();
    const repo = await primary(root, "alpha", { "package.json": "{}" });
    const result = await scan({ roots: [root] });

    const before = (await fs.readdir(repo)).sort();
    const dry = await adopt(result, { target: "alpha" });
    expect(dry.log.join("\n")).toContain("would create mechanics.config.yaml");
    expect((await fs.readdir(repo)).sort()).toEqual(before);

    await adopt(result, { target: "alpha", yes: true });
    expect(await fs.readdir(repo)).toContain("mechanics.config.yaml");
  });
});
