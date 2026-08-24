/**
 * Repo-root resolution and `mechanics.config.yaml` interpretation.
 *
 * These are the seams that decide *which repo* every other module answers
 * about, so they are worth pinning: a wrong root is not an error, it is a
 * confidently wrong answer about someone else's tree.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findRepoRoot } from "./fsutil";
import { appAdapters, appDir, appLayout, appPath, clearLayoutCache, manifestsDir } from "./layout";

const made: string[] = [];

afterEach(async () => {
  clearLayoutCache();
  await Promise.all(made.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mechanics-layout-")));
  made.push(dir);
  return dir;
}

async function write(root: string, rel: string, body: string): Promise<void> {
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, "utf8");
}

const MONOREPO = "appsDir: apps\nmanifestsDir: packages/mechanics/manifests\n";
const SOLO = `apps:
  - slug: example
    dir: .
    adapters: []
    surfaces:
      - kind: cli-command
        label: CLI command
        globs: ["src/commands/*.ts"]
manifestsDir: .mechanics/manifests
`;

describe("findRepoRoot", () => {
  it("finds the nearest ancestor holding the config", async () => {
    const root = await tmp();
    await write(root, "mechanics.config.yaml", MONOREPO);
    await fs.mkdir(path.join(root, "apps", "console", "src"), { recursive: true });
    expect(findRepoRoot(path.join(root, "apps", "console", "src"))).toBe(root);
    expect(findRepoRoot(root)).toBe(root);
  });

  it("returns null rather than escaping the repo when nothing declares a root", async () => {
    const root = await tmp();
    expect(findRepoRoot(root)).toBeNull();
  });

  it("stops at a working-tree root, so a worktree cannot resolve to its parent checkout", async () => {
    // The exact shape this repo uses: worktrees live INSIDE the primary
    // checkout at .claude/worktrees/<branch>. A worktree on a branch that
    // predates the config must not inherit the primary's.
    const primary = await tmp();
    await write(primary, "mechanics.config.yaml", MONOREPO);
    await fs.mkdir(path.join(primary, ".git"), { recursive: true });

    const worktree = path.join(primary, ".claude", "worktrees", "feat", "old");
    await fs.mkdir(worktree, { recursive: true });
    // A linked worktree's `.git` is a FILE, not a directory — both must fence.
    await fs.writeFile(path.join(worktree, ".git"), "gitdir: /elsewhere\n", "utf8");

    expect(findRepoRoot(worktree)).toBeNull();
  });

  it("still resolves a worktree that carries its own config", async () => {
    const primary = await tmp();
    await write(primary, "mechanics.config.yaml", MONOREPO);
    await fs.mkdir(path.join(primary, ".git"), { recursive: true });

    const worktree = path.join(primary, ".claude", "worktrees", "feat", "new");
    await fs.mkdir(worktree, { recursive: true });
    await fs.writeFile(path.join(worktree, ".git"), "gitdir: /elsewhere\n", "utf8");
    await write(worktree, "mechanics.config.yaml", MONOREPO);

    expect(findRepoRoot(worktree)).toBe(worktree);
  });
});

describe("layout: apps under appsDir", () => {
  it("derives app dirs and keeps the apps/<slug>/ prefix on every path", async () => {
    const root = await tmp();
    await write(root, "mechanics.config.yaml", MONOREPO);

    expect(appLayout("console", root).dir).toBe("apps/console");
    expect(appDir("console", root)).toBe(path.join(root, "apps", "console"));
    expect(appPath("console", root, "mechanics", "observe", "logs-tab.md")).toBe(
      "apps/console/mechanics/observe/logs-tab.md"
    );
    expect(manifestsDir(root)).toBe("packages/mechanics/manifests");
  });

  it("gives every app the default adapters", async () => {
    const root = await tmp();
    await write(root, "mechanics.config.yaml", MONOREPO);
    expect(appAdapters("console", root).map((a) => a.name)).toEqual([
      "nextjs-app-router",
      "convex",
    ]);
  });

  it("falls back to the monorepo shape when no config exists", async () => {
    const root = await tmp();
    expect(appPath("console", root, "mechanics")).toBe("apps/console/mechanics");
    expect(manifestsDir(root)).toBe("packages/mechanics/manifests");
  });
});

describe("layout: a single-app repo", () => {
  it("drops the app segment from every derived path", async () => {
    const root = await tmp();
    await write(root, "mechanics.config.yaml", SOLO);

    expect(appLayout("example", root).dir).toBe("");
    expect(appDir("example", root)).toBe(root);
    // No leading slash, no `./` — the app root IS the repo root.
    expect(appPath("example", root, "mechanics", "backups", "x.md")).toBe("mechanics/backups/x.md");
    expect(appPath("example", root)).toBe("");
  });

  it("serves declared surfaces through generic-glob and nothing else", async () => {
    const root = await tmp();
    await write(root, "mechanics.config.yaml", SOLO);
    const adapters = appAdapters("example", root);
    expect(adapters.map((a) => a.name)).toEqual(["generic-glob"]);
    expect(adapters[0]?.kinds.map((k) => k.kind)).toEqual(["cli-command"]);
  });

  it("names the declared apps when asked for one that is not there", async () => {
    const root = await tmp();
    await write(root, "mechanics.config.yaml", SOLO);
    expect(() => appLayout("nope", root)).toThrow(/declared apps are: example/);
  });
});

describe("layout: config errors name the fix", () => {
  it("rejects declaring both appsDir and apps", async () => {
    const root = await tmp();
    await write(root, "mechanics.config.yaml", `appsDir: apps\n${SOLO}`);
    expect(() => appLayout("example", root)).toThrow(/exactly one of appsDir/);
  });

  it("rejects declaring neither", async () => {
    const root = await tmp();
    await write(root, "mechanics.config.yaml", "manifestsDir: out\n");
    expect(() => appLayout("x", root)).toThrow(/exactly one of appsDir/);
  });

  it("rejects duplicate app slugs", async () => {
    const root = await tmp();
    await write(
      root,
      "mechanics.config.yaml",
      "apps:\n  - slug: a\n    dir: x\n  - slug: a\n    dir: y\n"
    );
    expect(() => appLayout("a", root)).toThrow(/app slugs must be unique/);
  });

  it("names the built-ins when an adapter does not exist", async () => {
    const root = await tmp();
    await write(
      root,
      "mechanics.config.yaml",
      "apps:\n  - slug: a\n    dir: .\n    adapters: [rails]\n"
    );
    expect(() => appLayout("a", root)).toThrow(/built-ins are: convex, nextjs-app-router/);
  });
});
