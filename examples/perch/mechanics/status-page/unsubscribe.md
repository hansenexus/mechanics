---
title: Unsubscribe from a status page
kind: user-facing
status: active
priority: p1
roles: [public]
claims:
  http-endpoint: ["/unsubscribe"]
  convex-function: ["subscribers.unsubscribe"]
paths: ["convex/http.ts", "convex/subscribers.ts"]
nonFunctional: [security]
destructive: true
aliases: []
verify: e2e
---

## Story

As a subscriber, I can unsubscribe in one click from any email so that leaving
is as easy as joining.

## Acceptance Criteria

- **AC1** Given the unsubscribe link in any email, When I follow it, Then I am
  unsubscribed immediately, with no confirmation step and no sign-in.
- **AC2** Given I am already unsubscribed, When I follow the link again, Then I
  see the same confirmation.
- **AC3** Given a `List-Unsubscribe-Post` request from a mail client, When it
  arrives, Then it unsubscribes without a browser ever being opened.

## Edge Cases

- Unsubscribing removes the address from that status page only, never from
  others the same address follows.
- A link in an email older than the retention window still works; unsubscribe
  tokens do not expire.

## Error States

- Unknown token: the page still reads as a successful unsubscribe. Anything
  else would let the endpoint confirm which addresses are subscribed.
