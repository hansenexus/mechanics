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
import { planScaffold, stubPath } from "./scaffold";
import { validateScreens } from "./screens";
import type {
  CoverageBucket,
  MechanicsManifest,
  VerificationMethod,
  VerificationStatus,
} from "./types";
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
  json: boolean;
  fix?: string[];
  propose: boolean;
  run?: string;
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
 * Colour, only when someone is there to see it.
 *
 * Off when stdout is not a TTY, so a redirect, a pipe, or a CI log gets clean
 * text — every test capture depends on that. `FORCE_COLOR` turns it back on
 * for callers that are piping deliberately and can render the escapes anyway;
 * `bun run docs:shots` uses it so the screenshots show the real terminal
 * colours instead of a second guess at them.
 *
 * `NO_COLOR` wins over `FORCE_COLOR`: the convention is that the user's opt
 * out beats the program's opt in.
 *
 * Colour never carries meaning on its own here — every state that is coloured
 * also says what it is in words.
 */
const COLOUR =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== "dumb" &&
  (process.env.FORCE_COLOR !== undefined || Boolean(process.stdout.isTTY));

const paint = (code: string) => (s: string) => (COLOUR && s ? `[${code}m${s}[0m` : s);
const bold = paint("1");
const dim = paint("2");
const red = paint("31");
const green = paint("32");
const yellow = paint("33");

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
    case "gaps":
      await runGaps(args);
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

/**
 * A surface is accounted for if it is claimed OR explicitly ignored. Filling
 * the bar from `claimed` alone would paint an excused surface as a gap, which
 * is the one thing the ignore list exists to say it is not.
 */
function coveredCount(b: { claimed: number; ignored: number }): number {
  return b.claimed + b.ignored;
}

/**
 * Heavy rule for the covered span, light rule for what is left. Two glyphs of
 * the same width, so the bar reads as one line rather than as a block of
 * shading, and a terminal without colour still shows the split.
 */
function bar(n: number, d: number, width = 16): string {
  const filled = d === 0 ? width : Math.round((n / d) * width);
  return "━".repeat(filled) + "─".repeat(width - filled);
}

async function runCoverage(args: Args) {
  const slugs = await resolveSlugs(args);
  for (const slug of slugs) {
    const { manifest, errors } = await buildManifest(slug);

    // Surfaces come from the app's adapters, so a project with a `worker` or
    // `migration` kind gets a row here without this file knowing about it.
    const buckets = manifest.surfaces
      .map((s) => ({ surface: s, b: manifest.coverage[s.kind] }))
      .filter((r): r is { surface: (typeof manifest.surfaces)[number]; b: CoverageBucket } =>
        Boolean(r.b)
      );
    const totals = buckets.reduce(
      (a, r) => ({ covered: a.covered + coveredCount(r.b), total: a.total + r.b.total }),
      { covered: 0, total: 0 }
    );

    console.log(
      `${bold(`mechanics · ${slug}`)} · ${manifest.mechanicCount} behaviours · ${totals.covered}/${totals.total} surfaces covered`
    );
    console.log("");

    const width = Math.max(9, ...buckets.map((r) => r.surface.kind.length));
    for (const { surface, b } of buckets) {
      const n = coveredCount(b);
      const pct = b.total === 0 ? 100 : Math.round((n / b.total) * 100);
      const note = b.unclaimed.length
        ? yellow(`${b.unclaimed.length} gap${b.unclaimed.length === 1 ? "" : "s"}`)
        : b.ignored
          ? dim(`${b.ignored} ignored`)
          : "";
      console.log(
        `  ${surface.kind.padEnd(width)} ${String(b.claimed).padStart(3)}/${String(b.total).padEnd(3)} ${paintBar(n, b.total)} ${String(pct).padStart(3)}%  ${note}`.trimEnd()
      );
    }

    // Named, one per line. A count tells you a gap exists; the name is what
    // you act on, and needing a second command to see it is why gaps get left.
    const gaps = buckets.flatMap(({ surface, b }) =>
      b.unclaimed.map((item) => ({ kind: surface.kind, item }))
    );
    if (gaps.length > 0) {
      console.log("");
      for (const g of gaps) console.log(`  ${yellow("⚠")} ${g.kind.padEnd(width)} ${g.item}`);
    }

    console.log("");
    const t = manifest.testCoverage;
    console.log(
      `  ${"tests".padEnd(width)} ${t.withTests} linked · ${t.manualOnly} manual · ${t.untested > 0 ? yellow(`${t.untested} untested`) : "0 untested"}`
    );

    const { waves } = await loadWaves(slug);
    for (const wave of waves) {
      const s = summarizeWave(wave, manifest.mechanics);
      const verified = s.counts.pass + s.counts["n-a"];
      console.log(
        `  ${"wave".padEnd(width)} ${s.slug} ${s.status} ${paintBar(verified, s.scopeSize)} ${verified}/${s.scopeSize} · ${s.counts.fail > 0 ? red(`${s.counts.fail} fail`) : "0 fail"} · ${s.counts.pending} pending`
      );
    }

    for (const e of errors) console.log(`  ${red("(error)")} ${e}`);
  }
}

/** Green for the covered span, dim for the remainder. */
function paintBar(n: number, d: number): string {
  const b = bar(n, d);
  const cut = b.lastIndexOf("━") + 1;
  return green(b.slice(0, cut)) + dim(b.slice(cut));
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
// gaps
// ---------------------------------------------------------------------------

/**
 * Report what the corpus is missing, and optionally close the mechanical part.
 *
 * Report-only by default. `--fix` applies the judgment-free ops and nothing
 * else; `--propose` queues the rest onto a docket run for a person. The two
 * lanes are deliberately separate flags rather than one "do the right thing"
 * mode, because the second one puts work in front of a human and that should
 * be asked for.
 */
async function runGaps(args: Args) {
  const { findGaps } = await import("./gaps");
  const { planAutoFix, applyAutoFix, DEFAULT_ALLOWED_OPS } = await import("./fix");
  const slugs = await resolveSlugs(args);

  const all: Awaited<ReturnType<typeof findGaps>> = [];
  for (const slug of slugs) all.push(...(await findGaps(slug)));

  if (args.json) {
    console.log(JSON.stringify({ gaps: all }, null, 2));
    return;
  }

  const auto = all.filter((g) => g.lane === "auto");
  const propose = all.filter((g) => g.lane === "propose");

  for (const g of all) {
    const mark = g.lane === "auto" ? green("fix") : yellow("ask");
    console.log(`  ${mark} ${g.severity} ${g.title}`);
    if (g.lane === "propose") console.log(`        ${dim(g.suggestion)}`);
  }
  console.log("");
  console.log(
    `  ${all.length} gap(s): ${auto.length} mechanical, ${propose.length} needing a decision`
  );

  if (args.fix) {
    const allow = args.fix.length > 0 ? (args.fix as never) : DEFAULT_ALLOWED_OPS;
    const plan = planAutoFix(slugs[0] as string, all, { allow });
    const res = await applyAutoFix(plan, REPO_ROOT, { dryRun: args.dryRun });
    if (res.revertedBecause) {
      console.error(`  ${red("(reverted)")} ${res.revertedBecause}`);
      process.exit(1);
    }
    for (const f of res.written)
      console.log(`  ${green(args.dryRun ? "would fix" : "fixed")} ${f}`);
    for (const d of plan.deferred) console.log(`  ${dim(`deferred ${d.gap.key}: ${d.reason}`)}`);
  }

  if (args.propose) {
    if (!args.run) {
      console.error(
        "[mechanics] gaps --propose needs --run=<id>. Opening a work order is a decision:\n" +
          '  bun mechanics run new --title="close the <app> gaps"'
      );
      process.exit(1);
    }
    const { raiseProposals } = await import("./proposals");
    const { currentCliActor } = await import("./docket-cli");
    const { raised, skipped } = await raiseProposals(
      REPO_ROOT,
      args.run,
      propose,
      currentCliActor(args.by)
    );
    console.log(`  raised ${raised.length}, already queued ${skipped.length}`);
  }
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
      // Same template init uses, not a copy of it. Two templates for one
      // strict schema is how the old copy came to emit keys the schema had
      // never accepted.
      const { appConfigYaml, detect } = await import("./init");
      await fs.mkdir(mechDir, { recursive: true });
      await fs.writeFile(
        configPath,
        appConfigYaml(detect(appDir(slug, REPO_ROOT), REPO_ROOT)),
        "utf8"
      );
      console.log(`[mechanics] wrote ${appPath(slug, REPO_ROOT, "mechanics", "_config.yaml")}`);
    }

    // Plan first, write second: what to emit is pure and tested in
    // `scaffold.test.ts`; only the skip-if-exists rule lives here.
    const plan = planScaffold(routes);
    let created = 0;
    for (const area of plan.areas) {
      const target = stubPath(mechDir, area.relPath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      if (await pathExistsLocal(target)) continue;
      await fs.writeFile(target, area.content, "utf8");
    }
    for (const stub of plan.stubs) {
      const target = stubPath(mechDir, stub.relPath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      if (await pathExistsLocal(target)) continue;
      await fs.writeFile(target, stub.content, "utf8");
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
    json: false,
    propose: false,
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
    else if (a === "--json") out.json = true;
    else if (a === "--propose") out.propose = true;
    // Empty means "whatever fix.ts considers safe by default" — resolved
    // there rather than duplicated here, so the two cannot drift.
    else if (a === "--fix") out.fix = [];
    else if (a.startsWith("--fix=")) out.fix = a.slice(6).split(",").filter(Boolean);
    else if (a.startsWith("--run=")) out.run = a.slice(6);
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
      "  bun mechanics gaps --app=<slug> | --all [--json] What the corpus is missing",
      "  bun mechanics gaps --app=<s> --fix[=ops]        Apply only the mechanical gaps",
      "  bun mechanics gaps --app=<s> --propose --run=<id>  Queue the rest for a human",
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
      "  bun mechanics run proposals --run=<id>          What is queued for review",
      "  bun mechanics run accept --run=<id> --proposal=<id> [--apply]   (human only)",
      "  bun mechanics run reject --run=<id> --proposal=<id> --reason=…",
    ].join("\n")
  );
}
