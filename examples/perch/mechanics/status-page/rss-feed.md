---
title: Follow a status page by RSS
kind: user-facing
status: deprecated
priority: p2
roles: [public]
claims: {}
paths: []
nonFunctional: []
destructive: false
aliases: []
---

## Story

As a customer, I could subscribe to a status page's incidents with a feed
reader instead of by email.

## Acceptance Criteria

- **AC1** Given a published status page, When I fetch `/status/<slug>/feed.xml`,
  Then I get the last 50 incidents as Atom.
- **AC2** Given an incident is updated, When the feed is refetched, Then the
  entry's `updated` timestamp changes and its content is replaced.

## Edge Cases

- A private monitor's incidents never appeared in the feed.

## Error States

- An unpublished page returned 404, matching the HTML page's behaviour.

## Notes

Deprecated 2026-06: the endpoint was removed after two quarters at under 40
requests a week across all workspaces. The mechanic stays because deleting it
would lose the answer to "did Perch ever have a feed, and why doesn't it now?"
— which is the question that otherwise gets re-litigated every year. It claims
nothing, so it is out of coverage and out of every wave's scope.
