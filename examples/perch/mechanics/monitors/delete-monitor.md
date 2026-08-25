---
title: Delete a monitor and its history
kind: user-facing
status: active
priority: p1
roles: [admin]
claims:
  api-route: ["/api/monitors/[id]"]
  convex-function: ["monitors.remove"]
paths: ["convex/monitors.ts"]
nonFunctional: []
destructive: true
aliases: []
verify: e2e
---

## Story

As an admin, I can delete a monitor so that a decommissioned service stops
being probed and stops appearing on the public page.

## Acceptance Criteria

- **AC1** Given a monitor with history, When I confirm deletion by typing its
  name, Then the monitor, its checks and its incidents are removed and the
  status page updates within a minute.
- **AC2** Given the confirmation text does not match, When I submit, Then
  nothing is deleted.
- **AC3** Given deletion succeeds, When I return to the monitor's URL, Then I
  get a 404 page, not an empty detail view.

## Edge Cases

- Deleting the last monitor unpublishes the status page rather than showing an
  empty one.
- A check in flight at deletion time is discarded rather than written back.

## Error States

- Insufficient role: `only admins can delete monitors`, 403, nothing removed.
