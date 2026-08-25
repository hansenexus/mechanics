# mechanics

[![npm](https://img.shields.io/npm/v/@hansenexus/mechanics?logo=npm&color=cb3837)](https://www.npmjs.com/package/@hansenexus/mechanics)
[![ci](https://github.com/hansenexus/mechanics/actions/workflows/ci.yml/badge.svg)](https://github.com/hansenexus/mechanics/actions/workflows/ci.yml)
[![licence](https://img.shields.io/npm/l/@hansenexus/mechanics?color=blue)](./LICENSE)

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

## What it looks like

Coverage is the whole idea: every surface the app ships, against every surface
the corpus claims. What is left over is a gap with a name.

![mechanics coverage — six surface kinds, four unclaimed surfaces named, and an open wave](https://raw.githubusercontent.com/hansenexus/mechanics/main/docs/images/coverage.png)

The gate is what stops the corpus rotting. Edit a mechanic without rebuilding
the manifest and CI says so; validation names every gap rather than totalling
them.

![the drift gate rejecting a stale manifest, and check naming each unclaimed surface](https://raw.githubusercontent.com/hansenexus/mechanics/main/docs/images/drift-gate.png)

`mechanics report --html` is the same data as one self-contained page — no
build step, no server, no external request. Attach it to a PR, or open it from
`file://` six months later.

![the HTML coverage report: surface coverage bars, wave rollup with failures, and all 25 behaviours](https://raw.githubusercontent.com/hansenexus/mechanics/main/docs/images/report.png)

Every one of those is generated from [`examples/perch`](./examples/perch) by
`bun run docs:shots`, so they are the real CLI's real output on a real corpus.

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

Two worked examples ship with the package, and they show opposite ends of a
corpus's life:

- **[`template/`](./template)** — what `init` gives you, and the starting
  point for a fork: small, fully claimed, green. It ships **no routes and no
  Convex functions** on purpose, so `generic-glob` carries the whole inventory
  and nothing works by accident of the built-in adapters.
- **[`examples/perch`](./examples/perch)** — a corpus part-way through its
  life: 25 behaviours over three areas, both built-in adapters plus a
  glob-declared kind, four deliberately unclaimed surfaces, and a redesign wave
  in flight with failures and a blocker on it. It is what the screenshots
  above are pictures of, and a test asserts its gaps stay exactly the four it
  means to have.

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

Releases are published from [CI](./.github/workflows/release.yml) with npm
provenance, so the tarball on npm carries a signed attestation tying it to this
repository and the commit it was built from. `repository` in a package.json is
a claim anyone can make; the attestation is the part that can be checked.

## Licence

MIT. The protocol specification in `spec/` is additionally available under
CC BY 4.0, so another implementation may reuse its wording with attribution.
See [LICENSE](./LICENSE).
