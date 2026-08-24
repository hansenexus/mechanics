/**
 * Zod schemas for every hand-authored mechanics file: mechanic frontmatter,
 * `_area.yaml`, `_config.yaml`, and wave YAML. All schemas are `.strict()` so
 * a typo'd key fails loudly at `check` time instead of silently vanishing.
 *
 * Deliberately NOT accepted in frontmatter: `id` (derived from the file path),
 * `area` (derived from the parent dir), `tests` (discovered from spec
 * annotations) — each would be a second source of truth that rots.
 */

import { z } from "zod";
import type {
  AppMechanicsConfig,
  AreaMeta,
  MechanicFrontmatter,
  RepoMechanicsConfig,
  WaveFile,
} from "./types";
import { KEBAB_SEGMENT_RE, MECHANIC_ID_RE } from "./types";

const kebab = z.string().regex(KEBAB_SEGMENT_RE, "must be kebab-case ([a-z0-9][a-z0-9-]*)");
/** A surface kind key: `route`, `api-route`, `convex-function`. */
const surfaceKind = z
  .string()
  .regex(KEBAB_SEGMENT_RE, "surface kind must be kebab-case (route, api-route, …)");
const mechanicId = z
  .string()
  .regex(MECHANIC_ID_RE, "must be a mechanic ID (<app>.<area>.<slug>, kebab-case segments)");
/** `AC1`, `AC2`, … — labels used in Acceptance Criteria bullets. */
const acLabel = z.string().regex(/^AC[1-9]\d*$/, "must be an AC label (AC1, AC2, …)");
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date-only string (YYYY-MM-DD)");

export const mechanicFrontmatterSchema = z
  .object({
    title: z.string().min(1),
    kind: z.enum(["user-facing", "system"]),
    status: z.enum(["draft", "active", "deprecated"]).default("active"),
    priority: z.enum(["p0", "p1", "p2"]).default("p1"),
    roles: z.array(z.string().min(1)).min(1),
    // Keys are surface kinds. Which kinds exist depends on the app's adapters,
    // which the parser has no way to know — so the shape is checked here and
    // the *names* are checked against the live inventory at coverage time.
    claims: z.record(surfaceKind, z.array(z.string().min(1))).default({}),
    paths: z.array(z.string().min(1)).default([]),
    nonFunctional: z.array(z.enum(["perf", "a11y", "security", "i18n", "offline"])).default([]),
    destructive: z.boolean().default(false),
    aliases: z.array(mechanicId).default([]),
    verify: z.enum(["e2e", "agent", "manual-only"]).optional(),
  })
  .strict();

export const areaMetaSchema = z
  .object({
    title: z.string().min(1),
    order: z.number().int().nonnegative(),
    description: z.string().optional(),
  })
  .strict();

export const appConfigSchema = z
  .object({
    testGlobs: z.array(z.string().min(1)).default([]),
    e2eRunner: z.enum(["bun-script", "playwright"]).default("bun-script"),
    playwrightConfig: z.string().optional(),
    coverage: z
      .object({
        enforce: z.enum(["warn", "error"]).default("warn"),
        ignore: z.record(surfaceKind, z.array(z.string())).default({}),
      })
      .strict()
      .default({ enforce: "warn", ignore: {} }),
    screens: z
      .object({
        viewport: z
          .string()
          .regex(/^\d{3,4}x\d{3,4}$/, "must be <width>x<height> in px")
          .default("1440x900"),
        params: z.record(z.string(), z.string().min(1)).default({}),
        overrides: z
          .record(
            z.string().startsWith("/"),
            z
              .object({
                path: z.string().startsWith("/").optional(),
                skip: z.boolean().default(false),
                reason: z.string().optional(),
              })
              .strict()
          )
          .default({}),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((c) => c.e2eRunner !== "playwright" || Boolean(c.playwrightConfig), {
    message: "playwrightConfig is required when e2eRunner is 'playwright'",
    path: ["playwrightConfig"],
  });

const surfaceSpecSchema = z
  .object({
    kind: surfaceKind,
    label: z.string().min(1).optional(),
    globs: z.array(z.string().min(1)).min(1),
  })
  .strict();

/**
 * `mechanics.config.yaml`. Exactly one of `appsDir` (one dir per app) or
 * `apps` (explicit entries) — a repo that declared both would have two answers
 * to "what apps are there", and the discovered set would silently win.
 */
export const repoConfigSchema = z
  .object({
    appsDir: z.string().min(1).optional(),
    apps: z
      .array(
        z
          .object({
            slug: kebab,
            dir: z.string().min(1),
            adapters: z.array(z.string().min(1)).optional(),
            surfaces: z.array(surfaceSpecSchema).optional(),
          })
          .strict()
      )
      .default([]),
    manifestsDir: z.string().min(1).default("packages/mechanics/manifests"),
    adapters: z.array(z.string().min(1)).default(["nextjs-app-router", "convex"]),
    surfaces: z.array(surfaceSpecSchema).default([]),
  })
  .strict()
  .refine((c) => (c.appsDir === undefined) !== (c.apps.length === 0), {
    message: "declare exactly one of appsDir (one dir per app) or apps (explicit entries)",
    path: ["apps"],
  })
  .refine((c) => new Set(c.apps.map((a) => a.slug)).size === c.apps.length, {
    message: "app slugs must be unique",
    path: ["apps"],
  });

export const waveVerificationSchema = z
  .object({
    mechanic: mechanicId,
    status: z.enum(["pending", "pass", "fail", "blocked", "n-a"]),
    method: z.enum(["e2e", "agent", "manual"]),
    evidence: z.string().min(1).optional(),
    verifiedBy: z.string().min(1).optional(),
    verifiedAt: dateOnly.optional(),
    failedCriteria: z.array(acLabel).optional(),
    note: z.string().optional(),
  })
  .strict()
  .refine((v) => v.status !== "pass" || Boolean(v.evidence), {
    message: "a 'pass' verification requires an evidence string",
    path: ["evidence"],
  });

export const waveFileSchema = z
  .object({
    wave: kebab,
    title: z.string().min(1),
    status: z.enum(["open", "closed", "abandoned"]).default("open"),
    startedAt: dateOnly,
    closedAt: dateOnly.nullish(),
    baselineSha: z
      .string()
      .regex(/^[0-9a-f]{7,40}$/, "must be a git sha")
      .optional(),
    scope: z
      .object({
        areas: z.array(kebab).default([]),
        kinds: z.array(z.enum(["user-facing", "system"])).default([]),
        ids: z.array(mechanicId).default([]),
        exclude: z.array(mechanicId).default([]),
      })
      .strict()
      .default({ areas: [], kinds: [], ids: [], exclude: [] }),
    links: z
      .object({
        designDirection: z.string().optional(),
        previewCategoryIds: z.array(z.string()).default([]),
        previewDecisions: z.array(z.string()).default([]),
      })
      .strict()
      .default({ previewCategoryIds: [], previewDecisions: [] }),
    notes: z.string().optional(),
    verifications: z.array(waveVerificationSchema).default([]),
  })
  .strict();

// Compile-time drift guards: the zod output shapes must stay assignable to the
// hand-written contract types in types.ts (and vice-versa for required keys).
type _FrontmatterMatches =
  z.infer<typeof mechanicFrontmatterSchema> extends MechanicFrontmatter ? true : never;
type _AreaMatches = z.infer<typeof areaMetaSchema> extends AreaMeta ? true : never;
type _ConfigMatches = z.infer<typeof appConfigSchema> extends AppMechanicsConfig ? true : never;
type _RepoConfigMatches =
  z.infer<typeof repoConfigSchema> extends RepoMechanicsConfig ? true : never;
type _WaveMatches = z.infer<typeof waveFileSchema> extends WaveFile ? true : never;
const _guards: [
  _FrontmatterMatches,
  _AreaMatches,
  _ConfigMatches,
  _RepoConfigMatches,
  _WaveMatches,
] = [true, true, true, true, true];
void _guards;

/** Format a ZodError into short `path: message` lines for CLI output. */
export function formatZodError(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
}
