---
title: View the thing
kind: user-facing
status: active
priority: p0
roles: [viewer]
claims:
  route:
    - "/thing"
  api-route:
    - "/api/ping"
  convex-function:
    - "things.list"
paths: ["apps/testapp/src/app/(dash)/thing/**"]
---

## Story

As a viewer, I can open the thing page and see the list of things, so that I
know what exists.

## Acceptance Criteria

- **AC1** Given I am signed in, When I open `/thing`, Then the thing list renders.
- **AC2** Given the API is up, When the page loads, Then `/api/ping` returns ok.

## Edge Cases

- Empty list renders an empty state, not a blank page.

## Error States

- Backend down shows a degraded banner.
