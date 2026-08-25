---
title: See every monitor and its current state
kind: user-facing
status: active
priority: p0
roles: [operator, admin, viewer]
claims:
  route: ["/dashboard", "/dashboard/monitors"]
  api-route: ["/api/monitors"]
  convex-function: ["monitors.list"]
paths: ["src/app/dashboard/monitors/page.tsx"]
nonFunctional: [perf, a11y]
destructive: false
aliases: []
verify: e2e
---

## Story

As anyone on the team, I can see all monitors and their current state on one
screen so that "is anything broken right now?" takes one glance.

## Acceptance Criteria

- **AC1** Given monitors in several states, When I open the list, Then failing
  monitors sort above degraded, above healthy, above paused.
- **AC2** Given the list is open, When a monitor's state changes, Then the row
  updates without a reload.
- **AC3** Given more than 50 monitors, When I open the list, Then it paginates
  and the failing ones are still on the first page.
- **AC4** Given I filter by name, When I type, Then the filter applies to the
  whole workspace, not only the current page.

## Edge Cases

- A workspace with no monitors shows the create-monitor call to action, not an
  empty table.
- A monitor created seconds ago shows `pending`, distinct from `healthy`.

## Error States

- Backend unreachable: the last known states render greyed with `as of
  <time>`, rather than an empty list that reads as "all clear".

## Non-functional

- perf: first contentful paint under 1.5s at 200 monitors on a cold cache.
- a11y: state is conveyed by icon and text, never by colour alone.
