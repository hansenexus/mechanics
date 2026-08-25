---
title: Agent providers
description: The scan → gaps → propose → fix loop, running on whatever agent this machine actually has.
---

```bash
mechanics agents                                    # what is reachable
mechanics gaps --app=<slug> --agent=claude          # a harness edits the tree itself
mechanics gaps --app=<slug> --agent=ollama --model=qwen2.5-coder:7b
mechanics gaps --app=<slug> --agent=?               # pick from what responded
```

`run dispatch` used to hardcode `claude`. That was fine while there was one
harness worth pointing at and wrong the moment there were several: a repo on a
locked-down network, a team standardised on a different CLI, and a machine with
a local model and no API budget all want the same pipeline.

## Two provider shapes

### Harness providers — `claude`, `codex`, `qwen`

Already agents. They have their own tools, their own file access, their own
loop. Handing one a brief in a worktree is the whole integration; it edits the
tree itself.

### Model providers — `ollama`, `lmstudio`, any OpenAI-compatible endpoint

Text in, text out. They cannot open a file. Giving them the same autonomy means
giving them a way to *say* what to change and having mechanics make the change,
so they answer in a small edit protocol which is validated, applied, and rolled
back as one unit if the result does not build.

The protocol is exact-substring rather than a diff on purpose: a patch needs the
model to count context lines, and a hunk that lands at the wrong offset still
parses.

## What every provider may do

Write behaviours, write specs, restructure app code — full reach over the tree.

## What no provider may do

Four moves are refused whatever the provider's kind:

1. Editing a wave file
2. Promoting a `draft` behaviour to `active`
3. Touching `coverage.ignore`
4. Flipping `coverage.enforce`

Those are not work. They are claims that the work is good. An agent that edits a
thousand files is doing work; an agent that marks its own work green is doing
something else, and providers here are given the first without the second,
deliberately.

The same line runs through the [docket](/docket/) protocol: an agent may raise
or reject a proposal, but `mechanics run accept` refuses any actor that is not
human.

## The honest limit

The actor check infers `human` from the absence of an agent session variable, so
a process that unsets it is indistinguishable from a person. It removes the
default path and nothing more. The durable boundary is that proposals and their
resolutions are committed files somebody reviews.
