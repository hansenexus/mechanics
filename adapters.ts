/**
 * Surface adapters — what an app *ships*, discovered per surface kind.
 *
 * Coverage compares what mechanics CLAIM against what the app SHIPS. Until now
 * the second half was five hardcoded inventories (page routes, API routes,
 * Convex functions, crons, Convex HTTP endpoints) baked straight into
 * `coverage.ts`. That is exactly right for this monorepo and useless anywhere
 * else: a Rails app, a Go service or an Expo project ships nothing that fits
 * those five names, and had no way to say so.
 *
 * An adapter is the seam. It declares the kinds it knows how to find and
 * returns the items it found; everything downstream — coverage buckets, claim
 * validation, the manifest — keys off adapter-declared kinds instead of a fixed
 * list. Adding a surface stops meaning "edit five files in the core".
 *
 * Three ship in the box:
 *
 *   nextjs-app-router  route, api-route
 *   convex             convex-function, cron, http-endpoint
 *   generic-glob       whatever the config declares, matched by glob
 *
 * The first two reproduce the previous behaviour item for item — the proof is
 * that every committed manifest stays byte-identical across this change.
 *
 * Scanning stays regex-based on purpose. A real parse would catch exotic export
 * styles that regexes miss, at the cost of a TypeScript program per app; the
 * misses fall through as unclaimed items, which is visible and cheap to absorb
 * with an ignore glob. A build that takes a minute is a build nobody runs.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { matchesAnyGlob, pathExists } from "./fsutil";

/** One surface an adapter can enumerate. */
export interface SurfaceKind {
  /** Stable, kebab-case, singular: `route`, `api-route`, `convex-function`. */
  kind: string;
  /** Used in error prose: `claims route "/x" which does not exist`. */
  label: string;
  /**
   * Frontmatter key mechanics claim this kind under, while claims are still
   * flat (`routes:`, `convexFunctions:`). Kind-keyed claims land with
   * `core:config`; until then this is the bridge, and dropping it is the
   * migration.
   */
  legacyClaimKey?: string;
}

/**
 * What an adapter gets. `files` is walked once by the caller and shared: five
 * adapters each walking a Next.js app independently is five times the I/O for
 * one answer.
 */
export interface AdapterContext {
  appSlug: string;
  /** Absolute path to the app root. */
  appDir: string;
  /** Absolute repo root — for cross-package lookups like the routes manifest. */
  repoRoot: string;
  /** Every file under `appDir`, app-relative, `node_modules` already pruned. */
  files: string[];
}

export interface SurfaceAdapter {
  /** Stable id, used in config and diagnostics. */
  name: string;
  kinds: SurfaceKind[];
  /**
   * Items found, keyed by kind. A kind the adapter declares but does not find
   * may be omitted — `buildInventory` fills the gap, so consumers never have to
   * handle `undefined`.
   */
  inventory(ctx: AdapterContext): Promise<Record<string, string[]>>;
  /**
   * The reverse of `inventory`: item → the source file(s) that produced it,
   * keyed by kind. Used to fill a mechanic's `paths:` from its claims, which
   * is what makes `mechanics impact` able to answer "I touched these files,
   * whose behaviour did I break?" for a stack it has no heuristics for.
   *
   * Optional, and an adapter that cannot answer honestly must answer NOTHING
   * — omit the kind, or omit the item. A guessed implementing file does not
   * stay a guess: it lands in a mechanic's `paths:`, `check` then blesses it,
   * and the corpus has quietly recorded a fact nobody established.
   */
  provenance?(ctx: AdapterContext): Promise<Record<string, Record<string, string[]>>>;
}

export interface Inventory {
  /** Every kind any adapter declared, in adapter order. */
  kinds: SurfaceKind[];
  /** kind → sorted, deduped items. Every declared kind has an entry. */
  items: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// nextjs-app-router
// ---------------------------------------------------------------------------

/** Strip route groups `(x)`, parallel slots `@x`, and a leading `[locale]`. */
export function normalizeRoutePattern(pattern: string): string {
  const segs = pattern
    .split("/")
    .filter(Boolean)
    .filter((s) => !(s.startsWith("(") && s.endsWith(")")) && !s.startsWith("@"));
  if (segs[0] === "[locale]") segs.shift();
  return `/${segs.join("/")}`.replace(/\/$/, "") || "/";
}

/** App-dir-relative page file → normalized route (`(dashboard)/observe/page.tsx` → `/observe`). */
export function pageFileToRoute(rel: string): string {
  return normalizeRoutePattern(`/${rel.split("/").slice(0, -1).join("/")}`);
}

/** Options for `nextjs-app-router`, from `adapterOptions` in `mechanics.config.yaml`. */
export interface NextjsAppRouterAdapterOptions {
  /**
   * App-relative directory holding the App Router tree. Defaults to `src/app`,
   * which is every app in a monorepo laid out as `apps/<slug>/src/app`. A
   * single-app repo whose Next app sits deeper (`apps/web/src/app` with the
   * repo root as the mechanics app) has no other way to say so: the routes
   * live under the app, just not where the default looks, and the inventory
   * silently came back empty.
   */
  appDir?: string;
}

/** `"./src/app/"` → `"src/app/"`; `"."` → `""` — the prefix every file test uses. */
function dirPrefix(dir: string): string {
  const posix = dir.split("\\").join("/").replace(/^\.\//, "").replace(/\/+$/, "");
  return posix === "." || posix === "" ? "" : `${posix}/`;
}

/**
 * Page routes prefer the app's dev-routes manifest when one exists — it is
 * generated from the same tree but already knows about routes a file walk
 * cannot see. Both paths run through the same normalizer, so the two sources
 * cannot disagree about shape.
 */
async function nextjsRoutes(ctx: AdapterContext, prefix: string): Promise<string[]> {
  const manifestPath = path.join(
    ctx.repoRoot,
    "packages",
    "dev-routes",
    "manifests",
    `${ctx.appSlug}.routes.json`
  );
  if (await pathExists(manifestPath)) {
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      routes?: Array<{ pattern: string }>;
    };
    return (manifest.routes ?? []).map((r) => normalizeRoutePattern(r.pattern));
  }
  return nextjsPageFiles(ctx, prefix).map(([route]) => route);
}

/** Page files → the route each one serves. The file IS the provenance. */
function nextjsPageFiles(
  ctx: AdapterContext,
  prefix: string
): Array<[route: string, file: string]> {
  return ctx.files
    .filter(
      (f) => f.startsWith(prefix) && /\/page\.tsx?$/.test(f) && !f.startsWith(`${prefix}api/`)
    )
    .map((f) => [pageFileToRoute(f.slice(prefix.length)), f]);
}

/** API route handlers → the endpoint each one serves. */
function nextjsApiFiles(ctx: AdapterContext, prefix: string): Array<[route: string, file: string]> {
  return ctx.files
    .filter((f) => f.startsWith(`${prefix}api/`) && /\/route\.tsx?$/.test(f))
    .map((f) => [
      normalizeRoutePattern(`/${f.slice(prefix.length).replace(/\/route\.tsx?$/, "")}`),
      f,
    ]);
}

export function createNextjsAppRouterAdapter(
  options: NextjsAppRouterAdapterOptions = {}
): SurfaceAdapter {
  const prefix = dirPrefix(options.appDir ?? "src/app");
  return {
    name: "nextjs-app-router",
    kinds: [
      { kind: "route", label: "route", legacyClaimKey: "routes" },
      { kind: "api-route", label: "API route", legacyClaimKey: "apiRoutes" },
    ],
    async inventory(ctx) {
      return {
        route: await nextjsRoutes(ctx, prefix),
        "api-route": nextjsApiFiles(ctx, prefix).map(([route]) => route),
      };
    },
    async provenance(ctx) {
      // Derived from the FILE scan even when `inventory` preferred the
      // dev-routes manifest: a manifest entry has no file behind it, so a
      // route only present there is one this cannot answer for, and it is
      // simply absent from the map.
      return {
        route: groupPairs(nextjsPageFiles(ctx, prefix)),
        "api-route": groupPairs(nextjsApiFiles(ctx, prefix)),
      };
    },
  };
}

/** `[item, file][]` → `item → files[]`, deduped and sorted. */
function groupPairs(pairs: Array<[string, string]>): Record<string, string[]> {
  const out: Record<string, Set<string>> = {};
  for (const [item, file] of pairs) {
    const set = out[item] ?? new Set<string>();
    set.add(file);
    out[item] = set;
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort()]));
}

// ---------------------------------------------------------------------------
// convex
// ---------------------------------------------------------------------------

/** The builders Convex itself exports for public functions. */
const CONVEX_PUBLIC_BUILDERS = ["query", "mutation", "action"] as const;
const CRON_NAME_RE =
  /crons\.(?:interval|cron|hourly|daily|weekly|monthly)\(\s*["'`]([^"'`]+)["'`]/g;
const HTTP_PATH_RE = /path:\s*["'`]([^"'`]+)["'`]/g;

/** Options for `convex`, from `adapterOptions` in `mechanics.config.yaml`. */
export interface ConvexAdapterOptions {
  /** App-relative Convex functions directory. Defaults to `convex`. */
  dir?: string;
  /**
   * Extra builder names whose exports count as public functions, on top of
   * `query`/`mutation`/`action`.
   *
   * A codebase that authorizes every handler usually does it by wrapping the
   * builders (`spaceQuery`, `publicMutation`), and then not one of its public
   * functions matches the three built-in names — the inventory reads zero and
   * coverage looks complete for the wrong reason. There is no way to tell a
   * public wrapper from an internal one by its name, so the list is explicit:
   * `internalQuery` and friends are never counted unless someone writes them
   * down here, which keeps the default answer the one Convex itself gives.
   */
  wrappers?: string[];
}

/**
 * `export const <fn> = <builder>(` for the given builder names.
 *
 * Built per adapter rather than shared, because the names come from config.
 * The schema already refuses anything that is not a JS identifier, and every
 * name is escaped anyway: a `$` is a legal identifier character and a regex
 * anchor, and this is the one place a config string becomes a pattern.
 */
export function convexFunctionRegExp(wrappers: readonly string[] = []): RegExp {
  const names = [...new Set([...CONVEX_PUBLIC_BUILDERS, ...wrappers])].map((n) =>
    n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  );
  return new RegExp(`export\\s+const\\s+(\\w+)\\s*=\\s*(?:${names.join("|")})\\s*\\(`, "g");
}

export function createConvexAdapter(options: ConvexAdapterOptions = {}): SurfaceAdapter {
  const prefix = dirPrefix(options.dir ?? "convex");
  const fnRe = convexFunctionRegExp(options.wrappers);
  const cronsFile = `${prefix}crons.ts`;
  const httpFile = `${prefix}http.ts`;

  // `<path under dir>.<fn>`, the shape Convex's own `api.<path>.<fn>` uses —
  // so `modules/lexilink/status.get` for `convex/modules/lexilink/status.ts`.
  const scanFunctions = async (ctx: AdapterContext): Promise<Array<[string, string]>> => {
    const out: Array<[string, string]> = [];
    for (const rel of convexSourceFiles(ctx, prefix)) {
      const content = await fs.readFile(path.join(ctx.appDir, rel), "utf8");
      const base = rel.slice(prefix.length).replace(/\.ts$/, "");
      for (const m of content.matchAll(fnRe)) {
        if (m[1]) out.push([`${base}.${m[1]}`, rel]);
      }
    }
    return out;
  };

  return {
    name: "convex",
    kinds: [
      { kind: "convex-function", label: "Convex function", legacyClaimKey: "convexFunctions" },
      { kind: "cron", label: "cron", legacyClaimKey: "crons" },
      { kind: "http-endpoint", label: "HTTP endpoint", legacyClaimKey: "httpEndpoints" },
    ],
    async inventory(ctx) {
      return {
        "convex-function": (await scanFunctions(ctx)).map(([item]) => item),
        cron: await scanFile(ctx, cronsFile, CRON_NAME_RE),
        "http-endpoint": await scanFile(ctx, httpFile, HTTP_PATH_RE),
      };
    },
    async provenance(ctx) {
      // `<module>.<fn>` came out of `<dir>/<module>.ts` by construction, and
      // crons and HTTP endpoints are only ever scanned out of their one
      // declaring file. Nothing here is inferred.
      const fns: Record<string, string[]> = {};
      for (const [item, rel] of await scanFunctions(ctx)) fns[item] = [rel];
      const single = async (rel: string, re: RegExp) =>
        Object.fromEntries((await scanFile(ctx, rel, re)).map((item) => [item, [rel]]));
      return {
        "convex-function": fns,
        cron: await single(cronsFile, CRON_NAME_RE),
        "http-endpoint": await single(httpFile, HTTP_PATH_RE),
      };
    },
  };
}

/**
 * Convex modules that are a public surface. `_generated` is codegen and
 * `lib/` is helpers — neither is claimable, so counting them would only
 * inflate the unclaimed list. Both are read relative to the configured dir.
 */
function convexSourceFiles(ctx: AdapterContext, prefix: string): string[] {
  return ctx.files.filter(
    (f) =>
      f.startsWith(prefix) &&
      f.endsWith(".ts") &&
      !f.startsWith(`${prefix}_generated/`) &&
      !f.startsWith(`${prefix}lib/`) &&
      !f.endsWith(".test.ts") &&
      !f.endsWith(".d.ts")
  );
}

async function scanFile(ctx: AdapterContext, rel: string, re: RegExp): Promise<string[]> {
  const abs = path.join(ctx.appDir, rel);
  if (!(await pathExists(abs))) return [];
  const content = await fs.readFile(abs, "utf8");
  const out: string[] = [];
  for (const m of content.matchAll(re)) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// generic-glob
// ---------------------------------------------------------------------------

/** One user-declared surface: a kind name and the globs that find it. */
export interface GlobSurfaceSpec {
  kind: string;
  label?: string;
  /** App-relative globs. Matching file paths become the items, verbatim. */
  globs: string[];
  legacyClaimKey?: string;
}

/**
 * The escape hatch, and the reason this abstraction is worth having: a project
 * whose surfaces nobody wrote an adapter for can still declare them in config
 * and get the same coverage ratchet, without a plugin or a fork.
 *
 * Items are the matching file paths as written. Not a guess at some prettier
 * identifier — a path is stable, greppable, and unambiguous, and the mechanic
 * claiming it can use the same `<prefix>/*` subtree syntax as any other kind.
 */
export function createGenericGlobAdapter(specs: GlobSurfaceSpec[]): SurfaceAdapter {
  return {
    name: "generic-glob",
    kinds: specs.map((s) => ({
      kind: s.kind,
      label: s.label ?? s.kind,
      legacyClaimKey: s.legacyClaimKey,
    })),
    async inventory(ctx) {
      const out: Record<string, string[]> = {};
      for (const spec of specs) {
        out[spec.kind] = ctx.files.filter((f) => matchesAnyGlob(f, spec.globs));
      }
      return out;
    },
    async provenance(ctx) {
      // Identity: for a glob-declared kind the item IS the file path, so this
      // is the one adapter whose provenance cannot be wrong.
      const out: Record<string, Record<string, string[]>> = {};
      for (const spec of specs) {
        out[spec.kind] = Object.fromEntries(
          ctx.files.filter((f) => matchesAnyGlob(f, spec.globs)).map((f) => [f, [f]])
        );
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

/** What every app in this monorepo gets without saying anything. */
export function defaultAdapters(): SurfaceAdapter[] {
  return [createNextjsAppRouterAdapter(), createConvexAdapter()];
}

/**
 * Run every adapter and merge the results.
 *
 * Adapters run concurrently: they only read, and the file list is already in
 * memory, so the only cost left is reading the handful of files each one opens.
 *
 * Two kinds with the same name would silently merge into one bucket and make
 * coverage quietly wrong, so a collision throws instead. It can only happen
 * through config — a `generic-glob` surface named `route` — which means the
 * message has to name both adapters to be actionable.
 */
/**
 * Every adapter's `provenance`, merged: kind → item → source files.
 *
 * An adapter without the method contributes nothing, and so does an item it
 * declined to answer for. Absence here means "unknown", never "none" — a
 * caller filling in a mechanic's `paths:` must treat a missing item as a
 * question it cannot answer rather than as an empty answer.
 */
export async function buildProvenance(
  adapters: SurfaceAdapter[],
  ctx: AdapterContext
): Promise<Record<string, Record<string, string[]>>> {
  const parts = await Promise.all(
    adapters.map(async (a) => (a.provenance ? await a.provenance(ctx) : {}))
  );
  const out: Record<string, Record<string, string[]>> = {};
  for (const part of parts) {
    for (const [kind, items] of Object.entries(part)) {
      const bucket = out[kind] ?? {};
      out[kind] = bucket;
      for (const [item, files] of Object.entries(items)) {
        if (files.length === 0) continue;
        bucket[item] = [...new Set([...(bucket[item] ?? []), ...files])].sort();
      }
    }
  }
  return out;
}

export async function buildInventory(
  adapters: SurfaceAdapter[],
  ctx: AdapterContext
): Promise<Inventory> {
  const kinds: SurfaceKind[] = [];
  const owner = new Map<string, string>();
  for (const adapter of adapters) {
    for (const kind of adapter.kinds) {
      const existing = owner.get(kind.kind);
      if (existing) {
        throw new Error(
          `mechanics: surface kind "${kind.kind}" is declared by both "${existing}" and "${adapter.name}" — kinds must be unique`
        );
      }
      owner.set(kind.kind, adapter.name);
      kinds.push(kind);
    }
  }

  const results = await Promise.all(adapters.map((a) => a.inventory(ctx)));

  const items: Record<string, string[]> = {};
  for (const kind of kinds) items[kind.kind] = [];
  for (const result of results) {
    for (const [kind, found] of Object.entries(result)) {
      // An adapter returning a kind it never declared is a bug in that adapter,
      // not something to guess at: dropping it keeps `items` and `kinds` in
      // lockstep, which is what every consumer assumes.
      if (!owner.has(kind)) continue;
      items[kind]?.push(...found);
    }
  }
  for (const kind of Object.keys(items)) {
    items[kind] = [...new Set(items[kind])].sort();
  }

  return { kinds, items };
}
