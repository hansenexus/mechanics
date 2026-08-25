---
title: Accept results from an out-of-region probe
kind: system
status: active
priority: p1
roles: [system]
claims:
  http-endpoint: ["/probe-callback"]
paths: ["convex/http.ts"]
nonFunctional: [security]
destructive: false
aliases: []
verify: agent
---

## Story

As the system, I accept signed results from probes running outside the primary
region so that a monitor can be checked from where its users actually are.

## Acceptance Criteria

- **AC1** Given a correctly signed payload, When it arrives, Then the result is
  recorded against the named monitor and region.
- **AC2** Given an invalid or missing signature, When it arrives, Then it is
  rejected with 401 and nothing is recorded.
- **AC3** Given a payload whose timestamp is more than 5 minutes old, When it
  arrives, Then it is rejected as stale.

## Edge Cases

- Results from two regions for the same due check are both recorded; the
  monitor is failing only if every region failed.
- An unknown region name is accepted and stored, so adding a region does not
  require a deploy of this endpoint.

## Error States

- Unknown monitor id: 404 with no detail about whether the id exists in another
  workspace.

## Non-functional

- security: signatures are HMAC over the raw body with a per-region key;
  comparison is constant-time.
