---
title: Confirm an email subscription
kind: user-facing
status: active
priority: p1
roles: [public]
claims:
  convex-function: ["subscribers.confirm"]
paths: ["convex/subscribers.ts"]
nonFunctional: [security]
destructive: false
aliases: []
verify: e2e
---

## Story

As a customer, I confirm my subscription from the email so that nobody can
subscribe my address without me.

## Acceptance Criteria

- **AC1** Given a valid confirmation token, When I follow the link, Then the
  subscription becomes `confirmed` and I see which page I subscribed to.
- **AC2** Given a token already used, When I follow it again, Then I see the
  same confirmation rather than an error.
- **AC3** Given a token older than 7 days, When I follow it, Then it is refused
  and I am offered a fresh confirmation email.

## Edge Cases

- Confirming after the status page has been unpublished succeeds and says the
  page is not currently public.

## Error States

- Malformed or unknown token: `this confirmation link is not valid`, with no
  detail distinguishing "expired" from "never existed".

## Non-functional

- security: tokens are single-purpose, random, and never derived from the email
  address.
