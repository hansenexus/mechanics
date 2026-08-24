---
title: Prune snapshots past the retention window
kind: system
status: active
priority: p1
roles: [system]
claims:
  scheduled-job: ["src/jobs/prune-snapshots.ts"]
paths: ["src/jobs/prune-snapshots.ts"]
nonFunctional: []
destructive: true
aliases: []
verify: agent
---

## Story

As the system, I delete snapshots older than the retention window so that the
store does not grow without bound.

## Acceptance Criteria

- **AC1** Given snapshots older than the retention window, When the job runs,
  Then those snapshots are deleted and each deletion is logged with its id.
- **AC2** Given a snapshot that is the only one for its tag, When the job runs,
  Then it is kept regardless of age — a tag never loses its last snapshot.
- **AC3** Given `DRY_RUN=1`, When the job runs, Then it logs what it would
  delete and deletes nothing.

## Edge Cases

- A store with no snapshots older than the window is a no-op that still exits 0.
- Two snapshots with identical timestamps are ordered by id, so the run is
  deterministic.

## Error States

- Store unreadable: the job exits non-zero and deletes nothing — a partial
  prune is worse than a skipped one.
