#!/usr/bin/env bun
/**
 * mechanics CLI — `bun mechanics <command> [opts]` (root script forwards args).
 *
 * Commands:
 *   init     [--app=<slug>]            Set a repo up: config, corpus skeleton, CI gate,
 *            [--no-ci|--no-mcp|--no-docket] [--dry-run]   MCP registration, manifest
 *   check    --app=<slug> | --all      Validate corpus + waves + coverage (exit 1 on errors)
 *   build    --app=<slug> | --all      Regenerate committed manifest(s)
 *   build    ... --check               Drift mode: exit 1 if any manifest is stale
 *   coverage --app=<slug>              Human-readable coverage table + gap list
 *   verify   --app=<slug> --wave=<w>   Run linked specs for a wave, merge results
 *            [--only=a,b] [--resume] [--dry-run]
 *            [--set <id>=<status> --method=<m> --evidence=<e> --by=<who>]
 *   scaffold --app=<slug>              Emit draft stubs for unclaimed routes
 *   impact   --app=<slug> [--base=r]   Map changed files → claiming mechanics
 *   mcp                                Serve the corpus over MCP on stdio (read-only)
 *   screens  --app=<slug> --wave=<w> --checkpoint=<c>
 *            Capture per-route webp screenshots into waves/screens/ — thin
 *            delegator to `apps/<slug>/scripts/capture-screens.ts` (the engine
 *            needs app-side deps: Playwright + sharp).
 */

import { execFile, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { inventoryRoutes } from "./coverage";
import { REPO_ROOT } from "./fsutil";
import { mapImpact } from "./impact";
import { appDir, appPath } from "./layout";
import { buildManifest, emitManifest, loadManifest, onboardedApps } from "./manifest";
import { validateScreens } from "./screens";
import type { MechanicsManifest, VerificationMethod, VerificationStatus } from "./types";
import {
  applySpecResults,
  createSpecExecutor,
  planVerify,
  setVerification,
  writeWave,
} from "./verify";
import { loadWave, loadWaves, summarizeWave, validateWaveAgainstCorpus } from "./waves";

const execFileAsync = promisify(execFile);

type Args = {
  command: string;
  app?: string;
  wave?: string;
  base: string;
  only?: string[];
  set?: string;
  method?: string;
  evidence?: string;
  by?: string;
  note?: string;
  all: boolean;
  check: boolean;
  resume: boolean;
  dryRun: boolean;
  // screens
  checkpoint?: string;
  routes?: string[];
  baseUrl?: string;
  viewport?: string;
  suffix?: string;
  keepPng: boolean;
  // report
  html: boolean;
  out?: string;
};

/**
 * Spellings that mean "print usage and succeed", not "run a command".
 * Declared above the top-level `await main()` on purpose: a `const` below it
 * would still be in its temporal dead zone when the dispatch reads it.
 */
const HELP_FLAGS = new Set(["--help", "-h", "help"]);

await main();

async function main() {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "init": {
      // Init creates the config the other commands resolve the repo through,
      // so it has its own flag vocabulary and root resolution.
      const { runInit } = await import("./init");
      await runInit(process.argv.slice(3));
      break;
    }
    case "check":
      await runCheck(args);
      break;
    case "build":
      await runBuild(args);
      break;
    case "report":
      await runReport(args);
      break;
    case "coverage":
      await runCoverage(args);
      break;
    case "verify":
      await runVerify(args);
      break;
    case "scaffold":
      await runScaffold(args);
      break;
    case "impact":
      await runImpact(args);
      break;
    case "screens":
      await runScreens(args);
      break;
    case "mcp": {
      // Dynamic import: the SDK is only needed when serving, and the corpus
      // commands should not pay its startup on every invocation.
      const { runMechanicsMcp } = await import("./mcp");
      await runMechanicsMcp();
      break;
    }
    case "run": {
      // The run layer has its own flag vocabulary and its own arg parser, so
      // it takes the raw argv rather than `Args`. Dynamic import keeps the
      // corpus commands' startup free of it.
      const { runDocketCli } = await import("./docket-cli");
      await runDocketCli(process.argv.slice(3));
      break;
    }
    default:
      // An asked-for usage screen is a success; an unrecognised command is
      // not. Both print the same text, so only the exit code separates
      // `mechanics --help` in a script from a typo'd subcommand.
      usage();
      process.exit(args.command && !HELP_FLAGS.has(args.command) ? 1 : 0);
  }
}

async function resolveSlugs(args: Args): Promise<string[]> {
  const slugs = args.all ? await onboardedApps() : args.app ? [args.app] : [];
  if (slugs.length === 0) {
    console.error(`[mechanics] ${args.command}: pass --app=<slug> or --all`);
    process.exit(1);
  }
  return slugs;
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

async function runCheck(args: Args) {
  const slugs = await resolveSlugs(args);
  let failed = false;

  for (const slug of slugs) {
    const { manifest, corpus, errors, warnings } = await buildManifest(slug);
    const allErrors = [...errors];
    const allWarnings = [...warnings];

    const { waves, errors: waveErrors } = await loadWaves(slug);
    allErrors.push(...waveErrors);
    for (const wave of waves) {
      allErrors.push(...validateWaveAgainstCorpus(wave, manifest.mechanics, slug));
    }
    // Screenshots are optional per wave and never gate: warnings only.
    allWarnings.push(
      ...(await validateScreens(
        slug,
        waves.map((w) => w.wave)
      ))
    );

    const enforce = corpus.config?.coverage.enforce ?? "warn";
    collectCoverageFindings(manifest, slug, enforce, allErrors, allWarnings);

    for (const w of allWarnings) console.warn(`[mechanics] warn  ${w}`);
    for (const e of allErrors) console.error(`[mechanics] error ${e}`);
    if (allErrors.length > 0) {
      failed = true;
      console.error(
        `[mechanics] ✗ ${slug}: ${allErrors.length} error(s), ${allWarnings.length} warning(s)`
      );
    } else {
      console.log(
        `[mechanics] ✓ ${slug}: ${manifest.mechanicCount} mechanics ok (${allWarnings.length} warning(s))`
      );
    }
  }
  if (failed) process.exit(1);
}

function collectCoverageFindings(
  manifest: MechanicsManifest,
  slug: string,
  enforce: "warn" | "error",
  errors: string[],
  warnings: string[]
) {
  const sink = enforce === "error" ? errors : warnings;
  for (const surface of manifest.surfaces) {
    for (const item of manifest.coverage[surface.kind]?.unclaimed ?? []) {
      sink.push(
        `${appPath(slug, REPO_ROOT) || slug}: unclaimed ${surface.label} "${item}" — claim it in a mechanic or ignore it`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

async function runBuild(args: Args) {
  const slugs = await resolveSlugs(args);
  let anyStale = false;
  let anyError = false;

  for (const slug of slugs) {
    const { manifest, errors } = await buildManifest(slug);
    if (errors.length > 0) {
      for (const e of errors) console.error(`[mechanics] error ${e}`);
      console.error(`[mechanics] ✗ ${slug}: fix ${errors.length} error(s) before building`);
      anyError = true;
      continue;
    }
    const res = await emitManifest(manifest, { check: args.check });
    if (args.check) {
      if (res.changed) {
        anyStale = true;
        await printDrift(slug, manifest);
      } else {
        console.log(`[mechanics] ${slug}: up to date (${manifest.mechanicCount} mechanics)`);
      }
    } else {
      console.log(
        `[mechanics] ${slug}: ${manifest.mechanicCount} mechanics — ${res.changed ? "updated" : "unchanged"} ${path.relative(REPO_ROOT, res.jsonPath)}`
      );
    }
  }

  if (anyError) process.exit(1);
  if (args.check && anyStale) {
    console.error(
      "\n[mechanics] ✗ committed manifest(s) are stale. Run `bun mechanics build --all` and commit the result."
    );
    process.exit(1);
  }
  if (args.check) console.log("[mechanics] ✓ all manifests up to date");
}

async function printDrift(slug: string, fresh: MechanicsManifest) {
  const committed = await loadManifest(slug);
  const before = new Map((committed?.mechanics ?? []).map((m) => [m.id, m]));
  const after = new Map(fresh.mechanics.map((m) => [m.id, m]));

  console.error(`\n[mechanics] ✗ ${slug}: manifest drift`);
  for (const m of fresh.mechanics.filter((m) => !before.has(m.id))) {
    console.error(`  + added   ${m.id} (${m.status})`);
  }
  for (const m of (committed?.mechanics ?? []).filter((m) => !after.has(m.id))) {
    console.error(`  - removed ${m.id}`);
  }
  for (const m of fresh.mechanics) {
    const prev = before.get(m.id);
    if (prev && JSON.stringify(prev) !== JSON.stringify(m)) {
      console.error(`  ~ changed ${m.id}`);
    }
  }
  if (JSON.stringify(committed?.coverage) !== JSON.stringify(fresh.coverage)) {
    console.error("  ~ coverage counts changed");
  }
}

// ---------------------------------------------------------------------------
// coverage
// ---------------------------------------------------------------------------

async function runCoverage(args: Args) {
  const slugs = await resolveSlugs(args);
  for (const slug of slugs) {
    const { manifest, errors } = await buildManifest(slug);
    console.log(`[mechanics] ${slug} — ${manifest.mechanicCount} mechanics`);
    // Surfaces come from the app's adapters, so a project with a `worker` or
    // `migration` kind gets a row here without this file knowing about it.
    for (const surface of manifest.surfaces) {
      const b = manifest.coverage[surface.kind];
      if (!b) continue;
      console.log(
        `  ${surface.kind.padEnd(17)} ${String(b.claimed).padStart(3)}/${String(b.total).padEnd(3)} claimed, ${b.ignored} ignored, ${b.unclaimed.length} unclaimed`
      );
    }
    console.log(
      `  tests             ${manifest.testCoverage.withTests} with tests, ${manifest.testCoverage.manualOnly} manual-only, ${manifest.testCoverage.untested} untested`
    );
    for (const surface of manifest.surfaces) {
      for (const item of manifest.coverage[surface.kind]?.unclaimed ?? []) {
        console.log(`    unclaimed ${surface.label}: ${item}`);
      }
    }
    for (const e of errors) console.log(`    (error) ${e}`);

    const { waves } = await loadWaves(slug);
    for (const wave of waves) {
      const s = summarizeWave(wave, manifest.mechanics);
      console.log(
        `  wave ${s.slug} [${s.status}]: ${s.counts.pass + s.counts["n-a"]}/${s.scopeSize} verified, ${s.counts.fail} fail, ${s.counts.pending} pending`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

/**
 * Reads the COMMITTED manifests rather than rebuilding, so the page describes
 * the branch exactly as it stands and costs nothing to produce. A rebuild
 * walks every app tree; a report anyone can regenerate in a second is a report
 * people actually regenerate.
 */
async function runReport(args: Args) {
  if (!args.html) {
    console.error("[mechanics] report: only --html is supported (pass --html)");
    process.exit(1);
  }
  const { renderReport } = await import("./report");
  const slugs = args.app ? [args.app] : await onboardedApps();

  const apps = [];
  for (const slug of slugs) {
    const manifest = await loadManifest(slug);
    if (!manifest) {
      console.error(
        `[mechanics] report: ${slug} has no committed manifest — run 'mechanics build --app=${slug}' first`
      );
      process.exit(1);
    }
    const { waves } = await loadWaves(slug);
    apps.push({ manifest, waves });
  }

  const html = renderReport(apps, {
    generatedAt: new Date().toISOString().replace("T", " ").slice(0, 16),
    revision: await gitRevision(),
    ...(args.app ? { title: `${args.app} — mechanics coverage` } : {}),
  });

  const out = args.out ?? "mechanics-report.html";
  await fs.mkdir(path.dirname(path.resolve(REPO_ROOT, out)), { recursive: true });
  await fs.writeFile(path.resolve(REPO_ROOT, out), html, "utf8");
  console.log(
    `[mechanics] wrote ${out} — ${apps.length} app(s), ${apps.reduce((n, a) => n + a.manifest.mechanicCount, 0)} mechanics`
  );
}

/** Best-effort: a report generated outside a git checkout still renders. */
async function gitRevision(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: REPO_ROOT,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

async function runVerify(args: Args) {
  if (!args.app || !args.wave) {
    console.error("[mechanics] verify: pass --app=<slug> and --wave=<slug>");
    process.exit(1);
  }
  const slug = args.app;
  const wave = await loadWave(slug, args.wave);
  if (!wave) {
    console.error(`[mechanics] verify: wave "${args.wave}" not found for ${slug}`);
    process.exit(1);
  }
  const today = new Date().toISOString().slice(0, 10);

  if (args.set) {
    const m = args.set.match(/^(.+)=(pending|pass|fail|blocked|n-a)$/);
    if (!m?.[1] || !m[2]) {
      console.error("[mechanics] verify --set expects <mechanicId>=<status>");
      process.exit(1);
    }
    const next = setVerification(wave, {
      mechanic: m[1],
      status: m[2] as VerificationStatus,
      method: (args.method ?? "manual") as VerificationMethod,
      ...(args.evidence !== undefined ? { evidence: args.evidence } : {}),
      verifiedBy: args.by ?? process.env.USER ?? "unknown",
      date: today,
      ...(args.note !== undefined ? { note: args.note } : {}),
    });
    const p = await writeWave(slug, next);
    console.log(`[mechanics] recorded ${m[1]}=${m[2]} in ${path.relative(REPO_ROOT, p)}`);
    return;
  }

  const { manifest, corpus, errors } = await buildManifest(slug);
  if (errors.length > 0) {
    for (const e of errors) console.error(`[mechanics] error ${e}`);
    console.error("[mechanics] verify: fix corpus errors first (`bun mechanics check`)");
    process.exit(1);
  }

  const plan = planVerify(manifest.mechanics, wave, {
    ...(args.only ? { only: args.only } : {}),
    resume: args.resume,
  });

  console.log(
    `[mechanics] verify ${slug}/${wave.wave}: ${plan.e2e.length} spec run(s), ${plan.agent.length} agent, ${plan.manual.length} manual, ${plan.skipped.length} skipped`
  );
  if (args.dryRun) {
    for (const run of plan.e2e) {
      console.log(`  e2e   ${run.spec} → ${run.mechanicIds.join(", ")}`);
    }
    for (const m of plan.agent) console.log(`  agent ${m.id} (${m.criteria.length} ACs)`);
    for (const m of plan.manual) {
      console.log(`  manual ${m.id}${m.destructive ? " [destructive]" : ""}`);
    }
    return;
  }

  if (!corpus.config) {
    console.error("[mechanics] verify: no _config.yaml");
    process.exit(1);
  }
  const executor = createSpecExecutor(slug, corpus.config);
  const results = [];
  for (const run of plan.e2e) {
    console.log(`[mechanics] running ${run.spec} …`);
    results.push(await executor(run));
  }

  const merged = applySpecResults(wave, results, { verifiedBy: "mechanics-cli", date: today });
  const p = await writeWave(slug, merged);
  const failedSpecs = results.filter((r) => !r.ok);
  console.log(
    `[mechanics] wrote ${path.relative(REPO_ROOT, p)} — ${results.length - failedSpecs.length}/${results.length} spec(s) green`
  );
  const summary = summarizeWave(merged, manifest.mechanics);
  console.log(
    `[mechanics] wave ${summary.slug}: ${summary.counts.pass + summary.counts["n-a"]}/${summary.scopeSize} verified, ${summary.counts.fail} fail, ${summary.counts.pending} pending`
  );
  if (plan.agent.length > 0) {
    console.log("[mechanics] agent-method mechanics (drive with /mechanics-verify skill):");
    for (const m of plan.agent) console.log(`  - ${m.id}`);
  }
  if (plan.manual.length > 0) {
    console.log("[mechanics] manual checklist (record with `verify --set`):");
    for (const m of plan.manual) {
      console.log(`  - ${m.id}${m.destructive ? " [destructive — never auto-drive]" : ""}`);
    }
  }
  if (failedSpecs.length > 0) process.exit(1);
}

// ---------------------------------------------------------------------------
// scaffold
// ---------------------------------------------------------------------------

async function runScaffold(args: Args) {
  const slugs = await resolveSlugs(args);
  for (const slug of slugs) {
    const routes = await inventoryRoutes(slug);
    const mechDir = path.join(REPO_ROOT, appPath(slug, REPO_ROOT, "mechanics"));
    const configPath = path.join(mechDir, "_config.yaml");
    if (!(await pathExistsLocal(configPath))) {
      await fs.mkdir(mechDir, { recursive: true });
      await fs.writeFile(configPath, defaultConfigYaml(), "utf8");
      console.log(`[mechanics] wrote ${appPath(slug, REPO_ROOT, "mechanics", "_config.yaml")}`);
    }

    let created = 0;
    const areaOrders = new Map<string, number>();
    for (const route of routes) {
      const { area, slug: fileSlug } = routeToStub(route);
      const areaDir = path.join(mechDir, area);
      await fs.mkdir(areaDir, { recursive: true });
      const areaMeta = path.join(areaDir, "_area.yaml");
      if (!(await pathExistsLocal(areaMeta))) {
        const order = areaOrders.size + 1;
        areaOrders.set(area, order);
        await fs.writeFile(
          areaMeta,
          `title: ${titleCase(area)}\norder: ${order}\ndescription: TODO\n`,
          "utf8"
        );
      }
      const stub = path.join(areaDir, `${fileSlug}.md`);
      if (await pathExistsLocal(stub)) continue;
      await fs.writeFile(stub, stubMarkdown(route), "utf8");
      created++;
    }
    console.log(
      `[mechanics] ${slug}: scaffolded ${created} draft stub(s) from ${routes.length} routes — author them, then \`bun mechanics build --app=${slug}\``
    );
    // Scaffolding only writes route stubs; every other surface the app declares
    // still needs a claim, so say how many are waiting rather than naming Convex
    // specifically — a project without it would be told about a thing it has not got.
    const { manifest } = await buildManifest(slug);
    const pending = manifest.surfaces
      .filter((s) => s.kind !== "route")
      .map((s) => [s, manifest.coverage[s.kind]?.unclaimed.length ?? 0] as const)
      .filter(([, n]) => n > 0);
    for (const [surface, n] of pending) {
      console.log(
        `[mechanics] ${slug}: ${n} ${surface.label}(s) await claims — see \`bun mechanics coverage --app=${slug}\``
      );
    }
  }
}

function routeToStub(route: string): { area: string; slug: string } {
  const segs = route
    .split("/")
    .filter(Boolean)
    .map((s) =>
      s
        .replace(/[[\]().@]/g, "")
        .replace(/\.{3}/g, "")
        .toLowerCase()
    )
    .filter((s) => s.length > 0);
  if (segs.length === 0) return { area: "overview", slug: "home" };
  const [first, ...rest] = segs;
  return {
    area: first ?? "overview",
    slug: rest.length > 0 ? rest.join("-") : "index",
  };
}

function titleCase(s: string): string {
  return s.replace(/(^|-)(\w)/g, (_, sep, c) => `${sep === "-" ? " " : ""}${c.toUpperCase()}`);
}

function defaultConfigYaml(): string {
  return `testGlobs:
  - "e2e/**/*.spec.ts"
e2eRunner: bun-script
coverage:
  enforce: warn
  ignoreRoutes: []
  ignoreApiRoutes: []
  ignoreConvexFunctions: []
`;
}

function stubMarkdown(route: string): string {
  return `---
title: "TODO: describe the behavior at ${route}"
kind: user-facing
status: draft
priority: p1
roles: [viewer]
routes: ["${route}"]
---

## Story

TODO — As a <role>, I can … so that ….

## Acceptance Criteria

- **AC1** Given … When … Then ….

## Edge Cases

- TODO

## Error States

- TODO
`;
}

async function pathExistsLocal(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// impact
// ---------------------------------------------------------------------------

async function runImpact(args: Args) {
  if (!args.app) {
    console.error("[mechanics] impact: pass --app=<slug>");
    process.exit(1);
  }
  const slug = args.app;
  const manifest = await loadManifest(slug);
  if (!manifest) {
    console.log(`[mechanics] ${slug} is not onboarded — nothing to report`);
    return;
  }

  const { stdout } = await execFileAsync("git", ["diff", "--name-only", `${args.base}...HEAD`], {
    cwd: REPO_ROOT,
    maxBuffer: 10 * 1024 * 1024,
  });
  const { changedFiles, hits } = mapImpact(
    manifest,
    appPath(slug, REPO_ROOT),
    stdout.split("\n").filter(Boolean)
  );

  if (changedFiles.length === 0) {
    console.log(`[mechanics] no ${slug} changes vs ${args.base}`);
    return;
  }
  if (hits.length === 0) {
    console.log(
      `[mechanics] ${changedFiles.length} ${slug} file(s) changed; no documented mechanic claims them`
    );
    return;
  }
  console.log(`[mechanics] diff touches ${hits.length} documented mechanic(s):`);
  for (const hit of hits) {
    const extra = hit.reasons.length > 1 ? ` +${hit.reasons.length - 1}` : "";
    console.log(`  - ${hit.id}  (${hit.reasons[0]}${extra})`);
  }
  console.log(
    `[mechanics] consider: /mechanics-verify ${slug} <wave> --only=${hits
      .slice(0, 3)
      .map((h) => h.id)
      .join(",")}`
  );
}

// ---------------------------------------------------------------------------
// screens — thin delegator; the engine lives app-side (Playwright + sharp)
// ---------------------------------------------------------------------------

async function runScreens(args: Args) {
  if (!args.app || !args.wave || !args.checkpoint) {
    console.error("[mechanics] screens: pass --app=<slug> --wave=<slug> --checkpoint=<name>");
    process.exit(1);
  }
  const slug = args.app;
  const wave = await loadWave(slug, args.wave);
  if (!wave) {
    console.error(`[mechanics] screens: wave "${args.wave}" not found for ${slug}`);
    process.exit(1);
  }
  const script = path.join(appDir(slug, REPO_ROOT), "scripts", "capture-screens.ts");
  if (!(await pathExistsLocal(script))) {
    console.error(
      `[mechanics] screens: ${appPath(slug, REPO_ROOT, "scripts", "capture-screens.ts")} not found — the app has no capture engine`
    );
    process.exit(1);
  }

  const forwarded = [
    `--wave=${args.wave}`,
    `--checkpoint=${args.checkpoint}`,
    ...(args.routes ? [`--routes=${args.routes.join(",")}`] : []),
    ...(args.baseUrl ? [`--base-url=${args.baseUrl}`] : []),
    ...(args.viewport ? [`--viewport=${args.viewport}`] : []),
    ...(args.suffix ? [`--suffix=${args.suffix}`] : []),
    ...(args.keepPng ? ["--keep-png"] : []),
    ...(args.dryRun ? ["--dry-run"] : []),
  ];
  const res = spawnSync("bun", ["scripts/capture-screens.ts", ...forwarded], {
    cwd: appDir(slug, REPO_ROOT),
    stdio: "inherit",
  });
  process.exit(res.status ?? 1);
}

// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Args {
  const out: Args = {
    command: argv[0] ?? "",
    all: false,
    check: false,
    resume: false,
    dryRun: false,
    keepPng: false,
    html: false,
    base: "master",
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a === "--all") out.all = true;
    else if (a === "--check") out.check = true;
    else if (a === "--resume") out.resume = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a.startsWith("--app=")) out.app = a.slice(6);
    else if (a.startsWith("--wave=")) out.wave = a.slice(7);
    else if (a.startsWith("--base=")) out.base = a.slice(7);
    else if (a.startsWith("--only=")) out.only = a.slice(7).split(",").filter(Boolean);
    else if (a.startsWith("--set=")) out.set = a.slice(6);
    else if (a === "--set" && argv[i + 1]) out.set = argv[++i];
    else if (a.startsWith("--method=")) out.method = a.slice(9);
    else if (a.startsWith("--evidence=")) out.evidence = a.slice(11);
    else if (a.startsWith("--by=")) out.by = a.slice(5);
    else if (a.startsWith("--note=")) out.note = a.slice(7);
    else if (a === "--app" && argv[i + 1]) out.app = argv[++i];
    else if (a === "--wave" && argv[i + 1]) out.wave = argv[++i];
    else if (a.startsWith("--checkpoint=")) out.checkpoint = a.slice(13);
    else if (a === "--checkpoint" && argv[i + 1]) out.checkpoint = argv[++i];
    else if (a.startsWith("--routes=")) out.routes = a.slice(9).split(",").filter(Boolean);
    else if (a.startsWith("--base-url=")) out.baseUrl = a.slice(11);
    else if (a.startsWith("--viewport=")) out.viewport = a.slice(11);
    else if (a.startsWith("--suffix=")) out.suffix = a.slice(9);
    else if (a === "--keep-png") out.keepPng = true;
    else if (a === "--html") out.html = true;
    else if (a.startsWith("--out=")) out.out = a.slice(6);
    else if (a === "--out" && argv[i + 1]) out.out = argv[++i];
  }
  return out;
}

function usage() {
  console.log(
    [
      "mechanics — app mechanics corpus tooling",
      "",
      "Usage:",
      "  bun mechanics init [--app=<slug>] [--dry-run]   Set this repo up: config, corpus",
      "                [--no-ci] [--no-mcp] [--no-docket] skeleton, CI gate, MCP, manifest",
      "  bun mechanics check --app=<slug> | --all       Validate corpus + waves + coverage",
      "  bun mechanics build --app=<slug> | --all        Regenerate committed manifest(s)",
      "  bun mechanics build --all --check               Drift gate (exit 1 if stale)",
      "  bun mechanics coverage --app=<slug>             Coverage table + gaps + wave rollups",
      "  bun mechanics report --html [--out=<path>]      Coverage as one self-contained page",
      "  bun mechanics verify --app=<s> --wave=<w>       Run linked specs, merge into wave YAML",
      "  bun mechanics verify ... --set <id>=<status> --method=<m> --evidence=<e> --by=<who>",
      "  bun mechanics scaffold --app=<slug>             Draft stubs for unclaimed routes",
      "  bun mechanics impact --app=<slug> --base=<ref>  Changed files → claiming mechanics",
      "  bun mechanics screens --app=<s> --wave=<w> --checkpoint=<before|after|...>",
      "                [--routes=/a,/b] [--base-url=u] [--viewport=WxH] [--suffix=mobile]",
      "                [--keep-png] [--dry-run]         Capture per-route screenshots",
      "  bun mechanics mcp                               Serve the corpus to an agent (stdio)",
      "",
      "  bun mechanics run list [--watch]                Board: runs in flight (docket/1)",
      '  bun mechanics run new --title="…"               Open a work order',
      "  bun mechanics run event --run=<id> --type=<t>   Append to a run's event log",
      "  bun mechanics run show --run=<id>               Phases, criteria, evidence",
      "  bun mechanics run rebuild --run=<id> | --all    Regenerate state.json from events",
    ].join("\n")
  );
}
