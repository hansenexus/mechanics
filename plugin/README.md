# mechanics — Claude Code plugin

Three skills for working with a behaviour-spec corpus, in any repo that has a
`mechanics.config.yaml`:

| Skill | Use it when |
|---|---|
| `mechanics-init` | onboarding an app: scaffold the tree, fan out one authoring agent per area, consolidate, build the manifest |
| `mechanics-verify` | running a verification wave: specs, then agent-driven ACs, then the manual checklist for destructive behaviours |
| `mechanics-gaps` | auditing what the corpus is missing, and closing the gaps that need no judgment |

They assume the `mechanics` CLI is on PATH (`npm i -D @hansenexus/mechanics`,
or `bunx @hansenexus/mechanics`). Nothing here is specific to a stack, a CI
provider or a forge: where a step needs one, the skill says "whatever this
project uses" and expects you to know.

## Install

```bash
/plugin marketplace add hansenexus/mechanics
/plugin install mechanics
```

Or copy `skills/` into your repo's `.claude/skills/`.

## Overriding a skill for one repo

A repo with its own conventions should not fork the body. Keep the packaged
skill as the procedure and add a short overlay in `.claude/skills/<name>/`
that lists only the deltas — the corpus path, the command prefix, the PR
mechanism, the tools that exist here and nowhere else. One body, one table of
differences.

A dozen lines of table over the packaged procedure is usually enough — name
the corpus path, the command prefix, and the PR mechanism, and stop there.

## What no skill here will do

Record a verification verdict on your behalf without evidence, add an ignore
glob to make a gap disappear, or auto-merge anything. Those are the three moves
that turn a corpus into decoration, and they are refused on purpose rather than
merely discouraged.
