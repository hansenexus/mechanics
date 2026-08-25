/**
 * Find the repos on this machine, and say which could be onboarded.
 *
 * Onboarding is per-repo and always has been: you `cd` somewhere and run
 * `mechanics init`. That is fine for the first repo and useless for the
 * twentieth, because the hard part is not running init — it is knowing which
 * of the directories on your disk are even candidates.
 *
 * **The load-bearing part is worktree dedupe.** A `git worktree` shares its
 * primary's history and, more to the point here, its committed
 * `mechanics.config.yaml`. On the machine this was written for,
 * `~/repos` holds 21 primary checkouts and 26 linked worktrees, and one
 * monorepo accounts for 10 of them — so a scanner that treats every `.git` as
 * a repo reports that project eleven times and puts the estate at 47. Both
 * numbers are wrong in a way that looks authoritative.
 *
 * Detection is `init.ts`'s `detect`, imported rather than reimplemented. Two
 * detection implementations is two answers, and the one that drifts is always
 * the one nobody is looking at.
 *
 * **This module must never import `REPO_ROOT`.** That constant
 * (`fsutil.ts`) is computed once at import time from `process.cwd()` and
 * cannot be re-pointed, so a multi-repo caller that reaches for it silently
 * answers about whichever repo it happened to start in. Every root here is a
 * parameter.
 */

import {
  type Dirent,
  existsSync,
  promises as fs,
  readFileSync,
  type Stats,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Detection, detect, type InitResult, init } from "./init";

/** Never worth descending into, and expensive to walk. */
const PRUNE = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  "Library",
  "Applications",
]);

/** A mistyped `--root=/` must not walk the disk. */
const MAX_DIRS = 4000;

export const CONFIG_FILENAME = "mechanics.config.yaml";

export interface ScanOptions {
  roots: string[];
  /** How far below each root to look. 2 covers `~/repos/*` and `~/src/<org>/*`. */
  depth?: number;
}

export interface RepoEntry {
  /** Directory name of the primary checkout. */
  name: string;
  /** Absolute path of the primary checkout. */
  path: string;
  /** Linked worktrees found during this scan, absolute. */
  worktrees: string[];
  /** False when only worktrees were found and the primary is outside every root. */
  primaryPresent: boolean;
  onboarded: boolean;
  /** Apps found under a monorepo layout, or null for a single-app repo. */
  apps: { dir: string; slugs: string[] } | null;
  detection: Detection;
  /**
   * `ok` — a built-in adapter applies.
   * `needs-surfaces` — nothing matched, so the repo must declare its own
   *   surfaces by glob. This is a real state, not a blank: roughly half a
   *   typical estate (services, CLIs, anything not Next.js or Convex) lands
   *   here, and reporting it as an empty cell reads as "nothing to do".
   */
  status: "ok" | "needs-surfaces";
}

export interface ScanResult {
  roots: string[];
  repos: RepoEntry[];
  /**
   * Worktrees whose primary could not be resolved — an unusual git layout
   * rather than a bug. Reported rather than dropped: a worktree nobody can
   * trace back is exactly the stray checkout worth knowing about.
   */
  orphanWorktrees: string[];
  /** True when the walk hit `MAX_DIRS` and stopped early. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// git layout
// ---------------------------------------------------------------------------

export type GitDir =
  | { kind: "primary" }
  | { kind: "worktree"; primary: string }
  | { kind: "worktree-unknown" };

/**
 * What kind of checkout this is, from the `.git` entry alone.
 *
 * A directory is a primary checkout. A FILE holds `gitdir: <path>`, and for a
 * linked worktree that path is `<primary>/.git/worktrees/<name>` — so the
 * primary is simply the part before `/.git/worktrees/`.
 *
 * Deliberately parsed rather than shelled out to `git rev-parse
 * --git-common-dir`: one subprocess per candidate is ~50 spawns on a normal
 * estate, and the whole posture of this tool is that a file on disk is enough.
 */
export function classifyGitDir(repoDir: string): GitDir | null {
  const dotGit = path.join(repoDir, ".git");
  let stat: Stats;
  try {
    stat = statSync(dotGit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return { kind: "primary" };

  let raw: string;
  try {
    raw = readFileSync(dotGit, "utf8");
  } catch {
    return { kind: "worktree-unknown" };
  }
  const m = raw.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!m?.[1]) return { kind: "worktree-unknown" };
  const target = m[1];
  const at = target.indexOf(`${path.sep}.git${path.sep}worktrees${path.sep}`);
  if (at < 0) {
    // A `--separate-git-dir` layout, or a submodule. Neither is a worktree of
    // something in this scan, and guessing a primary would invent a grouping.
    return { kind: "worktree-unknown" };
  }
  return { kind: "worktree", primary: target.slice(0, at) };
}

// ---------------------------------------------------------------------------
// the walk
// ---------------------------------------------------------------------------

/** Every directory holding a `.git`, at most `depth` below each root. */
export async function findCheckouts(
  roots: string[],
  depth: number
): Promise<{ dirs: string[]; truncated: boolean }> {
  const dirs: string[] = [];
  const seen = new Set<string>();
  let visited = 0;
  let truncated = false;

  const walk = async (dir: string, left: number): Promise<void> => {
    if (truncated) return;
    if (++visited > MAX_DIRS) {
      truncated = true;
      return;
    }
    let real: string;
    try {
      real = await fs.realpath(dir);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);

    if (existsSync(path.join(real, ".git"))) {
      // Stop here. A repo inside a repo is a submodule or a worktree, not a
      // separate thing to onboard.
      dirs.push(real);
      return;
    }
    if (left <= 0) return;

    let entries: Dirent[];
    try {
      entries = await fs.readdir(real, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (PRUNE.has(e.name) || e.name.startsWith(".")) continue;
      await walk(path.join(real, e.name), left - 1);
    }
  };

  for (const root of roots) await walk(path.resolve(root), depth);
  return { dirs: dirs.sort(), truncated };
}

/**
 * Where this repo's apps live, if it has a monorepo layout.
 *
 * `apps/` counts with a SINGLE child; `packages/` and `services/` need two.
 * The asymmetry is deliberate and was wrong the first time: a repo with one
 * `apps/<name>` next to fifteen `packages/*` is extremely common, and
 * requiring two apps made it fall through to `packages/`, where detection then
 * ran against a library and reported a Next.js + Convex app as having no
 * recognisable surfaces at all. `apps/` is a strong signal by name; the other
 * two are only a monorepo when there are several.
 */
async function detectApps(repoRoot: string): Promise<{ dir: string; slugs: string[] } | null> {
  for (const [name, min] of [
    ["apps", 1],
    ["packages", 2],
    ["services", 2],
  ] as const) {
    const dir = path.join(repoRoot, name);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const slugs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .filter((slug) => existsSync(path.join(dir, slug, "package.json")))
      .sort();
    if (slugs.length >= min) return { dir: name, slugs };
  }
  return null;
}

/**
 * Adapters across EVERY app, not just the first.
 *
 * A monorepo is a set of apps with different stacks; asking only the first one
 * reports whatever happens to sort earliest, which is a coin flip dressed as a
 * finding. The package manager and playwright config are repo-level enough to
 * take from the first app that has one.
 */
function detectAcrossApps(repoRoot: string, appRoots: string[]): Detection {
  const adapters = new Set<string>();
  let playwrightConfig: string | undefined;
  let packageManager: Detection["packageManager"] = "npm";
  for (const appRoot of appRoots) {
    const det = detect(appRoot, repoRoot);
    for (const a of det.adapters) adapters.add(a);
    playwrightConfig ??= det.playwrightConfig;
    if (det.packageManager !== "npm") packageManager = det.packageManager;
  }
  return { adapters: [...adapters].sort(), playwrightConfig, packageManager };
}

export async function scan(options: ScanOptions): Promise<ScanResult> {
  const depth = options.depth ?? 2;
  const { dirs, truncated } = await findCheckouts(options.roots, depth);

  const byPrimary = new Map<string, RepoEntry>();
  const orphanWorktrees: string[] = [];
  const worktreesOf = new Map<string, string[]>();
  const primaries: string[] = [];

  for (const dir of dirs) {
    const kind = classifyGitDir(dir);
    if (!kind) continue;
    if (kind.kind === "primary") primaries.push(dir);
    else if (kind.kind === "worktree") {
      worktreesOf.set(kind.primary, [...(worktreesOf.get(kind.primary) ?? []), dir]);
    } else orphanWorktrees.push(dir);
  }

  // A worktree whose primary lies outside every scan root still describes a
  // real project, so it gets a group keyed by that primary with
  // `primaryPresent: false` rather than vanishing.
  const allPrimaries = new Set([...primaries, ...worktreesOf.keys()]);

  for (const repoRoot of [...allPrimaries].sort()) {
    const apps = await detectApps(repoRoot);
    // Detect against the APPS, not the workspace root: a monorepo root holds
    // no routes or convex dir of its own, so detecting there reports every
    // monorepo as having nothing.
    const appRoots = apps
      ? apps.slugs.map((slug) => path.join(repoRoot, apps.dir, slug))
      : [repoRoot];
    const detection = detectAcrossApps(repoRoot, appRoots);
    byPrimary.set(repoRoot, {
      name: path.basename(repoRoot),
      path: repoRoot,
      worktrees: (worktreesOf.get(repoRoot) ?? []).sort(),
      primaryPresent: primaries.includes(repoRoot),
      onboarded: existsSync(path.join(repoRoot, CONFIG_FILENAME)),
      apps,
      detection,
      status: detection.adapters.length > 0 ? "ok" : "needs-surfaces",
    });
  }

  return {
    roots: options.roots.map((r) => path.resolve(r)),
    repos: [...byPrimary.values()],
    orphanWorktrees: orphanWorktrees.sort(),
    truncated,
  };
}

// ---------------------------------------------------------------------------
// roots
// ---------------------------------------------------------------------------

/**
 * Where to look, in precedence order: explicit flags, then the environment,
 * then the parent of the current repo.
 *
 * Deliberately NOT the home directory by default. Nothing in this tool reads
 * `os.homedir()` today, and a command that enumerates someone's whole disk on
 * first run is a surprise — anything wider than "the folder my repos live in"
 * has to be asked for. Equally deliberately not `mechanics.config.yaml`: that
 * file describes one repo and is committed, while scan roots are absolute
 * paths on one person's machine.
 */
export function resolveRoots(explicit: string[], cwd: string, env = process.env): string[] {
  if (explicit.length > 0) return explicit.map((r) => path.resolve(expandHome(r)));
  const fromEnv = (env.MECHANICS_SCAN_ROOTS ?? "")
    .split(path.delimiter)
    .map((r) => r.trim())
    .filter(Boolean);
  if (fromEnv.length > 0) return fromEnv.map((r) => path.resolve(expandHome(r)));
  return [path.dirname(nearestCheckout(cwd) ?? cwd)];
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith(`~${path.sep}`) ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Nearest ancestor holding a `.git`, or null. */
function nearestCheckout(from: string): string | null {
  let dir = path.resolve(from);
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// adopt
// ---------------------------------------------------------------------------

export interface AdoptOptions {
  /** Repo name as reported by the scan, or a path. */
  target: string;
  app?: string;
  /** Without this, the plan is printed and nothing is written. */
  yes?: boolean;
}

/**
 * Onboard exactly one repo, via the existing `init`.
 *
 * There is no adopt-all, and no interactive prompt even on a TTY. Naming the
 * repo is the first half of the confirmation and `--yes` is the second; a
 * command that behaves differently depending on whether stdin is a terminal is
 * a command you cannot safely put in a script.
 */
export async function adopt(result: ScanResult, options: AdoptOptions): Promise<InitResult> {
  const match =
    result.repos.find((r) => r.name === options.target) ??
    result.repos.find((r) => r.path === path.resolve(options.target));
  if (!match) {
    const names = result.repos
      .map((r) => r.name)
      .sort()
      .join(", ");
    throw new Error(`mechanics scan: no repo "${options.target}" in the scan — found: ${names}`);
  }
  if (!match.primaryPresent) {
    throw new Error(
      `mechanics scan: "${match.name}" was seen only as a linked worktree; its primary checkout ` +
        `is ${match.path}, which is outside the scanned roots. Adopt the primary.`
    );
  }
  return init({
    dir: match.path,
    app: options.app,
    ci: true,
    mcp: true,
    docket: true,
    dryRun: !options.yes,
  });
}
