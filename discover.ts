/**
 * Corpus discovery: walk `apps/<app>/mechanics/` into parsed docs + area
 * metadata, and scan the app's spec files for test↔mechanic links.
 *
 * Test links are DISCOVERED, never declared in frontmatter:
 *   1. `// @mechanic <id> [<id> …]` annotation comments — the universal
 *      mechanism (works in console's plain bun-script agent-browser specs,
 *      which have no describe blocks).
 *   2. A mechanic ID as the leading token of a Playwright describe title:
 *      `test.describe("console.observe.logs-tab — filters by level", …)`.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { listFilesRecursive, matchesAnyGlob, pathExists, REPO_ROOT } from "./fsutil";
import { appPath, appDir as appRootDir } from "./layout";
import { parseMechanicFile } from "./parser";
import { appConfigSchema, areaMetaSchema, formatZodError } from "./schema";
import type { AppMechanicsConfig, AreaMeta, MechanicDoc, TestLink } from "./types";
import { KEBAB_SEGMENT_RE, MECHANIC_ID_RE } from "./types";

/** Directory names under `mechanics/` that are not areas. */
const NON_AREA_DIRS = new Set(["waves"]);

export interface DiscoveredCorpus {
  appSlug: string;
  config: AppMechanicsConfig | null;
  /** Area slug → metadata (only areas whose `_area.yaml` parsed). */
  areas: Map<string, AreaMeta>;
  docs: MechanicDoc[];
  errors: string[];
  warnings: string[];
}

export function mechanicsDir(appSlug: string, repoRoot = REPO_ROOT): string {
  return path.join(repoRoot, appPath(appSlug, repoRoot, "mechanics"));
}

/** Walk one app's mechanics tree. Missing tree → `config: null` + one error. */
export async function discoverCorpus(
  appSlug: string,
  repoRoot = REPO_ROOT
): Promise<DiscoveredCorpus> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const areas = new Map<string, AreaMeta>();
  const docs: MechanicDoc[] = [];
  const dir = mechanicsDir(appSlug, repoRoot);
  // Repo-relative prefix for every path this function names. `apps/console` in
  // a monorepo, `` in a single-app repo — the only place the two differ.
  const rel = (...segments: string[]) => appPath(appSlug, repoRoot, "mechanics", ...segments);
  const pathCtx = { appSlug, mechanicsDir: rel() };

  if (!(await pathExists(dir))) {
    return {
      appSlug,
      config: null,
      areas,
      docs,
      errors: [`${rel()} does not exist — not onboarded`],
      warnings,
    };
  }

  const config = await readConfig(appSlug, repoRoot, errors);

  const entries = await fs.readdir(dir, { withFileTypes: true });
  const areaDirs = entries
    .filter((e) => e.isDirectory() && !NON_AREA_DIRS.has(e.name))
    .map((e) => e.name)
    .sort();

  for (const area of areaDirs) {
    if (!KEBAB_SEGMENT_RE.test(area)) {
      errors.push(`${rel(area)}: area dir must be kebab-case (it becomes the ID segment)`);
      continue;
    }

    const areaDir = path.join(dir, area);
    const metaPath = path.join(areaDir, "_area.yaml");
    if (await pathExists(metaPath)) {
      try {
        const parsed = areaMetaSchema.safeParse(YAML.parse(await fs.readFile(metaPath, "utf8")));
        if (parsed.success) {
          areas.set(area, parsed.data);
        } else {
          for (const line of formatZodError(parsed.error)) {
            errors.push(`${rel(area, "_area.yaml")}: ${line}`);
          }
        }
      } catch (err) {
        errors.push(
          `${rel(area, "_area.yaml")}: unparseable YAML (${err instanceof Error ? err.message : err})`
        );
      }
    } else {
      errors.push(`${rel(area, "_area.yaml")} is missing`);
    }

    const files = (await fs.readdir(areaDir)).filter(
      (f) => f.endsWith(".md") && !f.startsWith("_")
    );
    for (const file of files.sort()) {
      const source = rel(area, file);
      const raw = await fs.readFile(path.join(areaDir, file), "utf8");
      const { doc, errors: fileErrors } = parseMechanicFile(raw, source, pathCtx);
      for (const e of fileErrors) {
        errors.push(`${source}: ${e}`);
      }
      if (doc) docs.push(doc);
    }
  }

  // Cross-file: alias uniqueness (path-derived IDs are unique by construction).
  const idSet = new Set(docs.map((d) => d.id));
  const aliasOwner = new Map<string, string>();
  for (const doc of docs) {
    for (const alias of doc.frontmatter.aliases) {
      if (idSet.has(alias)) {
        errors.push(`${doc.source}: alias ${alias} collides with a live mechanic ID`);
      }
      const owner = aliasOwner.get(alias);
      if (owner) {
        errors.push(`${doc.source}: alias ${alias} already claimed by ${owner}`);
      } else {
        aliasOwner.set(alias, doc.id);
      }
    }
  }

  docs.sort((a, b) => a.id.localeCompare(b.id));
  return { appSlug, config, areas, docs, errors, warnings };
}

async function readConfig(
  appSlug: string,
  repoRoot: string,
  errors: string[]
): Promise<AppMechanicsConfig | null> {
  const configPath = path.join(mechanicsDir(appSlug, repoRoot), "_config.yaml");
  const rel = appPath(appSlug, repoRoot, "mechanics", "_config.yaml");
  if (!(await pathExists(configPath))) {
    errors.push(`${rel} is missing`);
    return null;
  }
  try {
    const parsed = appConfigSchema.safeParse(YAML.parse(await fs.readFile(configPath, "utf8")));
    if (!parsed.success) {
      for (const line of formatZodError(parsed.error)) {
        errors.push(`${rel}: ${line}`);
      }
      return null;
    }
    return parsed.data;
  } catch (err) {
    errors.push(`${rel}: unparseable YAML (${err instanceof Error ? err.message : err})`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Test-link discovery
// ---------------------------------------------------------------------------

const ANNOTATION_RE = /@mechanic\s+([^\n]+)/g;
const DESCRIBE_RE = /\bdescribe\(\s*["'`]([^"'`\n]+)["'`]/g;

/** Scan the app's `testGlobs` spec files for mechanic links. */
export async function discoverTestLinks(
  appSlug: string,
  config: AppMechanicsConfig,
  repoRoot = REPO_ROOT
): Promise<Map<string, TestLink[]>> {
  const links = new Map<string, TestLink[]>();
  if (config.testGlobs.length === 0) return links;

  const dir = appRootDir(appSlug, repoRoot);
  const allFiles = await listFilesRecursive(dir);
  const specFiles = allFiles.filter(
    (f) => !f.includes("node_modules/") && matchesAnyGlob(f, config.testGlobs)
  );

  for (const rel of specFiles) {
    const spec = appPath(appSlug, repoRoot, rel);
    const content = await fs.readFile(path.join(dir, rel), "utf8");

    for (const match of content.matchAll(ANNOTATION_RE)) {
      for (const token of (match[1] ?? "").trim().split(/\s+/)) {
        if (MECHANIC_ID_RE.test(token)) {
          addLink(links, token, { spec, runner: config.e2eRunner, via: "annotation" });
        }
      }
    }
    for (const match of content.matchAll(DESCRIBE_RE)) {
      const leading = (match[1] ?? "").trim().split(/\s+/)[0] ?? "";
      if (MECHANIC_ID_RE.test(leading)) {
        addLink(links, leading, { spec, runner: config.e2eRunner, via: "describe-title" });
      }
    }
  }

  for (const list of links.values()) {
    list.sort((a, b) => a.spec.localeCompare(b.spec) || a.via.localeCompare(b.via));
  }
  return links;
}

function addLink(map: Map<string, TestLink[]>, id: string, link: TestLink): void {
  const list = map.get(id) ?? [];
  if (!list.some((l) => l.spec === link.spec && l.via === link.via)) {
    list.push(link);
  }
  map.set(id, list);
}
