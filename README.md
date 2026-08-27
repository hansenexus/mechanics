# mechanics

**[mechanics.hansenexus.dev](https://mechanics.hansenexus.dev)** — docs, and a live coverage report.

[![npm](https://img.shields.io/npm/v/@hansenexus/mechanics?logo=npm&color=cb3837)](https://www.npmjs.com/package/@hansenexus/mechanics)
[![ci](https://github.com/hansenexus/mechanics/actions/workflows/ci.yml/badge.svg)](https://github.com/hansenexus/mechanics/actions/workflows/ci.yml)
[![licence](https://img.shields.io/npm/l/@hansenexus/mechanics?color=0f7b6c)](./LICENSE)

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
mechanics scan                     # every repo here, its stack, whether it is onboarded
mechanics init                     # set a repo up: config, corpus skeleton, CI, MCP
mechanics check --all              # corpus + waves + coverage
mechanics build --all --check      # drift gate
mechanics coverage --app=<slug>    # the table, the gaps, wave rollups
mechanics gaps --app=<slug>        # what is missing, split into fix / ask
mechanics report --html            # one self-contained page
mechanics mcp                      # serve the corpus to an agent over stdio
mechanics agents                   # which agent providers are reachable from here
mechanics run list                 # the docket/1 board
mechanics tui                      # leave it open: drift, gaps, runs, updates
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

## Any agent, not just one

The pipeline — scan, gaps, propose, fix — runs on whatever this machine
actually has. `mechanics agents` probes and says which:

```bash
mechanics agents                                   # what is reachable
mechanics gaps --app=<slug> --agent=claude         # a harness edits the tree itself
mechanics gaps --app=<slug> --agent=ollama --model=qwen2.5-coder:7b
mechanics gaps --app=<slug> --agent=?              # pick from what responded
```

Two provider shapes. A **harness** — `claude`, `codex`, `qwen` — is already an
agent: hand it a brief in a worktree and it edits with its own tools. A
**model** — `ollama`, `lmstudio`, any OpenAI-compatible endpoint — is text in,
text out and cannot open a file, so it answers in a small edit protocol that
mechanics validates, applies, and rolls back as one unit if the result does not
build. The protocol is exact-substring rather than a diff on purpose: a patch
needs the model to count context lines, and a hunk that lands at the wrong
offset still parses.

A provider may write mechanics, write specs, restructure app code — full reach
over the tree. Four moves are refused whatever the provider: editing a wave
file, promoting a draft to `active`, touching `coverage.ignore`, and flipping
`coverage.enforce`. Those are not work, they are claims that the work is good.

## Leaving it open

```bash
mechanics tui
```

A dashboard rather than a command: apps and their gaps, the issues worth acting
on ordered by how quietly they fail, runs in flight, proposals waiting on you,
and whether a newer release is out. It watches the corpus and `.docket/`, so it
reacts to an edit rather than to a refresh.

It never writes. The manifest is diffed with `check`, and the fix and scan keys
print the command instead of running it — a keystroke that mutates the repo
behind a full-screen redraw leaves you no diff and nowhere for the output to
go.

## Onboarding more than one repo

`mechanics scan` inventories the checkouts under a directory and says which
could be onboarded — stack, detected adapters, monorepo layout, and whether a
config is already there. It collapses linked worktrees into their primary
checkout, which is the difference between an honest count and a list that
reports one monorepo eleven times.

```bash
mechanics scan --root=~/repos              # the inventory
mechanics scan --adopt=<repo>              # what init would write — nothing yet
mechanics scan --adopt=<repo> --yes        # write it
```

There is no adopt-all, and no prompt: naming the repo is half the confirmation
and `--yes` is the other half, so the command behaves the same in a script as
in a terminal.

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
| **MCP** | six read tools over stdio: list, get, coverage, wave status, diff impact, decisions |
| **Report** | `--html`: one file, no build step, no external request |
| **TUI** | `mechanics tui` — the always-open view: drift, issues, runs, proposals, updates |
| **Agents** | `claude`, `codex`, `qwen`, `ollama`, `lmstudio` — harnesses edit directly, models edit through a validated protocol |
| **Gaps** | the five gap classes as predicates, each tagged `auto` (one correct answer) or `propose` (a judgment) — `gaps --fix` applies the first kind and refuses the rest in code |
| **[Decisions](./spec/docket-1.md#decision-records)** | `.docket/decisions/` — ADRs retrievable by the file you are about to touch; an accepted record whose `affects.paths` matches nothing fails `check`, and two open runs deciding about one subsystem get flagged |
| **[docket/1](./spec/docket-1.md)** | the run protocol — work orders with checkable exit criteria and an append-only event log, with [executable conformance vectors](./spec/docket-1.vectors.json) |
| **[Plugin](./plugin/)** | three Claude Code skills: init, verify, gaps |

## The two things it refuses to do

**Record a verdict without evidence.** `pass` requires an evidence string, at
write time and again at read time. A hand-edited log cannot slip one through.

**Let a model mark its own work green.** The MCP server is read-only, and a
test asserts no write-shaped tool name is advertised. Verdicts go through
`mechanics verify`, which runs the specs, or `verify --set`, which is a
deliberate human action. The same line runs through the agent loop: an agent
may fix what has one correct answer, and may raise or reject a proposal, but
`mechanics run accept` refuses any actor that is not human — accepting asserts
a suggestion was right, which is the same act as marking work green. Both of
those refusals are the whole value of the format; a convenient way around them
would be a way of destroying it.

*Stated plainly, because the alternative is overclaiming:* the actor check
infers `human` from the absence of an agent session variable, so a process that
unsets it is indistinguishable from a person. It removes the default path and
nothing more. The durable boundary is that proposals and their resolutions are
committed files somebody reviews.

## Runtime

The `mechanics` bin is a bundled Node build (`dist/cli.js`), so both
`npx mechanics` and `bunx mechanics` work with no Bun requirement at use time.
The package also ships its TypeScript source, importable directly under Bun
(≥ 1.2), which is what development and the test suite run on.

Releases are published from [CI](./.github/workflows/release.yml) over npm
Trusted Publishing, so the tarball on npm carries a signed attestation tying it
to this repository and the commit it was built from. `repository` in a
package.json is a claim anyone can make; the attestation is the part that can
be checked. There is no publish token to leak or rotate — npm verifies the
workflow's OIDC identity directly.

## Licence

MIT. The protocol specification in `spec/` is additionally available under
CC BY 4.0, so another implementation may reuse its wording with attribution.
See [LICENSE](./LICENSE).
