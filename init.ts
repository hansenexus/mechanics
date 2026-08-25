/**
 * `mechanics init` — set a repo up for mechanics in one idempotent pass.
 *
 * Init is the structural half of onboarding: it writes the config, the corpus
 * skeleton, the CI gate, the MCP registration, and the docket directory, and
 * then bootstraps the committed manifest. The semantic half — actually
 * describing behaviour — is authoring work; `scaffold` helps once an adapter
 * inventory exists.
 *
 * Everything is skip-if-exists, so re-running init on a live repo is safe and
 * reports `skip` for every file it left alone. That property matters more
 * than any flag: agents can run it unconditionally.
 *
 * Deliberately NOT resolved through `REPO_ROOT`: that constant walks up from
 * the working directory looking for `mechanics.config.yaml`, which is exactly
 * the file init exists to create. Init finds its own root (`--dir`, else the
 * nearest `.git`, else an existing config, else the working directory) and
 * passes it explicitly to every helper.
 */

import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { clearLayoutCache } from "./layout";
import { buildManifest, emitManifest } from "./manifest";

export interface InitOptions {
  /** Monorepo mode: onboard `apps/<slug>` instead of treating the repo as the app. */
  app?: string;
  /** Target repo root. Defaults to the nearest `.git`/config ancestor of cwd. */
  dir?: string;
  ci: boolean;
  mcp: boolean;
  docket: boolean;
  dryRun: boolean;
}

interface PlannedFile {
  /** Repo-relative POSIX path. */
  relPath: string;
  content: string;
}

export interface Detection {
  adapters: string[];
  playwrightConfig?: string;
  packageManager: "bun" | "pnpm" | "yarn" | "npm";
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Nearest ancestor holding `.git` or an existing `mechanics.config.yaml`. */
function findInitRoot(from: string): string {
  let dir = path.resolve(from);
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    if (existsSync(path.join(dir, "mechanics.config.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(from);
    dir = parent;
  }
}

/**
 * What this repo looks like, by the only evidence that does not lie: files on
 * disk. Exported because `scaffold` and `scan` must answer the same question
 * the same way — a second detection implementation is a second answer, and the
 * one that drifts is always the one nobody is looking at.
 *
 * An empty `adapters` is a real result, not a failure: a repo no built-in
 * adapter matches declares its surfaces by glob under `surfaces:` instead.
 */
export function detect(appRoot: string, repoRoot: string): Detection {
  const adapters: string[] = [];
  if (existsSync(path.join(appRoot, "src", "app")) || existsSync(path.join(appRoot, "app"))) {
    adapters.push("nextjs-app-router");
  }
  if (existsSync(path.join(appRoot, "convex"))) adapters.push("convex");

  let playwrightConfig: string | undefined;
  for (const name of ["playwright.config.ts", "playwright.config.mts", "playwright.config.js"]) {
    if (existsSync(path.join(appRoot, name))) {
      playwrightConfig = name;
      break;
    }
  }

  let packageManager: Detection["packageManager"] = "npm";
  if (existsSync(path.join(repoRoot, "bun.lock")) || existsSync(path.join(repoRoot, "bun.lockb"))) {
    packageManager = "bun";
  } else if (existsSync(path.join(repoRoot, "pnpm-lock.yaml"))) {
    packageManager = "pnpm";
  } else if (existsSync(path.join(repoRoot, "yarn.lock"))) {
    packageManager = "yarn";
  }
  return { adapters, playwrightConfig, packageManager };
}

// ---------------------------------------------------------------------------
// Generated file contents
// ---------------------------------------------------------------------------

function repoConfigYaml(opts: InitOptions, det: Detection): string {
  const adapterList = det.adapters.length ? `[${det.adapters.join(", ")}]` : "[]";
  const surfacesHint = det.adapters.length
    ? ""
    : `
    # No built-in adapter matched this repo. Declare your surfaces by glob —
    # the kind names are yours and become the keys under \`claims:\`:
    # surfaces:
    #   - kind: cli-command
    #     label: CLI command
    #     globs: ["src/commands/*.ts"]
`;
  if (opts.app) {
    return `# Where mechanics runs, and how this repo is laid out.
# The presence of this file marks the repo root — the CLI walks up from the
# working directory to find it.

# Apps are discovered: every directory under \`appsDir\` with a \`mechanics/\`
# corpus is an app. Onboard the next app with \`mechanics init --app=<slug>\`.
appsDir: apps

# Adapters applied to every discovered app.
adapters: ${adapterList}
${surfacesHint}
# Committed, generated, drift-gated in CI. Never hand-edit.
manifestsDir: .mechanics/manifests
`;
  }
  return `# Where mechanics runs, and how this repo is laid out.
# The presence of this file marks the repo root — the CLI walks up from the
# working directory to find it.

# A single-app repo: the app IS the repo. \`dir: .\` makes every derived path
# lose the \`apps/<slug>/\` prefix, so mechanics live at \`mechanics/…\`.
apps:
  - slug: app
    dir: .
    adapters: ${adapterList}
${surfacesHint}
# Committed, generated, drift-gated in CI. Never hand-edit.
manifestsDir: .mechanics/manifests
`;
}

/**
 * The per-app `_config.yaml`. Exported because `scaffold` writes this same
 * file when it runs before `init`, and it must be the SAME template: the two
 * drifted once already, and `appConfigSchema` is `.strict()`, so the copy that
 * fell behind emitted a config the tool then refused to load.
 */
export function appConfigYaml(det: Detection): string {
  const runner = det.playwrightConfig
    ? `e2eRunner: playwright
playwrightConfig: ${det.playwrightConfig}`
    : `# bun-script | playwright. Playwright additionally needs \`playwrightConfig\`.
e2eRunner: bun-script`;
  return `# Per-app config. Paths are relative to the app root.

# Specs scanned for \`// @mechanic <id>\` annotations and mechanic-prefixed
# describe titles. Test links are DISCOVERED from these, never declared in
# frontmatter — a declared link is a second source of truth that rots.
testGlobs:
  - "e2e/**/*.spec.ts"

${runner}

coverage:
  # warn while you are still writing the corpus; error once it is complete.
  # That flip is the ratchet — it is what stops the corpus going stale.
  enforce: warn
  ignore: {}
`;
}

const AREA_YAML = `title: Getting started
order: 1
description: Replace this area with your app's real behaviour areas.
`;

const STARTER_MECHANIC = `---
title: Document the first behaviour
kind: user-facing
status: draft
roles: [user]
claims: {}
---

## Story

As a user, I can rely on documented behaviour so that changes to it are
deliberate, reviewed, and verified — never accidental.

This file is a placeholder. Replace it (and its area) with your app's first
real mechanic: one markdown file per behaviour, named after the behaviour.
With an adapter inventory in place, \`mechanics scaffold --app=<slug>\` emits a
draft stub per unclaimed surface.

## Acceptance Criteria

- **AC1** Given the corpus describes a behaviour, When the surface shipping it
  changes in a PR, Then CI requires the corpus to change too (or the PR to be
  labeled \`mechanics-not-needed\`).
- **AC2** Given \`coverage.enforce\` is ratcheted to \`error\`, When a surface has
  no claiming mechanic, Then \`mechanics check\` fails.

## Edge Cases

- A surface that genuinely needs no documentation belongs in
  \`coverage.ignore\`, with a comment saying why.

## Error States

- A claim naming a surface that does not exist fails \`mechanics check\` with
  the offending mechanic and claim key.
`;

function workflowYaml(opts: InitOptions, det: Detection): string {
  const pm = det.packageManager;
  const setup =
    pm === "bun"
      ? `      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install --frozen-lockfile`
      : `      - uses: actions/setup-node@v4
        with:
          node-version: 24
${
  pm === "pnpm"
    ? `      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile`
    : pm === "yarn"
      ? `      - run: yarn install --frozen-lockfile`
      : `      - run: npm ci`
}`;
  const runner = pm === "bun" ? "bunx" : "npx";
  const corpusRe = opts.app ? "^apps/[^/]+/mechanics/" : "^mechanics/";
  const surfaceParts: string[] = [];
  const prefix = opts.app ? "^apps/[^/]+/" : "^";
  if (det.adapters.includes("nextjs-app-router")) surfaceParts.push(`${prefix}(src/)?app/`);
  if (det.adapters.includes("convex")) surfaceParts.push(`${prefix}convex/`);
  const coupling = surfaceParts.length
    ? `
  coupling:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0

      - name: Surface changed without a corpus change
        if: \${{ !contains(github.event.pull_request.labels.*.name, 'mechanics-not-needed') }}
        env:
          BASE: \${{ github.event.pull_request.base.sha }}
          HEAD: \${{ github.event.pull_request.head.sha }}
        run: |
          set -euo pipefail
          changed=$(git diff --name-only "$BASE" "$HEAD")

          # Directories whose contents are documented behaviour. Keep this in
          # step with the adapters/surfaces in mechanics.config.yaml.
          surface=$(echo "$changed" | grep -E '${surfaceParts.join("|")}' || true)
          corpus=$(echo "$changed" | grep -E '${corpusRe}' || true)

          if [ -n "$surface" ] && [ -z "$corpus" ]; then
            echo "::error::This PR changes documented surfaces but no mechanic:"
            echo "$surface" | sed 's/^/  /'
            echo "Update the mechanics corpus, or label the PR 'mechanics-not-needed'."
            exit 1
          fi
          echo "ok"
`
    : `
  # No adapter was detected at init time, so there is no coupling gate yet.
  # Once mechanics.config.yaml declares surfaces, add a \`coupling\` job that
  # fails a PR touching those globs without touching the corpus — see the
  # template in the @hansenexus/mechanics package for the exact shape.
`;
  return `name: mechanics

# Two gates, and they do different jobs:
#
#   validate + drift  — the corpus parses, every claim resolves, and the
#                       committed manifest matches what the tree produces.
#   coupling          — a PR that changes a documented surface must also touch
#                       the corpus. This is the gate that keeps the corpus from
#                       going stale.
#
# Escape hatch for a surface-only change that genuinely needs no doc update:
# add the \`mechanics-not-needed\` label to the PR.

on:
  pull_request:
  push:
    branches: [main, master]

permissions:
  contents: read
  pull-requests: read

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
${setup}

      - name: Validate corpus, waves and coverage
        run: ${runner} mechanics check --all

      - name: Manifests match the tree
        run: ${runner} mechanics build --all --check
${coupling}`;
}

const DOCKET_README = `# .docket

Work orders and their event logs, in the [docket/1](https://github.com/hansenexus/mechanics/blob/main/spec/docket-1.md)
protocol. Everything under \`runs/\` is committed: the board is repo state, not
a service.

    mechanics run new --title="…"     open a work order
    mechanics run list                board: runs in flight
    mechanics run show --run=<id>     phases, criteria, evidence
`;

// ---------------------------------------------------------------------------
// Plan + execute
// ---------------------------------------------------------------------------

export async function runInit(argv: string[]): Promise<void> {
  const opts: InitOptions = { ci: true, mcp: true, docket: true, dryRun: false };
  for (const a of argv) {
    if (a === "--no-ci") opts.ci = false;
    else if (a === "--no-mcp") opts.mcp = false;
    else if (a === "--no-docket") opts.docket = false;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a.startsWith("--app=")) opts.app = a.slice(6);
    else if (a.startsWith("--dir=")) opts.dir = a.slice(6);
    else {
      console.error(`[mechanics] init: unknown flag ${a}`);
      process.exit(1);
    }
  }

  const result = await init(opts);
  for (const line of result.log) console.log(line);
  if (result.failed) process.exit(1);
}

export interface InitResult {
  root: string;
  appSlug: string;
  log: string[];
  failed: boolean;
}

export async function init(opts: InitOptions): Promise<InitResult> {
  const root = path.resolve(opts.dir ?? findInitRoot(process.cwd()));
  const appSlug = opts.app ?? "app";
  const appRel = opts.app ? path.posix.join("apps", opts.app) : "";
  const appRoot = path.join(root, appRel);
  const log: string[] = [];
  const tag = opts.dryRun ? "would create" : "created";

  if (opts.app && !existsSync(appRoot)) {
    return {
      root,
      appSlug,
      failed: true,
      log: [`[mechanics] init: ${appRel}/ does not exist — create the app first`],
    };
  }

  const det = detect(appRoot, root);
  log.push(
    `[mechanics] init in ${root}${opts.app ? ` (app: ${opts.app})` : " (single-app repo)"}`,
    `[mechanics] detected: adapters=${det.adapters.join(",") || "none"} pm=${det.packageManager}${det.playwrightConfig ? ` playwright=${det.playwrightConfig}` : ""}`
  );

  const planned: PlannedFile[] = [
    { relPath: "mechanics.config.yaml", content: repoConfigYaml(opts, det) },
    { relPath: path.posix.join(appRel, "mechanics", "_config.yaml"), content: appConfigYaml(det) },
    {
      relPath: path.posix.join(appRel, "mechanics", "getting-started", "_area.yaml"),
      content: AREA_YAML,
    },
    {
      relPath: path.posix.join(
        appRel,
        "mechanics",
        "getting-started",
        "document-first-behaviour.md"
      ),
      content: STARTER_MECHANIC,
    },
  ];
  if (opts.ci) {
    planned.push({
      relPath: ".github/workflows/mechanics-check.yml",
      content: workflowYaml(opts, det),
    });
  }
  if (opts.docket) {
    planned.push({ relPath: ".docket/README.md", content: DOCKET_README });
  }

  for (const file of planned) {
    const abs = path.join(root, file.relPath);
    if (existsSync(abs)) {
      log.push(`  skip    ${file.relPath} (exists)`);
      continue;
    }
    if (!opts.dryRun) {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, file.content, "utf8");
    }
    log.push(`  ${tag} ${file.relPath}`);
  }

  if (opts.mcp) log.push(await mergeMcpJson(root, opts.dryRun));

  // Manifest bootstrap: generate the committed manifest for the fresh corpus.
  // The layout cache may hold a pre-init answer for this root, so drop it.
  if (opts.dryRun) {
    log.push(`  would create .mechanics/manifests/${appSlug}.mechanics.json`);
  } else {
    clearLayoutCache();
    const { manifest, errors } = await buildManifest(appSlug, root);
    if (errors.length) {
      for (const e of errors) log.push(`  error   ${e}`);
      return { root, appSlug, log, failed: true };
    }
    const { jsonPath, changed } = await emitManifest(manifest, { repoRoot: root });
    const rel = path.relative(root, jsonPath);
    log.push(changed ? `  ${tag} ${rel}` : `  skip    ${rel} (up to date)`);
  }

  const install =
    det.packageManager === "bun"
      ? "bun add -d @hansenexus/mechanics"
      : det.packageManager === "pnpm"
        ? "pnpm add -D @hansenexus/mechanics"
        : det.packageManager === "yarn"
          ? "yarn add -D @hansenexus/mechanics"
          : "npm i -D @hansenexus/mechanics";
  log.push(
    "",
    "Next steps:",
    `  1. ${install}   (if not already a devDependency)`,
    `  2. Author real mechanics under ${appRel ? `${appRel}/` : ""}mechanics/ — one file per behaviour${det.adapters.length ? `; \`mechanics scaffold --app=${appSlug}\` drafts a stub per unclaimed surface` : ""}`,
    `  3. Commit the generated manifest — CI diffs it against the tree`,
    `  4. When the corpus is complete, ratchet coverage.enforce to error`
  );
  return { root, appSlug, log, failed: false };
}

/** Add the mechanics MCP server to `.mcp.json`, preserving whatever else is there. */
async function mergeMcpJson(root: string, dryRun: boolean): Promise<string> {
  const rel = ".mcp.json";
  const abs = path.join(root, rel);
  let doc: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(abs)) {
    try {
      doc = JSON.parse(await fs.readFile(abs, "utf8"));
    } catch {
      return `  skip    ${rel} (exists but is not valid JSON — add the mechanics server by hand)`;
    }
    if (doc.mcpServers && "mechanics" in doc.mcpServers) {
      return `  skip    ${rel} (mechanics server already registered)`;
    }
  }
  doc.mcpServers = {
    ...doc.mcpServers,
    mechanics: { command: "npx", args: ["-y", "@hansenexus/mechanics", "mcp"] },
  };
  if (!dryRun) await fs.writeFile(abs, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  return `  ${dryRun ? "would merge" : "merged"} ${rel} (mechanics MCP server, stdio)`;
}
