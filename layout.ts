/**
 * Repo layout — where apps live, where manifests are committed, which adapters
 * each app gets.
 *
 * Until now all three were constants: apps were `apps/<slug>`, manifests were
 * `packages/mechanics/manifests`, and every app got the Next.js + Convex
 * adapters. That is a faithful description of this monorepo and a wall around
 * everyone else. `mechanics.config.yaml` at the repo root turns the three
 * constants into declarations, which is what makes a single-app repo — the
 * template, and any project adopting this — expressible at all.
 *
 * The config is also the repo-root MARKER: `findRepoRoot` walks up from the
 * working directory looking for it. That is deliberate. A module-relative root
 * would always resolve to the repo mechanics was *installed into*, so a
 * published CLI could never answer a question about the repo it was run in.
 *
 * Loading is synchronous. The file is a few lines of YAML read once per root,
 * and every existing path helper (`wavesDir`, `screensRoot`, `manifestPath`)
 * is synchronous — making them async to fetch a cached 200-byte file would
 * ripple through every caller for no gain.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import {
  createConvexAdapter,
  createGenericGlobAdapter,
  createNextjsAppRouterAdapter,
  type GlobSurfaceSpec,
  type SurfaceAdapter,
} from "./adapters";
import { CONFIG_FILENAME, REPO_ROOT } from "./fsutil";
import { formatZodError, repoConfigSchema } from "./schema";
import type { RepoAdapterOptions, RepoMechanicsConfig } from "./types";

/**
 * Built-in adapters, by the name config refers to them by. Each factory picks
 * its own block out of the app's effective `adapterOptions`; an adapter with
 * no options simply ignores the argument.
 */
const BUILTIN_ADAPTERS: Record<string, (options: RepoAdapterOptions) => SurfaceAdapter> = {
  "nextjs-app-router": (o) => createNextjsAppRouterAdapter(o["nextjs-app-router"]),
  convex: (o) => createConvexAdapter(o.convex),
};

export const BUILTIN_ADAPTER_NAMES = Object.keys(BUILTIN_ADAPTERS).sort();

/** What this monorepo was before the config existed — and the fallback if none is found. */
const DEFAULT_CONFIG: RepoMechanicsConfig = {
  appsDir: "apps",
  apps: [],
  manifestsDir: "packages/mechanics/manifests",
  adapters: ["nextjs-app-router", "convex"],
  surfaces: [],
  adapterOptions: {},
};

export interface AppLayout {
  slug: string;
  /**
   * Repo-relative POSIX path to the app root. `""` for a single-app repo,
   * where the app IS the repo — so every derived path loses one segment
   * (`mechanics/…` rather than `apps/x/mechanics/…`) and stays relative.
   */
  dir: string;
  adapters: SurfaceAdapter[];
}

export interface RepoLayout {
  repoRoot: string;
  /** Repo-relative POSIX path holding `<slug>.mechanics.json`. */
  manifestsDir: string;
  /** Explicitly declared apps, or null when apps are discovered under `appsDir`. */
  apps: Map<string, AppLayout> | null;
  /** Repo-relative POSIX parent of every app, when apps are discovered. */
  appsDir: string | null;
  /**
   * Repo-level adapter names and glob surfaces, applied to every DISCOVERED
   * app. Carried here because a discovered app has no entry of its own to read
   * them from — without this field the config's `adapters:`/`surfaces:` are
   * parsed, validated, and then silently dropped, so a monorepo could never
   * declare a glob surface and `init --app=<slug>`'s generated `adapters:`
   * block had no effect at all.
   */
  adapters: string[];
  surfaces: GlobSurfaceSpec[];
  /** Repo-level adapter options, applied to every discovered app for the same reason. */
  adapterOptions: RepoAdapterOptions;
}

const CACHE = new Map<string, RepoLayout>();

/** Drop the cache — for tests that write a config and re-read it. */
export function clearLayoutCache(): void {
  CACHE.clear();
}

export function loadLayout(repoRoot = REPO_ROOT): RepoLayout {
  const cached = CACHE.get(repoRoot);
  if (cached) return cached;
  const layout = buildLayout(repoRoot, readConfig(repoRoot));
  CACHE.set(repoRoot, layout);
  return layout;
}

function readConfig(repoRoot: string): RepoMechanicsConfig {
  let raw: string;
  try {
    raw = readFileSync(path.join(repoRoot, CONFIG_FILENAME), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_CONFIG;
    throw err;
  }
  const parsed = repoConfigSchema.safeParse(YAML.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `${CONFIG_FILENAME}: ${formatZodError(parsed.error).join("; ")}\n  (in ${repoRoot})`
    );
  }
  return parsed.data;
}

function buildLayout(repoRoot: string, config: RepoMechanicsConfig): RepoLayout {
  const base = {
    repoRoot,
    manifestsDir: normalizeDir(config.manifestsDir),
    adapters: config.adapters,
    surfaces: config.surfaces,
    adapterOptions: config.adapterOptions,
  };

  if (config.apps.length > 0) {
    const apps = new Map<string, AppLayout>();
    // `adapterOptions` for an adapter the app does not run is an ERROR, not
    // ignored. A block that configures nothing is almost always a typo'd
    // adapter list or an app that was meant to run the adapter, and ignoring it
    // reproduces exactly the failure the options exist to fix: an inventory
    // that reads empty and coverage that looks complete. An app's OWN block
    // must match its adapters; a repo-level block is a default, so an app that
    // does not use it is fine as long as SOME app does.
    const readRepoOptions = new Set<string>();
    for (const entry of config.apps) {
      const names = entry.adapters ?? config.adapters;
      const own = entry.adapterOptions ?? {};
      apps.set(entry.slug, {
        slug: entry.slug,
        dir: normalizeDir(entry.dir),
        adapters: resolveAdapters(names, entry.surfaces ?? config.surfaces, entry.slug, {
          ...config.adapterOptions,
          ...own,
        }),
      });
      for (const key of Object.keys(own)) {
        if (!names.includes(key)) {
          throw new Error(
            `${CONFIG_FILENAME}: app "${entry.slug}" sets adapterOptions.${key} but does not run the "${key}" adapter — its adapters are: ${names.join(", ") || "(none)"}`
          );
        }
      }
      for (const key of Object.keys(config.adapterOptions)) {
        if (!(key in own) && names.includes(key)) readRepoOptions.add(key);
      }
    }
    for (const key of Object.keys(config.adapterOptions)) {
      if (!readRepoOptions.has(key)) {
        throw new Error(
          `${CONFIG_FILENAME}: adapterOptions.${key} applies to no app — every app either does not run the "${key}" adapter or sets its own adapterOptions.${key}`
        );
      }
    }
    return { ...base, apps, appsDir: null };
  }

  for (const key of Object.keys(config.adapterOptions)) {
    if (!config.adapters.includes(key)) {
      throw new Error(
        `${CONFIG_FILENAME}: adapterOptions.${key} is set but "${key}" is not in adapters: [${config.adapters.join(", ")}]`
      );
    }
  }

  return {
    ...base,
    apps: null,
    appsDir: normalizeDir(config.appsDir ?? DEFAULT_CONFIG.appsDir ?? "apps"),
  };
}

/** `"."` / `"./apps"` / `"apps/"` all mean the same thing; `""` is the repo root. */
function normalizeDir(dir: string): string {
  const posix = dir.split(path.sep).join("/").replace(/^\.\//, "").replace(/\/+$/, "");
  return posix === "." ? "" : posix;
}

function resolveAdapters(
  names: string[],
  surfaces: GlobSurfaceSpec[],
  slug: string,
  options: RepoAdapterOptions
) {
  const adapters: SurfaceAdapter[] = [];
  for (const name of names) {
    const factory = BUILTIN_ADAPTERS[name];
    if (!factory) {
      throw new Error(
        `${CONFIG_FILENAME}: app "${slug}" requests unknown adapter "${name}" — built-ins are: ${BUILTIN_ADAPTER_NAMES.join(", ")}` +
          `\n  (declare project-specific surfaces under "surfaces:" instead — they are served by generic-glob)`
      );
    }
    adapters.push(factory(options));
  }
  if (surfaces.length > 0) adapters.push(createGenericGlobAdapter(surfaces));
  return adapters;
}

// ---------------------------------------------------------------------------
// Per-app lookups
// ---------------------------------------------------------------------------

/**
 * One app's layout.
 *
 * In discovery mode any slug is plausible — whether `apps/<slug>/mechanics`
 * exists is `discoverCorpus`'s question, not this one. With an explicit list,
 * an unknown slug is a config error, and the message says which apps ARE
 * declared: the usual cause is a manifest left behind by a deleted app.
 */
export function appLayout(appSlug: string, repoRoot = REPO_ROOT): AppLayout {
  const layout = loadLayout(repoRoot);
  if (!layout.apps) {
    return {
      slug: appSlug,
      dir: joinRel(layout.appsDir ?? "apps", appSlug),
      adapters: resolveAdapters(layout.adapters, layout.surfaces, appSlug, layout.adapterOptions),
    };
  }
  const found = layout.apps.get(appSlug);
  if (!found) {
    const declared = [...layout.apps.keys()].sort().join(", ") || "(none)";
    throw new Error(`${CONFIG_FILENAME}: no app "${appSlug}" — declared apps are: ${declared}`);
  }
  return found;
}

/**
 * The slug of the only app, when `mechanics.config.yaml` declares exactly one
 * under `apps:` — otherwise null.
 *
 * Lets the corpus commands run without `--app` in a single-app repo, where
 * asking for the slug is a question with one possible answer. Discovery mode
 * never qualifies, even with one directory under `appsDir`: a monorepo that
 * happens to have one app today is still a monorepo, and a default that flips
 * to an error the day a second app lands is worse than no default.
 */
export function soleDeclaredApp(repoRoot = REPO_ROOT): string | null {
  const { apps } = loadLayout(repoRoot);
  if (!apps || apps.size !== 1) return null;
  return [...apps.keys()][0] ?? null;
}

/** Absolute path to the app root. */
export function appDir(appSlug: string, repoRoot = REPO_ROOT): string {
  return path.join(repoRoot, appLayout(appSlug, repoRoot).dir);
}

/**
 * Repo-relative POSIX path inside an app:
 * `appPath("console", root, "mechanics")` → `apps/console/mechanics`, or just
 * `mechanics` in a single-app repo.
 *
 * Every user-visible path — error prose, `doc.source`, the manifest — goes
 * through here, so the two layouts differ in exactly one place.
 */
export function appPath(appSlug: string, repoRoot: string, ...segments: string[]): string {
  return joinRel(appLayout(appSlug, repoRoot).dir, ...segments);
}

function joinRel(...parts: string[]): string {
  return parts.filter((p) => p !== "").join("/");
}

/** Adapters for one app, in declaration order. */
export function appAdapters(appSlug: string, repoRoot = REPO_ROOT): SurfaceAdapter[] {
  return appLayout(appSlug, repoRoot).adapters;
}

/** Repo-relative POSIX dir holding the committed manifests. */
export function manifestsDir(repoRoot = REPO_ROOT): string {
  return loadLayout(repoRoot).manifestsDir;
}
