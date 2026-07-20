# mechanics

Full-spec behavior documentation for apps — user stories with acceptance
criteria that are machine-compiled, coverage-audited against your real code
surface, linked to e2e tests, and verified per redesign "wave". Built so a
design-system migration or rewrite can answer *"did we keep every behavior?"*
with evidence instead of vibes.

> **Status: pre-release.** The system is live inside the hansenexus monorepo
> (reference implementation); extraction into this standalone repo is in
> progress. No license has been chosen yet — all rights reserved until the
> first tagged release.

## What v1 will ship

- `@hansenexus/mechanics` — core library + CLI (`check` · `build --check`
  drift gate · `coverage` · `verify` · `scaffold` · `impact` · `report --html`)
- **Surface adapters** — pluggable code-inventory sources (`nextjs-app-router`,
  `convex`, `generic-glob`; bring your own) so any stack can be covered
- **MCP server** — `bunx @hansenexus/mechanics mcp` gives coding agents
  `mechanics_list / get / coverage / wave_status / impact` (+ opt-in record)
- **Claude Code skills** — `/mechanics-init`, `/mechanics-verify`,
  `/mechanics-gaps`, usable standalone or as a plugin
- **Forkable template** — GitHub template scaffold with CI gates and a
  `template-sync` workflow; your customization lives in `mechanics.config.ts`
  + local adapters, so upstream updates merge cleanly

## The model in one breath

One markdown file per mechanic (`apps/<app>/mechanics/<area>/<slug>.md`):
YAML frontmatter for machine fields (kind, roles, claimed surfaces, code
paths, `destructive` flag) + fixed prose sections (Story, labeled
Given/When/Then Acceptance Criteria, Edge Cases, Error States). IDs derive
from the path. A byte-stable committed manifest powers drift gates and
dashboards; hand-editable wave YAML records per-mechanic verification
(pass/fail + method + evidence) during a migration. Format without a gate
rots — the gate ships first.
