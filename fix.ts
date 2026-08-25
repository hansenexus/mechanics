/**
 * Applying the mechanical gaps, and refusing everything else.
 *
 * Split the way `planDispatch`/`executeDispatch` and `planVerify`/its executor
 * are: `planAutoFix` is pure and decides WHAT, `applyAutoFix` does the IO. The
 * planner is where the safety argument lives, so it must be testable without a
 * repo.
 *
 * Three properties this module is responsible for, in descending order of how
 * badly their absence would hurt:
 *
 * 1. **The forbidden moves are refused in code, not in prose.** An agent
 *    reading a skill can be talked out of a rule. `assertNoForbiddenOp` throws.
 *
 * 2. **A mechanical fix can never leave the corpus red.** Every write is
 *    buffered, the manifest is rebuilt afterwards, and if the corpus stopped
 *    validating every byte is restored. A fix that can break `check` is not
 *    mechanical, whatever the planner believed.
 *
 * 3. **Edits are surgical text, never a YAML round-trip.** `matter.stringify`
 *    would reflow frontmatter and drop the comments a hand-authored corpus is
 *    largely made of. Each op below is defined so that exactly one line or one
 *    insertion point matches.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./fsutil";
import type { AutoOp, Gap } from "./gaps";
import { appDir, appPath } from "./layout";
import { buildManifest, emitManifest } from "./manifest";

export type AutoOpKind = AutoOp["kind"];

/** Every op kind, so a caller can spell an allow-list without a literal. */
export const AUTO_OP_KINDS: readonly AutoOpKind[] = [
  "add-paths",
  "narrow-ignore",
  "annotate-spec",
] as const;

/**
 * `annotate-spec` is the only op that writes APP SOURCE rather than the
 * corpus. That is a different blast radius and a different reviewer, so it is
 * off unless asked for by name.
 */
export const DEFAULT_ALLOWED_OPS: readonly AutoOpKind[] = ["add-paths", "narrow-ignore"] as const;

export interface AutoFixPlan {
  app: string;
  ops: AutoOp[];
  /** Gaps that were `auto` but are not being applied, with the reason. */
  deferred: Array<{ gap: Gap; reason: string }>;
}

export interface AutoFixResult {
  applied: AutoOp[];
  /** Repo-relative paths actually written. */
  written: string[];
  /** Set when the corpus stopped validating and everything was rolled back. */
  revertedBecause?: string;
  manifestChanged: boolean;
}

export interface PlanAutoFixOptions {
  allow?: readonly AutoOpKind[];
}

/**
 * Which auto ops to run.
 *
 * Two ops on one file are refused rather than ordered. Both edits are defined
 * against the file as it exists now, so applying them in sequence means the
 * second one is reasoning about a file that no longer matches its precondition
 * — and the failure would be silent. Re-running after the first lands is free.
 */
export function planAutoFix(
  app: string,
  gaps: Gap[],
  options: PlanAutoFixOptions = {}
): AutoFixPlan {
  const allow = new Set(options.allow ?? DEFAULT_ALLOWED_OPS);
  const ops: AutoOp[] = [];
  const deferred: AutoFixPlan["deferred"] = [];
  const claimedFile = new Set<string>();

  for (const gap of gaps) {
    if (gap.lane !== "auto" || !gap.op) continue;
    const op = gap.op;
    if (!allow.has(op.kind)) {
      deferred.push({ gap, reason: `op kind "${op.kind}" is not enabled` });
      continue;
    }
    if (claimedFile.has(op.file)) {
      deferred.push({
        gap,
        reason: `another op already edits ${op.file} — re-run after this pass`,
      });
      continue;
    }
    claimedFile.add(op.file);
    ops.push(op);
  }
  return { app, ops, deferred };
}

// ---------------------------------------------------------------------------
// The refusals
// ---------------------------------------------------------------------------

/**
 * Key for the before/after ignore maps. A named function rather than an inline
 * template: the separator has to be identical on both sides, and a stray
 * invisible character in one of two literals is a lookup that silently misses
 * — which turns the widening guard off without failing anything.
 */
export function ignoreKey(surfaceKind: string, glob: string): string {
  return `${surfaceKind}::${glob}`;
}

export interface ForbidContext {
  app: string;
  repoRoot: string;
  /** Repo-relative POSIX path of the app's corpus dir. */
  corpusDir: string;
  /** Items each ignore glob matches now, keyed `<kind> <glob>`. */
  ignoreMatchesBefore?: Map<string, string[]>;
  /** Items each ignore glob would match after the edit. */
  ignoreMatchesAfter?: Map<string, string[]>;
}

/**
 * The moves that turn a corpus into decoration, refused rather than
 * discouraged — the same choice `docket-events.ts` makes for a `pass` verdict
 * without evidence.
 *
 * Enforced HERE rather than trusted to the planner because the planner is one
 * caller among several: the CLI, a skill, and whatever an agent writes next.
 */
export function assertNoForbiddenOp(op: AutoOp, ctx: ForbidContext): void {
  const rel = op.file.split(path.sep).join("/");

  // 1. Never author a mechanic. Drafting behaviour nobody described is the
  //    single move this whole format exists to prevent.
  if (op.kind === "add-paths" && !rel.startsWith(`${ctx.corpusDir}/`) && ctx.corpusDir !== "") {
    throw new Error(
      `mechanics fix: refusing to edit "${rel}" — a mechanic edit must live under ${ctx.corpusDir}/`
    );
  }

  // 2. Never escape the app tree, whatever the planner produced.
  const abs = path.resolve(ctx.repoRoot, op.file);
  const root = appDir(ctx.app, ctx.repoRoot);
  if (rel.includes("..") || (!abs.startsWith(`${root}${path.sep}`) && abs !== root)) {
    throw new Error(`mechanics fix: refusing to write outside the app tree: ${rel}`);
  }

  // 3. Never widen an ignore glob. "Narrowing" is the only reason this op
  //    exists, and a widening wearing its name is the exact move that makes a
  //    gap disappear without anyone deciding it should.
  if (op.kind === "narrow-ignore") {
    const key = ignoreKey(op.surfaceKind, op.glob);
    const before = ctx.ignoreMatchesBefore?.get(key);
    const after = ctx.ignoreMatchesAfter?.get(key) ?? op.literals;
    if (before) {
      const allowed = new Set(before);
      const widened = after.filter((i) => !allowed.has(i));
      if (widened.length > 0) {
        throw new Error(
          `mechanics fix: refusing to widen ignore "${op.glob}" — it would newly excuse ${widened.join(", ")}`
        );
      }
    }
    if (op.literals.length === 0) {
      throw new Error(
        `mechanics fix: refusing to replace ignore "${op.glob}" with nothing — deleting an ignore is a judgment`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The edits
// ---------------------------------------------------------------------------

/**
 * Insert a `paths:` block just before the frontmatter's closing `---`.
 *
 * The planner only emits this op when `paths:` is absent, so there is nothing
 * to merge with — which is what makes a textual insert safe here and unsafe in
 * general.
 */
export function insertPaths(source: string, paths: string[]): string {
  const lines = source.split("\n");
  if (lines[0]?.trim() !== "---") throw new Error("expected frontmatter to open on line 1");
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (close < 0) throw new Error("frontmatter has no closing ---");
  if (lines.slice(1, close).some((l) => /^paths\s*:/.test(l))) {
    throw new Error("frontmatter already declares paths:");
  }
  const block = ["paths:", ...paths.map((p) => `  - "${p}"`)];
  return [...lines.slice(0, close), ...block, ...lines.slice(close)].join("\n");
}

/**
 * Replace the one list-item line holding `glob` with its literal members.
 *
 * Requires exactly one match: a glob written twice in one config is already
 * ambiguous, and picking one occurrence would edit a line the reader was not
 * looking at.
 */
export function narrowIgnoreGlob(source: string, glob: string, literals: string[]): string {
  const lines = source.split("\n");
  const hits: number[] = [];
  lines.forEach((line, i) => {
    const m = line.match(/^(\s*)-\s*(.*?)\s*$/);
    if (!m) return;
    const value = (m[2] ?? "").replace(/^["']|["']$/g, "");
    if (value === glob) hits.push(i);
  });
  if (hits.length !== 1) {
    throw new Error(
      `expected exactly one list entry for "${glob}", found ${hits.length} — narrow it by hand`
    );
  }
  const at = hits[0] as number;
  const indent = (lines[at]?.match(/^(\s*)-/)?.[1] ?? "  ") as string;
  return [
    ...lines.slice(0, at),
    ...literals.map((l) => `${indent}- "${l}"`),
    ...lines.slice(at + 1),
  ].join("\n");
}

/**
 * Prepend the annotation. `ANNOTATION_RE` is position-independent, so the only
 * constraint is not landing above a shebang — which would stop the file being
 * executable and is the kind of breakage a "mechanical" fix must never cause.
 */
export function annotateSpec(source: string, mechanicId: string): string {
  const marker = `// @mechanic ${mechanicId}`;
  if (source.includes(marker)) return source;
  const lines = source.split("\n");
  const at = lines[0]?.startsWith("#!") ? 1 : 0;
  return [...lines.slice(0, at), marker, ...lines.slice(at)].join("\n");
}

function applyOp(op: AutoOp, before: string): string {
  switch (op.kind) {
    case "add-paths":
      return insertPaths(before, op.paths);
    case "narrow-ignore":
      return narrowIgnoreGlob(before, op.glob, op.literals);
    case "annotate-spec":
      return annotateSpec(before, op.mechanic);
  }
}

// ---------------------------------------------------------------------------
// The executor
// ---------------------------------------------------------------------------

export interface ApplyOptions {
  dryRun?: boolean;
  /** Skip the rebuild + rollback. Only for tests that assert the guard itself. */
  skipVerify?: boolean;
}

/**
 * Write the plan, then prove the corpus still validates.
 *
 * Ops are resolved against the APP root, not the repo root: `op.file` comes
 * from the manifest (`m.source`) and the app-relative file walk, both of which
 * are app-relative. The corpus dir is repo-relative, so it is normalised here
 * rather than at every call site.
 */
export async function applyAutoFix(
  plan: AutoFixPlan,
  repoRoot = REPO_ROOT,
  options: ApplyOptions = {}
): Promise<AutoFixResult> {
  const corpusDir = appPath(plan.app, repoRoot, "mechanics");
  const root = appDir(plan.app, repoRoot);
  const ctx: ForbidContext = { app: plan.app, repoRoot, corpusDir };

  const resolve = (rel: string) => {
    // A corpus path is repo-relative; everything else is app-relative. Both
    // must land inside the app tree, which `assertNoForbiddenOp` re-checks.
    const asRepo = path.resolve(repoRoot, rel);
    return asRepo.startsWith(`${root}${path.sep}`) || asRepo === root
      ? asRepo
      : path.resolve(root, rel);
  };

  const originals = new Map<string, string>();
  const written: string[] = [];
  const applied: AutoOp[] = [];

  for (const op of plan.ops) {
    const abs = resolve(op.file);
    assertNoForbiddenOp({ ...op, file: path.relative(repoRoot, abs) }, ctx);
    const before = await fs.readFile(abs, "utf8");
    const after = applyOp(op, before);
    if (after === before) continue;
    originals.set(abs, before);
    if (!options.dryRun) await fs.writeFile(abs, after, "utf8");
    written.push(op.file);
    applied.push(op);
  }

  if (options.dryRun || options.skipVerify || applied.length === 0) {
    return { applied, written, manifestChanged: false };
  }

  // The whole justification for the auto lane is that these edits cannot make
  // things worse. Prove it rather than asserting it.
  const { manifest, errors } = await buildManifest(plan.app, repoRoot);
  if (errors.length > 0) {
    await Promise.all([...originals].map(([abs, before]) => fs.writeFile(abs, before, "utf8")));
    return {
      applied: [],
      written: [],
      manifestChanged: false,
      revertedBecause: errors[0],
    };
  }

  // An auto-fix that leaves the manifest stale breaks the drift gate, which is
  // a worse problem than the gap it just closed.
  const emit = await emitManifest(manifest, { repoRoot });
  return { applied, written, manifestChanged: emit.changed };
}
