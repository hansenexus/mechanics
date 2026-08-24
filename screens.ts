/**
 * Screenshot subsystem — committed per-route visual evidence for waves.
 *
 * Layout: `apps/<app>/mechanics/waves/screens/<wave>/<checkpoint>/<slug>.webp`
 * plus one committed `index.json` per checkpoint dir (capture metadata: date,
 * measured viewport, per-route capture status). The `screens/` subtree is
 * invisible to the corpus walkers (`loadWaves` filters `*.yaml`,
 * `discoverCorpus` skips `waves/`), so committed binaries can NEVER move
 * manifest bytes — the byte-stable drift gate is untouched by design.
 *
 * Screenshots are human-eye evidence for redesign review, never pixel-diff CI
 * input: `check` surfaces findings from `validateScreens` as WARNINGS only.
 *
 * Checkpoint names are free-form kebab-case; `before` / `after` are the
 * blessed pair (gallery pins `before` first and `after` last, anything else
 * sorts lexicographically between).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { pathExists, REPO_ROOT } from "./fsutil";
import { appPath } from "./layout";
import { formatZodError } from "./schema";
import { KEBAB_SEGMENT_RE } from "./types";

/** Screenshot filenames: `<slug>.webp`, optionally suffixed (`<slug>@mobile.webp`). */
export const SCREEN_FILE_RE = /^[a-z0-9][a-z0-9@-]*\.(webp|png)$/;

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date-only string (YYYY-MM-DD)");
const kebab = z.string().regex(KEBAB_SEGMENT_RE, "must be kebab-case ([a-z0-9][a-z0-9-]*)");
const viewport = z.string().regex(/^\d{3,4}x\d{3,4}$/, "must be <width>x<height> in px");

export type ScreenCaptureStatus = "captured" | "missing" | "skipped";

export const screensIndexEntrySchema = z
  .object({
    /** Normalized route pattern from the coverage inventory, e.g. `/apps/[app]`. */
    route: z.string().startsWith("/"),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must be a route slug"),
    /** Present iff status is `captured`. */
    file: z.string().regex(SCREEN_FILE_RE).optional(),
    status: z.enum(["captured", "missing", "skipped"]),
    /** Why a route is missing (unresolved segment) or deliberately skipped. */
    reason: z.string().optional(),
    /** The concrete URL path visited (params substituted), when captured. */
    visitedPath: z.string().optional(),
  })
  .strict()
  .refine((e) => e.status !== "captured" || Boolean(e.file), {
    message: "a 'captured' entry requires a file",
    path: ["file"],
  });

export const screensIndexSchema = z
  .object({
    schemaVersion: z.literal(1),
    app: kebab,
    /** Must equal the grandparent dir name — checked by validateScreens. */
    wave: kebab,
    /** Must equal the parent dir name — checked by validateScreens. */
    checkpoint: kebab,
    capturedAt: dateOnly,
    /** ACTUAL measured px at capture time, not the requested size. */
    viewport,
    fullPage: z.boolean().default(false),
    /** Informational — where the capture ran. */
    baseUrl: z.string().optional(),
    /** Sorted by `route`. */
    routes: z.array(screensIndexEntrySchema),
  })
  .strict();

export type ScreensIndexEntry = z.infer<typeof screensIndexEntrySchema>;
export type ScreensIndex = z.infer<typeof screensIndexSchema>;

/** One loaded checkpoint dir (index may be null when absent/invalid). */
export interface LoadedCheckpoint {
  checkpoint: string;
  index: ScreensIndex | null;
  /** Image files present on disk (sorted). */
  files: string[];
  errors: string[];
}

export interface LoadedWaveScreens {
  wave: string;
  checkpoints: LoadedCheckpoint[];
}

export function screensRoot(appSlug: string, repoRoot = REPO_ROOT): string {
  return path.join(repoRoot, appPath(appSlug, repoRoot, "mechanics", "waves", "screens"));
}

export function checkpointDir(
  appSlug: string,
  wave: string,
  checkpoint: string,
  repoRoot = REPO_ROOT
): string {
  return path.join(screensRoot(appSlug, repoRoot), wave, checkpoint);
}

/**
 * Encode a normalized route pattern as a screenshot slug — same sanitizer as
 * the scaffold command's `routeToStub` so the two stay culturally consistent:
 * strip `[ ] ( ) . @`, lowercase, join segments with `-`; `/` → `home`.
 * `/apps/[app]` → `apps-app`, `/admin/deploy/[jobId]` → `admin-deploy-jobid`.
 */
export function routeToScreenSlug(route: string): string {
  const segs = route
    .split("/")
    .filter(Boolean)
    .map((s) => s.replace(/[[\]().@]/g, "").toLowerCase())
    .filter((s) => s.length > 0);
  return segs.length === 0 ? "home" : segs.join("-");
}

/** `before` first, `after` last, other checkpoints lexicographic between. */
export function orderCheckpoints(names: string[]): string[] {
  const rank = (c: string) => (c === "before" ? 0 : c === "after" ? 2 : 1);
  return [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Canonical serialization for tool-written index.json (routes sorted, trailing \n). */
export function screensIndexJson(index: ScreensIndex): string {
  const ordered: ScreensIndex = {
    ...index,
    routes: [...index.routes].sort((a, b) => a.route.localeCompare(b.route)),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** Wave slugs that have a screens dir (sorted). */
export async function listScreenWaves(appSlug: string, repoRoot = REPO_ROOT): Promise<string[]> {
  const root = screensRoot(appSlug, repoRoot);
  if (!(await pathExists(root))) return [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** Load every checkpoint of one wave's screens dir, ordered before → after. */
export async function loadScreensForWave(
  appSlug: string,
  wave: string,
  repoRoot = REPO_ROOT
): Promise<LoadedWaveScreens> {
  const waveDir = path.join(screensRoot(appSlug, repoRoot), wave);
  const rel = appPath(appSlug, repoRoot, "mechanics", "waves", "screens", wave);
  const checkpoints: LoadedCheckpoint[] = [];
  if (!(await pathExists(waveDir))) return { wave, checkpoints };

  const entries = await fs.readdir(waveDir, { withFileTypes: true });
  const names = orderCheckpoints(entries.filter((e) => e.isDirectory()).map((e) => e.name));
  for (const checkpoint of names) {
    const dir = path.join(waveDir, checkpoint);
    const errors: string[] = [];
    const files = (await fs.readdir(dir)).filter((f) => SCREEN_FILE_RE.test(f)).sort();

    let index: ScreensIndex | null = null;
    const indexPath = path.join(dir, "index.json");
    if (await pathExists(indexPath)) {
      try {
        const parsed = screensIndexSchema.safeParse(
          JSON.parse(await fs.readFile(indexPath, "utf8"))
        );
        if (parsed.success) {
          index = parsed.data;
          if (index.wave !== wave || index.checkpoint !== checkpoint) {
            errors.push(
              `${rel}/${checkpoint}/index.json: wave/checkpoint fields must match the dir names`
            );
          }
        } else {
          for (const line of formatZodError(parsed.error)) {
            errors.push(`${rel}/${checkpoint}/index.json: ${line}`);
          }
        }
      } catch (err) {
        errors.push(
          `${rel}/${checkpoint}/index.json: unparseable (${err instanceof Error ? err.message : err})`
        );
      }
    } else {
      errors.push(`${rel}/${checkpoint}: missing index.json`);
    }
    checkpoints.push({ checkpoint, index, files, errors });
  }
  return { wave, checkpoints };
}

/**
 * Path guard for the image-serving route. `segments` is
 * `[appSlug, wave, checkpoint, file]` from the URL; returns the absolute file
 * path only when every segment is shape-valid AND the resolved path stays
 * under that app's screens root — else null. Same discipline as
 * `loadMechanicDoc`.
 */
export function resolveScreenPath(segments: string[], repoRoot = REPO_ROOT): string | null {
  if (segments.length !== 4) return null;
  const [appSlug, wave, checkpoint, file] = segments as [string, string, string, string];
  if (![appSlug, wave, checkpoint].every((s) => KEBAB_SEGMENT_RE.test(s))) return null;
  if (!SCREEN_FILE_RE.test(file)) return null;
  const root = screensRoot(appSlug, repoRoot);
  const resolved = path.resolve(root, wave, checkpoint, file);
  if (!resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

/**
 * Soft validation for `check` — WARNINGS only, screenshots are optional per
 * wave. Flags: screens dirs for unknown waves, checkpoints without/with
 * invalid index.json, index entries whose files are gone, images on disk the
 * index doesn't know, and a missing-count summary.
 */
export async function validateScreens(
  appSlug: string,
  knownWaveSlugs: string[],
  repoRoot = REPO_ROOT
): Promise<string[]> {
  const warnings: string[] = [];
  const known = new Set(knownWaveSlugs);

  for (const wave of await listScreenWaves(appSlug, repoRoot)) {
    const rel = appPath(appSlug, repoRoot, "mechanics", "waves", "screens", wave);
    if (!known.has(wave)) {
      warnings.push(`${rel}: screens for unknown wave "${wave}" (no ${wave}.yaml)`);
    }
    const { checkpoints } = await loadScreensForWave(appSlug, wave, repoRoot);
    for (const cp of checkpoints) {
      warnings.push(...cp.errors);
      if (!cp.index) continue;

      const onDisk = new Set(cp.files);
      const referenced = new Set<string>();
      for (const entry of cp.index.routes) {
        if (entry.file) {
          referenced.add(entry.file);
          if (!onDisk.has(entry.file)) {
            warnings.push(`${rel}/${cp.checkpoint}: index references missing file ${entry.file}`);
          }
        }
      }
      for (const file of cp.files) {
        if (!referenced.has(file)) {
          warnings.push(`${rel}/${cp.checkpoint}: ${file} is not referenced by index.json`);
        }
      }
      const missing = cp.index.routes.filter((r) => r.status === "missing").length;
      if (missing > 0) {
        warnings.push(`${rel}/${cp.checkpoint}: ${missing} route(s) missing screenshots`);
      }
    }
  }
  return warnings;
}
