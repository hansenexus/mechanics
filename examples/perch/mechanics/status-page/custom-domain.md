---
title: Serve the status page from a customer domain
kind: user-facing
status: draft
priority: p2
roles: [admin]
claims: {}
paths: []
nonFunctional: [security]
destructive: false
aliases: []
---

## Story

As an admin, I can serve the status page from `status.ourcompany.com` so that
customers never see a third-party domain during an outage.

## Acceptance Criteria

- **AC1** Given a CNAME pointed at Perch, When I add the domain, Then a
  certificate is issued and the page serves over HTTPS within 10 minutes.
- **AC2** Given the CNAME is missing, When I add the domain, Then I see the
  exact record to create and the domain stays `pending`.
- **AC3** Given a custom domain is active, When someone opens the original
  `/status/<slug>` URL, Then they are redirected to the custom domain.

## Edge Cases

- A domain already claimed by another workspace is refused without revealing
  which workspace holds it.
- Removing the domain keeps the original URL working, so removal cannot take
  the page offline.

## Error States

- Certificate issuance failing: the domain stays `pending` with the ACME error
  shown, and the page keeps serving from the original URL.

## Non-functional

- security: certificates are per-domain and never shared between workspaces.

## Notes

Draft: written during design, before any surface exists. It carries no
`claims`, so it adds nothing to coverage — which is exactly right. A draft is a
decision recorded early, not a promise that code is there.
