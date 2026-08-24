/**
 * Wave loading + rollup math. Waves live at
 * `apps/<app>/mechanics/waves/<slug>.yaml`, are hand/tool-edited, and are
 * deliberately NOT part of the manifest — consumers (dashboard, CLI) read
 * them directly. Pure fs + YAML: safe to import from Next server components.
 *
 * Scope semantics: start from all non-deprecated mechanics; `areas`/`kinds`
 * filter when non-empty; `ids` are explicit additions on top; `exclude` always
 * wins. Absent verification entry = `pending`. A wave verifies the app AS IT
 * STANDS — mechanics added mid-wave grow the denominator by design.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { pathExists, REPO_ROOT } from "./fsutil";
import { appPath } from "./layout";
import { formatZodError, waveFileSchema } from "./schema";
import type { ManifestMechanic, VerificationStatus, WaveFile, WaveSummary } from "./types";

export function wavesDir(appSlug: string, repoRoot = REPO_ROOT): string {
  return path.join(repoRoot, appPath(appSlug, repoRoot, "mechanics", "waves"));
}

export function waveFilePath(appSlug: string, waveSlug: string, repoRoot = REPO_ROOT): string {
  return path.join(wavesDir(appSlug, repoRoot), `${waveSlug}.yaml`);
}

export interface LoadedWaves {
  waves: WaveFile[];
  errors: string[];
}

/** Load + validate every wave file, newest-first by slug. */
export async function loadWaves(appSlug: string, repoRoot = REPO_ROOT): Promise<LoadedWaves> {
  const dir = wavesDir(appSlug, repoRoot);
  const errors: string[] = [];
  const waves: WaveFile[] = [];
  if (!(await pathExists(dir))) return { waves, errors };

  const files = (await fs.readdir(dir))
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .reverse();
  for (const file of files) {
    const rel = appPath(appSlug, repoRoot, "mechanics", "waves", file);
    try {
      const parsed = waveFileSchema.safeParse(
        YAML.parse(await fs.readFile(path.join(dir, file), "utf8"))
      );
      if (!parsed.success) {
        for (const line of formatZodError(parsed.error)) errors.push(`${rel}: ${line}`);
        continue;
      }
      const wave = parsed.data;
      if (`${wave.wave}.yaml` !== file) {
        errors.push(`${rel}: 'wave: ${wave.wave}' must equal the filename stem`);
      }
      const seen = new Set<string>();
      for (const v of wave.verifications) {
        if (seen.has(v.mechanic)) errors.push(`${rel}: duplicate entry for ${v.mechanic}`);
        seen.add(v.mechanic);
      }
      waves.push(wave);
    } catch (err) {
      errors.push(`${rel}: unparseable YAML (${err instanceof Error ? err.message : err})`);
    }
  }
  return { waves, errors };
}

export async function loadWave(
  appSlug: string,
  waveSlug: string,
  repoRoot = REPO_ROOT
): Promise<WaveFile | null> {
  const { waves } = await loadWaves(appSlug, repoRoot);
  return waves.find((w) => w.wave === waveSlug) ?? null;
}

/** Resolve which mechanics a wave covers (deprecated docs never in scope). */
export function resolveWaveScope(
  wave: WaveFile,
  mechanics: ManifestMechanic[]
): ManifestMechanic[] {
  const live = mechanics.filter((m) => m.status !== "deprecated");
  const byId = new Map(live.map((m) => [m.id, m]));

  let scoped = live;
  if (wave.scope.areas.length > 0) {
    scoped = scoped.filter((m) => wave.scope.areas.includes(m.area));
  }
  if (wave.scope.kinds.length > 0) {
    scoped = scoped.filter((m) => wave.scope.kinds.includes(m.kind));
  }
  const ids = new Set(scoped.map((m) => m.id));
  for (const id of wave.scope.ids) {
    if (byId.has(id)) ids.add(id);
  }
  for (const id of wave.scope.exclude) {
    ids.delete(id);
  }
  return live.filter((m) => ids.has(m.id));
}

const STATUSES: VerificationStatus[] = ["pending", "pass", "fail", "blocked", "n-a"];

/** Roll one wave up against the current corpus. Absent entry = pending. */
export function summarizeWave(wave: WaveFile, mechanics: ManifestMechanic[]): WaveSummary {
  const scoped = resolveWaveScope(wave, mechanics);
  const scopeIds = new Set(scoped.map((m) => m.id));
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<
    VerificationStatus,
    number
  >;

  const entryFor = new Map(wave.verifications.map((v) => [v.mechanic, v]));
  for (const id of scopeIds) {
    const entry = entryFor.get(id);
    counts[entry?.status ?? "pending"]++;
  }

  const scopeSize = scopeIds.size;
  const verified = counts.pass + counts["n-a"];
  return {
    slug: wave.wave,
    title: wave.title,
    status: wave.status,
    startedAt: wave.startedAt,
    scopeSize,
    counts,
    verifiedRatio: scopeSize === 0 ? 0 : verified / scopeSize,
    links: wave.links,
  };
}

/**
 * Wave-level `check` findings: entries referencing unknown mechanics, scope
 * filters matching nothing, and the closed-wave invariant (a closed wave may
 * not still have pending/fail entries in scope).
 */
export function validateWaveAgainstCorpus(
  wave: WaveFile,
  mechanics: ManifestMechanic[],
  appSlug: string,
  repoRoot = REPO_ROOT
): string[] {
  const errors: string[] = [];
  const rel = appPath(appSlug, repoRoot, "mechanics", "waves", `${wave.wave}.yaml`);
  const known = new Set(mechanics.map((m) => m.id));
  const aliasToId = new Map<string, string>();
  for (const m of mechanics) {
    for (const alias of m.aliases) aliasToId.set(alias, m.id);
  }

  for (const v of wave.verifications) {
    if (!known.has(v.mechanic)) {
      const renamed = aliasToId.get(v.mechanic);
      errors.push(
        renamed
          ? `${rel}: entry ${v.mechanic} was renamed to ${renamed} — update the entry`
          : `${rel}: entry references unknown mechanic ${v.mechanic}`
      );
    }
  }
  for (const area of wave.scope.areas) {
    if (!mechanics.some((m) => m.area === area)) {
      errors.push(`${rel}: scope area "${area}" matches no mechanics`);
    }
  }
  for (const id of [...wave.scope.ids, ...wave.scope.exclude]) {
    if (!known.has(id)) {
      errors.push(`${rel}: scope references unknown mechanic ${id}`);
    }
  }

  if (wave.status === "closed") {
    const summary = summarizeWave(wave, mechanics);
    const open = summary.counts.pending + summary.counts.fail + summary.counts.blocked;
    if (open > 0) {
      errors.push(
        `${rel}: wave is closed but ${open} in-scope mechanic(s) are still pending/fail/blocked`
      );
    }
  }
  return errors;
}

/** Canonical YAML serialization for tool-written wave files. */
export function waveYaml(wave: WaveFile): string {
  const ordered: WaveFile = {
    wave: wave.wave,
    title: wave.title,
    status: wave.status,
    startedAt: wave.startedAt,
    ...(wave.closedAt !== undefined ? { closedAt: wave.closedAt } : {}),
    ...(wave.baselineSha !== undefined ? { baselineSha: wave.baselineSha } : {}),
    scope: wave.scope,
    links: wave.links,
    ...(wave.notes !== undefined ? { notes: wave.notes } : {}),
    verifications: [...wave.verifications].sort((a, b) => a.mechanic.localeCompare(b.mechanic)),
  };
  return YAML.stringify(ordered, { lineWidth: 100 });
}
