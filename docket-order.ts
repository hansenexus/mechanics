/**
 * `order.yaml` — the work order, and the only hand-authored file in a run
 * directory. Strict schema for the same reason mechanics frontmatter is
 * strict: a typo'd key must fail loudly instead of silently vanishing.
 *
 * `exitCriteria` deliberately accepts free strings alongside `<spec>:AC<n>`
 * references. That is what lets the run layer be adopted on a repo with no
 * spec corpus on day one and grow richer as specs arrive — a structured
 * reference merely resolves to something linkable and verifiable.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { DEFAULT_PHASES, DOCKET_DIR, type DocketOrder, RUN_ID_RE } from "./docket-types";

const kebabPhase = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "phase must be kebab-case");

export const orderSchema = z
  .object({
    run: z.string().regex(RUN_ID_RE, "must be <YYYY-MM-DD>-<kebab-slug>"),
    title: z.string().min(1),
    scope: z
      .object({
        app: z.string().min(1).optional(),
        specs: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .optional(),
    exitCriteria: z.array(z.string().min(1)).default([]),
    phases: z
      .array(kebabPhase)
      .min(1)
      .default([...DEFAULT_PHASES]),
    wave: z.string().min(1).optional(),
    git: z
      .object({
        branch: z.string().min(1).optional(),
        worktree: z.string().min(1).optional(),
        forge: z.string().min(1).optional(),
        pr: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    agent: z
      .object({
        harness: z.string().min(1).optional(),
        sessionId: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    assignee: z.string().min(1).optional(),
    links: z
      .object({
        issue: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export function runsRoot(repoRoot: string): string {
  return path.join(repoRoot, DOCKET_DIR, "runs");
}

export function runDir(repoRoot: string, runId: string): string {
  return path.join(runsRoot(repoRoot), runId);
}

export function orderPath(repoRoot: string, runId: string): string {
  return path.join(runDir(repoRoot, runId), "order.yaml");
}

/** Parse + validate an order. Throws with the field path on a bad key. */
export function parseOrder(raw: string): DocketOrder {
  const parsed = orderSchema.safeParse(parseYaml(raw));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid order.yaml — ${issues}`);
  }
  return parsed.data;
}

export async function loadOrder(repoRoot: string, runId: string): Promise<DocketOrder> {
  return parseOrder(await fs.readFile(orderPath(repoRoot, runId), "utf8"));
}

export function orderYaml(order: DocketOrder): string {
  // Key order is fixed so a hand edit produces a readable diff rather than a
  // reshuffle of the whole file.
  const ordered: Record<string, unknown> = { run: order.run, title: order.title };
  if (order.scope) ordered.scope = order.scope;
  ordered.exitCriteria = order.exitCriteria;
  ordered.phases = order.phases;
  if (order.wave) ordered.wave = order.wave;
  if (order.git) ordered.git = order.git;
  if (order.agent) ordered.agent = order.agent;
  if (order.assignee) ordered.assignee = order.assignee;
  if (order.links) ordered.links = order.links;
  return stringifyYaml(ordered, { lineWidth: 0 });
}

export async function writeOrder(repoRoot: string, order: DocketOrder): Promise<string> {
  const dir = runDir(repoRoot, order.run);
  await fs.mkdir(path.join(dir, "evidence"), { recursive: true });
  const target = orderPath(repoRoot, order.run);
  await fs.writeFile(target, orderYaml(order), "utf8");
  return target;
}

/** Run ids present on disk, newest first (ids sort lexicographically by date). */
export async function listRunIds(repoRoot: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = (await fs.readdir(runsRoot(repoRoot), { withFileTypes: true }))
      .filter((e) => e.isDirectory() && RUN_ID_RE.test(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
  return entries.sort().reverse();
}

/**
 * Title → kebab slug.
 *
 * Accented letters are folded to their base form before anything is stripped.
 * Without that, "Rückgabe" becomes `r-ckgabe` — every umlaut turns into a
 * word break, which mangles run ids and branch names for anyone not writing
 * in English. NFD handles ä/ö/ü/é/ñ and friends; ß has no decomposition and
 * is spelled out.
 */
export function slugify(input: string, maxLength: number): string {
  return input
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
}

/** `<date>-<slug>` from a free-text title; the date must be supplied. */
export function deriveRunId(title: string, today: string): string {
  return `${today}-${slugify(title, 48) || "run"}`;
}
