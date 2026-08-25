---
title: Prune check results past the retention window
kind: system
status: active
priority: p2
roles: [system]
claims:
  cron: ["prune old check results"]
paths: ["convex/crons.ts"]
nonFunctional: [perf]
destructive: true
aliases: []
verify: agent
---

## Story

As the system, I delete raw check results older than the workspace's retention
window so that storage tracks the plan rather than growing without limit.

## Acceptance Criteria

- **AC1** Given results older than the window, When the cron fires, Then they
  are deleted and the precomputed uptime rollups are kept.
- **AC2** Given a result inside an incident's window, When pruning runs, Then it
  is retained regardless of age, because it is the incident's evidence.
- **AC3** Given the run is interrupted, When it next fires, Then it resumes
  rather than restarting from the oldest row.

## Edge Cases

- Lowering a workspace's retention takes effect on the next run, not
  retroactively at the moment of change.
- A workspace with no results older than the window is a no-op.

## Error States

- Pruning failing for one workspace leaves that workspace's data intact and
  does not block the others.

## Non-functional

- perf: pruning runs in bounded batches and never holds a transaction across
  more than 1000 rows.
