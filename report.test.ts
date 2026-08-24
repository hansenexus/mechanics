/**
 * The report is a deliverable people read and hand to other people, so the
 * things worth pinning are the ones a wrong page would state confidently:
 * that a gap is visible, that "nothing to cover" does not look like full
 * coverage, and that author-controlled text cannot execute.
 */

import { describe, expect, it } from "vitest";
import { renderReport } from "./report";
import type { ManifestMechanic, MechanicsManifest, WaveFile } from "./types";

const OPTIONS = { generatedAt: "2026-08-12 10:00", revision: "abc1234" };

/** The single mechanic every fixture starts from. */
function mechanic(over: Partial<ManifestMechanic> = {}): ManifestMechanic {
  return {
    id: "example.backups.create-snapshot",
    title: "Create a snapshot",
    kind: "user-facing",
    area: "backups",
    status: "active",
    priority: "p0",
    roles: ["operator"],
    claims: { "cli-command": ["src/commands/backup.ts"] },
    paths: [],
    nonFunctional: [],
    destructive: false,
    criteria: ["AC1", "AC2"],
    edgeCaseCount: 1,
    errorStateCount: 1,
    tests: [{ spec: "e2e/backup.spec.ts", runner: "bun-script", via: "annotation" }],
    source: "mechanics/backups/create-snapshot.md",
    aliases: [],
    ...over,
  };
}

function manifest(over: Partial<MechanicsManifest> = {}): MechanicsManifest {
  return {
    schemaVersion: 2,
    appSlug: "example",
    mechanicCount: 1,
    surfaces: [{ kind: "cli-command", label: "CLI command" }],
    areas: [{ slug: "backups", title: "Backups", order: 1, mechanicCount: 1 }],
    mechanics: [mechanic()],
    coverage: {
      "cli-command": { total: 4, claimed: 2, ignored: 1, unclaimed: ["src/commands/status.ts"] },
    },
    testCoverage: { withTests: 1, manualOnly: 0, untested: 0 },
    ...over,
  };
}

const WAVE: WaveFile = {
  wave: "2026-01-baseline",
  title: "Baseline",
  status: "open",
  startedAt: "2026-01-05",
  scope: { areas: [], kinds: [], ids: [], exclude: [] },
  links: { previewCategoryIds: [], previewDecisions: [] },
  verifications: [
    {
      mechanic: "example.backups.create-snapshot",
      status: "fail",
      method: "e2e",
      failedCriteria: ["AC2"],
    },
  ],
};

describe("renderReport", () => {
  it("is one self-contained file — no external request of any kind", () => {
    const html = renderReport([{ manifest: manifest(), waves: [WAVE] }], OPTIONS);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    // A page that needs a CDN cannot be opened from file:// or on a locked-down
    // machine, which is most of the point of shipping a file rather than a URL.
    expect(html).not.toMatch(/<(script|link|img)[^>]+(src|href)=["']?(https?:)?\/\//);
  });

  it("names the unclaimed items, not just how many there are", () => {
    const html = renderReport([{ manifest: manifest(), waves: [] }], OPTIONS);
    expect(html).toContain("1 unclaimed CLI command");
    expect(html).toContain("src/commands/status.ts");
  });

  it("labels the bar as covered, since it counts ignored items the number does not", () => {
    const html = renderReport([{ manifest: manifest(), waves: [] }], OPTIONS);
    // 2 claimed + 1 ignored of 4. The column says 2/4; without the label the
    // 3/4 bar beside it reads as a bug.
    expect(html).toContain(">2/4<");
    expect(html).toContain('aria-label="3 of 4 covered"');
  });

  it("renders an empty surface as empty, not as fully covered", () => {
    const html = renderReport(
      [
        {
          manifest: manifest({
            surfaces: [{ kind: "cron", label: "cron" }],
            coverage: { cron: { total: 0, claimed: 0, ignored: 0, unclaimed: [] } },
          }),
          waves: [],
        },
      ],
      OPTIONS
    );
    expect(html).toContain('class="bar empty"');
    expect(html).not.toContain('style="width:100%"');
  });

  it("breaks out which mechanics are failing, not just the count", () => {
    const html = renderReport([{ manifest: manifest(), waves: [WAVE] }], OPTIONS);
    expect(html).toContain("2026-01-baseline");
    expect(html).toContain("failing:");
    expect(html).toContain("example.backups.create-snapshot");
  });

  it("says so plainly when there is no wave rather than omitting the section", () => {
    const html = renderReport([{ manifest: manifest(), waves: [] }], OPTIONS);
    expect(html).toContain("No verification wave has been opened");
  });

  it("says what to run when nothing is onboarded", () => {
    const html = renderReport([], OPTIONS);
    expect(html).toContain("mechanics build --all");
  });

  it("escapes author-controlled text — a title is not markup", () => {
    const evil = manifest({
      mechanics: [mechanic({ title: '<img src=x onerror="alert(1)">' })],
    });
    const html = renderReport([{ manifest: evil, waves: [] }], OPTIONS);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  it("flags destructive and non-active mechanics, which read differently", () => {
    const flagged = manifest({
      mechanics: [mechanic({ destructive: true, status: "draft", tests: [] })],
    });
    const html = renderReport([{ manifest: flagged, waves: [] }], OPTIONS);
    expect(html).toContain("destructive");
    expect(html).toContain(">draft<");
    expect(html).toContain(">none<");
  });
});
