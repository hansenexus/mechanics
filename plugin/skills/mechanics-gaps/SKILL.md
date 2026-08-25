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
  report only. `--fix=<ops>` selects lanes by name.
- `--propose --run=<id>` — queue the rest onto a docket run for a person.

## Gather

```
mechanics gaps --app=$1            # every gap, tagged `fix` (mechanical) or `ask` (judgment)
mechanics gaps --app=$1 --json     # the same, for a machine
mechanics report --html --app=$1   # the readable form, if you want to hand it over
```

`mechanics gaps` is the whole audit. `coverage` and `check` still answer their
own narrower questions — what is claimed, and whether the corpus is valid — but
you no longer need to assemble the picture from them by hand.

## The five gaps, in the order they matter

1. **Unclaimed surfaces.** A shipped surface nothing documents. The most
   serious gap, because it is behaviour with no definition of done. For each:
   name the area that should own it, and propose it — drafting the mechanic is
   authoring, and belongs to a person.
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

## The two lanes

This section used to be instructions. It is now a description of what the tool
will and will not do, because a rule an agent can be argued out of is not a
rule. `mechanics gaps --fix` performs the mechanical ops and **throws** on the
others (`assertNoForbiddenOp`).

`--fix` applies, because each has exactly one correct form given the tree:

- **`add-paths`** — fill a mechanic's EMPTY `paths:` from the files its claims
  resolve to, via the adapter's `provenance()`. Literal paths, never invented
  globs. Refused if any claim resolves to no known file, or if another mechanic
  claims the same surface.
- **`narrow-ignore`** — replace a wildcard ignore with the literal items it
  matches today. This reads like a judgment and is not: it is
  behaviour-preserving now (the manifest is byte-identical, which is a test)
  and strictly narrower later, because a surface that would have been silently
  excused shows up unclaimed instead. It appeals to nobody's intent.
- **`annotate-spec`** — add `// @mechanic <id>` where a spec's basename can mean
  exactly one untested mechanic. **Off by default**: it is the only op that
  writes app source. Ask for it with `--fix=annotate-spec`.

The manifest is rebuilt afterwards, and if the corpus stops validating every
byte is restored.

**Never**, and the CLI enforces it:

- Write a mechanic for an unclaimed surface. Drafting one is authoring, and it
  belongs to `mechanics-init` with a human in the loop.
- Add or widen an ignore glob. That is the single move that turns this whole
  system into decoration, and a widening dressed as a narrowing is refused by
  name.
- Flip `status: draft` to `active`, or record any verification verdict.
- Flip `coverage.enforce` in either direction.
- **Accept your own proposal.** You may raise one and you may reject one;
  accepting asserts the suggestion was right, which is the same act as marking
  work green. `mechanics run accept` refuses any actor that is not human.

## Handing the rest to an agent

A `propose`-lane gap needs judgment, which is what a model is for:

```
mechanics agents                              # what is reachable here
mechanics gaps --app=$1 --agent=<name>        # let it close them
```

It has full reach over the tree — mechanics, specs, app code. Four moves stay
refused whatever the provider: wave files, promoting a draft, touching
`coverage.ignore`, flipping the ratchet. Verification is still yours.

## Proposing the rest

Gaps in the `ask` lane go to a person, on a docket run:

```
mechanics gaps --app=$1 --propose --run=<run-id>
mechanics run proposals --run=<run-id>       # what is queued
```

It will not open a run for you — that is a decision — and it is idempotent, so
re-running never puts the same suggestion in front of a reviewer twice.

## Report

One table per gap class — item, owning area, suggested action — then the two
numbers worth tracking over time: unclaimed surfaces, and `p0` behaviours with
no test. Say plainly what `--fix` changed, what it deferred and why, and what went to
proposals.

If nothing is missing, say that in one line. A clean audit is a real result and
does not need padding.
