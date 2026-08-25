---
title: Send a daily digest of yesterday
kind: system
status: active
priority: p2
roles: [system]
claims:
  cron: ["send daily digest"]
paths: ["convex/crons.ts"]
nonFunctional: []
destructive: false
aliases: []
verify: agent
---

## Story

As the system, I send a daily summary so that a team which had a quiet night
still sees the slow degradations that never opened an incident.

## Acceptance Criteria

- **AC1** Given a workspace with digests enabled, When the cron fires, Then one
  email lists yesterday's incidents, uptime per monitor, and the slowest
  responders.
- **AC2** Given a workspace with no activity, When the cron fires, Then the
  digest is skipped rather than sent empty.
- **AC3** Given the cron is retried after a partial failure, When it reruns,
  Then workspaces already sent are not sent twice.

## Edge Cases

- A workspace created yesterday gets a digest covering its partial first day.
- Digest windows follow the workspace timezone, not UTC.

## Error States

- Digest generation failing for one workspace does not stop the rest of the
  run, and the failure is logged against that workspace.
