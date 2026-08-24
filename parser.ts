/**
 * Mechanic-file parser: gray-matter frontmatter + the fixed H2 section
 * contract. Collects ALL problems into `errors` (instead of throwing on the
 * first) so `bun mechanics check` can report a file's full damage in one run.
 *
 * Section contract (H2s, exact titles, fixed order):
 *   ## Story · ## Acceptance Criteria · ## Edge Cases · ## Error States
 *   [## Non-functional] [## Notes]        ← optional, in this order
 *
 * Acceptance criteria are bullets shaped `- **AC<n>** Given … When … Then …`.
 * Labels must be unique within a file; they are the addressable unit wave
 * failures point at (`failedCriteria: [AC2]`).
 */

import matter from "gray-matter";
import { formatZodError, mechanicFrontmatterSchema } from "./schema";
import type { MechanicDoc, SectionName } from "./types";
import { KEBAB_SEGMENT_RE, OPTIONAL_SECTIONS, REQUIRED_SECTIONS } from "./types";

export interface ParseResult {
  /** `null` when the file is too broken to produce a usable doc. */
  doc: MechanicDoc | null;
  errors: string[];
}

const SECTION_ORDER: SectionName[] = [...REQUIRED_SECTIONS, ...OPTIONAL_SECTIONS];
const AC_BULLET_RE = /^-\s+\*\*(AC[1-9]\d*)\*\*\s+(.*)$/;
const BULLET_RE = /^-\s+\S/;

/**
 * Where an app's mechanic tree is rooted. The app slug is passed rather than
 * read off the path because it is not always ON the path: a single-app repo
 * has `mechanics/<area>/<slug>.md` and nothing to parse a slug out of.
 */
export interface MechanicPathContext {
  appSlug: string;
  /** Repo-relative POSIX dir: `apps/console/mechanics`, or `mechanics`. */
  mechanicsDir: string;
}

/** Derive `{area, slug}` from a repo-relative mechanic source path. */
export function parseMechanicPath(
  source: string,
  ctx: MechanicPathContext
): { appSlug: string; area: string; slug: string } | null {
  const prefix = ctx.mechanicsDir === "" ? "" : `${ctx.mechanicsDir}/`;
  if (!source.startsWith(prefix)) return null;
  const m = source.slice(prefix.length).match(/^([^/]+)\/([^/]+)\.md$/);
  if (!m) return null;
  const [, area, slug] = m;
  if (!area || !slug) return null;
  if (
    !KEBAB_SEGMENT_RE.test(ctx.appSlug) ||
    !KEBAB_SEGMENT_RE.test(area) ||
    !KEBAB_SEGMENT_RE.test(slug)
  ) {
    return null;
  }
  return { appSlug: ctx.appSlug, area, slug };
}

/** Parse one mechanic file. `source` is the repo-relative path (drives the ID). */
export function parseMechanicFile(
  raw: string,
  source: string,
  ctx: MechanicPathContext
): ParseResult {
  const errors: string[] = [];

  const parts = parseMechanicPath(source, ctx);
  if (!parts) {
    const expected = [ctx.mechanicsDir, "<area>", "<slug>.md"].filter(Boolean).join("/");
    return {
      doc: null,
      errors: [
        `invalid mechanic path — expected ${expected} with kebab-case segments, got ${source}`,
      ],
    };
  }

  let fmRaw: Record<string, unknown>;
  let body: string;
  try {
    const parsed = matter(raw);
    fmRaw = parsed.data as Record<string, unknown>;
    body = parsed.content;
  } catch (err) {
    return {
      doc: null,
      errors: [`frontmatter is not parseable YAML: ${err instanceof Error ? err.message : err}`],
    };
  }

  const fm = mechanicFrontmatterSchema.safeParse(fmRaw);
  if (!fm.success) {
    for (const line of formatZodError(fm.error)) {
      errors.push(`frontmatter ${line}`);
    }
  }

  const sections = splitSections(body, errors);
  const criteria = extractCriteria(sections["Acceptance Criteria"], errors);
  const edgeCaseCount = countBullets(sections["Edge Cases"]);
  const errorStateCount = countBullets(sections["Error States"]);

  if (sections.Story !== undefined && sections.Story.trim().length === 0) {
    errors.push("Story section is empty");
  }

  if (!fm.success) {
    return { doc: null, errors };
  }

  const doc: MechanicDoc = {
    id: `${parts.appSlug}.${parts.area}.${parts.slug}`,
    appSlug: parts.appSlug,
    area: parts.area,
    slug: parts.slug,
    source,
    frontmatter: fm.data,
    sections,
    criteria,
    edgeCaseCount,
    errorStateCount,
  };
  return { doc, errors };
}

/** Split the body on H2 headings, enforcing the section contract. */
function splitSections(body: string, errors: string[]): Partial<Record<SectionName, string>> {
  const sections: Partial<Record<SectionName, string>> = {};
  const seen: string[] = [];
  let current: string | null = null;
  let buf: string[] = [];

  const flush = () => {
    if (current !== null && (SECTION_ORDER as string[]).includes(current)) {
      sections[current as SectionName] = buf.join("\n").trim();
    }
    buf = [];
  };

  for (const line of body.split("\n")) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2?.[1]) {
      flush();
      current = h2[1];
      if (!(SECTION_ORDER as string[]).includes(current)) {
        errors.push(`unknown section "## ${current}" — allowed: ${SECTION_ORDER.join(", ")}`);
      } else if (seen.includes(current)) {
        errors.push(`duplicate section "## ${current}"`);
      }
      seen.push(current);
      continue;
    }
    if (current === null && line.trim().length > 0 && !line.startsWith("<!--")) {
      errors.push(`content before the first section heading: "${line.trim().slice(0, 60)}"`);
      current = "";
    }
    buf.push(line);
  }
  flush();

  for (const required of REQUIRED_SECTIONS) {
    if (!seen.includes(required)) {
      errors.push(`missing required section "## ${required}"`);
    }
  }
  const known = seen.filter((s) => (SECTION_ORDER as string[]).includes(s));
  const expectedOrder = SECTION_ORDER.filter((s) => known.includes(s));
  if (known.join("|") !== expectedOrder.join("|")) {
    errors.push(
      `sections out of order — expected ${expectedOrder.join(" → ")}, got ${known.join(" → ")}`
    );
  }

  return sections;
}

/** Extract `AC<n>` labels from the Acceptance Criteria section. */
function extractCriteria(section: string | undefined, errors: string[]): string[] {
  if (section === undefined) return [];
  const labels: string[] = [];
  for (const line of section.split("\n")) {
    const m = line.match(AC_BULLET_RE);
    if (m?.[1]) {
      if (labels.includes(m[1])) {
        errors.push(`duplicate acceptance-criteria label ${m[1]}`);
      }
      labels.push(m[1]);
      if (!m[2] || m[2].trim().length === 0) {
        errors.push(`${m[1]} has no criterion text`);
      }
    } else if (BULLET_RE.test(line.trim())) {
      errors.push(
        `acceptance-criteria bullet without an AC label: "${line.trim().slice(0, 60)}" — use "- **AC<n>** Given … When … Then …"`
      );
    }
  }
  if (labels.length === 0) {
    errors.push("Acceptance Criteria section has no `- **AC<n>**` bullets");
  }
  return labels;
}

function countBullets(section: string | undefined): number {
  if (!section) return 0;
  return section.split("\n").filter((l) => BULLET_RE.test(l.trim())).length;
}
