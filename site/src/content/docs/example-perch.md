---
title: "Example: perch"
description: A worked corpus part-way through its life — with real gaps, a draft, a deprecation, and a wave in flight.
---

`examples/perch/` in the package is a fictional uptime-monitoring product,
documented with mechanics. It is a real runnable corpus: `check`, `build`,
`coverage`, `report` and the MCP server all work against that directory.

```bash
cd examples/perch
bun ../../cli.ts check --app=perch
bun ../../cli.ts coverage --app=perch
bun ../../cli.ts report --html --out=/tmp/perch.html
```

[Open the generated report →](/report/)

## Why it exists

`template/` is the corpus `mechanics init` gives you: four behaviours, fully
claimed, green. That is the right starting point and a bad advertisement — a
coverage table with no gaps in it shows the tool doing nothing.

perch is the other end. It is a corpus part-way through its life, and every
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

## What is real and what is not

The `mechanics/` corpus, `mechanics.config.yaml`, the wave and the committed
manifest are real inputs — the CLI reads them the same way it reads yours.

`src/` and `convex/` are stubs. They exist so the adapters have something to
enumerate: an empty `page.tsx` is as much of a route as a real one, and the
inventory is what coverage compares against. Nothing here runs as an app.

## The screenshots are generated from it

Every image on this site and in the README is captured from this corpus by
`bun run docs:shots`, so they are the real CLI's real output rather than a
mock-up. `examples.test.ts` asserts the corpus stays valid and that its gaps
stay exactly the four listed above — so if the shots go stale, CI says so first.
