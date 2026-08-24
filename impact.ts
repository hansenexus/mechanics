/**
 * Changed files → the mechanics that document them.
 *
 * The question this answers is "I touched these files; whose documented
 * behaviour might I have broken?" — asked by the CLI before a wave, and by an
 * agent through the MCP before it opens a PR.
 *
 * Two mechanisms, and the difference matters:
 *
 * 1. **`paths:` globs.** Universal, explicit, and the only one that works for
 *    any stack. A mechanic saying which files implement it is the honest
 *    answer to this question.
 * 2. **Surface heuristics.** A changed `page.tsx` implies its route; a changed
 *    `convex/things.ts` implies `things.*`. These are conveniences for the two
 *    built-in adapters, not a general mechanism — a mechanic that claims a
 *    route but lists no `paths` is still found. When adapters grow a
 *    `itemForFile` hook these move behind it; until then they are named as
 *    what they are rather than pretending to be general.
 */

import { claimMatches, pageFileToRoute } from "./coverage";
import { globToRegExp } from "./fsutil";
import type { ManifestMechanic, MechanicsManifest } from "./types";

export interface ImpactHit {
  id: string;
  title: string;
  /** Why it matched — a file path, `route /x`, or `convex things`. */
  reasons: string[];
}

export interface ImpactResult {
  /** Changed files inside the app, the only ones considered. */
  changedFiles: string[];
  /** Sorted by id; empty when the diff touches nothing documented. */
  hits: ImpactHit[];
}

/**
 * `appPrefix` is the app's repo-relative directory (`apps/console`), or `""`
 * in a single-app repo where every changed file is in scope. It is passed in
 * rather than derived so this stays pure — the MCP calls it with a manifest it
 * read off disk and nothing else.
 */
export function mapImpact(
  manifest: MechanicsManifest,
  appPrefix: string,
  changedFiles: string[]
): ImpactResult {
  const under = (rest: string) => (appPrefix === "" ? rest : `${appPrefix}/${rest}`);
  const scoped =
    appPrefix === "" ? changedFiles : changedFiles.filter((f) => f.startsWith(`${appPrefix}/`));
  const reasons = new Map<string, Set<string>>();
  const note = (m: ManifestMechanic, why: string) => {
    const set = reasons.get(m.id) ?? new Set<string>();
    set.add(why);
    reasons.set(m.id, set);
  };

  for (const file of scoped) {
    for (const m of manifest.mechanics) {
      if (m.paths.some((glob) => globToRegExp(glob).test(file))) note(m, file);

      // Heuristic 1: a page file is its route.
      if (/\/page\.tsx?$/.test(file) && file.includes("/src/app/")) {
        const route = pageFileToRoute(
          file.replace(under("src/app/"), "").replace(/\/page\.tsx?$/, "/page.tsx")
        );
        if ((m.claims.route ?? []).some((r) => claimMatches(r, route))) note(m, `route ${route}`);
      }

      // Heuristic 2: a convex module owns every `<module>.<export>` under it.
      const convexMatch = file.match(new RegExp(`^${escapeRe(under("convex"))}/(.+)\\.ts$`));
      if (convexMatch?.[1] && !convexMatch[1].startsWith("_generated")) {
        const base = convexMatch[1];
        if ((m.claims["convex-function"] ?? []).some((fn) => fn.startsWith(`${base}.`))) {
          note(m, `convex ${base}`);
        }
      }
    }
  }

  const byId = new Map(manifest.mechanics.map((m) => [m.id, m]));
  const hits: ImpactHit[] = [...reasons.entries()]
    .map(([id, why]) => ({
      id,
      title: byId.get(id)?.title ?? id,
      reasons: [...why].sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return { changedFiles: scoped, hits };
}

/** The prefix is a path, not a pattern — escape it before it becomes one. */
function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
