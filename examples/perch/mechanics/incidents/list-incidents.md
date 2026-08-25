---
title: See open and recent incidents
kind: user-facing
status: active
priority: p0
roles: [operator, admin, viewer]
claims:
  route: ["/dashboard/incidents"]
  convex-function: ["incidents.list"]
paths: ["src/app/dashboard/incidents/page.tsx"]
nonFunctional: []
destructive: false
aliases: []
verify: e2e
---

## Story

As anyone on the team, I can see which incidents are open and which closed
recently, so that a handover does not depend on who was awake.

## Acceptance Criteria

- **AC1** Given open and resolved incidents, When I open the list, Then open
  ones sort first, newest within each group.
- **AC2** Given an unacknowledged open incident, When the list renders, Then it
  is visually distinct from an acknowledged one.
- **AC3** Given I filter to one monitor, When the filter applies, Then resolved
  incidents for that monitor are included.

## Edge Cases

- An incident that opened and resolved inside one check interval still appears,
  with a duration rather than a dash.
- A workspace that has never had an incident shows a first-run message, not an
  empty table.

## Error States

- Backend unreachable: the list renders from cache with an `as of <time>`
  banner, because a blank incident list reads as "nothing is wrong".
