import { describe, expect, it } from "vitest";
import { parseMechanicFile, parseMechanicPath } from "./parser";

const GOOD = `---
title: Logs tab with level filtering
kind: user-facing
status: active
priority: p0
roles: [viewer, operator]
claims:
  route: ["/observe"]
---

## Story

As a viewer, I can filter logs.

## Acceptance Criteria

- **AC1** Given logs, When I filter, Then only matches remain.
- **AC2** Given nothing, When I load, Then an empty state shows.

## Edge Cases

- Empty result set shows an empty state.
- Very long lines scroll horizontally.

## Error States

- Backend down shows a degraded banner.

## Non-functional

- perf: renders under 1.5s.
`;

/** The monorepo shape: apps live under `apps/<slug>/`. */
const CTX = { appSlug: "console", mechanicsDir: "apps/console/mechanics" };
/** A single-app repo: the app IS the repo, so the tree is rooted at `mechanics`. */
const SOLO = { appSlug: "example", mechanicsDir: "mechanics" };

describe("parseMechanicPath", () => {
  it("derives app/area/slug from a valid path", () => {
    expect(parseMechanicPath("apps/console/mechanics/observe/logs-tab.md", CTX)).toEqual({
      appSlug: "console",
      area: "observe",
      slug: "logs-tab",
    });
  });

  it("derives the same shape in a single-app repo, where the slug is not on the path", () => {
    expect(parseMechanicPath("mechanics/backups/create-snapshot.md", SOLO)).toEqual({
      appSlug: "example",
      area: "backups",
      slug: "create-snapshot",
    });
  });

  it("rejects non-kebab segments and wrong shapes", () => {
    expect(parseMechanicPath("apps/console/mechanics/_system/x.md", CTX)).toBeNull();
    expect(parseMechanicPath("apps/console/mechanics/observe/Bad_Name.md", CTX)).toBeNull();
    expect(parseMechanicPath("apps/console/mechanics/observe/nested/x.md", CTX)).toBeNull();
    expect(parseMechanicPath("packages/x/mechanics/a/b.md", CTX)).toBeNull();
  });

  it("rejects a path outside this app's tree", () => {
    expect(parseMechanicPath("apps/other/mechanics/observe/logs-tab.md", CTX)).toBeNull();
    expect(parseMechanicPath("vendor/mechanics/backups/x.md", SOLO)).toBeNull();
  });
});

describe("parseMechanicFile", () => {
  it("parses a valid mechanic with derived ID and extracted criteria", () => {
    const { doc, errors } = parseMechanicFile(
      GOOD,
      "apps/console/mechanics/observe/logs-tab.md",
      CTX
    );
    expect(errors).toEqual([]);
    expect(doc).not.toBeNull();
    expect(doc?.id).toBe("console.observe.logs-tab");
    expect(doc?.criteria).toEqual(["AC1", "AC2"]);
    expect(doc?.edgeCaseCount).toBe(2);
    expect(doc?.errorStateCount).toBe(1);
    expect(doc?.frontmatter.destructive).toBe(false);
    expect(doc?.sections.Story).toContain("filter logs");
  });

  it("reports missing required sections", () => {
    const raw = GOOD.replace("## Error States\n\n- Backend down shows a degraded banner.\n", "");
    const { errors } = parseMechanicFile(raw, "apps/console/mechanics/observe/logs-tab.md", CTX);
    expect(errors.some((e) => e.includes('missing required section "## Error States"'))).toBe(true);
  });

  it("reports out-of-order sections", () => {
    const raw = GOOD.replace(
      /## Edge Cases\n\n- Empty result set shows an empty state\.\n- Very long lines scroll horizontally\.\n\n## Error States/,
      "## Error States\n\n- x.\n\n## Edge Cases"
    );
    const { errors } = parseMechanicFile(raw, "apps/console/mechanics/observe/logs-tab.md", CTX);
    expect(errors.some((e) => e.includes("sections out of order"))).toBe(true);
  });

  it("rejects duplicate and unlabeled acceptance criteria", () => {
    const raw = GOOD.replace(
      "- **AC2** Given nothing, When I load, Then an empty state shows.",
      "- **AC1** Given dupe, When x, Then y.\n- plain bullet without a label"
    );
    const { errors } = parseMechanicFile(raw, "apps/console/mechanics/observe/logs-tab.md", CTX);
    expect(errors.some((e) => e.includes("duplicate acceptance-criteria label AC1"))).toBe(true);
    expect(errors.some((e) => e.includes("without an AC label"))).toBe(true);
  });

  it("rejects unknown frontmatter keys (id/area/tests are derived, not declared)", () => {
    const raw = GOOD.replace("title:", "id: console.observe.logs-tab\ntitle:");
    const { doc, errors } = parseMechanicFile(
      raw,
      "apps/console/mechanics/observe/logs-tab.md",
      CTX
    );
    expect(doc).toBeNull();
    expect(errors.some((e) => e.includes("id"))).toBe(true);
  });

  it("rejects unknown sections", () => {
    const raw = `${GOOD}\n## Random Thoughts\n\n- nope\n`;
    const { errors } = parseMechanicFile(raw, "apps/console/mechanics/observe/logs-tab.md", CTX);
    expect(errors.some((e) => e.includes('unknown section "## Random Thoughts"'))).toBe(true);
  });
});
