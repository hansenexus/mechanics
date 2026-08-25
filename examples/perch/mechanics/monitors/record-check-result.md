---
title: Record the outcome of a probe
kind: system
status: active
priority: p0
roles: [system]
claims:
  convex-function: ["checks.recordResult"]
paths: ["convex/checks.ts"]
nonFunctional: []
destructive: false
aliases: []
verify: agent
---

## Story

As the system, I write every probe outcome down so that uptime, timelines and
incident detection all read from one record rather than three.

## Acceptance Criteria

- **AC1** Given a probe result, When it is recorded, Then the monitor's current
  state is recomputed in the same transaction.
- **AC2** Given the result is the second consecutive failure, When it is
  recorded, Then an incident opens.
- **AC3** Given the result is the first success after a failure run, When it is
  recorded, Then any open incident for that monitor is resolved.
- **AC4** Given a duplicate result for a probe already recorded, When it
  arrives, Then it is ignored and the response is still success.

## Edge Cases

- A result for a monitor deleted mid-probe is discarded without error.
- A result older than the monitor's last recorded check is stored in order but
  does not move the current state backwards.

## Error States

- Malformed payload: rejected with `invalid probe result`, and the probe is
  retried once before being recorded as an infrastructure failure — which is
  reported separately from an endpoint failure, so a Perch outage never shows
  up as a customer outage.
