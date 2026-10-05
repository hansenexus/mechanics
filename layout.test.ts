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
import { buildInventory } from "./adapters";
import { findRepoRoot } from "./fsutil";
import {
  appAdapters,
  appDir,
  appLayout,
  appPath,
  clearLayoutCache,
  manifestsDir,
  soleDeclaredApp,
} from "./layout";

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

  it("applies the repo-level adapters and surfaces to a discovered app", async () => {
    // The whole point of declaring `adapters:`/`surfaces:` alongside `appsDir`
    // is that discovered apps inherit them. They used to be parsed, validated
    // and then dropped on the floor: `appLayout` fell back to the built-in
    // defaults, so a monorepo could not declare a glob surface at all and the
    // `adapters:` block `init --app=<slug>` generates did nothing.
    const root = await tmp();
    await write(
      root,
      "mechanics.config.yaml",
      `appsDir: apps
manifestsDir: packages/mechanics/manifests
adapters: ["convex"]
surfaces:
  - kind: worker
    label: background worker
    globs: ["src/workers/*.ts"]
`
    );
    expect(appAdapters("console", root).map((a) => a.name)).toEqual(["convex", "generic-glob"]);
    const kinds = appAdapters("console", root).flatMap((a) => a.kinds.map((k) => k.kind));
    expect(kinds).toContain("worker");
    // The default that was being forced on every discovered app is gone.
    expect(kinds).not.toContain("route");
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

describe("layout: adapterOptions", () => {
  /** Inventory one app's adapters against an in-memory file list. */
  async function inventory(root: string, slug: string, files: string[]) {
    return buildInventory(appAdapters(slug, root), {
      appSlug: slug,
      appDir: appDir(slug, root),
      repoRoot: root,
      files,
    });
  }

  it("applies repo-level options to an explicit app", async () => {
    const root = await tmp();
    await write(
      root,
      "mechanics.config.yaml",
      `apps:
  - slug: solo
    dir: .
manifestsDir: out
adapterOptions:
  convex:
    wrappers: [spaceQuery]
  nextjs-app-router:
    appDir: apps/web/src/app
`
    );
    await write(root, "convex/x/y.ts", "export const get = spaceQuery({});\n");
    const inv = await inventory(root, "solo", ["convex/x/y.ts", "apps/web/src/app/a/page.tsx"]);
    expect(inv.items["convex-function"]).toEqual(["x/y.get"]);
    expect(inv.items.route).toEqual(["/a"]);
  });

  it("applies repo-level options to discovered apps", async () => {
    const root = await tmp();
    await write(
      root,
      "mechanics.config.yaml",
      `${MONOREPO}adapterOptions:\n  nextjs-app-router:\n    appDir: app\n`
    );
    const inv = await inventory(root, "console", ["app/orders/page.tsx", "src/app/x/page.tsx"]);
    expect(inv.items.route).toEqual(["/orders"]);
  });

  it("lets an app replace one adapter's block whole and inherit the others", async () => {
    // Same precedence as `adapters:`/`surfaces:` — the app's value wins — at
    // the granularity of one adapter's block. Field-by-field merging would
    // make `wrappers: []` unable to mean "none".
    const root = await tmp();
    await write(
      root,
      "mechanics.config.yaml",
      `apps:
  - slug: a
    dir: a
    adapterOptions:
      convex:
        dir: backend
  - slug: b
    dir: b
manifestsDir: out
adapterOptions:
  convex:
    wrappers: [spaceQuery]
  nextjs-app-router:
    appDir: web
`
    );
    await write(
      root,
      "a/backend/m.ts",
      "export const q = spaceQuery({});\nexport const p = query({});\n"
    );
    await write(root, "b/convex/m.ts", "export const q = spaceQuery({});\n");
    const a = await inventory(root, "a", ["backend/m.ts", "web/r/page.tsx"]);
    expect(a.items["convex-function"]).toEqual(["m.p"]);
    expect(a.items.route).toEqual(["/r"]);
    const b = await inventory(root, "b", ["convex/m.ts"]);
    expect(b.items["convex-function"]).toEqual(["m.q"]);
  });

  it("rejects an unknown adapter key and an unknown option, strictly", async () => {
    const root = await tmp();
    await write(root, "mechanics.config.yaml", `${MONOREPO}adapterOptions:\n  rails: {}\n`);
    expect(() => appLayout("x", root)).toThrow(/adapterOptions: Unrecognized key.*rails/);

    clearLayoutCache();
    await write(
      root,
      "mechanics.config.yaml",
      `${MONOREPO}adapterOptions:\n  convex:\n    dirr: backend\n`
    );
    expect(() => appLayout("x", root)).toThrow(/adapterOptions\.convex: Unrecognized key.*dirr/);
  });

  it("refuses a wrapper that is not an identifier, and a dir outside the app", async () => {
    const root = await tmp();
    await write(
      root,
      "mechanics.config.yaml",
      `${MONOREPO}adapterOptions:\n  convex:\n    wrappers: ["query|.*"]\n`
    );
    expect(() => appLayout("x", root)).toThrow(/wrappers\.0: must be a JavaScript identifier/);

    for (const bad of ["../convex", "/abs/convex"]) {
      clearLayoutCache();
      await write(
        root,
        "mechanics.config.yaml",
        `${MONOREPO}adapterOptions:\n  convex:\n    dir: "${bad}"\n`
      );
      expect(() => appLayout("x", root)).toThrow(/adapterOptions\.convex\.dir: must/);
    }
  });

  it("refuses an app's own options for an adapter it does not run", async () => {
    const root = await tmp();
    await write(
      root,
      "mechanics.config.yaml",
      `apps:
  - slug: a
    dir: .
    adapters: [nextjs-app-router]
    adapterOptions:
      convex:
        wrappers: [spaceQuery]
manifestsDir: out
`
    );
    expect(() => appLayout("a", root)).toThrow(
      /app "a" sets adapterOptions\.convex but does not run the "convex" adapter/
    );
  });

  it("allows a repo-level default some app ignores, but not one that no app reads", async () => {
    const root = await tmp();
    const config = (bAdapters: string) => `apps:
  - slug: a
    dir: a
    adapters: [nextjs-app-router]
  - slug: b
    dir: b
    adapters: ${bAdapters}
manifestsDir: out
adapterOptions:
  convex:
    wrappers: [spaceQuery]
`;
    await write(root, "mechanics.config.yaml", config("[convex]"));
    expect(appAdapters("a", root).map((x) => x.name)).toEqual(["nextjs-app-router"]);

    clearLayoutCache();
    await write(root, "mechanics.config.yaml", config("[nextjs-app-router]"));
    expect(() => appLayout("a", root)).toThrow(/adapterOptions\.convex applies to no app/);
  });

  it("refuses repo-level options for an adapter discovered apps do not run", async () => {
    const root = await tmp();
    await write(
      root,
      "mechanics.config.yaml",
      `${MONOREPO}adapters: [nextjs-app-router]\nadapterOptions:\n  convex:\n    dir: backend\n`
    );
    expect(() => appLayout("x", root)).toThrow(
      /adapterOptions\.convex is set but "convex" is not in adapters/
    );
  });
});

describe("soleDeclaredApp", () => {
  it("names the app when exactly one is declared under apps:", async () => {
    const root = await tmp();
    await write(root, "mechanics.config.yaml", SOLO);
    expect(soleDeclaredApp(root)).toBe("example");
  });

  it("is null with several declared apps, in discovery mode, and with no config", async () => {
    const many = await tmp();
    await write(
      many,
      "mechanics.config.yaml",
      "apps:\n  - slug: a\n    dir: a\n  - slug: b\n    dir: b\n"
    );
    expect(soleDeclaredApp(many)).toBeNull();

    const discovered = await tmp();
    await write(discovered, "mechanics.config.yaml", MONOREPO);
    await fs.mkdir(path.join(discovered, "apps", "only", "mechanics"), { recursive: true });
    expect(soleDeclaredApp(discovered)).toBeNull();

    expect(soleDeclaredApp(await tmp())).toBeNull();
  });
});
