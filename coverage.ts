/**
 * Coverage: cross-check what mechanics CLAIM against what the app actually
 * SHIPS. Every inventory item ends up `claimed` (≥1 mechanic), `ignored`
 * (matches a `_config.yaml` ignore glob), or `unclaimed` (a documentation gap).
 *
 * *What* an app ships is no longer decided here — that moved behind
 * `SurfaceAdapter` (`adapters.ts`), so a project whose surfaces are not page
 * routes and Convex functions can still use this. What stayed here is the
 * comparison itself, which is the part that never varies by stack.
 */

import {
  type AdapterContext,
  buildInventory,
  type Inventory,
  type SurfaceAdapter,
} from "./adapters";
import { globToRegExp, listFilesRecursive, matchesAnyGlob, REPO_ROOT } from "./fsutil";
import { appAdapters, appDir, appPath } from "./layout";
import type { AppMechanicsConfig, CoverageBucket, CoverageReport, MechanicDoc } from "./types";

/** Route helpers live with the adapter that owns them; re-exported so existing
 * importers (the CLI's screens command, tests) keep working. */
export { normalizeRoutePattern, pageFileToRoute } from "./adapters";

export interface CoverageResult {
  report: CoverageReport;
  /** Frontmatter claims that resolve to nothing in the inventory — errors. */
  danglingClaims: string[];
  /** `paths` globs that match zero files — warnings. */
  emptyPathGlobs: string[];
}

/** One claim, kept with the doc that made it so errors can name the file. */
interface ClaimRef {
  claim: string;
  doc: MechanicDoc;
}

/**
 * Walk the app once and run every adapter against it. Which adapters those are
 * is the app's own declaration (`mechanics.config.yaml`), not a global default:
 * a repo may hold a Next.js app and a Go service and want different answers.
 */
export async function inventoryAppKinds(
  appSlug: string,
  repoRoot = REPO_ROOT,
  adapters?: SurfaceAdapter[]
): Promise<Inventory> {
  const dir = appDir(appSlug, repoRoot);
  const ctx: AdapterContext = {
    appSlug,
    appDir: dir,
    repoRoot,
    files: await listFilesRecursive(dir),
  };
  return buildInventory(adapters ?? appAdapters(appSlug, repoRoot), ctx);
}

/**
 * Just the page routes.
 *
 * Screenshot capture and route scaffolding are genuinely route-shaped — you
 * cannot photograph a cron — so they get a named helper rather than reaching
 * into the kind map. An app with no `route` kind gets an empty list, which is
 * the correct answer for it.
 */
export async function inventoryRoutes(appSlug: string, repoRoot = REPO_ROOT): Promise<string[]> {
  const { items } = await inventoryAppKinds(appSlug, repoRoot);
  return items.route ?? [];
}

/**
 * Does `claim` cover `item`? Exact match, or a `<prefix>/*` subtree claim
 * which covers the prefix itself and everything below it.
 */
export function claimMatches(claim: string, item: string): boolean {
  if (claim === item) return true;
  if (claim.endsWith("/*")) {
    const prefix = claim.slice(0, -2);
    return item === prefix || item.startsWith(`${prefix}/`);
  }
  return false;
}

/** Compute the coverage report + claim validity for one app. */
export async function computeCoverage(
  docs: MechanicDoc[],
  inventory: Inventory,
  config: AppMechanicsConfig,
  appSlug: string,
  repoRoot = REPO_ROOT
): Promise<CoverageResult> {
  const danglingClaims: string[] = [];

  const bucket = (items: string[], claims: ClaimRef[], ignoreGlobs: string[]): CoverageBucket => {
    const claimedSet = new Set<string>();
    for (const item of items) {
      if (claims.some(({ claim }) => claimMatches(claim, item))) {
        claimedSet.add(item);
      }
    }
    const unclaimed: string[] = [];
    let ignored = 0;
    for (const item of items) {
      if (claimedSet.has(item)) continue;
      if (matchesAnyGlob(item, ignoreGlobs)) {
        ignored++;
      } else {
        unclaimed.push(item);
      }
    }
    return { total: items.length, claimed: claimedSet.size, ignored, unclaimed: unclaimed.sort() };
  };

  const labels = new Map(inventory.kinds.map((k) => [k.kind, k.label]));
  const byKind = new Map<string, ClaimRef[]>();
  for (const doc of docs) {
    for (const [kind, claims] of Object.entries(doc.frontmatter.claims)) {
      const list = byKind.get(kind) ?? [];
      for (const claim of claims) list.push({ claim, doc });
      byKind.set(kind, list);
    }
  }

  // A claim under a kind nothing provides is its own failure and needs its own
  // words: "claims route X which does not exist" would send you looking for the
  // route, when the actual problem is that no adapter reports routes at all.
  for (const [kind, claims] of byKind) {
    if (labels.has(kind)) continue;
    const known = inventory.kinds.map((k) => k.kind).join(", ") || "(none)";
    for (const { claim, doc } of claims) {
      danglingClaims.push(
        `${doc.source}: claims "${claim}" under unknown surface kind "${kind}" — this app's adapters provide: ${known}`
      );
    }
  }

  // Sorted keys: the manifest must be byte-stable regardless of adapter order.
  const report: CoverageReport = {};
  for (const kind of [...inventory.kinds].sort((a, b) => a.kind.localeCompare(b.kind))) {
    const items = inventory.items[kind.kind] ?? [];
    const claims = byKind.get(kind.kind) ?? [];
    for (const { claim, doc } of claims) {
      if (!items.some((item) => claimMatches(claim, item))) {
        danglingClaims.push(`${doc.source}: claims ${kind.label} "${claim}" which does not exist`);
      }
    }
    report[kind.kind] = bucket(items, claims, config.coverage.ignore[kind.kind] ?? []);
  }

  // `paths` globs are repo-relative; validate the ones inside this app's tree.
  // In a single-app repo the app root IS the repo root, so the prefix is empty
  // and every glob is in scope — which is the correct reading there.
  const emptyPathGlobs: string[] = [];
  const appRel = appPath(appSlug, repoRoot);
  const appPrefix = appRel === "" ? "" : `${appRel}/`;
  const appFiles = await listFilesRecursive(appDir(appSlug, repoRoot));
  for (const doc of docs) {
    for (const glob of doc.frontmatter.paths) {
      if (!glob.startsWith(appPrefix)) continue;
      const re = globToRegExp(glob.slice(appPrefix.length));
      if (!appFiles.some((f) => re.test(f))) {
        emptyPathGlobs.push(`${doc.source}: paths glob "${glob}" matches no files`);
      }
    }
  }

  return { report, danglingClaims, emptyPathGlobs };
}
