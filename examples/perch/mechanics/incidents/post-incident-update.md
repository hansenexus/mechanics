---
title: Post an update to an incident
kind: user-facing
status: active
priority: p1
roles: [operator, admin]
claims:
  convex-function: ["incidents.addUpdate"]
paths: ["convex/incidents.ts"]
nonFunctional: [i18n]
destructive: false
aliases: []
verify: e2e
---

## Story

As an operator, I can post an update to an incident so that everyone watching
the public page learns what is happening without asking.

## Acceptance Criteria

- **AC1** Given an open incident, When I post an update, Then it appears on the
  public status page and is sent to confirmed subscribers.
- **AC2** Given I mark an update as internal, When it is posted, Then it appears
  on the incident timeline and NOT on the public page or in any email.
- **AC3** Given I edit an update within 5 minutes, When I save, Then the public
  page shows the edit and no second email goes out.

## Edge Cases

- An update posted to an already-resolved incident is allowed and delivered —
  a postmortem link is the most common one.
- An update longer than the email template's limit is truncated in the email
  with a link, and shown in full on the page.

## Error States

- Delivery to some subscribers fails: the update still posts, and the failures
  are retried separately. Publishing is never blocked on email.

## Non-functional

- i18n: updates are stored and delivered as written; no locale is inferred.
