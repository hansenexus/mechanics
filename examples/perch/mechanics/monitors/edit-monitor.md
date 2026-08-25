---
title: Change a monitor's URL, interval or name
kind: user-facing
status: active
priority: p1
roles: [operator, admin]
claims:
  route: ["/dashboard/monitors/[id]"]
  api-route: ["/api/monitors/[id]"]
  convex-function: ["monitors.update"]
paths: ["convex/monitors.ts"]
nonFunctional: []
destructive: false
aliases: []
verify: e2e
---

## Story

As an operator, I can edit a monitor in place so that a moved endpoint or a
changed SLA does not force me to lose its history.

## Acceptance Criteria

- **AC1** Given an existing monitor, When I change its URL and save, Then
  subsequent checks probe the new URL and the existing check history is kept.
- **AC2** Given I shorten the interval, When I save, Then the next check is
  scheduled from now, not from the last check.
- **AC3** Given I change only the display name, When I save, Then no check is
  rescheduled and the public status page shows the new name within a minute.

## Edge Cases

- Editing a paused monitor saves the change without resuming it.
- An edit that lands while a check is in flight lets that check finish and
  records it against the old URL.

## Error States

- Concurrent edit by another member: `this monitor changed while you were
  editing`, showing both versions. Nothing is overwritten silently.
