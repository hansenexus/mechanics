---
title: Configuration
description: mechanics.config.yaml and mechanics/_config.yaml, field by field.
---

Two files. `mechanics.config.yaml` at the repo root says what the apps are and
what surfaces they ship; `mechanics/_config.yaml` inside each app says how that
app's corpus is checked.

Both are strict — an unrecognised key is an error, not a silent no-op.

## `mechanics.config.yaml`

Its presence marks the repo root: the CLI walks up from the working directory
to find it.

```yaml
apps:
  - slug: perch
    dir: .
    adapters: ["nextjs-app-router", "convex"]
    surfaces:
      - kind: worker
        label: background worker
        globs: ["src/workers/*.ts"]

manifestsDir: .mechanics/manifests
```

| Field | Meaning |
|---|---|
| `apps[].slug` | kebab-case; the first segment of every mechanic ID in this app |
| `apps[].dir` | app root, relative to the repo root. `.` for a single-app repo — it drops the `apps/<slug>/` prefix from every derived path |
| `apps[].adapters` | which [adapters](/adapters/) run for this app |
| `apps[].surfaces` | extra surface kinds declared by glob |
| `appsDir` | alternative to `apps`: one directory per app, discovered |
| `manifestsDir` | where committed manifests live. Generated, drift-gated, never hand-edited |
| `adapters` | repo-level default when an app does not override it |
| `surfaces` | repo-level default, same |

Declare **exactly one** of `appsDir` and `apps`. A repo that declared both would
have two answers to "what apps are there", and the discovered set would silently
win.

## `mechanics/_config.yaml`

Per-app, relative to the app root.

```yaml
testGlobs:
  - "e2e/**/*.spec.ts"

e2eRunner: bun-script

coverage:
  enforce: warn
  ignore:
    worker:
      - "src/workers/_*.ts"
```

### `testGlobs`

The specs scanned for `// @mechanic <id>` annotations and mechanic-prefixed
describe titles. Test links are **discovered** from these, never declared in
frontmatter — a declared link is a second source of truth that rots.

### `e2eRunner`

`bun-script` or `playwright`. Playwright additionally requires
`playwrightConfig` pointing at the config file; the schema refuses the
combination without it.

### `coverage.enforce`

`warn` while the corpus is still being written; `error` once it is complete.
That flip is the ratchet.

### `coverage.ignore`

Surfaces excused from needing a claim, keyed by the same surface kinds as
`claims`. Use it for things that are not product behaviour — internal debugging
tools, generated endpoints:

```yaml
coverage:
  ignore:
    cli-command:
      - "src/commands/_*.ts"
```

An ignore is a committed statement that something does not need documenting.
Widening one to make a gap disappear is a move [agent providers](/agents/) are
refused.

### `screens`

Optional, for `mechanics screens`:

```yaml
screens:
  viewport: 1440x900
  params:
    workspace: acme
  overrides:
    /dashboard/billing:
      skip: true
      reason: "needs a live Stripe session"
```

## Worked examples

Two ship inside the package and show opposite ends of a corpus's life:

- **`template/`** — what `init` gives you and the starting point for a fork:
  small, fully claimed, green, `enforce: error`. It ships no routes and no
  Convex functions on purpose, so `generic-glob` carries the whole inventory
  and nothing works by accident of the built-in adapters.
- **`examples/perch/`** — a corpus part-way through its life: 25 behaviours over
  three areas, both built-in adapters plus a glob-declared kind, four
  deliberately unclaimed surfaces, and a redesign wave in flight. See
  [Example: perch](/example-perch/).
