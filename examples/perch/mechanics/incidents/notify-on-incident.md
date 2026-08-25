---
title: Notify the configured channels when an incident opens
kind: system
status: active
priority: p0
roles: [system]
claims:
  worker: ["src/workers/notifier.ts"]
paths: ["src/workers/notifier.ts"]
nonFunctional: [perf]
destructive: false
aliases: []
verify: agent
---

## Story

As the system, I deliver a notification the moment an incident opens so that
the team learns about an outage from Perch rather than from the status page.

## Acceptance Criteria

- **AC1** Given an incident opens, When notification runs, Then every enabled
  channel for that workspace receives one notification.
- **AC2** Given a channel fails, When it is retried, Then the other channels
  are not delayed and the failing one backs off exponentially.
- **AC3** Given an incident is acknowledged before the escalation delay, When
  the delay elapses, Then no escalation notification is sent.

## Edge Cases

- Several monitors failing inside one minute produce one grouped notification
  per channel, not one per monitor.
- A channel removed between opening and escalation is skipped silently.

## Error States

- Every channel failing is itself surfaced in the dashboard as `notifications
  are not being delivered` — silence must never be indistinguishable from
  health.

## Non-functional

- perf: first notification dispatched within 10s of the incident opening.
