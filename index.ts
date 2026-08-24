/**
 * @hansenexus/mechanics — public read API.
 *
 * This barrel is what the console dashboard imports: committed-manifest
 * loaders + wave loading/rollups + the contract types. Build/verify machinery
 * (corpus discovery, coverage scans, spec execution) stays in its own modules
 * (`./manifest`, `./verify`) so Next server components never pull in process
 * spawning or repo-wide walks.
 */

export {
  type AdapterContext,
  buildInventory,
  createConvexAdapter,
  createGenericGlobAdapter,
  createNextjsAppRouterAdapter,
  defaultAdapters,
  type GlobSurfaceSpec,
  type Inventory,
  normalizeRoutePattern,
  pageFileToRoute,
  type SurfaceAdapter,
  type SurfaceKind,
} from "./adapters";
export { claimMatches } from "./coverage";
export { appendEvent, eventsPath, isKnownEventType, readEvents } from "./docket-events";
export {
  deriveRunId,
  listRunIds,
  loadOrder,
  orderSchema,
  orderYaml,
  parseOrder,
  runDir,
  runsRoot,
  writeOrder,
} from "./docket-order";
export { reduceRun, statePath, writeState } from "./docket-state";
export type {
  Actor,
  CriterionState,
  DocketEvent,
  DocketOrder,
  Liveness,
  RunState,
} from "./docket-types";
export { DEFAULT_PHASES, DOCKET_DIR, DOCKET_PROTO, RUN_ID_RE } from "./docket-types";
export {
  type LoadedMechanicDoc,
  loadAllManifests,
  loadManifest,
  loadMechanicDoc,
  onboardedApps,
} from "./manifest";
export {
  type LoadedCheckpoint,
  type LoadedWaveScreens,
  listScreenWaves,
  loadScreensForWave,
  orderCheckpoints,
  resolveScreenPath,
  routeToScreenSlug,
  SCREEN_FILE_RE,
  type ScreenCaptureStatus,
  type ScreensIndex,
  type ScreensIndexEntry,
  screensIndexJson,
  screensIndexSchema,
  validateScreens,
} from "./screens";
export * from "./types";
export {
  type LoadedWaves,
  loadWave,
  loadWaves,
  resolveWaveScope,
  summarizeWave,
  validateWaveAgainstCorpus,
  waveYaml,
} from "./waves";
