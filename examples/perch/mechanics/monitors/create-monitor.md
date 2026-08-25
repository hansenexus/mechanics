---
title: Create a monitor for an endpoint
kind: user-facing
status: active
priority: p0
roles: [operator, admin]
claims:
  route: ["/dashboard/monitors/new"]
  api-route: ["/api/monitors"]
  convex-function: ["monitors.create"]
paths: ["src/app/dashboard/monitors/new/page.tsx", "convex/monitors.ts"]
nonFunctional: [a11y]
destructive: false
aliases: []
verify: e2e
---

## Story

As an operator, I can point Perch at a URL and say how often to check it, so
that I hear about an outage from Perch rather than from a customer.

## Acceptance Criteria

- **AC1** Given a valid HTTPS URL and an interval, When I submit the form, Then
  the monitor appears in the list with status `pending` and its first check is
  scheduled within one interval.
- **AC2** Given a URL that is already monitored in this workspace, When I
  submit, Then the form rejects it and links to the existing monitor.
- **AC3** Given an interval below the workspace's plan minimum, When I submit,
  Then the field shows the minimum allowed and the monitor is not created.
- **AC4** Given the form has unsaved changes, When I navigate away, Then I am
  asked to confirm.

## Edge Cases

- A URL with a non-standard port is accepted and probed on that port.
- A URL that redirects is monitored at the URL given, not at its destination.
- Creating the workspace's first monitor also publishes its status page.

## Error States

- Unreachable at creation time: the monitor is still created, marked `down`,
  and an incident opens on the second consecutive failure, not the first.
- Plan monitor limit reached: `this workspace is limited to N monitors`, with
  a link to billing. Nothing is created.

## Non-functional

- a11y: every field has a persistent label; validation errors are announced.
