---
title: Customise the status page's branding
kind: user-facing
status: active
priority: p2
roles: [admin]
claims:
  route: ["/dashboard/settings/status-page"]
  convex-function: ["statusPages.updateBranding"]
paths: ["src/app/dashboard/settings/status-page/page.tsx"]
nonFunctional: [a11y]
destructive: false
aliases: []
verify: e2e
---

## Story

As an admin, I can put our logo and colours on the status page so that it reads
as ours rather than as a third party's.

## Acceptance Criteria

- **AC1** Given a logo and an accent colour, When I save, Then the public page
  shows them within a minute and the preview matched what shipped.
- **AC2** Given an accent colour that fails contrast against the page
  background, When I save, Then I am warned and the page uses an adjusted tone
  for text while keeping mine for decoration.
- **AC3** Given I choose which monitors are public, When I save, Then private
  ones vanish from the public page and from its uptime figures.

## Edge Cases

- Removing the logo falls back to the workspace name as text, never to a broken
  image.
- Branding survives the workspace being renamed.

## Error States

- Upload larger than 1MB or not an image: rejected before save, with the
  previous logo left in place.

## Non-functional

- a11y: the rendered page meets WCAG AA contrast regardless of accent choice.
