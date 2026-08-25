/**
 * Draft stubs for surfaces nothing claims yet.
 *
 * Scaffolding is the *propose* primitive: it turns "17 routes are undocumented"
 * into 17 files an author can edit. It deliberately produces `status: draft`
 * skeletons and never prose — inventing acceptance criteria for behaviour
 * nobody described is how a corpus fills up with confident fiction.
 *
 * This lives outside `cli.ts` because `cli.ts` ends in a top-level `await
 * main()`, so nothing in it can be imported by a test. That is not a style
 * preference: both of the generators below once emitted frontmatter the strict
 * schema rejected — `routes:` where the schema has `claims: { route: [...] }`
 * — and shipped that way precisely because no test could reach them. The
 * planner here is pure and the round-trip through the real schemas is
 * `scaffold.test.ts`.
 */

import path from "node:path";

/** One stub file the plan intends to write, repo-relative to the corpus root. */
export interface ScaffoldStub {
  /** Corpus-relative POSIX path, e.g. `billing/invoices.md`. */
  relPath: string;
  area: string;
  slug: string;
  route: string;
  content: string;
}

export interface ScaffoldArea {
  area: string;
  /** Corpus-relative POSIX path to `_area.yaml`. */
  relPath: string;
  content: string;
}

export interface ScaffoldPlan {
  areas: ScaffoldArea[];
  stubs: ScaffoldStub[];
}

/**
 * What to write for a set of routes. Pure: the caller decides what already
 * exists on disk and skips those, which keeps the skip-if-exists rule in one
 * place instead of threading a filesystem through here.
 *
 * Area `order` is assigned by first appearance, so a given route list always
 * produces the same plan — a scaffold that renumbers areas on every run would
 * churn the diff for no reason.
 */
export function planScaffold(routes: string[]): ScaffoldPlan {
  const areas: ScaffoldArea[] = [];
  const seen = new Set<string>();
  const stubs: ScaffoldStub[] = [];

  for (const route of routes) {
    const { area, slug } = routeToStub(route);
    if (!seen.has(area)) {
      seen.add(area);
      areas.push({
        area,
        relPath: `${area}/_area.yaml`,
        content: `title: ${titleCase(area)}\norder: ${seen.size}\ndescription: TODO\n`,
      });
    }
    stubs.push({
      relPath: `${area}/${slug}.md`,
      area,
      slug,
      route,
      content: stubMarkdown(route),
    });
  }
  return { areas, stubs };
}

/**
 * A route's owning area and file slug. The first path segment is the area, the
 * rest is the slug — dynamic segments lose their brackets so `[id]` and
 * `[...rest]` do not become filenames nothing can address.
 */
export function routeToStub(route: string): { area: string; slug: string } {
  const segs = route
    .split("/")
    .filter(Boolean)
    .map((s) =>
      s
        .replace(/[[\]().@]/g, "")
        .replace(/\.{3}/g, "")
        .toLowerCase()
    )
    .filter((s) => s.length > 0);
  if (segs.length === 0) return { area: "overview", slug: "home" };
  const [first, ...rest] = segs;
  return {
    area: first ?? "overview",
    slug: rest.length > 0 ? rest.join("-") : "index",
  };
}

export function titleCase(s: string): string {
  return s.replace(/(^|-)(\w)/g, (_, sep, c) => `${sep === "-" ? " " : ""}${c.toUpperCase()}`);
}

/**
 * The draft stub itself.
 *
 * `claims` is keyed by SURFACE KIND and `mechanicFrontmatterSchema` is
 * `.strict()`: a top-level `routes:` key — which this emitted for its first
 * two releases — parses nowhere and fails `mechanics check`. A scaffold whose
 * output the tool rejects is worse than no scaffold at all, because the author
 * blames their own editing rather than the generator.
 */
export function stubMarkdown(route: string): string {
  return `---
title: "TODO: describe the behavior at ${route}"
kind: user-facing
status: draft
priority: p1
roles: [viewer]
claims:
  route:
    - "${route}"
---

## Story

TODO — As a <role>, I can … so that ….

## Acceptance Criteria

- **AC1** Given … When … Then ….

## Edge Cases

- TODO

## Error States

- TODO
`;
}

/** Absolute path for a plan entry, given the corpus root. */
export function stubPath(corpusDir: string, relPath: string): string {
  return path.join(corpusDir, ...relPath.split("/"));
}
