# mechanics

Behaviour specs with a coverage ratchet.

Every user-observable behaviour is one markdown file with labelled acceptance
criteria. A committed manifest is compiled from them and gated against drift in
CI. Every surface the project ships — route, endpoint, CLI command, scheduled
job, whatever your adapters declare — must be **claimed** by a behaviour or
explicitly **ignored**; anything else is a gap the build can be made to fail on.

The question it answers is "did we keep every behaviour?" during a rewrite or a
redesign, and the reason it works is that the answer is checkable rather than
asserted.

```bash
mechanics init                     # set a repo up: config, corpus skeleton, CI, MCP
mechanics check --all              # corpus + waves + coverage
mechanics build --all --check      # drift gate
mechanics coverage --app=<slug>    # the table, the gaps, wave rollups
mechanics report --html            # one self-contained page
mechanics mcp                      # serve the corpus to an agent over stdio
mechanics run list                 # the docket/1 board
```

## Start here

```bash
npm i -D @hansenexus/mechanics && npx mechanics init      # single-app repo
npx mechanics init --app=<slug>                           # monorepo: apps/<slug>
```

Init is idempotent (every file is skip-if-exists) and writes the repo config,
a corpus skeleton, the CI gate matched to your package manager and detected
adapters, the `.mcp.json` registration, the `.docket/` directory, and the
committed manifest. `--dry-run` shows the plan; `--no-ci`, `--no-mcp`,
`--no-docket` opt out. Then replace the starter mechanic with real behaviours —
`mechanics scaffold --app=<slug>` drafts a stub per unclaimed surface.

`template/` is the readable worked example: a runnable single-app corpus for a
fictional backup CLI. It ships **no routes and no Convex functions** on
purpose, so `generic-glob` carries the whole inventory and nothing works by
accident of the built-in adapters.

## What is in the box

| | |
|---|---|
| **Core** | parser, schema, manifest, coverage, waves, verify, CLI |
| **Adapters** | `nextjs-app-router`, `convex`, `generic-glob` — plus the `SurfaceAdapter` seam, so a stack nobody wrote an adapter for declares its surfaces in config instead of forking |
| **MCP** | five read tools over stdio: list, get, coverage, wave status, diff impact |
| **Report** | `--html`: one file, no build step, no external request |
| **[docket/1](./spec/docket-1.md)** | the run protocol — work orders with checkable exit criteria and an append-only event log, with [executable conformance vectors](./spec/docket-1.vectors.json) |
| **[Plugin](./plugin/)** | three Claude Code skills: init, verify, gaps |

## The two things it refuses to do

**Record a verdict without evidence.** `pass` requires an evidence string, at
write time and again at read time. A hand-edited log cannot slip one through.

**Let a model mark its own work green.** The MCP server is read-only, and a
test asserts no tool with `record` in its name is advertised. Verdicts go
through `mechanics verify`, which runs the specs, or `verify --set`, which is a
deliberate human action. Both of those are the whole value of the format; a
convenient way around them would be a way of destroying it.

## Runtime

The `mechanics` bin is a bundled Node build (`dist/cli.js`), so both
`npx mechanics` and `bunx mechanics` work with no Bun requirement at use time.
The package also ships its TypeScript source, importable directly under Bun
(≥ 1.2), which is what development and the test suite run on.

## Licence

MIT. The protocol specification in `spec/` is additionally available under
CC BY 4.0, so another implementation may reuse its wording with attribution.
See [LICENSE](./LICENSE).
