---
title: CLI reference
description: Every mechanics command, what it does, and the flags that matter.
---

Commands are shown as `mechanics …`. Under npm that is `npx mechanics …`; under
Bun, `bunx mechanics …` or `bun mechanics …` in a repo that has it installed.

Every command that operates on an app takes either `--app=<slug>` or, where
noted, `--all`.

## Setting up

### `init`

```bash
mechanics init [--app=<slug>] [--dry-run] [--no-ci] [--no-mcp] [--no-docket]
```

Sets the repo up: `mechanics.config.yaml`, a corpus skeleton, the CI gate
matched to your package manager and detected adapters, the `.mcp.json`
registration, `.docket/`, and the committed manifest. Every file is
skip-if-exists, so running it twice is safe. `--dry-run` prints the plan and
writes nothing.

### `scan`

```bash
mechanics scan [--root=<dir>] [--depth=N] [--json]
mechanics scan --adopt=<repo> [--app=<slug>] [--yes]
mechanics scan --interactive
```

Inventories the checkouts under a directory and says which could be onboarded —
stack, detected adapters, monorepo layout, and whether a config is already
there. Linked worktrees are collapsed into their primary checkout, which is the
difference between an honest count and a list that reports one monorepo eleven
times.

There is no adopt-all and no prompt: naming the repo is half the confirmation
and `--yes` is the other half, so the command behaves the same in a script as
in a terminal.

## Checking

### `check`

```bash
mechanics check --app=<slug> | --all
```

Validates the corpus (frontmatter, AC labels, ID shape), resolves waves,
reports coverage, and checks the [decision records](/docket/#decision-records).
Every unclaimed surface is warned about by name and path. Exits non-zero when
`coverage.enforce` is `error` and gaps remain, or when a decision record is
stale.

The decision gate runs once for the repo rather than per app: `.docket/` is
repo-level, and a stale decision is stale regardless of which app you were
checking.

### `build`

```bash
mechanics build --app=<slug> | --all
mechanics build --all --check      # the drift gate: exit 1 if stale
```

Regenerates the committed manifest. `--check` writes nothing and instead fails
when what is committed no longer matches the corpus — this is the command CI
runs.

### `coverage`

```bash
mechanics coverage --app=<slug>
```

The table: every surface kind, claimed against found, with each gap named. Plus
the test link counts and any open wave's rollup.

### `impact`

```bash
mechanics impact --app=<slug> --base=<ref>
```

Maps changed files back to the behaviours that claim them — what a diff touches,
in behaviour terms, for a PR description or a review checklist.

## Reporting

### `report`

```bash
mechanics report --html [--out=<path>]
```

The same data as one self-contained page: no build step, no server, no external
request. Attach it to a PR, or open it from `file://` six months later.

### `tui`

```bash
mechanics tui
```

A dashboard rather than a command: apps and their gaps, issues ordered by how
quietly they fail, runs in flight, proposals waiting on you, and whether a newer
release is out. It watches the corpus and `.docket/`, so it reacts to an edit
rather than to a refresh.

It never writes. The manifest is diffed with `check`, and the fix and scan keys
print the command instead of running it — a keystroke that mutates the repo
behind a full-screen redraw leaves you no diff and nowhere for the output to go.

## Closing gaps

### `gaps`

```bash
mechanics gaps --app=<slug> | --all [--json]
mechanics gaps --app=<slug> --fix[=ops]
mechanics gaps --app=<slug> --propose --run=<id>
mechanics gaps --app=<slug> --agent=<name> [--model=<m>]
```

What the corpus is missing, split by whether the answer is mechanical or a
judgment. `--fix` applies only the first kind and refuses the rest in code.
`--propose` queues the rest against a [docket run](/docket/) for a human.
`--agent` hands the remainder to an [agent provider](/agents/).

### `scaffold`

```bash
mechanics scaffold --app=<slug>
```

Drafts a stub behaviour per unclaimed surface — a starting point to edit, not a
corpus. The stubs are `status: draft` and carry `TODO` placeholders on purpose.

## Verifying

### `verify`

```bash
mechanics verify --app=<slug> --wave=<wave>
mechanics verify --app=<slug> --wave=<wave> \
  --set <id>=<status> --method=<m> --evidence=<e> --by=<who>
```

Runs the specs linked to the wave's behaviours and merges the results into the
wave YAML. `--set` records a verdict by hand — a deliberate human action, and
the only way a `manual` method gets recorded. A `pass` without `--evidence` is
refused.

### `screens`

```bash
mechanics screens --app=<slug> --wave=<wave> --checkpoint=<before|after|…> \
  [--routes=/a,/b] [--base-url=<url>] [--viewport=WxH] [--suffix=mobile] \
  [--keep-png] [--dry-run]
```

Captures per-route screenshots at a named checkpoint, for before/after comparison
across a redesign wave. Needs Playwright and sharp on the app side.

## Agents

### `mcp`

```bash
mechanics mcp
```

Serves the corpus to an agent over stdio. Five read tools, no write tools — see
[MCP server](/mcp/).

### `agents`

```bash
mechanics agents
```

Probes which [agent providers](/agents/) are reachable from this machine and
prints what responded.

## The run board

`docket/1` work orders — see [the spec](/docket/).

```bash
mechanics run list [--watch]                   # the board
mechanics run new --title="…"                  # open a work order
mechanics run event --run=<id> --type=<type>   # append to the event log
mechanics run show --run=<id>                  # phases, criteria, evidence
mechanics run rebuild --run=<id> | --all       # regenerate state.json from events
mechanics run proposals --run=<id>             # what is queued for review
mechanics run accept --run=<id> --proposal=<id> [--apply]    # human only
mechanics run reject --run=<id> --proposal=<id> --reason=…
```

`run accept` refuses any actor that is not human. Accepting asserts that a
suggestion was right, which is the same act as marking work green.

## Colour

Colour is off unless stdout is a TTY. `NO_COLOR` beats `FORCE_COLOR`. Colour
never carries meaning on its own — every state that has a colour also has a
word or a symbol.
