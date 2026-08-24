/**
 * @hansenexus/mechanics — contract types.
 *
 * A "mechanic" is one user-observable (or system-observable) behavior of an
 * app, documented at full-spec depth in `apps/<app>/mechanics/<area>/<slug>.md`
 * (YAML frontmatter + fixed H2 sections). The corpus compiles into a committed
 * manifest consumed by the console dashboard, the CI drift gate, and the wave
 * verification workflow.
 *
 * DETERMINISM CONTRACT: a manifest is fully derived from the mechanics tree
 * (`*.md`, `_area.yaml`, `_config.yaml`), the app's code inventory (routes,
 * Convex functions, crons, HTTP endpoints), and test-annotation discovery.
 * It carries NO timestamp and NO wave state — wave YAML churns on every
 * check-off and is read directly by consumers instead, so re-running `build`
 * on an unchanged tree is byte-identical and the drift gate has zero false
 * positives.
 *
 * ID GRAMMAR: `<app>.<area>.<slug>` — three dot-separated kebab-case segments
 * (`console.observe.logs-tab`). IDs are DERIVED from the file path, never
 * stored in frontmatter, so they cannot drift. Renames keep the old ID in
 * `aliases`.
 */

/** Matches one full mechanic ID: app.area.slug, each segment kebab-case. */
export const MECHANIC_ID_RE = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;

/** One kebab-case path segment (area dir name / mechanic file slug). */
export const KEBAB_SEGMENT_RE = /^[a-z0-9][a-z0-9-]*$/;

export type MechanicKind = "user-facing" | "system";
export type MechanicDocStatus = "draft" | "active" | "deprecated";
export type MechanicPriority = "p0" | "p1" | "p2";
export type NonFunctionalTag = "perf" | "a11y" | "security" | "i18n" | "offline";
/** Authoring hint for how the NEXT wave should verify this mechanic. */
export type VerifyHint = "e2e" | "agent" | "manual-only";

/**
 * What a mechanic claims, keyed by surface kind: `{ route: ["/observe"],
 * "convex-function": ["logs.list"] }`.
 *
 * Kinds are NOT validated at parse time. The parser cannot know which adapters
 * an app runs, and hardcoding a list here would put back exactly the coupling
 * adapters removed. A claim under a kind no adapter provides is caught at
 * coverage time, alongside the claim that resolves to nothing — same class of
 * error, same place, one message shape.
 */
export type MechanicClaims = Record<string, string[]>;

/** Frontmatter of a mechanic file, post-validation. */
export interface MechanicFrontmatter {
  title: string;
  kind: MechanicKind;
  status: MechanicDocStatus;
  priority: MechanicPriority;
  roles: string[];
  claims: MechanicClaims;
  paths: string[];
  nonFunctional: NonFunctionalTag[];
  /** Verifying this mechanic mutates real state — NEVER auto-driven by agents. */
  destructive: boolean;
  aliases: string[];
  verify?: VerifyHint;
}

/** Required H2 sections, in order. `Non-functional` and `Notes` are optional. */
export const REQUIRED_SECTIONS = [
  "Story",
  "Acceptance Criteria",
  "Edge Cases",
  "Error States",
] as const;
export const OPTIONAL_SECTIONS = ["Non-functional", "Notes"] as const;
export type SectionName = (typeof REQUIRED_SECTIONS)[number] | (typeof OPTIONAL_SECTIONS)[number];

/** A fully parsed mechanic document. */
export interface MechanicDoc {
  /** Derived `<app>.<area>.<slug>` ID. */
  id: string;
  appSlug: string;
  area: string;
  slug: string;
  /** Repo-relative source path, e.g. `apps/console/mechanics/observe/logs-tab.md`. */
  source: string;
  frontmatter: MechanicFrontmatter;
  /** Section bodies keyed by H2 title (raw markdown, without the heading). */
  sections: Partial<Record<SectionName, string>>;
  /** Ordered `AC<n>` labels extracted from the Acceptance Criteria section. */
  criteria: string[];
  edgeCaseCount: number;
  errorStateCount: number;
}

/** Area metadata from `<area>/_area.yaml`. */
export interface AreaMeta {
  title: string;
  order: number;
  description?: string;
}

export type E2eRunner = "bun-script" | "playwright";
export type CoverageEnforce = "warn" | "error";

/** Per-route capture override in `_config.yaml` `screens.overrides`. */
export interface ScreensCaptureOverride {
  /** Concrete path to visit instead of the pattern (catch-alls, tokens, queries). */
  path?: string;
  skip: boolean;
  reason?: string;
}

/**
 * Optional `screens:` block of `_config.yaml` — screenshot-capture config
 * (viewport, dynamic-segment params, per-route overrides). Config only:
 * never serialized into the manifest; read by the capture script and `check`.
 */
export interface ScreensConfig {
  /** Requested capture viewport, `<width>x<height>` px. */
  viewport: string;
  /** Dynamic segment name → substitute value (`app: myapp` for `[app]`). */
  params: Record<string, string>;
  overrides: Record<string, ScreensCaptureOverride>;
}

/** Per-app config from `apps/<app>/mechanics/_config.yaml`. */
export interface AppMechanicsConfig {
  /** Spec globs relative to the app root, e.g. `e2e/**\/*.spec.ts`. */
  testGlobs: string[];
  e2eRunner: E2eRunner;
  /** Required when `e2eRunner: playwright`. */
  playwrightConfig?: string;
  coverage: {
    enforce: CoverageEnforce;
    /**
     * Surface kind → globs whose matches are excused from needing a claim.
     * Per-kind rather than three fixed keys, so a kind gains ignore support by
     * existing rather than by someone adding `ignoreWhatever` to this type —
     * crons and HTTP endpoints simply had none before.
     */
    ignore: Record<string, string[]>;
  };
  screens?: ScreensConfig;
}

/** One project-specific surface, found by glob and served by `generic-glob`. */
export interface RepoSurfaceSpec {
  kind: string;
  label?: string;
  /** App-relative globs; matching file paths become the items, verbatim. */
  globs: string[];
}

/** One explicitly declared app in `mechanics.config.yaml`. */
export interface RepoAppEntry {
  slug: string;
  /** Repo-relative app root. `.` for a single-app repo. */
  dir: string;
  /** Built-in adapter names; falls back to the repo-level default. */
  adapters?: string[];
  /** Glob surfaces for this app; falls back to the repo-level default. */
  surfaces?: RepoSurfaceSpec[];
}

/**
 * Repo-level config from `mechanics.config.yaml` — the file that says where
 * apps and manifests live, and which adapters apps get. Its presence is also
 * what marks a directory as the repo root.
 */
export interface RepoMechanicsConfig {
  /** Parent of every app, one dir per app. Ignored when `apps` is non-empty. */
  appsDir?: string;
  /** Explicit apps. Non-empty ⇒ discovery under `appsDir` is off. */
  apps: RepoAppEntry[];
  manifestsDir: string;
  /** Default adapters for apps that do not name their own. */
  adapters: string[];
  /** Default glob surfaces for apps that do not declare their own. */
  surfaces: RepoSurfaceSpec[];
}

/** How a spec ↔ mechanic link was discovered. */
export type TestLinkVia = "annotation" | "describe-title";

export interface TestLink {
  /** Repo-relative spec path. */
  spec: string;
  runner: E2eRunner;
  via: TestLinkVia;
}

/** One coverage bucket — one surface kind's items, split three ways. */
export interface CoverageBucket {
  total: number;
  claimed: number;
  ignored: number;
  /** Inventory items no mechanic claims (sorted). */
  unclaimed: string[];
}

/**
 * Buckets keyed by surface kind. Serialized with keys in sorted order so the
 * manifest stays byte-stable no matter what order adapters ran in; `surfaces`
 * on the manifest carries the order a UI should render them in.
 */
export type CoverageReport = Record<string, CoverageBucket>;

/** A surface kind an app's adapters provide, for consumers that render labels. */
export interface ManifestSurface {
  kind: string;
  label: string;
}

/** Manifest row for one mechanic (everything the dashboard list needs). */
export interface ManifestMechanic {
  id: string;
  title: string;
  kind: MechanicKind;
  area: string;
  status: MechanicDocStatus;
  priority: MechanicPriority;
  roles: string[];
  claims: MechanicClaims;
  paths: string[];
  nonFunctional: NonFunctionalTag[];
  destructive: boolean;
  criteria: string[];
  edgeCaseCount: number;
  errorStateCount: number;
  tests: TestLink[];
  source: string;
  aliases: string[];
  verify?: VerifyHint;
}

export interface ManifestArea {
  slug: string;
  title: string;
  order: number;
  description?: string;
  mechanicCount: number;
}

export interface TestCoverageSummary {
  /** Mechanics with ≥1 discovered test link. */
  withTests: number;
  /** Mechanics hinted `verify: manual-only` (missing-test warning suppressed). */
  manualOnly: number;
  /** Mechanics with no test link and no manual-only hint. */
  untested: number;
}

/** The committed manifest at `packages/mechanics/manifests/<slug>.mechanics.json`. */
export interface MechanicsManifest {
  /** 2 since claims and coverage became keyed by adapter-declared surface kind. */
  schemaVersion: 2;
  appSlug: string;
  mechanicCount: number;
  /** Kinds this app's adapters provide, in adapter order — the render order. */
  surfaces: ManifestSurface[];
  areas: ManifestArea[];
  /** Stably sorted by `id`. */
  mechanics: ManifestMechanic[];
  coverage: CoverageReport;
  testCoverage: TestCoverageSummary;
}

// ---------------------------------------------------------------------------
// Waves — hand-editable YAML at `apps/<app>/mechanics/waves/<slug>.yaml`.
// NOT part of the manifest (see determinism contract above).
// ---------------------------------------------------------------------------

export type WaveStatus = "open" | "closed" | "abandoned";
export type VerificationStatus = "pending" | "pass" | "fail" | "blocked" | "n-a";
export type VerificationMethod = "e2e" | "agent" | "manual";

export interface WaveScope {
  areas: string[];
  kinds: MechanicKind[];
  ids: string[];
  exclude: string[];
}

/** Links into the variant/redesign machinery this wave verifies. */
export interface WaveLinks {
  designDirection?: string;
  /** `previewCategories.categoryId` rows (carry `migrationWave`). */
  previewCategoryIds: string[];
  /** `<categoryId>/<winnerId>` keys from `.preview-decisions.json`. */
  previewDecisions: string[];
}

export interface WaveVerification {
  mechanic: string;
  status: VerificationStatus;
  method: VerificationMethod;
  /** Spec path, screenshot path, URL, or free-text note. Required for `pass`. */
  evidence?: string;
  verifiedBy?: string;
  /** Date-only (YYYY-MM-DD) to keep diffs small. */
  verifiedAt?: string;
  /** AC labels that failed, e.g. `[AC2]`. */
  failedCriteria?: string[];
  note?: string;
}

export interface WaveFile {
  /** Must equal the filename stem. */
  wave: string;
  title: string;
  status: WaveStatus;
  startedAt: string;
  closedAt?: string | null;
  baselineSha?: string;
  scope: WaveScope;
  links: WaveLinks;
  notes?: string;
  /** Absent mechanic = pending. One entry per mechanic, sorted by `mechanic`. */
  verifications: WaveVerification[];
}

/** Computed rollup of one wave against the current mechanics corpus. */
export interface WaveSummary {
  slug: string;
  title: string;
  status: WaveStatus;
  startedAt: string;
  scopeSize: number;
  counts: Record<VerificationStatus, number>;
  /**
   * `(pass + n-a) / scopeSize` — a RATIO in [0, 1], 0 when scope is empty.
   * Named for what it holds: it was `percentVerified` while nothing rendered
   * it, and the MCP made it the first thing an agent would read and report as
   * a percentage.
   */
  verifiedRatio: number;
  links: WaveLinks;
}
