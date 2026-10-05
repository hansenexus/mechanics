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

## Pointing the built-ins at your layout

The two built-in adapters assume a layout: the App Router under `src/app/`, and
Convex functions in `convex/`, built with `query`, `mutation` or `action`. A
repo that differs gets an empty inventory, not an error — so say where things
are:

```yaml
adapterOptions:
  convex:
    dir: convex                 # app-relative; default "convex"
    wrappers: [spaceQuery, spaceMutation, publicQuery]
  nextjs-app-router:
    appDir: apps/web/src/app    # app-relative; default "src/app"
```

| Option | Default | Effect |
|---|---|---|
| `convex.dir` | `convex` | where Convex functions live. `lib/`, `_generated/`, `*.test.ts` and `*.d.ts` are excluded relative to it, and `crons.ts` / `http.ts` are read from inside it |
| `convex.wrappers` | `[]` | builder names counted as public functions **in addition to** `query`, `mutation`, `action` |
| `nextjs-app-router.appDir` | `src/app` | the App Router tree. Routes, API routes (`<appDir>/api/`) and provenance all derive from it |

A Convex item stays `<path under dir, without .ts>.<export>`, the shape of
Convex's own `api.<path>.<fn>`: `export const get = spaceQuery({…})` in
`convex/modules/lexilink/status.ts` is `modules/lexilink/status.get`.

Wrappers are listed, never guessed. A codebase that authorizes every handler
usually does it by wrapping the builders, and nothing about a name says whether
the wrapper is public, so `internalQuery` and friends are only counted if you
list them. Each name must be a JavaScript identifier; it matches exactly, so
`spaceQuery` does not also match `spaceQueryAdmin`.

The `packages/dev-routes/manifests/<slug>.routes.json` preference is unchanged:
when that manifest exists, page routes come from it whatever `appDir` says.

**Precedence.** `adapterOptions` sits at repo level and can be overridden per
entry under `apps:`, like `adapters:` and `surfaces:`. The unit is one
adapter's block: an app that sets `adapterOptions.convex` replaces the
repo-level `convex` block whole (no field-by-field merge, so `wrappers: []`
means none) and still inherits the repo-level `nextjs-app-router` block.

**Options for an adapter that does not run are an error.** An app's own block
for an adapter missing from its `adapters:` fails the load, and so does a
repo-level block that no app ends up reading. A block that configures nothing
is nearly always a mistake, and ignoring it would reproduce the silent empty
inventory the options exist to prevent. Unknown keys fail too — the block is
strict like the rest of the file.

## Why scanning is regex-based

A real parse would catch exotic export styles that regexes miss, at the cost of
a TypeScript program per app. The misses fall through as unclaimed items —
visible, and cheap to absorb with an ignore glob. A build that takes a minute is
a build nobody runs.

If a surface is being missed, the fix is usually a glob rather than a bug
report: declare it explicitly under `surfaces:` and it is inventoried like
anything else.
