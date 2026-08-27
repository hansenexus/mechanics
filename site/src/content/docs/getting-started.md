---
title: Getting started
description: Install mechanics, onboard a repo, and get a coverage table out of it.
---

mechanics keeps a record of every user-observable behaviour an app has, checks
that record against the surfaces the app actually ships, and fails the build
when the two drift apart. This page takes a repo from nothing to a coverage
table.

## Install

```bash
npm i -D @hansenexus/mechanics
```

The `mechanics` bin is a bundled Node build, so `npx mechanics` and
`bunx mechanics` both work with no Bun requirement at use time. The package
also ships its TypeScript source, importable directly under Bun (≥ 1.2), which
is what development and the test suite run on.

## Onboard the repo

```bash
npx mechanics init                 # single-app repo
npx mechanics init --app=<slug>    # monorepo: apps/<slug>
npx mechanics init --dry-run       # show the plan, write nothing
```

Init is idempotent — every file is skip-if-exists — and writes:

| | |
|---|---|
| `mechanics.config.yaml` | repo root marker, app list, adapters, glob-declared surfaces |
| `mechanics/_config.yaml` | per-app: test globs, e2e runner, coverage enforcement and ignores |
| `mechanics/…` | a corpus skeleton with one starter behaviour |
| CI workflow | the drift gate, matched to your package manager and detected adapters |
| `.mcp.json` | registers the read-only MCP server |
| `.docket/` | the run protocol's directory |
| `.mechanics/manifests/` | the committed, generated manifest |

`--no-ci`, `--no-mcp` and `--no-docket` opt out of the last three.

## Write a behaviour

One markdown file per behaviour. Frontmatter says what it claims; the body says
what it promises.

```markdown
---
title: Create a monitor for an endpoint
kind: user-facing
status: active
priority: p0
roles: [operator, admin]
claims:
  route: ["/dashboard/monitors/new"]
  api-route: ["/api/monitors"]
  convex-function: ["monitors.create"]
paths: ["src/app/dashboard/monitors/new/page.tsx", "convex/monitors.ts"]
verify: e2e
---

## Story

As an operator, I can point Perch at a URL and say how often to check it, so
that I hear about an outage from Perch rather than from a customer.

## Acceptance Criteria

- **AC1** Given a valid HTTPS URL and an interval, When I submit the form,
  Then the monitor appears in the list with status `pending` and its first
  check is scheduled within one interval.
- **AC2** Given a URL that is already monitored in this workspace, When I
  submit, Then the form rejects it and links to the existing monitor.
```

Acceptance criteria are labelled (`**AC1**`, `**AC2**`, …) because the labels
are what a verification verdict attaches to. An unlabelled bullet is prose;
a labelled one is checkable.

## Check, build, and read the coverage

```bash
npx mechanics check --all           # corpus parses, waves resolve, gaps named
npx mechanics build --all           # regenerate the committed manifest
npx mechanics coverage --app=<slug> # the table, the gaps, the wave rollups
npx mechanics report --html         # the same data as one self-contained page
```

`check` warns about every surface no behaviour claims, one line each with its
path. Claim it in a behaviour, or add it to `coverage.ignore` — those are the
only two ways to make a gap go away, and both leave a record.

## Turn the ratchet

While the corpus is still being written, leave enforcement at `warn`:

```yaml
# mechanics/_config.yaml
coverage:
  enforce: warn
```

When it is complete, flip it:

```yaml
coverage:
  enforce: error
```

That flip is the ratchet. From then on a new route with no behaviour behind it
fails the build, and the corpus cannot quietly fall behind the app.

## Where next

- [Concepts](/concepts/) — behaviours, surfaces, claims, gaps, waves
- [CLI reference](/cli/) — every command and flag
- [Adapters](/adapters/) — covering a stack with no built-in adapter
- [Example: perch](/example-perch/) — a corpus with real gaps in it
