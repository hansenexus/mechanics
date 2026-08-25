---
title: Resolve an incident by hand
kind: user-facing
status: active
priority: p1
roles: [operator, admin]
claims:
  convex-function: ["incidents.resolve"]
paths: ["convex/incidents.ts"]
nonFunctional: []
destructive: false
aliases: []
verify: manual-only
---

## Story

As an operator, I can close an incident myself so that a monitor which recovered
in a way Perch cannot observe does not leave a false alarm standing.

## Acceptance Criteria

- **AC1** Given an open incident, When I resolve it with a reason, Then it
  closes, the reason is on the timeline, and the public page updates.
- **AC2** Given I resolve while the monitor is still failing, When the next
  check fails, Then a NEW incident opens rather than the old one reopening.
- **AC3** Given the incident is already resolved, When I resolve it, Then
  nothing changes and no second resolution appears on the timeline.

## Edge Cases

- Resolving an incident on a paused monitor is allowed; pausing alone never
  resolves anything.

## Error States

- Missing reason: `a manual resolution needs a reason`, nothing closed. The
  reason is what makes the timeline readable six months later, so it is
  required rather than encouraged.
