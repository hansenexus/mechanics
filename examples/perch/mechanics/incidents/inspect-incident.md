---
title: Read one incident's timeline
kind: user-facing
status: active
priority: p1
roles: [operator, admin, viewer]
claims:
  route: ["/dashboard/incidents/[id]"]
paths: ["src/app/dashboard/incidents/[id]/page.tsx"]
nonFunctional: []
destructive: false
aliases: []
verify: e2e
---

## Story

As an operator, I can read the whole story of one incident in order so that a
postmortem does not mean reconstructing it from three tools.

## Acceptance Criteria

- **AC1** Given an incident, When I open it, Then I see, in time order: the
  failing checks that opened it, every acknowledgement, every posted update,
  and the check that resolved it.
- **AC2** Given the incident is open, When a new event occurs, Then it appends
  without a reload.
- **AC3** Given the incident is resolved, When I open it, Then its total
  duration and time-to-acknowledge are shown.

## Edge Cases

- An incident on a since-deleted monitor still renders, naming the monitor as
  it was.
- Two events with the same timestamp are ordered by insertion, never randomly.

## Error States

- Unknown incident id: a 404 page offering the incident list, not a blank
  timeline.
