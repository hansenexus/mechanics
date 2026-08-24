/**
 * Small fs/glob helpers shared by discover + coverage. Node-only APIs (no Bun
 * globals) so vitest can exercise everything against fixture trees.
 */

import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repo-root marker: the file that says "mechanics runs here, laid out like this". */
export const CONFIG_FILENAME = "mechanics.config.yaml";

/**
 * Nearest ancestor of `from` holding a `mechanics.config.yaml`, or null.
 *
 * The walk stops at a working-tree root — a directory holding `.git`, whether
 * that is a directory (primary checkout) or a file (linked worktree). Without
 * that fence, a worktree living under `<primary>/.claude/worktrees/…` on a
 * branch that predates the config would keep walking, find the PRIMARY
 * checkout's config, and silently answer about the wrong tree.
 */
export function findRepoRoot(from: string): string | null {
  let dir = path.resolve(from);
  for (;;) {
    if (existsSync(path.join(dir, CONFIG_FILENAME))) return dir;
    if (existsSync(path.join(dir, ".git"))) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The repo mechanics is operating on.
 *
 * Resolved from the *working directory* up, not from this module's location:
 * the CLI has to be able to run against a repo that merely depends on it — the
 * whole point of the extraction — and a module-relative root would always
 * answer "the repo I was installed into".
 */
// fileURLToPath instead of Bun's `import.meta.dir` so vitest (Node) can import this too.
const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const REPO_ROOT = findRepoRoot(process.cwd()) ?? MODULE_ROOT;

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Directories never worth descending into. */
const PRUNE_DIRS = new Set(["node_modules", ".next", ".turbo", ".git", "dist", "src-tauri"]);

/**
 * Recursively list files under `dir` as sorted /-separated paths relative to
 * `dir`, pruning build/dependency directories during the walk (an app's
 * `node_modules`/`.next` would otherwise dominate the traversal).
 */
export async function listFilesRecursive(dir: string): Promise<string[]> {
  if (!(await pathExists(dir))) return [];
  const files: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!PRUNE_DIRS.has(entry.name)) await walk(childRel);
      } else if (entry.isFile()) {
        files.push(childRel);
      }
    }
  };
  await walk("");
  return files.sort();
}

/**
 * Convert a glob to a RegExp. Supports `**` (any depth), `*` (within one
 * segment), and `?`. Enough for coverage ignore-globs, `paths` claims, and
 * `testGlobs` — not a full minimatch.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches zero or more whole segments; bare `**` matches anything.
        if (glob[i + 2] === "/") {
          re += "(?:[^/]+/)*";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c !== undefined && /[.+^${}()|[\]\\]/.test(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAnyGlob(value: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(value));
}
