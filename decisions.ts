/**
 * Decision records — `.docket/decisions/<id>.md`.
 *
 * An ADR whose job is to *reach the next agent*, not to sit in a folder. That
 * one sentence decides every design choice below.
 *
 * ## Why `affects` is the whole design
 *
 * `affects.paths` is a resolvable claim, exactly like a mechanic's `paths:`.
 * That makes a decision **retrievable by the thing an agent is about to
 * touch** — the only retrieval key that works when the agent does not yet know
 * the question. "Why is this like this" is unanswerable by search: the agent
 * would have to already suspect there was a reason. A glob resolved against
 * the file in hand needs no such suspicion.
 *
 * ## Two rules that stop the folder from rotting
 *
 * 1. **Staleness is an ERROR, not a warning.** An `accepted` record whose
 *    `affects.paths` matches nothing points at code that no longer exists. A
 *    decision about deleted code is worse than no decision: it is confident,
 *    committed, and wrong, and the next agent has no way to tell. The fix is
 *    to supersede it or reject it — both of which are one-line edits and both
 *    of which leave the reasoning readable.
 * 2. **Supersession replaces deletion.** `supersedes` forms a chain and a
 *    superseded record stays on disk. Deleting the old record deletes the
 *    reason the new one exists, which is exactly the context a later reader
 *    needs to avoid re-litigating a settled question.
 *
 * ## Conflict detection
 *
 * Two agents deciding contradictory things about one subsystem is the
 * characteristic multi-agent failure, and it is invisible in every harness
 * that ships today: each run looks locally coherent. Overlapping `affects`
 * across two *open* runs makes it cheap to catch — and cheap is the point,
 * because a check nobody can afford to run is a check nobody runs.
 *
 * ## What this module is NOT
 *
 * A decision record is a written argument, not a verdict. It grades nothing
 * and marks nothing green, so it is not a fourth way around the product's two
 * refusals — no verdict without evidence, and no model marking its own work
 * green. `status: accepted` on a decision means "we are doing it this way",
 * never "the work is done"; criteria still go through `mechanics verify` and
 * still need evidence. Nothing here appends a `criterion.evaluated`.
 *
 * The id is path-derived (the filename) and never stored in frontmatter —
 * the same rule mechanic ids follow, so one convention covers both. Two
 * sources of truth for a name is how a rename silently forks a record.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { DOCKET_DIR, RUN_ID_RE } from "./docket-types";
import { globToRegExp, listFilesRecursive, pathExists } from "./fsutil";
import { formatZodError } from "./schema";

/** Directory under `.docket/` holding every record. Flat: ids are unique. */
export const DECISIONS_SUBDIR = "decisions";

/** Same shape as a run id's slug half — sortable, readable, shell-safe. */
export const DECISION_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** `YYYY-MM-DD` on the wire and in every consumer. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * YAML types an unquoted `2026-08-08` as a Date, and the spec's own example
 * writes it unquoted — so the reader normalises rather than rejecting what the
 * spec told people to type. Back to a UTC calendar day, because a decision was
 * made on a date, not at an instant, and a timezone-shifted one would sort
 * wrong next to a run id.
 */
const decisionDate = z.preprocess(
  (v) => (v instanceof Date && !Number.isNaN(v.getTime()) ? v.toISOString().slice(0, 10) : v),
  z.string().regex(DATE_RE, "must be YYYY-MM-DD")
);

export type DecisionStatus = "proposed" | "accepted" | "superseded" | "rejected";

/**
 * The four sections, in this order, all required.
 *
 * Fixed rather than free-form for the reason mechanic files are: a reader that
 * has to guess where the rationale lives cannot inject "the rationale" into a
 * context window. `## Decision` is one imperative sentence because that is the
 * line that gets quoted back at the next agent.
 */
export const DECISION_SECTIONS = ["Context", "Decision", "Rationale", "Consequences"] as const;
export type DecisionSection = (typeof DECISION_SECTIONS)[number];

/**
 * Strict, so a typo'd key fails loudly instead of silently vanishing — the
 * same bargain mechanics frontmatter makes. A misspelled `affect:` that parsed
 * would produce a record that is retrievable by nothing.
 */
export const decisionFrontmatterSchema = z
  .object({
    status: z.enum(["proposed", "accepted", "superseded", "rejected"]),
    date: decisionDate,
    /** Who decided: humans by identity, agents as `harness:session`. */
    decidedBy: z.array(z.string().min(1)).min(1, "name who decided — anonymity is not a decision"),
    /** The run this was decided in, when there was one. */
    run: z.string().regex(RUN_ID_RE, "must be <YYYY-MM-DD>-<kebab-slug>").optional(),
    affects: z
      .object({
        specs: z.array(z.string().min(1)).default([]),
        paths: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .default({ specs: [], paths: [] }),
    /**
     * One predecessor or several. The spec writes a single id; an array is
     * accepted because a decision genuinely can replace two earlier ones, and
     * forcing that into two records would invent a decision nobody made.
     * Normalised to an array on the way out so consumers have one shape.
     */
    supersedes: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
  })
  .strict();

export type DecisionFrontmatter = z.infer<typeof decisionFrontmatterSchema>;

export interface DecisionRecord {
  /** Derived from the filename. Never present in frontmatter. */
  id: string;
  /** Repo-relative POSIX path, for error messages that can be clicked. */
  source: string;
  status: DecisionStatus;
  date: string;
  decidedBy: string[];
  run?: string;
  affects: { specs: string[]; paths: string[] };
  /** Always an array, even when the file wrote a bare string. */
  supersedes: string[];
  sections: Record<DecisionSection, string>;
  /** First sentence of `## Decision` — what every surface shows as the title. */
  headline: string;
}

export interface ParseDecisionResult {
  /** `null` when the file is too broken to produce a usable record. */
  record: DecisionRecord | null;
  errors: string[];
}

export function decisionsDir(repoRoot: string): string {
  return path.join(repoRoot, DOCKET_DIR, DECISIONS_SUBDIR);
}

export function decisionPath(repoRoot: string, id: string): string {
  return path.join(decisionsDir(repoRoot), `${id}.md`);
}

/** The repo-relative source path a record reports, independent of platform. */
export function decisionSource(id: string): string {
  return `${DOCKET_DIR}/${DECISIONS_SUBDIR}/${id}.md`;
}

// ---------------------------------------------------------------------------
// parse — pure
// ---------------------------------------------------------------------------

/**
 * Parse one record. `source` is the path it was read from and is the ONLY
 * source of the id.
 *
 * Collects every problem rather than throwing on the first, so `mechanics
 * check` reports a file's full damage in one run — a decision folder is
 * usually fixed in one sitting by whoever broke it.
 */
export function parseDecision(raw: string, source: string): ParseDecisionResult {
  const errors: string[] = [];
  const base = source.split(/[\\/]/).pop() ?? source;

  if (!base.endsWith(".md")) {
    return { record: null, errors: [`${source}: decision records must be .md files`] };
  }
  const id = base.slice(0, -3);
  if (!DECISION_ID_RE.test(id)) {
    return {
      record: null,
      errors: [`${source}: "${id}" is not a kebab-case id — rename the file, the id IS the name`],
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
      record: null,
      errors: [
        `${source}: frontmatter is not parseable YAML: ${err instanceof Error ? err.message : err}`,
      ],
    };
  }

  // The id rule is enforced, not merely documented: a stored id is a second
  // source of truth that disagrees with the filename the first time either
  // one is renamed, and nothing would notice.
  if ("id" in fmRaw || "decision" in fmRaw) {
    errors.push(
      `${source}: the id is the filename and must not be in frontmatter — remove "${"id" in fmRaw ? "id" : "decision"}:"`
    );
  }

  const fm = decisionFrontmatterSchema.safeParse(fmRaw);
  if (!fm.success) {
    for (const line of formatZodError(fm.error)) errors.push(`${source}: frontmatter ${line}`);
  }

  const sections = splitDecisionSections(body, source, errors);
  if (!fm.success) return { record: null, errors };

  const missing = DECISION_SECTIONS.filter((s) => !sections[s]);
  if (missing.length > 0) return { record: null, errors };

  const complete = sections as Record<DecisionSection, string>;
  const supersedes = fm.data.supersedes
    ? Array.isArray(fm.data.supersedes)
      ? fm.data.supersedes
      : [fm.data.supersedes]
    : [];

  const record: DecisionRecord = {
    id,
    source,
    status: fm.data.status,
    date: fm.data.date,
    decidedBy: fm.data.decidedBy,
    ...(fm.data.run ? { run: fm.data.run } : {}),
    affects: { specs: fm.data.affects.specs, paths: fm.data.affects.paths },
    supersedes,
    sections: complete,
    headline: firstSentence(complete.Decision),
  };
  return { record, errors };
}

/** Split on H2s, enforcing the four-section contract exactly and in order. */
function splitDecisionSections(
  body: string,
  source: string,
  errors: string[]
): Partial<Record<DecisionSection, string>> {
  const known: string[] = DECISION_SECTIONS as unknown as string[];
  const sections: Partial<Record<DecisionSection, string>> = {};
  const seen: string[] = [];
  let current: string | null = null;
  let buf: string[] = [];

  const flush = () => {
    if (current !== null && known.includes(current)) {
      sections[current as DecisionSection] = buf.join("\n").trim();
    }
    buf = [];
  };

  for (const line of body.split("\n")) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2?.[1]) {
      flush();
      current = h2[1];
      if (!known.includes(current)) {
        errors.push(`${source}: unknown section "## ${current}" — allowed: ${known.join(", ")}`);
      } else if (seen.includes(current)) {
        errors.push(`${source}: duplicate section "## ${current}"`);
      }
      seen.push(current);
      continue;
    }
    if (current === null && line.trim().length > 0 && !line.startsWith("<!--")) {
      errors.push(`${source}: content before the first section heading`);
      current = "";
    }
    buf.push(line);
  }
  flush();

  for (const required of DECISION_SECTIONS) {
    if (!seen.includes(required))
      errors.push(`${source}: missing required section "## ${required}"`);
    else if (!sections[required]) errors.push(`${source}: section "## ${required}" is empty`);
  }
  const got = seen.filter((s) => known.includes(s));
  const expected = known.filter((s) => got.includes(s));
  if (got.join("|") !== expected.join("|")) {
    errors.push(`${source}: sections out of order — expected ${expected.join(" → ")}`);
  }
  return sections;
}

/**
 * `## Decision` is contracted to be one imperative sentence, but a record
 * somebody wrote three sentences into must still render on a board rather
 * than blow out the column. First sentence, first line, capped.
 */
function firstSentence(text: string): string {
  const line =
    text
      .split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim() ?? "";
  const stop = line.search(/[.!?](\s|$)/);
  const sentence = stop === -1 ? line : line.slice(0, stop + 1);
  return sentence.length > 160 ? `${sentence.slice(0, 157)}…` : sentence;
}

// ---------------------------------------------------------------------------
// render + write
// ---------------------------------------------------------------------------

export interface DecisionInput {
  id: string;
  status: DecisionStatus;
  date: string;
  decidedBy: string[];
  run?: string;
  affects?: { specs?: string[]; paths?: string[] };
  supersedes?: string | string[];
  sections: Record<DecisionSection, string>;
}

/**
 * Render to markdown. Pure, and separated from `writeDecision` so the exact
 * bytes that land on disk are assertable without a filesystem — both scaffold
 * template bugs in this repo's history shipped because the text and the write
 * were the same untestable function.
 */
export function renderDecision(input: DecisionInput): string {
  if (!DECISION_ID_RE.test(input.id)) {
    throw new Error(`mechanics: "${input.id}" is not a kebab-case decision id`);
  }
  if (!DATE_RE.test(input.date)) {
    throw new Error(`mechanics: decision date must be YYYY-MM-DD, got "${input.date}"`);
  }
  if (input.decidedBy.length === 0) {
    throw new Error("mechanics: a decision must name who decided it");
  }
  for (const section of DECISION_SECTIONS) {
    if (!input.sections[section]?.trim()) {
      throw new Error(`mechanics: decision "${input.id}" has an empty "## ${section}"`);
    }
  }

  const supersedes = input.supersedes
    ? Array.isArray(input.supersedes)
      ? input.supersedes
      : [input.supersedes]
    : [];

  // Key order is fixed here rather than left to object iteration: a record is
  // read far more often by a human scanning a diff than by a parser.
  const fm: Record<string, unknown> = {
    status: input.status,
    date: input.date,
    decidedBy: input.decidedBy,
    ...(input.run ? { run: input.run } : {}),
    affects: {
      specs: input.affects?.specs ?? [],
      paths: input.affects?.paths ?? [],
    },
    ...(supersedes.length === 1
      ? { supersedes: supersedes[0] }
      : supersedes.length > 1
        ? { supersedes }
        : {}),
  };

  const body = DECISION_SECTIONS.map((s) => `## ${s}\n\n${input.sections[s].trim()}\n`).join("\n");
  return `---\n${stringifyYaml(fm, { lineWidth: 0 })}---\n\n${body}`;
}

/** Write one record; returns the absolute path. The id lives in the name. */
export async function writeDecision(repoRoot: string, input: DecisionInput): Promise<string> {
  const text = renderDecision(input);
  const target = decisionPath(repoRoot, input.id);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, text, "utf8");
  return target;
}

// ---------------------------------------------------------------------------
// load
// ---------------------------------------------------------------------------

export interface LoadedDecisions {
  decisions: DecisionRecord[];
  /** Files that failed to parse. Never thrown: one bad record must not hide
   *  the other twenty from the agent about to edit the code they cover. */
  errors: string[];
}

/** Every record in the folder, id-sorted. Missing folder is not an error. */
export async function listDecisions(repoRoot: string): Promise<LoadedDecisions> {
  const dir = decisionsDir(repoRoot);
  if (!(await pathExists(dir))) return { decisions: [], errors: [] };

  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return { decisions: [], errors: [] };
  }

  const decisions: DecisionRecord[] = [];
  const errors: string[] = [];
  for (const name of names.filter((n) => n.endsWith(".md")).sort()) {
    const raw = await fs.readFile(path.join(dir, name), "utf8");
    const parsed = parseDecision(raw, decisionSource(name.slice(0, -3)));
    errors.push(...parsed.errors);
    if (parsed.record) decisions.push(parsed.record);
  }
  return { decisions, errors };
}

// ---------------------------------------------------------------------------
// validation — pure
// ---------------------------------------------------------------------------

/** Live = still speaks for the code. Superseded and rejected do not. */
export function isLiveDecision(d: DecisionRecord): boolean {
  return d.status === "proposed" || d.status === "accepted";
}

/** Repo-relative files an `affects.paths` claim resolves to. */
export function resolveAffectedFiles(paths: string[], files: string[]): string[] {
  if (paths.length === 0) return [];
  const res = paths.map((g) => globToRegExp(g));
  return files.filter((f) => res.some((re) => re.test(f)));
}

/**
 * Errors that must fail `mechanics check`.
 *
 * `files` is the repo-relative file list the `affects.paths` claims resolve
 * against. Passed in rather than walked here so the rule is testable without
 * a filesystem and so a caller that already has the list pays for it once.
 */
export function validateDecisions(decisions: DecisionRecord[], files: string[]): string[] {
  const errors: string[] = [];
  const byId = new Map(decisions.map((d) => [d.id, d]));

  // Who is superseded by whom, so an accepted record that has been replaced
  // can be caught. Built first: the check below needs the whole set.
  const supersededBy = new Map<string, string[]>();
  for (const d of decisions) {
    for (const target of d.supersedes) {
      if (target === d.id) {
        errors.push(`${d.source}: supersedes itself`);
        continue;
      }
      if (!byId.has(target)) {
        errors.push(
          `${d.source}: supersedes "${target}", which is not a decision record — supersession replaces deletion, so the predecessor must still be there`
        );
        continue;
      }
      supersededBy.set(target, [...(supersededBy.get(target) ?? []), d.id]);
    }
  }

  for (const d of decisions) {
    const replacers = supersededBy.get(d.id);
    if (replacers && d.status === "accepted") {
      errors.push(
        `${d.source}: still "accepted" but superseded by ${replacers.join(", ")} — set status: superseded`
      );
    }

    // THE staleness rule. Only `accepted` records are held to it: a `proposed`
    // one is an argument in progress and may legitimately point at code that
    // does not exist yet, which is the whole point of proposing it.
    //
    // An EMPTY `paths` list is deliberately not an error. It is a
    // spec-scoped or repo-wide decision that makes no resolvable claim about
    // files, so there is nothing to have gone stale; erroring there would
    // punish a decision for being honest about its scope.
    if (d.status !== "accepted" || d.affects.paths.length === 0) continue;
    if (resolveAffectedFiles(d.affects.paths, files).length === 0) {
      errors.push(
        `${d.source}: accepted, but affects.paths [${d.affects.paths.join(", ")}] matches no files — ` +
          "a decision pointing at deleted code is stale; supersede it or reject it"
      );
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// conflict detection — pure
// ---------------------------------------------------------------------------

export interface DecisionConflict {
  /** The two open runs, id-sorted so a conflict is reported once. */
  runs: [string, string];
  decisions: [string, string];
  /** What they both claim — the evidence for the flag. */
  overlap: { specs: string[]; paths: string[] };
}

export interface ConflictInput {
  /** Runs a reader considers still in flight (liveness other than `done`). */
  openRuns: Iterable<string>;
  /** Repo-relative file list, for resolving `affects.paths` overlap. */
  files: string[];
}

/**
 * Flag decisions from two DIFFERENT open runs whose `affects` overlap.
 *
 * Two agents deciding contradictory things about one subsystem is the
 * characteristic multi-agent failure, and neither run can see it from the
 * inside. This does not claim the two decisions disagree — it cannot know
 * that — only that they are about the same thing at the same time, which is
 * the cheap signal a human can act on.
 *
 * Deliberate exclusions:
 *  - the same run (an agent refining its own decision is not a conflict),
 *  - superseded and rejected records (they no longer speak),
 *  - a pair where one supersedes the other (that IS the resolution),
 *  - runs that are finished (a landed decision is history, not contention).
 */
export function findDecisionConflicts(
  decisions: DecisionRecord[],
  input: ConflictInput
): DecisionConflict[] {
  const open = new Set(input.openRuns);
  const live = decisions.filter((d) => d.run && open.has(d.run) && isLiveDecision(d));

  const conflicts: DecisionConflict[] = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i];
      const b = live[j];
      if (!a || !b || a.run === b.run) continue;
      if (a.supersedes.includes(b.id) || b.supersedes.includes(a.id)) continue;

      const specs = a.affects.specs.filter((s) => b.affects.specs.some((o) => specsOverlap(s, o)));
      const paths = overlappingPaths(a, b, input.files);
      if (specs.length === 0 && paths.length === 0) continue;

      const [runA, runB] = [a.run as string, b.run as string].sort() as [string, string];
      const [idA, idB] = a.run === runA ? [a.id, b.id] : [b.id, a.id];
      conflicts.push({ runs: [runA, runB], decisions: [idA, idB], overlap: { specs, paths } });
    }
  }
  return conflicts;
}

/**
 * Spec ids are dotted and hierarchical, so `lockers.rental` and
 * `lockers.rental.rent-flow` are the same subsystem claimed at two
 * granularities. Exact-match only would miss precisely the pair most likely
 * to conflict — a broad decision and a narrow one.
 */
function specsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

/**
 * Path overlap is resolved through the real file list rather than compared as
 * glob strings: `src/**` and `src/lockers/*.ts` are textually unrelated and
 * cover the same code. Identical globs are additionally treated as an overlap
 * so the flag still fires when the file list is unavailable or the claim
 * points at code not yet written.
 */
function overlappingPaths(a: DecisionRecord, b: DecisionRecord, files: string[]): string[] {
  const shared = a.affects.paths.filter((g) => b.affects.paths.includes(g));
  const hitsA = new Set(resolveAffectedFiles(a.affects.paths, files));
  const both = resolveAffectedFiles(b.affects.paths, files).filter((f) => hitsA.has(f));
  return [...new Set([...shared, ...both])].sort();
}

/** One line a board, a CLI or an MCP reply can print unchanged. */
export function formatConflict(c: DecisionConflict): string {
  const what = [
    ...c.overlap.specs.map((s) => `spec ${s}`),
    ...c.overlap.paths.slice(0, 3).map((p) => p),
  ];
  const more = c.overlap.paths.length > 3 ? ` (+${c.overlap.paths.length - 3} more)` : "";
  return (
    `open runs ${c.runs[0]} and ${c.runs[1]} both decided about ${what.join(", ")}${more} ` +
    `— "${c.decisions[0]}" vs "${c.decisions[1]}"; one of them is probably wrong`
  );
}

// ---------------------------------------------------------------------------
// retrieval — pure
// ---------------------------------------------------------------------------

export interface DecisionQuery {
  /** Repo-relative file an agent is about to touch. */
  path?: string;
  /** Spec/mechanic id, matched hierarchically. */
  spec?: string;
  /** Free text over id, headline and section bodies. */
  query?: string;
  /** Off by default: a superseded record is history, not guidance. */
  includeSuperseded?: boolean;
}

/**
 * Select the records a reader should be shown. Filters AND together, which is
 * what makes `{path, query}` mean "about this file, mentioning this word"
 * rather than a union nobody asked for.
 */
export function selectDecisions(
  decisions: DecisionRecord[],
  q: DecisionQuery = {}
): DecisionRecord[] {
  const needle = q.query?.trim().toLowerCase();
  return decisions.filter((d) => {
    if (!q.includeSuperseded && !isLiveDecision(d)) return false;
    if (q.path && !d.affects.paths.some((g) => globToRegExp(g).test(q.path as string)))
      return false;
    if (q.spec && !d.affects.specs.some((s) => specsOverlap(s, q.spec as string))) return false;
    if (needle) {
      const hay = [d.id, d.headline, ...Object.values(d.sections)].join("\n").toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// executor — the fs side, kept thin on purpose
// ---------------------------------------------------------------------------

export interface DecisionCheck {
  decisions: DecisionRecord[];
  /** Parse failures + staleness. These fail `mechanics check`. */
  errors: string[];
  /** Conflicts. Flagged, never fatal — see below. */
  warnings: string[];
  conflicts: DecisionConflict[];
}

/**
 * Load, validate and cross-check the whole folder.
 *
 * Conflicts are WARNINGS, not errors, and the asymmetry is deliberate. A stale
 * record is a defect in the folder and only the folder's owner can fix it. Two
 * open runs touching one subsystem is a legitimate state that resolves itself
 * when one of them lands — failing CI on it would punish concurrency, which is
 * the thing the run layer exists to enable.
 */
export async function checkDecisions(
  repoRoot: string,
  openRuns?: Iterable<string>
): Promise<DecisionCheck> {
  const { decisions, errors } = await listDecisions(repoRoot);
  // Nothing recorded, nothing to be wrong about — and nothing worth walking
  // the tree or reducing every run log for. Most checkouts land here.
  if (decisions.length === 0 && errors.length === 0) {
    return { decisions, errors, warnings: [], conflicts: [] };
  }

  const files = await listFilesRecursive(repoRoot);
  const conflicts = findDecisionConflicts(decisions, {
    openRuns: openRuns ?? (await openRunIds(repoRoot)),
    files,
  });
  return {
    decisions,
    errors: [...errors, ...validateDecisions(decisions, files)],
    warnings: conflicts.map(formatConflict),
    conflicts,
  };
}

/**
 * Runs a reader should treat as in flight.
 *
 * Lives here rather than in the run layer because conflict detection is its
 * only caller: "open" is a decisions-layer question ("could two agents still
 * be arguing?"), not a board question. Anything with a `run.finished` is
 * `done` and its decisions are history — history does not contend.
 *
 * A run whose order or log is unreadable is treated as open. The conservative
 * direction is the one that flags too much: a missed conflict is silent and a
 * spurious one is a sentence a human reads and dismisses.
 */
export async function openRunIds(repoRoot: string): Promise<string[]> {
  const { listRunIds, loadOrder } = await import("./docket-order");
  const { readEvents } = await import("./docket-events");
  const { reduceRun } = await import("./docket-state");

  const open: string[] = [];
  for (const id of await listRunIds(repoRoot)) {
    try {
      const order = await loadOrder(repoRoot, id);
      const { events, malformed } = await readEvents(repoRoot, id);
      if (reduceRun(order, events, { malformed }).liveness !== "done") open.push(id);
    } catch {
      open.push(id);
    }
  }
  return open.sort();
}
