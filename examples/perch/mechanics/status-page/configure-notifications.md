---
title: Choose where alerts are delivered
kind: user-facing
status: active
priority: p1
roles: [admin]
claims:
  route: ["/dashboard/settings/notifications"]
paths: ["src/app/dashboard/settings/notifications/page.tsx"]
nonFunctional: []
destructive: false
aliases: []
verify: e2e
---

## Story

As an admin, I can choose which channels get alerted and how soon they
escalate, so that alerts land where the on-call person actually looks.

## Acceptance Criteria

- **AC1** Given I add a channel, When I save, Then a test notification is sent
  and the channel stays disabled until that test is confirmed delivered.
- **AC2** Given an escalation delay, When an incident goes unacknowledged for
  that long, Then the next channel in the chain is notified.
- **AC3** Given I disable every channel, When I save, Then I am warned that
  incidents will open silently, and must confirm.

## Edge Cases

- A channel that stops accepting deliveries is auto-disabled after 24h of
  failures and surfaced in the dashboard.
- Reordering the escalation chain during an open incident applies to the next
  escalation, not retroactively.

## Error States

- Test notification failing: the channel is saved as disabled with the provider
  error shown verbatim, because the provider's message is usually the fix.
