---
title: View a workspace's public status page
kind: user-facing
status: active
priority: p0
roles: [public]
claims:
  route: ["/status/[slug]"]
  convex-function: ["statusPages.get"]
paths: ["src/app/status/[slug]/page.tsx"]
nonFunctional: [perf, a11y]
destructive: false
aliases: []
verify: e2e
---

## Story

As a customer of a Perch user, I can open their status page and see whether the
thing I am trying to use is working, without an account.

## Acceptance Criteria

- **AC1** Given a published status page, When I open it, Then I see each public
  monitor's current state and 90 days of uptime, with no sign-in.
- **AC2** Given an open incident, When I open the page, Then the incident and
  its updates are above the monitor list, newest update first.
- **AC3** Given a monitor is paused, When the page renders, Then it reads
  `under maintenance` and is excluded from the uptime figure.
- **AC4** Given the page is open, When state changes, Then it updates within
  60s without a reload.

## Edge Cases

- A workspace with every monitor private renders the page with an explanatory
  line, rather than 404ing and implying the company does not exist.
- An unpublished slug 404s identically to an unknown one, so the page cannot be
  used to probe which workspaces exist.

## Error States

- Backend unreachable: a cached copy is served with `as of <time>`. A status
  page that is itself down is the worst possible failure, so it degrades to
  stale rather than to an error.

## Non-functional

- perf: served from cache; a cold request completes in under 500ms at p95.
- a11y: state is text plus icon, and the uptime bars have accessible labels.
