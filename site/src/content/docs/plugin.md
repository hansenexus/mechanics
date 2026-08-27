---
title: Claude Code plugin
description: Three skills — init, verify, gaps — for working a behaviour corpus from inside Claude Code.
---

```bash
/plugin marketplace add hansenexus/mechanics
/plugin install mechanics
```

Or copy `skills/` out of the package into your repo's `.claude/skills/`.

## The skills

| Skill | Use it when |
|---|---|
| `mechanics-init` | onboarding an app: scaffold the tree, fan out one authoring agent per area, consolidate, build the manifest |
| `mechanics-verify` | running a verification wave: specs, then agent-driven ACs, then the manual checklist for destructive behaviours |
| `mechanics-gaps` | auditing what the corpus is missing, closing the mechanical gaps, proposing the rest to a human |

They assume the `mechanics` CLI is on PATH — `npm i -D @hansenexus/mechanics`,
or `bunx @hansenexus/mechanics`. Nothing in them is specific to a stack, a CI
provider or a forge: where a step needs one, the skill says "whatever this
project uses" and expects you to know.

## Overriding a skill for one repo

A repo with its own conventions should not fork the body. Keep the packaged
skill as the procedure and add a short overlay in `.claude/skills/<name>/` that
lists only the deltas — the corpus path, the command prefix, the PR mechanism,
the tools that exist here and nowhere else. One body, one table of differences.
A dozen lines is usually enough.

## What no skill here will do

Record a verification verdict on your behalf without evidence, add or widen an
ignore glob to make a gap disappear, accept its own proposal, or auto-merge.
Those are the same refusals the CLI enforces, restated where an agent would
otherwise be tempted.
