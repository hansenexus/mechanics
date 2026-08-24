---
title: Create a snapshot of a source directory
kind: user-facing
status: active
priority: p0
roles: [operator]
claims:
  cli-command: ["src/commands/backup.ts"]
paths: ["src/commands/backup.ts"]
nonFunctional: [perf]
destructive: false
aliases: []
verify: e2e
---

## Story

As an operator, I can snapshot a directory into the snapshot store so that I
can recover its contents after an accidental deletion.

## Acceptance Criteria

- **AC1** Given a readable source directory, When I run `backup <dir>`, Then a
  new snapshot id is printed to stdout and the command exits 0.
- **AC2** Given a source directory that has not changed since the last
  snapshot, When I run `backup <dir>`, Then the existing snapshot id is printed
  with `(unchanged)` and no new snapshot is stored.
- **AC3** Given `--tag <name>`, When the snapshot is created, Then `status`
  lists it under that tag.

## Edge Cases

- An empty source directory produces a valid snapshot containing no files.
- A path containing a symlink loop is snapshotted once, not followed.

## Error States

- Unreadable source directory: `cannot read <dir>: permission denied`, exit 2.
- Snapshot store full: `snapshot store is full — prune or point --store
  elsewhere`, exit 3.

## Non-functional

- perf: a snapshot of an unchanged 10k-file tree completes in under 2s.
