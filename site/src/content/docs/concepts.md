---
title: Concepts
description: Behaviours, surfaces, claims, gaps, waves — the five ideas the whole tool is built from.
---

## Behaviour

One user-observable thing the app does, written as one markdown file. It has
frontmatter (what it claims, how it is verified) and a body (a story, labelled
acceptance criteria, edge cases, error states, non-functional notes).

Its ID is `<app>.<area>.<slug>`, derived from the file path — `perch`,
`monitors`, `create-monitor` becomes `perch.monitors.create-monitor`. Three
things are deliberately **not** accepted in frontmatter, because each would be
a second source of truth that rots:

| Not in frontmatter | Where it comes from |
|---|---|
| `id` | the file path |
| `area` | the parent directory |
| `tests` | discovered from `// @mechanic <id>` annotations in your specs |

Frontmatter is strict — a typo'd key fails at `check` time rather than
silently vanishing.

| Field | Values |
|---|---|
| `title` | required |
| `kind` | `user-facing` · `system` |
| `status` | `draft` · `active` (default) · `deprecated` |
| `priority` | `p0` · `p1` (default) · `p2` |
| `roles` | at least one |
| `claims` | surface kind → list of surfaces |
| `paths` | source files this behaviour lives in |
| `nonFunctional` | `perf` · `a11y` · `security` · `i18n` · `offline` |
| `destructive` | boolean |
| `aliases` | previous IDs, so a rename does not orphan history |
| `verify` | `e2e` · `agent` · `manual-only` |

## Surface

Anything the app ships that a user or another system can reach: a route, an API
route, a Convex function, a cron, an HTTP endpoint, a background worker, a CLI
command. Surfaces are **found, not declared** — an [adapter](/adapters/) walks
the real tree, so the inventory is what the app is rather than what somebody
remembered to write down.

The kinds that exist depend on the adapters and globs configured for the app.
They are checked against the live inventory at coverage time, so a `claims:`
key naming a kind the app has no notion of is an error rather than a silent
no-op.

## Claim

The link between the two. A behaviour's `claims:` block names the surfaces it
is responsible for:

```yaml
claims:
  route: ["/dashboard/monitors/new"]
  api-route: ["/api/monitors"]
  convex-function: ["monitors.create"]
```

One behaviour may claim several surfaces across several kinds — creating a
monitor is a page, an endpoint, and a mutation. Coverage is the set difference
between what the adapters found and what the corpus claims.

## Gap

A surface no behaviour claims and no ignore rule excuses. Gaps are reported
individually, with their path, and never as a total — a percentage is not
actionable and a path is.

There are exactly two ways to close one:

1. **Claim it** in a behaviour — the app does this thing, and now it is written
   down.
2. **Ignore it** in `mechanics/_config.yaml` under `coverage.ignore`, keyed by
   surface kind — this is not product behaviour, and here is the glob that
   says so.

Both leave a committed record. There is no third way, which is the point.

`mechanics gaps` splits the missing work into two piles by whether it has one
correct answer: `auto` gaps are mechanical and `gaps --fix` applies them;
`propose` gaps are judgments and are queued for a human. That split is a
predicate in code, not a convention.

## Wave

A verification effort scoped to a rewrite, a redesign, or a migration. One YAML
file naming the behaviours in scope and carrying a verdict for each:

```yaml
wave: 2026-08-redesign
title: Dashboard redesign — behaviour parity
status: open
startedAt: 2026-08-04
baselineSha: ac6fb3c
scope:
  areas: [monitors, incidents, status-page]
verifications:
  - mechanic: perch.monitors.create-monitor
    status: pass
    method: e2e
    evidence: "e2e/monitors.spec.ts:41 — green at ac6fb3c"
    verifiedBy: lennard
    verifiedAt: 2026-08-19
```

Verdicts are `pending`, `pass`, `fail`, `blocked` or `n-a`, recorded by method
`e2e`, `agent` or `manual`. **A `pass` requires an evidence string** — the
schema refuses one without it, at write time and again at read time, so a
hand-edited wave file cannot slip one through.

## The ratchet

`coverage.enforce` has two values and the flip between them is the whole
mechanism:

```yaml
coverage:
  enforce: warn    # still writing the corpus — gaps are reported, build passes
```

```yaml
coverage:
  enforce: error   # the corpus is complete — a new unclaimed surface fails CI
```

Set it to `error` once and the corpus cannot fall behind the app again without
somebody noticing. Nothing in the tool will flip it back for you: it is one of
the four moves refused to every agent provider, because it is not work, it is a
claim that the work is good.

## The drift gate

The manifest compiled from the corpus is **committed**, so CI can diff it.
`mechanics build --all --check` exits 1 when the committed manifest no longer
matches the corpus it was built from — which is what happens when somebody
edits a behaviour and forgets to rebuild. Documentation rots because nothing
checks it; this is the thing that checks it.
