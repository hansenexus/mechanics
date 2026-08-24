/**
 * Manifest build + emit + loaders.
 *
 * The committed manifest at `packages/mechanics/manifests/<slug>.mechanics.json`
 * is byte-stable (see the determinism contract in types.ts): stable sorts
 * everywhere, 2-space indent, trailing newline, no timestamps, no wave state.
 * `emitManifest({check: true})` is the drift gate primitive.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { computeCoverage, inventoryAppKinds } from "./coverage";
import { type DiscoveredCorpus, discoverCorpus, discoverTestLinks } from "./discover";
import { pathExists, REPO_ROOT } from "./fsutil";
import { appPath, manifestsDir } from "./layout";
import { parseMechanicFile } from "./parser";
import type {
  ManifestArea,
  ManifestMechanic,
  ManifestSurface,
  MechanicClaims,
  MechanicDoc,
  MechanicsManifest,
  TestLink,
} from "./types";

export interface BuildResult {
  manifest: MechanicsManifest;
  corpus: DiscoveredCorpus;
  errors: string[];
  warnings: string[];
}

/** Build one app's manifest from the committed tree (does not write anything). */
export async function buildManifest(appSlug: string, repoRoot = REPO_ROOT): Promise<BuildResult> {
  const corpus = await discoverCorpus(appSlug, repoRoot);
  const errors = [...corpus.errors];
  const warnings = [...corpus.warnings];

  const inventory = await inventoryAppKinds(appSlug, repoRoot);
  const config = corpus.config;
  const surfaces = inventory.kinds.map((k) => ({ kind: k.kind, label: k.label }));

  let links = new Map<string, TestLink[]>();
  if (config) {
    links = await discoverTestLinks(appSlug, config, repoRoot);
    const coverage = await computeCoverage(corpus.docs, inventory, config, appSlug, repoRoot);
    errors.push(...coverage.danglingClaims);
    warnings.push(...coverage.emptyPathGlobs);

    // A spec annotation referencing an ID (or alias) that no mechanic owns is
    // an error — a typo there silently unlinks the test.
    const known = new Set(corpus.docs.map((d) => d.id));
    const aliasToId = new Map<string, string>();
    for (const doc of corpus.docs) {
      for (const alias of doc.frontmatter.aliases) aliasToId.set(alias, doc.id);
    }
    for (const [id, linkList] of links) {
      if (!known.has(id) && !aliasToId.has(id)) {
        for (const link of linkList) {
          errors.push(`${link.spec}: references unknown mechanic "${id}"`);
        }
      }
    }

    const manifest = composeManifest(appSlug, corpus, surfaces, coverage.report, links, aliasToId);
    return { manifest, corpus, errors, warnings };
  }

  // Not onboarded / broken config — still return an empty-shaped manifest so
  // callers have a stable type, but `check` will fail on the errors above.
  const empty: MechanicsManifest["coverage"] = {};
  for (const kind of inventory.kinds) {
    empty[kind.kind] = {
      total: inventory.items[kind.kind]?.length ?? 0,
      claimed: 0,
      ignored: 0,
      unclaimed: [],
    };
  }
  const manifest = composeManifest(appSlug, corpus, surfaces, empty, links, new Map());
  return { manifest, corpus, errors, warnings };
}

function composeManifest(
  appSlug: string,
  corpus: DiscoveredCorpus,
  surfaces: ManifestSurface[],
  coverage: MechanicsManifest["coverage"],
  links: Map<string, TestLink[]>,
  aliasToId: Map<string, string>
): MechanicsManifest {
  // Attach links discovered under an alias to the mechanic that owns it now.
  const linksById = new Map<string, TestLink[]>();
  for (const [key, list] of links) {
    const id = aliasToId.get(key) ?? key;
    const existing = linksById.get(id) ?? [];
    for (const link of list) {
      if (!existing.some((l) => l.spec === link.spec && l.via === link.via)) {
        existing.push(link);
      }
    }
    linksById.set(id, existing);
  }

  const mechanics: ManifestMechanic[] = corpus.docs.map((doc) =>
    toManifestMechanic(doc, linksById)
  );
  mechanics.sort((a, b) => a.id.localeCompare(b.id));

  const areas: ManifestArea[] = [...corpus.areas.entries()]
    .map(([slug, meta]) => ({
      slug,
      title: meta.title,
      order: meta.order,
      ...(meta.description !== undefined ? { description: meta.description } : {}),
      mechanicCount: mechanics.filter((m) => m.area === slug).length,
    }))
    .sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));

  const withTests = mechanics.filter((m) => m.tests.length > 0).length;
  const manualOnly = mechanics.filter(
    (m) => m.tests.length === 0 && m.verify === "manual-only"
  ).length;

  return {
    schemaVersion: 2,
    appSlug,
    mechanicCount: mechanics.length,
    surfaces,
    areas,
    mechanics,
    coverage,
    testCoverage: {
      withTests,
      manualOnly,
      untested: mechanics.length - withTests - manualOnly,
    },
  };
}

function toManifestMechanic(doc: MechanicDoc, links: Map<string, TestLink[]>): ManifestMechanic {
  const fm = doc.frontmatter;
  return {
    id: doc.id,
    title: fm.title,
    kind: fm.kind,
    area: doc.area,
    status: fm.status,
    priority: fm.priority,
    roles: [...fm.roles].sort(),
    claims: sortClaims(fm.claims),
    paths: [...fm.paths].sort(),
    nonFunctional: [...fm.nonFunctional].sort(),
    destructive: fm.destructive,
    criteria: doc.criteria,
    edgeCaseCount: doc.edgeCaseCount,
    errorStateCount: doc.errorStateCount,
    tests: links.get(doc.id) ?? [],
    source: doc.source,
    aliases: [...fm.aliases].sort(),
    ...(fm.verify !== undefined ? { verify: fm.verify } : {}),
  };
}

/**
 * Claims come out of YAML in whatever order the author wrote them, so both the
 * kinds and the items inside each are sorted before serialization. Without it
 * the manifest would churn on a reordered frontmatter block and the drift gate
 * would fire on a no-op edit.
 */
function sortClaims(claims: MechanicClaims): MechanicClaims {
  const out: MechanicClaims = {};
  for (const kind of Object.keys(claims).sort()) {
    const items = claims[kind];
    if (items && items.length > 0) out[kind] = [...items].sort();
  }
  return out;
}

/** Canonical JSON serialization (2-space, trailing newline). */
export function manifestJson(manifest: MechanicsManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function manifestPath(appSlug: string, repoRoot = REPO_ROOT): string {
  return path.join(repoRoot, manifestsDir(repoRoot), `${appSlug}.mechanics.json`);
}

export interface EmitResult {
  jsonPath: string;
  changed: boolean;
}

/** Write (or, with `check`, only diff) the committed manifest. */
export async function emitManifest(
  manifest: MechanicsManifest,
  options: { check?: boolean; repoRoot?: string } = {}
): Promise<EmitResult> {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const jsonPath = manifestPath(manifest.appSlug, repoRoot);
  const json = manifestJson(manifest);
  const changed = await fileDiffers(jsonPath, json);
  if (!options.check && changed) {
    await fs.mkdir(path.dirname(jsonPath), { recursive: true });
    await fs.writeFile(jsonPath, json, "utf8");
  }
  return { jsonPath, changed };
}

/** Every onboarded app — one with a committed manifest. */
export async function onboardedApps(repoRoot = REPO_ROOT): Promise<string[]> {
  const dir = path.join(repoRoot, manifestsDir(repoRoot));
  if (!(await pathExists(dir))) return [];
  const files = await fs.readdir(dir);
  return files
    .filter((f) => f.endsWith(".mechanics.json"))
    .map((f) => f.replace(/\.mechanics\.json$/, ""))
    .sort();
}

/** Read one committed manifest, or `null` when the app isn't onboarded. */
export async function loadManifest(
  appSlug: string,
  repoRoot = REPO_ROOT
): Promise<MechanicsManifest | null> {
  try {
    const raw = await fs.readFile(manifestPath(appSlug, repoRoot), "utf8");
    return JSON.parse(raw) as MechanicsManifest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function loadAllManifests(repoRoot = REPO_ROOT): Promise<MechanicsManifest[]> {
  const slugs = await onboardedApps(repoRoot);
  const manifests = await Promise.all(slugs.map((slug) => loadManifest(slug, repoRoot)));
  return manifests.filter((m): m is MechanicsManifest => m !== null);
}

export interface LoadedMechanicDoc {
  doc: MechanicDoc;
  /** Raw markdown body (frontmatter stripped) for prose rendering. */
  body: string;
  errors: string[];
}

/**
 * Read + parse one mechanic file by its repo-relative `source` path (as found
 * in the manifest). PATH GUARD: the source must stay inside the app's
 * `mechanics/` tree — manifest fields are committed data, but the loader still
 * refuses traversal shapes.
 */
export async function loadMechanicDoc(
  appSlug: string,
  source: string,
  repoRoot = REPO_ROOT
): Promise<LoadedMechanicDoc | null> {
  const mechRel = appPath(appSlug, repoRoot, "mechanics");
  if (!source.startsWith(`${mechRel}/`) || source.includes("..")) {
    return null;
  }
  const abs = path.resolve(repoRoot, source);
  if (!abs.startsWith(path.resolve(repoRoot, mechRel) + path.sep)) {
    return null;
  }
  let raw: string;
  try {
    raw = await fs.readFile(abs, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const { doc, errors } = parseMechanicFile(raw, source, { appSlug, mechanicsDir: mechRel });
  if (!doc) return null;
  const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, "");
  return { doc, body, errors };
}

async function fileDiffers(filePath: string, next: string): Promise<boolean> {
  try {
    const current = await fs.readFile(filePath, "utf8");
    return current !== next;
  } catch {
    return true; // missing file ⇒ "changed"
  }
}
