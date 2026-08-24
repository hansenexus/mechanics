/**
 * `mechanics init` tests: single-app and monorepo scaffolding, adapter and
 * package-manager detection feeding the generated files, idempotency (the
 * property agents rely on), `.mcp.json` merging that never clobbers, opt-out
 * flags, dry-run writing nothing, and the missing-app failure mode.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { type InitOptions, init } from "./init";
import { clearLayoutCache, loadLayout } from "./layout";

const DEFAULTS: Omit<InitOptions, "dir"> = { ci: true, mcp: true, docket: true, dryRun: false };

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mechanics-init-"));
  await fs.mkdir(path.join(root, ".git"), { recursive: true });
  clearLayoutCache();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  clearLayoutCache();
});

async function exists(...segments: string[]): Promise<boolean> {
  try {
    await fs.access(path.join(root, ...segments));
    return true;
  } catch {
    return false;
  }
}

describe("init: single-app repo", () => {
  it("scaffolds config, corpus, CI, MCP, docket and the manifest", async () => {
    await fs.mkdir(path.join(root, "src", "app"), { recursive: true });
    await fs.writeFile(path.join(root, "bun.lock"), "{}");

    const res = await init({ ...DEFAULTS, dir: root });
    expect(res.failed).toBe(false);

    // The generated config is a valid layout the rest of the stack accepts.
    clearLayoutCache();
    const layout = loadLayout(root);
    expect(layout.apps?.get("app")?.dir).toBe("");
    expect(layout.manifestsDir).toBe(".mechanics/manifests");

    const config = YAML.parse(await fs.readFile(path.join(root, "mechanics.config.yaml"), "utf8"));
    expect(config.apps[0].adapters).toEqual(["nextjs-app-router"]);

    expect(await exists("mechanics", "_config.yaml")).toBe(true);
    expect(await exists("mechanics", "getting-started", "_area.yaml")).toBe(true);
    expect(await exists(".docket", "README.md")).toBe(true);

    const manifest = JSON.parse(
      await fs.readFile(path.join(root, ".mechanics", "manifests", "app.mechanics.json"), "utf8")
    );
    expect(manifest.mechanics).toHaveLength(1);
    expect(manifest.mechanics[0].id).toBe("app.getting-started.document-first-behaviour");

    // bun repo → bun setup + bunx in CI; nextjs detected → coupling gate.
    const wf = await fs.readFile(path.join(root, ".github/workflows/mechanics-check.yml"), "utf8");
    expect(wf).toContain("setup-bun");
    expect(wf).toContain("bunx mechanics check --all");
    expect(wf).toContain("coupling:");
    expect(wf).toContain("(src/)?app/");
  });

  it("is idempotent: a second run skips every file and changes nothing", async () => {
    await init({ ...DEFAULTS, dir: root });
    const manifestPath = path.join(root, ".mechanics", "manifests", "app.mechanics.json");
    const before = await fs.readFile(manifestPath, "utf8");

    const res = await init({ ...DEFAULTS, dir: root });
    expect(res.failed).toBe(false);
    const acted = res.log.filter((l) => /^\s+(created|merged)/.test(l));
    expect(acted).toEqual([]);
    expect(await fs.readFile(manifestPath, "utf8")).toBe(before);
  });

  it("falls back to npm + validate-only CI when nothing is detected", async () => {
    const res = await init({ ...DEFAULTS, dir: root });
    expect(res.failed).toBe(false);
    const wf = await fs.readFile(path.join(root, ".github/workflows/mechanics-check.yml"), "utf8");
    expect(wf).toContain("npm ci");
    expect(wf).toContain("npx mechanics check --all");
    expect(wf).not.toContain("coupling:");
  });

  it("honors the opt-out flags", async () => {
    const res = await init({ ...DEFAULTS, ci: false, mcp: false, docket: false, dir: root });
    expect(res.failed).toBe(false);
    expect(await exists(".github")).toBe(false);
    expect(await exists(".mcp.json")).toBe(false);
    expect(await exists(".docket")).toBe(false);
  });

  it("writes nothing on --dry-run", async () => {
    const res = await init({ ...DEFAULTS, dryRun: true, dir: root });
    expect(res.failed).toBe(false);
    expect(res.log.some((l) => l.includes("would create mechanics.config.yaml"))).toBe(true);
    expect(await exists("mechanics.config.yaml")).toBe(false);
    expect(await exists(".mcp.json")).toBe(false);
  });
});

describe("init: .mcp.json merging", () => {
  it("preserves existing servers and never re-adds mechanics", async () => {
    await fs.writeFile(
      path.join(root, ".mcp.json"),
      `${JSON.stringify({ mcpServers: { other: { command: "other-server" } } }, null, 2)}\n`
    );
    await init({ ...DEFAULTS, dir: root });

    const doc = JSON.parse(await fs.readFile(path.join(root, ".mcp.json"), "utf8"));
    expect(doc.mcpServers.other.command).toBe("other-server");
    expect(doc.mcpServers.mechanics.args).toEqual(["-y", "@hansenexus/mechanics", "mcp"]);

    const res = await init({ ...DEFAULTS, dir: root });
    expect(res.log.some((l) => l.includes("already registered"))).toBe(true);
  });

  it("refuses to touch an unparseable .mcp.json", async () => {
    await fs.writeFile(path.join(root, ".mcp.json"), "not json {");
    const res = await init({ ...DEFAULTS, dir: root });
    expect(res.failed).toBe(false);
    expect(res.log.some((l) => l.includes("not valid JSON"))).toBe(true);
    expect(await fs.readFile(path.join(root, ".mcp.json"), "utf8")).toBe("not json {");
  });
});

describe("init: monorepo mode", () => {
  it("onboards apps/<slug> with discovery config and app-scoped CI regexes", async () => {
    await fs.mkdir(path.join(root, "apps", "shop", "convex"), { recursive: true });
    await fs.writeFile(path.join(root, "pnpm-lock.yaml"), "");

    const res = await init({ ...DEFAULTS, app: "shop", dir: root });
    expect(res.failed).toBe(false);

    const config = YAML.parse(await fs.readFile(path.join(root, "mechanics.config.yaml"), "utf8"));
    expect(config.appsDir).toBe("apps");
    expect(config.adapters).toEqual(["convex"]);
    expect(await exists("apps", "shop", "mechanics", "_config.yaml")).toBe(true);
    expect(await exists(".mechanics", "manifests", "shop.mechanics.json")).toBe(true);

    const wf = await fs.readFile(path.join(root, ".github/workflows/mechanics-check.yml"), "utf8");
    expect(wf).toContain("pnpm install");
    expect(wf).toContain("^apps/[^/]+/convex/");
    expect(wf).toContain("^apps/[^/]+/mechanics/");
  });

  it("fails loudly when the app directory does not exist", async () => {
    const res = await init({ ...DEFAULTS, app: "ghost", dir: root });
    expect(res.failed).toBe(true);
    expect(res.log[0]).toContain("apps/ghost/ does not exist");
    expect(await exists("mechanics.config.yaml")).toBe(false);
  });
});
