---
title: Acknowledge an open incident
kind: user-facing
status: active
priority: p0
roles: [operator, admin]
claims:
  api-route: ["/api/incidents/[id]/ack"]
  convex-function: ["incidents.acknowledge"]
paths: ["convex/incidents.ts"]
nonFunctional: []
destructive: false
aliases: []
verify: e2e
---

## Story

As an operator, I can acknowledge an incident so that the rest of the team
knows someone has it and the escalation stops.

## Acceptance Criteria

- **AC1** Given an unacknowledged incident, When I acknowledge it, Then my name
  and the time are recorded and further escalation notifications stop.
- **AC2** Given an already-acknowledged incident, When I acknowledge it again,
  Then the first acknowledgement stands and the call still returns success.
- **AC3** Given I acknowledge from a notification link, When I am not signed in,
  Then I sign in and land back on the acknowledgement, which then applies.

## Edge Cases

- Acknowledging an incident that resolved moments earlier is recorded, so the
  timeline shows the race rather than hiding it.
- Two people acknowledging within the same second yields one acknowledgement
  and one recorded name.

## Error States

- Viewer role: `viewers cannot acknowledge incidents`, 403, no state change.
