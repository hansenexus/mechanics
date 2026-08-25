# perch — a worked example, mid-life

A fictional uptime-monitoring product, documented with mechanics. It is a real
runnable corpus: `check`, `build`, `coverage`, `report` and the MCP server all
work against this directory.

```bash
cd examples/perch
bun ../../cli.ts check --app=perch
bun ../../cli.ts coverage --app=perch
bun ../../cli.ts report --html --out=/tmp/perch.html
```

## Why it exists

`template/` is the corpus `mechanics init` gives you: four behaviours, fully
claimed, green. That is the right starting point and a bad advertisement — a
coverage table with no gaps in it shows the tool doing nothing.

This is the other end. It is a corpus part-way through its life, and every
awkward state a real one gets into is represented on purpose:

| | |
|---|---|
| 25 behaviours | over three areas, `user-facing` and `system` |
| Both built-in adapters | `nextjs-app-router` and `convex`, plus a glob-declared `worker` kind — mixing them is the normal case |
| 4 unclaimed surfaces | `/`, `/login`, `/api/webhooks/stripe`, `monitors.exportCsv` |
| 1 ignored surface | `src/workers/_replay.ts`, excused by glob in `mechanics/_config.yaml` |
| 1 draft | `status-page/custom-domain` — designed, not built, so it claims nothing |
| 1 deprecated | `status-page/rss-feed` — the surface is gone, the decision is kept |
| 1 open wave | with three failures, one blocker, one `n-a`, and three still pending |

`coverage.enforce` is `warn`, not `error`, because the gaps are the point.
Flipping it to `error` is the ratchet: it is how a project says "the corpus is
complete now, and it stays that way".

## What is real and what is not

The `mechanics/` corpus, `mechanics.config.yaml`, the wave and the committed
manifest are real inputs — the CLI reads them the same way it reads yours.

`src/` and `convex/` are stubs. They exist so the adapters have something to
enumerate: an empty `page.tsx` is as much of a route as a real one, and the
inventory is what coverage compares against. Nothing here runs as an app.

## Regenerating the README screenshots

The images in the top-level README are captured from this corpus:

```bash
bun run docs:shots      # from the repo root
```

`examples.test.ts` asserts the corpus stays valid and that its gaps stay
exactly the four listed above — so if the shots go stale, CI says so first.
