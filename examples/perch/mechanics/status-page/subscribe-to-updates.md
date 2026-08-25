---
title: Subscribe by email to a status page
kind: user-facing
status: active
priority: p1
roles: [public]
claims:
  route: ["/status/[slug]/subscribe"]
  api-route: ["/api/status/[slug]/subscribe"]
  convex-function: ["subscribers.subscribe"]
paths: ["src/app/status/[slug]/subscribe/page.tsx", "convex/subscribers.ts"]
nonFunctional: [security]
destructive: false
aliases: []
verify: e2e
---

## Story

As a customer, I can subscribe to a status page so that I am told about an
outage instead of having to keep checking.

## Acceptance Criteria

- **AC1** Given a valid email, When I subscribe, Then a confirmation email is
  sent and the subscription is `pending` until confirmed.
- **AC2** Given an email already subscribed and confirmed, When I subscribe
  again, Then the response is identical to a new subscription and no second
  confirmation is sent.
- **AC3** Given I subscribe, When the page renders the result, Then it never
  reveals whether that address was already subscribed.

## Edge Cases

- Subscribing while an incident is open sends the confirmation only; the
  current incident is included in the first update after confirmation.
- Plus-addressed and dot-variant addresses are treated as distinct.

## Error States

- Rate limit exceeded from one IP: `too many requests, try again shortly`,
  with no indication of which addresses were involved.

## Non-functional

- security: enumeration-safe by construction — the response does not vary on
  whether the address is known.
