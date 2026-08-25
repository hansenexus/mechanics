---
title: CI setup
description: The two gates mechanics init writes, and turning the ratchet when the corpus is complete.
---

`mechanics init` writes a workflow matched to your package manager and detected
adapters. It has two jobs, and they do different work.

## Gate one: validate and drift

```yaml
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm ci

      - name: Validate corpus, waves and coverage
        run: npx mechanics check --all

      - name: Manifests match the tree
        run: npx mechanics build --all --check
```

| Command | Fails when |
|---|---|
| `check --all` | the corpus does not parse, a claim names a surface that does not exist, a wave does not resolve, or gaps remain while `coverage.enforce` is `error` |
| `build --all --check` | the committed manifest no longer matches the corpus it was built from |

The second is the drift gate, and it is why the manifest is committed at all: a
generated artefact you do not commit cannot be diffed, and a documentation set
nothing diffs goes stale.

When it fires, the fix is one command:

```bash
npx mechanics build --all && git add -A && git commit -m "chore: rebuild manifests"
```

Under Bun the generated workflow uses `oven-sh/setup-bun@v2`,
`bun install --frozen-lockfile` and `bunx`; pnpm and yarn get their own install
steps. You do not pick — `init` detects it.

## Gate two: coupling

Drift catches an edited behaviour with a stale manifest. It does **not** catch
the more common failure: somebody changes a documented surface and never touches
the corpus at all. That is what the second job is for.

```yaml
  coupling:
    if: github.event_name == 'pull_request'
    steps:
      - name: Surface changed without a corpus change
        if: ${{ !contains(github.event.pull_request.labels.*.name, 'mechanics-not-needed') }}
```

The job diffs the PR against its base and fails when files under a documented
surface directory changed but nothing under `mechanics/` did. The directories it
watches are derived from your adapters — `app/` for `nextjs-app-router`,
`convex/` for `convex` — and the generated workflow says so in a comment, since
they have to stay in step with `mechanics.config.yaml`.

**The escape hatch is a label.** A surface-only change that genuinely needs no
documentation update gets the `mechanics-not-needed` label on the PR and the job
skips. A label is a deliberate, visible, reviewable act — which is the whole
requirement. It is on the PR, not in a config file, so it excuses one change
rather than a category of them forever.

## Turning the ratchet

Start at `warn` while the corpus is being written:

```yaml
# mechanics/_config.yaml
coverage:
  enforce: warn
```

Gaps are still reported by name on every run — they simply do not fail the
build. When the corpus covers everything the app ships, flip it:

```yaml
coverage:
  enforce: error
```

From then on, a new route with no behaviour behind it fails CI. That is the
whole mechanism: the corpus can only get more complete, never less.

## Attaching the report to a PR

```bash
npx mechanics report --html --out=coverage.html
```

One self-contained file — no build step, no server, no external request — so it
uploads as an artifact and opens straight from the download.

## Impact on a PR

```bash
npx mechanics impact --app=<slug> --base=origin/main
```

Maps the diff back to the behaviours that claim the changed files, which is a
better review checklist than a list of files.
