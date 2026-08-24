---
name: mechanics-init
description: Onboard an app to the mechanics corpus — scaffold its mechanics/ tree, fan out one authoring sub-agent per feature area, consolidate, and build the committed manifest. Trigger phrases "mechanics-init <app>", "onboard <app> to mechanics", "author mechanics for <app>", "document <app> behaviours".
---

# mechanics-init — onboard an app to the mechanics corpus

Produces full-spec behaviour documentation for one app, using the format
contract the tool enforces. **Read `mechanics --help` and the project's
mechanics reference first** — they define frontmatter, sections, IDs and
claims, and this skill assumes them rather than repeating them.

The runnable reference corpus is the package's `template/`: a single-app repo
whose surfaces are CLI commands and a scheduled job. Read it if you want to see
the shape before writing any.

## Inputs

- `$1` — app slug, as declared in `mechanics.config.yaml`.
- `--areas a,b` (optional) — re-run only these areas (repair/extend mode).
- `--batch N` (optional) — run only batch N of the fan-out.

## Preflight (abort if any fails)

1. `mechanics.config.yaml` exists at the repo root and declares `$1`. In a
   single-app repo the corpus lives at `mechanics/`; in a multi-app repo at
   `<appsDir>/$1/mechanics/`. Everything below says **`<corpus>`** for that
   directory — never hardcode either shape.
2. You are not on the default branch. The corpus lands through pull requests.
3. If `<corpus>/_config.yaml` is missing, create it (set `testGlobs` and
   `e2eRunner` to the app's harness; a `playwright` runner also needs
   `playwrightConfig`), then run `mechanics scaffold --app=$1` for
   route-derived draft stubs where the app has routes.
4. Build the **scope table**: from the app's own docs, routes and data model,
   define the areas (kebab-case dirs), each with its surfaces, source hints, an
   expected count band, and an explicit NOT_YOURS list of surfaces owned by
   sibling areas. Background work belongs to the area that owns its data.
   Cross-cutting shell behaviour gets its own area; authorization *rules* get
   an `auth` area.
5. Write `<corpus>/<area>/_area.yaml` (title / order / description) per area.

## Phase 1 — authoring fan-out (batches of 4 sub-agents, parallel per batch)

One general-purpose sub-agent per area. Disjoint write scopes, so no conflicts.
Per-area prompt contract (fill `{…}` from the scope table):

```
You are authoring the mechanics corpus for {APP}, area "{AREA}".
Repo: {ROOT}. You may WRITE ONLY inside {CORPUS}/{AREA}/. Everything else is
read-only. Never touch app source, tests, other areas, manifests or wave files.

Read the project's mechanics reference first and follow its frontmatter schema
and section contract EXACTLY. Key rules:
- One file per user-observable behaviour: {CORPUS}/{AREA}/<slug>.md
  (kebab-case; the ID is derived from the path — there is NO id:/area:/tests:
  frontmatter key).
- status: draft on every file. kind: system for scheduled work, machine-facing
  endpoints and degradation behaviour.
- Full spec: Story ("As a <role>, I can … so that …"), 2-6 labelled ACs
  ("- **AC<n>** Given … When … Then …", each observable via browser or API
  WITHOUT reading code), Edge Cases, Error States, optional Non-functional.
- Authorization behaviours name the exact role in an AC.
- destructive: true when verifying mutates real state (deploys, restarts, kill
  switches, DNS, token rotation, outbound sends).
- Claims must be REAL: every claim is keyed by a surface kind this app's
  adapters actually provide, and names an item you verified in code. Cite
  implementing files in paths[]. No aspirations — a claim that resolves to
  nothing fails `mechanics check`.

Scope — {AREA}:
  Surfaces: {SURFACES}
  Source hints: {SOURCE_HINTS}
  NOT YOURS (skip even if encountered): {NOT_YOURS}
Target: {COUNT_BAND} mechanics. One per behaviour, not one per file.

Return: one line per file (id · title · what it claims), plus anything in scope
you deliberately did NOT document and why.
```

If the repo has a code-map or search tool the sub-agents should orient with,
name it in the prompt. Do not assume one exists.

## Phase 2 — consolidation (one sub-agent per batch)

1. `mechanics check --app=$1` — fix schema, section and claim errors. The
   consolidator may edit mechanic files; it must not edit app source.
2. `mechanics coverage --app=$1` — report unclaimed items. Either assign each
   to the owning area's follow-up list, or add a justified ignore glob to
   `<corpus>/_config.yaml`. An ignore without a reason in the diff is a gap
   with a lid on it.
3. Find surfaces claimed by two areas and merge them into the owning one —
   delete the loser file, keep the better spec.
4. Enforce the count bands. Over the band usually means per-file rather than
   per-behaviour; under it usually means a missed surface.
5. `mechanics build --app=$1` — regenerate and stage the committed manifest.

## Phase 3 — land

- One pull request per batch (`docs(mechanics): <app> corpus batch N —
  <areas>`), through **whatever this project uses to open PRs**: a dedicated
  skill if one exists, otherwise the platform CLI, otherwise leave the branch
  pushed and say so. **Never auto-merge from this skill.**
- Batches merge as `status: draft`. A human reviews — `mechanics report --html`
  is the readable form — and flips areas to `active` in separate small PRs.
- After the last batch: annotate existing specs (`// @mechanic <id>`), open the
  baseline wave, and run `mechanics-verify`.

## Guardrails

- Never auto-merge. Never edit app source. Never open a wave mid-authoring.
- Abort a batch if `check` is still red after one consolidation retry — report
  the errors rather than force-landing.
- Keep `coverage.enforce: warn` until the corpus is complete. Flipping it to
  `error` is the ratchet, and a deliberate human step.
