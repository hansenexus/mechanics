---
title: Adapters
description: How mechanics finds what your app ships — and how a stack with no built-in adapter declares its own surfaces.
---

Coverage compares what behaviours **claim** against what the app **ships**. An
adapter is the second half: it declares the surface kinds it knows how to find
and returns the items it found.

Everything downstream — coverage buckets, claim validation, the manifest — keys
off adapter-declared kinds rather than a fixed list. Adding a surface kind does
not mean editing the core.

## What ships in the box

| Adapter | Kinds it finds |
|---|---|
| `nextjs-app-router` | `route`, `api-route` |
| `convex` | `convex-function`, `cron`, `http-endpoint` |
| `generic-glob` | whatever the config declares, matched by glob |

Three adapters is not the story. The seam is: a Rails app, a Go service or an
Expo project ships nothing that fits those five names, and `generic-glob` means
it does not have to fork the tool to say so.

## Covering a stack nobody wrote an adapter for

Declare the surfaces in `mechanics.config.yaml`. The kind names are yours —
they become the keys under `claims:` in each behaviour, the coverage buckets,
and the `ignore:` keys in `mechanics/_config.yaml`.

```yaml
apps:
  - slug: api
    dir: .
    adapters: []          # no built-in adapter applies
    surfaces:
      - kind: http-handler
        label: HTTP handler
        globs: ["internal/handlers/*.go"]
      - kind: grpc-method
        label: gRPC method
        globs: ["internal/rpc/*_service.go"]
      - kind: migration
        label: migration
        globs: ["db/migrate/*.sql"]
```

Behaviours then claim them by the same names:

```yaml
claims:
  http-handler: ["internal/handlers/monitors.go"]
  grpc-method: ["internal/rpc/monitor_service.go"]
```

`template/` in the package does exactly this and nothing else — it ships no
routes and no Convex functions on purpose, so `generic-glob` carries the whole
inventory and nothing works by accident of the built-in adapters. It is the
example to copy for a stack that is not Next.js.

## Mixing them

The normal case is both. `examples/perch/` runs the two built-in adapters and
adds one glob-declared kind:

```yaml
adapters: ["nextjs-app-router", "convex"]
surfaces:
  - kind: worker
    label: background worker
    globs: ["src/workers/*.ts"]
```

The adapters know Next.js and Convex; nothing but the config knows that
`src/workers/` is a surface at all.

## Why scanning is regex-based

A real parse would catch exotic export styles that regexes miss, at the cost of
a TypeScript program per app. The misses fall through as unclaimed items —
visible, and cheap to absorb with an ignore glob. A build that takes a minute is
a build nobody runs.

If a surface is being missed, the fix is usually a glob rather than a bug
report: declare it explicitly under `surfaces:` and it is inventoried like
anything else.
