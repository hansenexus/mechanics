---
title: List snapshots and store health
kind: user-facing
status: active
priority: p1
roles: [operator]
claims:
  cli-command: ["src/commands/status.ts"]
paths: ["src/commands/status.ts"]
nonFunctional: []
destructive: false
aliases: []
verify: e2e
---

## Story

As an operator, I can list the stored snapshots and the space they occupy so
that I can decide what to prune.

## Acceptance Criteria

- **AC1** Given at least one stored snapshot, When I run `status`, Then each
  snapshot is listed with its id, creation date, file count and tag.
- **AC2** Given an empty store, When I run `status`, Then it prints `no
  snapshots` and exits 0 — an empty store is a state, not an error.
- **AC3** Given `--json`, When I run `status`, Then stdout is a single JSON
  object and nothing else, so it can be piped.

## Edge Cases

- A snapshot whose metadata file is corrupt is listed with `(unreadable)`
  rather than omitted — a missing row would hide the problem.

## Error States

- Store directory missing: `no snapshot store at <path> — run 'backup' first`,
  exit 2.
