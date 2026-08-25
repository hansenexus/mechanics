---
title: Pause and resume a monitor
kind: user-facing
status: active
priority: p1
roles: [operator, admin]
claims:
  route: ["/dashboard/monitors/[id]"]
  convex-function: ["monitors.pause"]
paths: ["convex/monitors.ts"]
nonFunctional: []
destructive: false
aliases: []
verify: e2e
---

## Story

As an operator, I can pause a monitor during planned maintenance so that a
deliberate outage does not page anyone or dent the published uptime figure.

## Acceptance Criteria

- **AC1** Given an active monitor, When I pause it, Then no further checks run
  and the public status page shows it as `under maintenance`.
- **AC2** Given a paused monitor, When I resume it, Then checks resume at the
  configured interval and the paused span is excluded from uptime.
- **AC3** Given a monitor with an open incident, When I pause it, Then the
  incident stays open and is not auto-resolved.

## Edge Cases

- Pausing every monitor leaves the status page published, reading
  `under maintenance` rather than blank.
- A pause that outlives the retention window still reports correct uptime,
  because paused spans are stored as spans and not inferred from gaps.

## Error States

- Pausing an already-paused monitor is a no-op that returns success, so a
  retried request cannot double-count the pause.
