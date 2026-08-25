---
title: Inspect one monitor's history and uptime
kind: user-facing
status: active
priority: p1
roles: [operator, admin, viewer]
claims:
  route: ["/dashboard/monitors/[id]"]
  api-route: ["/api/monitors/[id]"]
  convex-function: ["monitors.get"]
paths: ["src/app/dashboard/monitors/[id]/page.tsx"]
nonFunctional: [perf]
destructive: false
aliases: []
verify: e2e
---

## Story

As an operator, I can open one monitor and see what it has been doing so that I
can tell a blip apart from a pattern.

## Acceptance Criteria

- **AC1** Given a monitor with check history, When I open it, Then I see uptime
  over 24h, 7d and 30d, and a timeline of the last 100 checks.
- **AC2** Given a failing check in the timeline, When I select it, Then I see
  its status code, response time and the first 2KB of the response body.
- **AC3** Given a paused span in the window, When uptime is computed, Then the
  paused span is excluded from both numerator and denominator.

## Edge Cases

- A monitor younger than the window reports uptime over its actual lifetime and
  labels it as such.
- A monitor with no checks yet shows the timeline scaffold, not a spinner that
  never resolves.

## Error States

- History partially pruned: the timeline starts at the oldest retained check
  and says so, rather than implying the monitor did not exist before then.

## Non-functional

- perf: the 30d uptime figure is precomputed; the page never aggregates raw
  check rows at request time.
