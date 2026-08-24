---
name: mechanics-gaps
description: Audit a mechanics corpus for what is missing — unclaimed surfaces, untested behaviours, stale ignores, dangling waves — and close the cheap gaps. Trigger phrases "mechanics gaps", "what is undocumented", "coverage audit", "close the mechanics gaps", "mechanics-gaps <app>".
---

# mechanics-gaps — find and close what the corpus is missing

`check` tells you the corpus is *valid*. This tells you whether it is *true*.
Those are different questions, and the second one is the one that decays: a
corpus goes stale by omission, never by breaking.

## Inputs

- `$1` — app slug, or omit for every onboarded app.
- `--fix` — also close the gaps that need no judgment (see below). Without it,
  report only.

## Gather

```
mechanics coverage --app=$1        # per-kind claimed / ignored / unclaimed
mechanics check --app=$1           # errors and warnings
mechanics report --html --app=$1   # the readable form, if you want to hand it over
```

Read the manifest for what the CLI summarises: `testCoverage`, per-mechanic
`tests`, `status`, `destructive`, and each area's count.

## The five gaps, in the order they matter

1. **Unclaimed surfaces.** A shipped surface nothing documents. The most
   serious gap, because it is behaviour with no definition of done. For each:
   name the area that should own it, and either draft the mechanic or add it to
   that area's follow-up list.
2. **Stale ignores.** An `ignore` glob in `_config.yaml` matching nothing is a
   lid on a hole that has since moved. Matching far more than intended is
   worse — it silently excuses new surfaces as they land. Report both.
3. **Untested behaviours.** `tests: []` and `verify` is not `manual-only`. The
   mechanic exists and nothing checks it. Rank `p0` first; a `p0` with no test
   and no manual-only marker is the highest-value thing on the list.
4. **Draft debt.** `status: draft` months after authoring means nobody reviewed
   it. Report the count per area and the oldest ones — a corpus of permanent
   drafts is a corpus nobody trusts.
5. **Dangling waves.** An open wave with no movement, entries pointing at
   aliases, or a `closed` wave that still has pending entries. `check` catches
   the last one; the first two are judgment.

## What `--fix` may do, and what it may never do

May, because none of it is a judgment about behaviour:

- Add a `paths:` glob that clearly matches a mechanic's implementing files.
- Narrow an over-broad ignore glob to what it actually needed to excuse.
- Link an existing spec to a mechanic by adding `// @mechanic <id>` where the
  spec unambiguously tests that mechanic.
- Regenerate the manifest afterwards (`mechanics build --app=$1`).

**Never**, because each is a claim only a person can make:

- Write a mechanic for an unclaimed surface. Drafting one is authoring, and it
  belongs to `mechanics-init` with a human in the loop.
- Add an ignore glob to make a gap disappear. That is the single move that
  turns this whole system into decoration.
- Flip `status: draft` to `active`, or record any verification verdict.
- Flip `coverage.enforce` in either direction.

## Report

One table per gap class — item, owning area, suggested action — then the two
numbers worth tracking over time: unclaimed surfaces, and `p0` behaviours with
no test. Say plainly what `--fix` changed and what it deliberately left alone.

If nothing is missing, say that in one line. A clean audit is a real result and
does not need padding.
