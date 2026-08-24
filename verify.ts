/**
 * Wave verification: plan which specs to run for a wave, execute them through
 * the app's harness (bun-script or Playwright), and merge results into the
 * wave YAML.
 *
 * Merge contract: e2e results NEVER overwrite `manual`/`agent` entries — a
 * human/agent verdict outlasts a re-run. Absent entries and `method: e2e`
 * entries are fair game. `--set` (a deliberate human action) may overwrite
 * anything.
 *
 * Verification granularity is the spec file: every mechanic linked to a spec
 * shares that spec's verdict (documented v1 limitation; Playwright links
 * discovered via describe-title additionally run `--grep <id>`).
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./fsutil";
import { appPath, appDir as appRootDir } from "./layout";
import type {
  AppMechanicsConfig,
  E2eRunner,
  ManifestMechanic,
  VerificationMethod,
  VerificationStatus,
  WaveFile,
  WaveVerification,
} from "./types";
import { resolveWaveScope } from "./waves";

export interface SpecRun {
  /** Repo-relative spec path. */
  spec: string;
  runner: E2eRunner;
  /** Mechanic IDs this spec's verdict applies to. */
  mechanicIds: string[];
  /** IDs linked via describe-title — Playwright runs scope to these via --grep. */
  grepIds: string[];
}

export interface VerifyPlan {
  e2e: SpecRun[];
  /** Non-destructive mechanics to drive via agent-browser against their ACs. */
  agent: ManifestMechanic[];
  /** Human-checklist mechanics (includes every `destructive: true` one). */
  manual: ManifestMechanic[];
  /** Mechanics skipped because an existing manual/agent entry stands. */
  skipped: string[];
}

export interface PlanOptions {
  only?: string[];
  /** Skip mechanics whose entry is already non-pending (any method). */
  resume?: boolean;
}

/** Partition a wave's scope into e2e/agent/manual work. */
export function planVerify(
  mechanics: ManifestMechanic[],
  wave: WaveFile,
  options: PlanOptions = {}
): VerifyPlan {
  let scoped = resolveWaveScope(wave, mechanics);
  if (options.only && options.only.length > 0) {
    const only = new Set(options.only);
    scoped = scoped.filter((m) => only.has(m.id));
  }

  const entryFor = new Map(wave.verifications.map((v) => [v.mechanic, v]));
  const skipped: string[] = [];
  const runnable: ManifestMechanic[] = [];
  for (const m of scoped) {
    const entry = entryFor.get(m.id);
    if (options.resume && entry && entry.status !== "pending") {
      skipped.push(m.id);
      continue;
    }
    if (entry && entry.method !== "e2e" && entry.status !== "pending") {
      // Standing manual/agent verdict — e2e re-runs must not clobber it.
      skipped.push(m.id);
      continue;
    }
    runnable.push(m);
  }

  const bySpec = new Map<string, SpecRun>();
  const agent: ManifestMechanic[] = [];
  const manual: ManifestMechanic[] = [];

  for (const m of runnable) {
    if (m.destructive) {
      manual.push(m);
      continue;
    }
    if (m.tests.length > 0) {
      for (const link of m.tests) {
        const run = bySpec.get(link.spec) ?? {
          spec: link.spec,
          runner: link.runner,
          mechanicIds: [],
          grepIds: [],
        };
        if (!run.mechanicIds.includes(m.id)) run.mechanicIds.push(m.id);
        if (link.via === "describe-title" && !run.grepIds.includes(m.id)) {
          run.grepIds.push(m.id);
        }
        bySpec.set(link.spec, run);
      }
      continue;
    }
    const hint = m.verify ?? (m.kind === "user-facing" ? "agent" : "manual-only");
    if (hint === "agent") {
      agent.push(m);
    } else {
      manual.push(m);
    }
  }

  const e2e = [...bySpec.values()].sort((a, b) => a.spec.localeCompare(b.spec));
  for (const run of e2e) {
    run.mechanicIds.sort();
    run.grepIds.sort();
  }
  return { e2e, agent, manual, skipped: skipped.sort() };
}

export interface SpecResult {
  spec: string;
  ok: boolean;
  mechanicIds: string[];
  /** Trailing process output, for fail notes. */
  outputTail: string;
}

export type SpecExecutor = (run: SpecRun) => Promise<SpecResult>;

/** Real executor: spawn the app's harness for one spec file. */
export function createSpecExecutor(
  appSlug: string,
  config: AppMechanicsConfig,
  repoRoot = REPO_ROOT
): SpecExecutor {
  const dir = appRootDir(appSlug, repoRoot);
  // Specs are recorded repo-relative; the harness runs from the app root, so
  // strip the app prefix — which is empty in a single-app repo.
  const prefix = appPath(appSlug, repoRoot);
  return async (run) => {
    const relSpec = prefix === "" ? run.spec : run.spec.replace(`${prefix}/`, "");
    const argv =
      run.runner === "playwright"
        ? [
            "bunx",
            "playwright",
            "test",
            relSpec,
            ...(config.playwrightConfig ? ["--config", config.playwrightConfig] : []),
            ...(run.grepIds.length > 0 ? ["--grep", run.grepIds.join("|")] : []),
          ]
        : ["bun", relSpec];

    const { code, output } = await execute(argv, dir);
    return {
      spec: run.spec,
      ok: code === 0,
      mechanicIds: run.mechanicIds,
      outputTail: output.split("\n").slice(-15).join("\n").trim(),
    };
  };
}

function execute(argv: string[], cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = argv;
    if (!cmd) {
      reject(new Error("empty command"));
      return;
    }
    const child = spawn(cmd, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.on("data", (d: Buffer) => {
      output += d.toString();
      process.stdout.write(d);
    });
    child.stderr?.on("data", (d: Buffer) => {
      output += d.toString();
      process.stderr.write(d);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

/**
 * Merge spec results into the wave. Per-mechanic verdict = AND over its
 * specs. Returns a NEW WaveFile; caller serializes via `waveYaml`.
 */
export function applySpecResults(
  wave: WaveFile,
  results: SpecResult[],
  options: { verifiedBy: string; date: string }
): WaveFile {
  const perMechanic = new Map<string, { ok: boolean; specs: string[]; tails: string[] }>();
  for (const res of results) {
    for (const id of res.mechanicIds) {
      const agg = perMechanic.get(id) ?? { ok: true, specs: [], tails: [] };
      agg.ok = agg.ok && res.ok;
      agg.specs.push(res.spec);
      if (!res.ok) agg.tails.push(`${res.spec}: ${res.outputTail.split("\n").at(-1) ?? "failed"}`);
      perMechanic.set(id, agg);
    }
  }

  const verifications = [...wave.verifications];
  for (const [mechanic, agg] of perMechanic) {
    const existing = verifications.find((v) => v.mechanic === mechanic);
    if (existing && existing.method !== "e2e" && existing.status !== "pending") {
      continue; // standing manual/agent verdict
    }
    const next: WaveVerification = {
      mechanic,
      status: agg.ok ? "pass" : "fail",
      method: "e2e",
      evidence: agg.specs.sort().join(", "),
      verifiedBy: options.verifiedBy,
      verifiedAt: options.date,
      ...(agg.ok ? {} : { note: agg.tails.join(" | ").slice(0, 300) }),
    };
    if (existing) {
      verifications[verifications.indexOf(existing)] = next;
    } else {
      verifications.push(next);
    }
  }

  return { ...wave, verifications };
}

export interface SetOptions {
  mechanic: string;
  status: VerificationStatus;
  method: VerificationMethod;
  evidence?: string;
  verifiedBy: string;
  date: string;
  failedCriteria?: string[];
  note?: string;
}

/** Deliberate human/agent check-off — may overwrite anything. */
export function setVerification(wave: WaveFile, opts: SetOptions): WaveFile {
  const next: WaveVerification = {
    mechanic: opts.mechanic,
    status: opts.status,
    method: opts.method,
    ...(opts.evidence !== undefined ? { evidence: opts.evidence } : {}),
    verifiedBy: opts.verifiedBy,
    verifiedAt: opts.date,
    ...(opts.failedCriteria !== undefined ? { failedCriteria: opts.failedCriteria } : {}),
    ...(opts.note !== undefined ? { note: opts.note } : {}),
  };
  const verifications = [...wave.verifications];
  const idx = verifications.findIndex((v) => v.mechanic === opts.mechanic);
  if (idx >= 0) {
    verifications[idx] = next;
  } else {
    verifications.push(next);
  }
  return { ...wave, verifications };
}

/** Persist a wave file (canonical serialization, sorted entries). */
export async function writeWave(
  appSlug: string,
  wave: WaveFile,
  repoRoot = REPO_ROOT
): Promise<string> {
  const { waveYaml, waveFilePath } = await import("./waves");
  const p = waveFilePath(appSlug, wave.wave, repoRoot);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, waveYaml(wave), "utf8");
  return p;
}
