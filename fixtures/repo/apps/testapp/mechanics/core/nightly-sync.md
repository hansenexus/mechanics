---
title: Nightly sync cron refreshes things
kind: system
status: draft
priority: p1
roles: [anonymous]
claims:
  convex-function:
    - "things.sync"
  cron:
    - "nightly-sync"
destructive: true
verify: manual-only
aliases: [testapp.core.old-sync]
---

## Story

As the system, I refresh the things table every night, so that stale entries
disappear without operator action.

## Acceptance Criteria

- **AC1** Given the cron fired, When I inspect the things table, Then `syncedAt` is under 24h old.

## Edge Cases

- Upstream empty response leaves the previous data untouched.

## Error States

- Upstream 500 logs one error row and retries next night.
