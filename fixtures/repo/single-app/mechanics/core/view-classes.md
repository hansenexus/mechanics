---
title: View my classes
kind: user-facing
priority: p0
roles: [teacher]
verify: manual-only
claims:
  route:
    - "/classes"
  api-route:
    - "/api/health"
  convex-function:
    - "modules/x/y.get"
---

## Story

As a teacher, I can open my classes and see them listed, so that I know
which classes exist in my space.

## Acceptance Criteria

- **AC1** Given I am signed in, When I open `/classes`, Then my classes render.

## Edge Cases

- No classes yet renders an empty state.

## Error States

- Backend down shows a degraded banner.
