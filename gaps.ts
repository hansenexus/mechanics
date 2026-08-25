/**
 * What the corpus is MISSING.
 *
 * `check` answers "is this corpus valid?". This answers "is it true?", and
 * those are different questions: a corpus goes stale by omission, never by
 * breaking. Every rule below was prose in the `mechanics-gaps` skill, which
 * meant an agent could be argued out of it. A predicate cannot be argued with.
 *
 * Every gap carries a LANE:
 *
 *   `auto`    — closing it is a mechanical edit with one correct answer, so a
 *               machine may make it. Each such rule is stated as a predicate
 *               below and asserted directly in `gaps.test.ts`; "clearly" and
 *               "unambiguously" are not implementable words.
 *   `propose` — closing it is a judgment about behaviour. A machine may draft
 *               it and a human decides. Authoring a mechanic, widening an
 *               ignore, promoting a draft and recording a verdict live here
 *               permanently: they are the moves that turn this system into
 *               decoration.
 *
 * `planGaps` is pure so the rules are testable without a repo; `collectGapInput`
 * is the only part that touches disk, and it does so entirely through the
 * existing engines — nothing here re-implements an inventory.
 */

import type { Inventory } from "./adapters";
import { buildProvenance } from "./adapters";
import { inventoryAppKinds } from "./coverage";
import { discoverCorpus } from "./discover";
import { listFilesRecursive, matchesAnyGlob, REPO_ROOT } from "./fsutil";
import { appAdapters, appDir, appPath } from "./layout";
import { buildManifest } from "./manifest";
import type { AppMechanicsConfig, ManifestMechanic, MechanicsManifest, WaveFile } from "./types";
import { loadWaves } from "./waves";

export type GapClass =
  | "unclaimed-surface"
  | "stale-ignore"
  | "broad-ignore"
  | "untested-behaviour"
  | "draft-debt"
  | "dangling-wave"
  | "missing-claim-path"
  | "unlinked-spec";

export type GapLane = "auto" | "propose";

export interface Gap {
  /**
   * Deterministic and readable — `untested-behaviour:perch.alerts.mute`. A
   * re-scan must produce the same key for the same gap, or every run raises a
   * duplicate proposal for something already under review.
   */
  key: string;
  gap: GapClass;
  lane: GapLane;
  app: string;
  /** The surface item, mechanic id, wave slug or ignore glob this is about. */
  subject: string;
  title: string;
  /** Why it matters. One line. */
  detail: string;
  /** What to do about it. One line. */
  suggestion: string;
  severity: "p0" | "p1" | "p2";
  /** Set only when `lane` is `auto`: the edit that closes it. */
  op?: AutoOp;
}

/**
 * The mechanical edits, and nothing else. Every variant here is required to
 * have exactly one correct form given the tree — if a reasonable person could
 * write it two ways, it is a judgment and belongs in the propose lane.
 */
export type AutoOp =
  | { kind: "add-paths"; file: string; mechanic: string; paths: string[] }
  | {
      kind: "narrow-ignore";
      file: string;
      surfaceKind: string;
      glob: string;
      literals: string[];
    }
  | { kind: "annotate-spec"; file: string; mechanic: string };

/** Everything `planGaps` needs, gathered once. */
export interface GapInput {
  app: string;
  manifest: MechanicsManifest;
  config: AppMechanicsConfig;
  inventory: Inventory;
  /** kind → item → source files, from `buildProvenance`. Absence means unknown. */
  provenance: Record<string, Record<string, string[]>>;
  waves: WaveFile[];
  /** App-relative paths of every file under the app root. */
  appFiles: string[];
  /** Repo-relative POSIX path of the app's `mechanics/` dir. */
  corpusDir: string;
}

/** How many files may be written into a `paths:` before it stops being a fact. */
const MAX_AUTO_PATHS = 6;
/** How many literals an ignore glob may collapse to before the list is noise. */
const MAX_IGNORE_LITERALS = 8;

export function planGaps(input: GapInput): Gap[] {
  const gaps: Gap[] = [
    ...unclaimedSurfaces(input),
    ...ignoreGaps(input),
    ...testGaps(input),
    ...draftDebt(input),
    ...danglingWaves(input),
    ...claimPathGaps(input),
  ];
  // Deterministic output: `--json` is diffed, and an unstable order turns
  // every re-scan into a change nobody made.
  const rank = { p0: 0, p1: 1, p2: 2 };
  return gaps.sort((a, b) => rank[a.severity] - rank[b.severity] || a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------
// 1. Unclaimed surfaces — always propose
// ---------------------------------------------------------------------------

function unclaimedSurfaces(input: GapInput): Gap[] {
  const out: Gap[] = [];
  for (const surface of input.manifest.surfaces) {
    const bucket = input.manifest.coverage[surface.kind];
    for (const item of bucket?.unclaimed ?? []) {
      out.push({
        key: `unclaimed-surface:${input.app}:${surface.kind}:${item}`,
        gap: "unclaimed-surface",
        lane: "propose",
        app: input.app,
        subject: item,
        title: `unclaimed ${surface.label} "${item}"`,
        detail:
          "A surface the app ships that no mechanic documents — behaviour with no definition of done.",
        // Naming the owning area is a judgment, and writing the mechanic is
        // authoring. Both belong to a person; this only says which is which.
        suggestion: `Claim it from the area that owns it, or add a justified ignore for ${surface.kind}.`,
        severity: "p1",
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2/3. Ignore globs — stale (matches nothing) and broad (collapsible)
// ---------------------------------------------------------------------------

/**
 * An `ignore` glob is a lid on a hole. Two ways it goes wrong: the hole moved
 * and the lid now covers nothing, or the lid is wide enough that surfaces
 * landing later are excused silently — which is the same as never having
 * looked at them.
 *
 * Narrowing IS mechanical, despite reading like a judgment: replacing a
 * wildcard with the sorted literal items it matches TODAY is provably
 * behaviour-preserving now (identical claimed/ignored/unclaimed counts) and
 * strictly narrower later, because a new surface that would have been silently
 * excused shows up as unclaimed instead. It appeals to no one's intent.
 */
function ignoreGaps(input: GapInput): Gap[] {
  const out: Gap[] = [];
  const claimed = claimedItems(input.manifest);

  for (const [kind, globs] of Object.entries(input.config.coverage.ignore)) {
    const items = input.inventory.items[kind] ?? [];
    for (const glob of globs ?? []) {
      const matched = items.filter((i: string) => matchesAnyGlob(i, [glob])).sort();
      const key = `${input.app}:${kind}:${glob}`;

      if (matched.length === 0) {
        out.push({
          key: `stale-ignore:${key}`,
          gap: "stale-ignore",
          lane: "propose",
          app: input.app,
          subject: glob,
          title: `ignore glob "${glob}" (${kind}) matches nothing`,
          detail:
            "A lid on a hole that has since moved. It excuses nothing today and will excuse whatever lands on that path tomorrow.",
          suggestion: "Delete it, or repoint it at what it was meant to excuse.",
          severity: "p2",
        });
        continue;
      }

      const wild = /[*?]/.test(glob);
      if (!wild) continue;

      // Narrowing must not move an item between buckets. If the glob covers
      // something a mechanic also claims, collapsing it changes what `ignored`
      // means, so a person decides.
      const overlapsClaimed = matched.some((i: string) => claimed.has(i));
      const collapsible = !overlapsClaimed && matched.length <= MAX_IGNORE_LITERALS;

      out.push({
        key: `broad-ignore:${key}`,
        gap: "broad-ignore",
        lane: collapsible ? "auto" : "propose",
        app: input.app,
        subject: glob,
        title: `ignore glob "${glob}" (${kind}) excuses ${matched.length} surface(s) by wildcard`,
        detail:
          "A wildcard ignore keeps excusing surfaces that land under it later, without anyone deciding to.",
        suggestion: collapsible
          ? `Freeze it to the ${matched.length} it actually excuses: ${matched.join(", ")}.`
          : overlapsClaimed
            ? "Some matches are also claimed by a mechanic — narrowing would move them between buckets, so decide by hand."
            : `It matches ${matched.length} surfaces, too many to list literally — narrow it by hand.`,
        severity: "p2",
        ...(collapsible
          ? {
              op: {
                kind: "narrow-ignore" as const,
                file: `${input.corpusDir}/_config.yaml`,
                surfaceKind: kind,
                glob,
                literals: matched,
              },
            }
          : {}),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. Untested behaviours, and the one spec link that is mechanical
// ---------------------------------------------------------------------------

/**
 * `// @mechanic <id>` on a spec is mechanical only when the file can mean one
 * mechanic and no other. The predicate:
 *
 *   1. the spec matches `testGlobs` and currently yields NO link at all,
 *   2. its basename stem matches exactly ONE mechanic slug in the whole app,
 *   3. that mechanic has no tests.
 *
 * Two mechanics sharing a slug across areas is ambiguous and drops to propose.
 * This is the only auto op that writes app source, so it is gated separately
 * at the CLI rather than riding along with the corpus edits.
 */
function testGaps(input: GapInput): Gap[] {
  const out: Gap[] = [];
  const untested = input.manifest.mechanics.filter(
    (m) => m.tests.length === 0 && m.verify !== "manual-only"
  );
  const bySlug = new Map<string, ManifestMechanic[]>();
  for (const m of untested) {
    const slug = m.id.split(".").pop() ?? m.id;
    bySlug.set(slug, [...(bySlug.get(slug) ?? []), m]);
  }

  const linked = new Set(input.manifest.mechanics.flatMap((m) => m.tests.map((t) => t.spec)));
  const unlinkedSpecs = input.appFiles
    .filter((f) => matchesAnyGlob(f, input.config.testGlobs))
    .filter((f) => !linked.has(f));

  const matchedMechanic = new Set<string>();
  for (const spec of unlinkedSpecs) {
    const stem = (spec.split("/").pop() ?? spec).replace(/\.(spec|test)\.[tj]sx?$/, "");
    const candidates = bySlug.get(stem) ?? [];
    if (candidates.length !== 1) continue;
    const m = candidates[0];
    if (!m) continue;
    matchedMechanic.add(m.id);
    out.push({
      key: `unlinked-spec:${input.app}:${spec}`,
      gap: "unlinked-spec",
      lane: "auto",
      app: input.app,
      subject: spec,
      title: `spec "${spec}" tests ${m.id} but nothing says so`,
      detail:
        "Test links are discovered from the spec, never declared in frontmatter — an unannotated spec leaves its mechanic reading as untested.",
      suggestion: `Annotate it with // @mechanic ${m.id}.`,
      severity: m.priority === "p0" ? "p0" : "p1",
      op: { kind: "annotate-spec", file: spec, mechanic: m.id },
    });
  }

  for (const m of untested) {
    if (matchedMechanic.has(m.id)) continue;
    out.push({
      key: `untested-behaviour:${m.id}`,
      gap: "untested-behaviour",
      lane: "propose",
      app: input.app,
      subject: m.id,
      title: `${m.id} has no test`,
      detail:
        m.priority === "p0"
          ? "A p0 behaviour with neither a linked spec nor a manual-only marker is the highest-value gap in the corpus."
          : "The mechanic exists and nothing checks it.",
      suggestion: `Write a spec and annotate it, or set verify: manual-only if it genuinely cannot be automated.`,
      severity: m.priority === "p0" ? "p0" : "p2",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5. Draft debt — always propose
// ---------------------------------------------------------------------------

function draftDebt(input: GapInput): Gap[] {
  return input.manifest.mechanics
    .filter((m) => m.status === "draft")
    .map((m) => ({
      key: `draft-debt:${m.id}`,
      gap: "draft-debt" as const,
      lane: "propose" as const,
      app: input.app,
      subject: m.id,
      title: `${m.id} is still a draft`,
      detail: "A corpus of permanent drafts is a corpus nobody trusts.",
      // Promoting a draft is a review, and a review is a person reading it.
      suggestion: "Review it and promote it to active, or delete it.",
      severity: "p2" as const,
    }));
}

// ---------------------------------------------------------------------------
// 6. Dangling waves — always propose
// ---------------------------------------------------------------------------

/**
 * A `closed` wave with pending entries is already an error from
 * `validateWaveAgainstCorpus`, so it is deliberately NOT repeated here —
 * reporting one problem twice teaches people to skim both.
 */
function danglingWaves(input: GapInput): Gap[] {
  const out: Gap[] = [];
  const aliasOf = new Map<string, string>();
  for (const m of input.manifest.mechanics) {
    for (const alias of m.aliases) aliasOf.set(alias, m.id);
  }

  for (const wave of input.waves) {
    if (wave.status !== "open") continue;

    if (wave.verifications.every((v) => v.status === "pending")) {
      out.push({
        key: `dangling-wave:${input.app}:${wave.wave}`,
        gap: "dangling-wave",
        lane: "propose",
        app: input.app,
        subject: wave.wave,
        title: `wave "${wave.wave}" is open with nothing verified`,
        detail: "An open wave nobody has moved reads as work in flight when it is not.",
        suggestion: "Run mechanics verify against it, or close it.",
        severity: "p2",
      });
    }

    for (const v of wave.verifications) {
      const live = aliasOf.get(v.mechanic);
      if (!live) continue;
      out.push({
        key: `dangling-wave:${input.app}:${wave.wave}:${v.mechanic}`,
        gap: "dangling-wave",
        lane: "propose",
        app: input.app,
        subject: `${wave.wave}:${v.mechanic}`,
        title: `wave "${wave.wave}" verifies "${v.mechanic}", which is now an alias of ${live}`,
        detail: "A verdict recorded against an alias is a verdict nobody will find again.",
        suggestion: `Repoint the entry at ${live}.`,
        severity: "p2",
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 7. Missing `paths:` — auto when provenance can answer for every claim
// ---------------------------------------------------------------------------

/**
 * `paths:` globs are the only impact mechanism that works for any stack — the
 * surface heuristics in `impact.ts` are conveniences for the two built-in
 * adapters. Filling them in directly improves the question an agent asks
 * before opening a PR.
 *
 * Auto only when ALL hold:
 *   1. `paths:` is empty — appending to a non-empty list is a judgment about
 *      whether the existing list was already complete,
 *   2. every claim resolves through provenance to at least one file, so
 *      nothing is guessed,
 *   3. no OTHER mechanic claims any of the same items — a shared surface has
 *      no single implementing file,
 *   4. the result is small enough to read.
 *
 * The written entries are literal repo-relative paths, never invented globs: a
 * literal path is self-verifying (`emptyPathGlobs` proves it matches), while
 * `src/foo/**` is an aspiration.
 */
function claimPathGaps(input: GapInput): Gap[] {
  const out: Gap[] = [];
  const claimants = new Map<string, string[]>();
  for (const m of input.manifest.mechanics) {
    for (const items of Object.values(m.claims)) {
      for (const item of items ?? []) {
        claimants.set(item, [...(claimants.get(item) ?? []), m.id]);
      }
    }
  }

  for (const m of input.manifest.mechanics) {
    if (m.paths.length > 0) continue;
    const claimEntries = Object.entries(m.claims).flatMap(([kind, items]) =>
      (items ?? []).map((item) => [kind, item] as const)
    );
    if (claimEntries.length === 0) continue;

    const files = new Set<string>();
    let complete = true;
    let shared = false;
    for (const [kind, item] of claimEntries) {
      const resolved = input.provenance[kind]?.[item];
      if (!resolved || resolved.length === 0) {
        complete = false;
        continue;
      }
      if ((claimants.get(item) ?? []).length > 1) shared = true;
      for (const f of resolved) files.add(f);
    }

    const paths = [...files].sort();
    const auto = complete && !shared && paths.length > 0 && paths.length <= MAX_AUTO_PATHS;
    out.push({
      key: `missing-claim-path:${m.id}`,
      gap: "missing-claim-path",
      lane: auto ? "auto" : "propose",
      app: input.app,
      subject: m.id,
      title: `${m.id} lists no implementing paths`,
      detail:
        "`paths:` is the only thing that lets `mechanics impact` answer for this mechanic on any stack.",
      suggestion: auto
        ? `Add the ${paths.length} file(s) its claims resolve to: ${paths.join(", ")}.`
        : !complete
          ? "Some claims resolve to no known file — no adapter can say what implements them, so add the paths by hand."
          : shared
            ? "It claims a surface another mechanic also claims, so no single file implements it."
            : `Its claims resolve to ${paths.length} files, too many to record as fact.`,
      severity: "p2",
      ...(auto
        ? { op: { kind: "add-paths" as const, file: m.source, mechanic: m.id, paths } }
        : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// collection
// ---------------------------------------------------------------------------

function claimedItems(manifest: MechanicsManifest): Set<string> {
  const out = new Set<string>();
  for (const m of manifest.mechanics) {
    for (const items of Object.values(m.claims)) {
      for (const item of items ?? []) out.add(item);
    }
  }
  return out;
}

/**
 * The only part that touches disk, and it is all reuse: `buildManifest` for
 * the corpus and coverage, `inventoryAppKinds` + `buildProvenance` for the
 * surfaces, `loadWaves` for the board.
 */
export async function collectGapInput(app: string, repoRoot = REPO_ROOT): Promise<GapInput> {
  const { manifest, corpus } = await buildManifest(app, repoRoot);
  if (!corpus.config) throw new Error(`${app}: no mechanics/_config.yaml — not onboarded`);

  const dir = appDir(app, repoRoot);
  const appFiles = await listFilesRecursive(dir);
  const adapters = appAdapters(app, repoRoot);
  const ctx = { appSlug: app, appDir: dir, repoRoot, files: appFiles };

  const [inventory, provenance, { waves }] = await Promise.all([
    inventoryAppKinds(app, repoRoot, adapters),
    buildProvenance(adapters, ctx),
    loadWaves(app, repoRoot),
  ]);

  return {
    app,
    manifest,
    config: corpus.config,
    inventory,
    provenance,
    waves,
    appFiles,
    corpusDir: appPath(app, repoRoot, "mechanics"),
  };
}

export async function findGaps(app: string, repoRoot = REPO_ROOT): Promise<Gap[]> {
  return planGaps(await collectGapInput(app, repoRoot));
}
