# mechanics — template

A working single-app corpus you can fork. The example is a fictional backup
CLI, chosen deliberately: it ships **no routes and no Convex functions**, so
nothing here works by accident of the built-in adapters. If mechanics can
describe this, it can describe your stack.

```
mechanics.config.yaml            # where apps and manifests live; which surfaces exist
mechanics/
├── _config.yaml                 # test globs, runner, coverage ignores + the enforce ratchet
├── backups/                     # an area; the dir name becomes the ID segment
│   ├── _area.yaml
│   ├── create-snapshot.md       # ONE behaviour per file
│   ├── inspect-status.md
│   └── restore-snapshot.md
├── maintenance/
│   ├── _area.yaml
│   └── prune-old-snapshots.md
└── waves/2026-01-baseline.yaml  # a verification effort
.mechanics/manifests/            # committed, generated, drift-gated — never hand-edit
src/commands/, src/jobs/         # the surfaces being documented (stubs)
e2e/backup.spec.ts               # shows how a spec links to a mechanic
.github/workflows/               # the two gates + template-sync
```

## Try it

```bash
bunx mechanics check --app=example      # corpus + waves + coverage
bunx mechanics build --app=example      # regenerate the committed manifest
bunx mechanics coverage --app=example   # the table, the gaps, wave rollups
bunx mechanics mcp                      # serve the corpus to an agent over stdio
```

`coverage` on the shipped template prints:

```
example — 4 mechanics
  cli-command         3/4   claimed, 1 ignored, 0 unclaimed
  scheduled-job       1/1   claimed, 0 ignored, 0 unclaimed
  tests             2 with tests, 1 manual-only, 1 untested
  wave 2026-01-baseline [open]: 1/4 verified, 1 fail, 2 pending
```

## Making it yours

1. **Declare your surfaces** in `mechanics.config.yaml`. The kind names are
   yours — `cli-command`, `queue-worker`, `migration`, `grpc-method`. They
   become the keys under `claims:`, the coverage buckets, and the `ignore:`
   keys. Add `nextjs-app-router` and/or `convex` to `adapters:` if you also
   ship those.
2. **Delete the example corpus** and write your own, one behaviour per file.
   `bunx mechanics check` tells you what is missing; it is meant to be run
   constantly, not at the end.
3. **Leave `coverage.enforce: warn`** while you write, then flip it to `error`.
   That flip is the ratchet: from then on a new surface cannot ship
   undocumented.
4. **Open a wave** when you start a redesign or migration. A wave is the unit
   that answers "did we keep every behaviour?" — and `pass` requires evidence,
   so it cannot be answered by assertion.

## Multi-app repos

Replace the single `apps:` entry with `appsDir: apps` and one directory per
app. Paths then gain the `apps/<slug>/` prefix everywhere — mechanics live at
`apps/<slug>/mechanics/`, and IDs are still `<app>.<area>.<slug>`.

## What is deliberately absent

There is no way to record a verification verdict from an agent tool. `pass`
requires evidence, and a tool that let a model mark its own work green would
hollow out the one guarantee this format offers. Verdicts go through
`mechanics verify` (which runs the specs) or `mechanics verify --set` (a
deliberate human action).
