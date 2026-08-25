/**
 * Template smoke: instantiate `template/` into a temp dir and drive the whole
 * stack against it.
 *
 * This is the only test that answers the question the extraction exists to
 * answer — *does mechanics work outside this monorepo?* — and it can only
 * answer it by running the real CLI as a subprocess from a directory that has
 * never heard of the source monorepo. Importing the modules would resolve the repo
 * root from this file's location and prove nothing.
 *
 * The template is deliberately a single-app repo shipping CLI commands and a
 * job: no routes, no Convex, so `generic-glob` carries the entire inventory
 * and every layout assumption that is still hardcoded shows up as a failure
 * here rather than in someone else's repo.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(HERE, "template");
const CLI = path.join(HERE, "cli.ts");

let repo: string;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the CLI as a user would: a `bun` subprocess, cwd inside the temp repo. */
function mechanics(args: string[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [CLI, ...args], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

beforeAll(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "mechanics-template-"));
  await fs.cp(TEMPLATE, repo, { recursive: true });
}, 30_000);

afterAll(async () => {
  if (repo) await fs.rm(repo, { recursive: true, force: true });
});

describe("template", () => {
  it("is a repo root: the config is what marks it, not the package location", async () => {
    await expect(fs.stat(path.join(repo, "mechanics.config.yaml"))).resolves.toBeTruthy();
    expect(repo.startsWith(HERE)).toBe(false);
  });

  it("checks clean out of the box", async () => {
    const { code, stdout, stderr } = await mechanics(["check", "--app=example"]);
    expect(`${stdout}${stderr}`).toContain("4 mechanics ok");
    expect(code).toBe(0);
  });

  it("ships a manifest that matches its tree", async () => {
    const { code, stdout } = await mechanics(["build", "--all", "--check"]);
    expect(stdout).toContain("up to date");
    expect(code).toBe(0);
  });

  it("builds a byte-identical manifest, so a fork starts on a green drift gate", async () => {
    const file = path.join(repo, ".mechanics", "manifests", "example.mechanics.json");
    const before = await fs.readFile(file, "utf8");
    const { code } = await mechanics(["build", "--app=example"]);
    expect(code).toBe(0);
    expect(await fs.readFile(file, "utf8")).toBe(before);
  });

  it("reports coverage per declared kind, honouring the ignore glob", async () => {
    const { code, stdout } = await mechanics(["coverage", "--app=example"]);
    expect(code).toBe(0);
    // 4 commands, 3 claimed, `_debug.ts` excused by the ignore glob — so the
    // kind is fully COVERED at 100% while the ratio still reads 3/4. Those two
    // disagreeing is the point: the ratio counts claims, the bar counts claims
    // plus the surfaces an ignore glob has excused.
    expect(stdout).toMatch(/cli-command\s+3\/4\s+[━─]+\s+100%\s+1 ignored/);
    expect(stdout).toMatch(/scheduled-job\s+1\/1\s+[━─]+\s+100%/);
    // No gap lines: every unignored surface is claimed.
    expect(stdout).not.toContain("⚠");
    expect(stdout).toContain("2026-01-baseline");
  });

  it("drops the app prefix from every path in a single-app repo", async () => {
    const raw = await fs.readFile(
      path.join(repo, ".mechanics", "manifests", "example.mechanics.json"),
      "utf8"
    );
    const manifest = JSON.parse(raw) as {
      appSlug: string;
      surfaces: Array<{ kind: string }>;
      mechanics: Array<{ id: string; source: string; tests: Array<{ spec: string }> }>;
    };
    expect(manifest.appSlug).toBe("example");
    expect(manifest.surfaces.map((s) => s.kind)).toEqual(["cli-command", "scheduled-job"]);
    // IDs still carry the app segment — they are the stable handle regardless
    // of layout — but paths lose the `apps/<slug>/` prefix that does not exist.
    const doc = manifest.mechanics.find((m) => m.id === "example.backups.create-snapshot");
    expect(doc?.source).toBe("mechanics/backups/create-snapshot.md");
    expect(doc?.tests.map((t) => t.spec)).toEqual(["e2e/backup.spec.ts"]);
  });

  it("writes a self-contained report naming the template's own kinds", async () => {
    const { code } = await mechanics(["report", "--html", "--out=report.html"]);
    expect(code).toBe(0);
    const html = await fs.readFile(path.join(repo, "report.html"), "utf8");
    expect(html).toContain("cli-command");
    expect(html).toContain("scheduled-job");
    expect(html).toContain("2026-01-baseline");
    // The one failing verdict in the shipped wave has to be visible, not
    // averaged away into a ratio.
    expect(html).toContain("example.backups.inspect-status");
    expect(html).not.toMatch(/<(script|link|img)[^>]+(src|href)=["']?(https?:)?\/\//);
  });

  it("fails loudly on an unknown surface kind, naming the kinds this app has", async () => {
    const file = path.join(repo, "mechanics", "backups", "create-snapshot.md");
    const original = await fs.readFile(file, "utf8");
    await fs.writeFile(file, original.replace("  cli-command:", "  http-route:"), "utf8");
    try {
      const { code, stdout, stderr } = await mechanics(["check", "--app=example"]);
      const out = `${stdout}${stderr}`;
      expect(out).toContain('unknown surface kind "http-route"');
      expect(out).toContain("cli-command, scheduled-job");
      expect(code).toBe(1);
    } finally {
      await fs.writeFile(file, original, "utf8");
    }
  });
});

describe("template over MCP", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ name: "template-smoke", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({ command: "bun", args: [CLI, "mcp"], cwd: repo })
    );
  }, 30_000);

  afterAll(async () => {
    await client?.close();
  });

  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    const first = (res.content as Array<{ type: string; text?: string }>)[0];
    return { isError: res.isError === true, text: first?.text ?? "" };
  };

  it("serves the temp repo, not the repo the package lives in", async () => {
    const { text } = await call("mechanics_list", { app: "example" });
    const ids = (JSON.parse(text) as { mechanics: Array<{ id: string }> }).mechanics.map(
      (m) => m.id
    );
    expect(ids).toEqual([
      "example.backups.create-snapshot",
      "example.backups.inspect-status",
      "example.backups.restore-snapshot",
      "example.maintenance.prune-old-snapshots",
    ]);
  });

  it("returns one mechanic in full, body sections included", async () => {
    const { text } = await call("mechanics_get", {
      app: "example",
      id: "example.backups.create-snapshot",
    });
    const doc = JSON.parse(text) as {
      criteria: string[];
      source: string;
      sections: Record<string, string> | null;
    };
    expect(doc.criteria).toEqual(["AC1", "AC2", "AC3"]);
    expect(doc.source).toBe("mechanics/backups/create-snapshot.md");
    // The body is the point of `get`: an agent needs the ACs, not a summary.
    expect(Object.keys(doc.sections ?? {})).toContain("Acceptance Criteria");
  });

  it("reports coverage over config-declared kinds", async () => {
    const { text } = await call("mechanics_coverage", { app: "example" });
    const res = JSON.parse(text) as {
      surfaces: Array<{ kind: string; claimed: number; total: number; ignored: number }>;
    };
    expect(res.surfaces).toEqual([
      expect.objectContaining({ kind: "cli-command", claimed: 3, total: 4, ignored: 1 }),
      expect.objectContaining({ kind: "scheduled-job", claimed: 1, total: 1, ignored: 0 }),
    ]);
  });

  it("rolls up the wave with failures broken out", async () => {
    const { text } = await call("mechanics_wave_status", { app: "example" });
    const wave = (
      JSON.parse(text) as {
        waves: Array<{ slug: string; scopeSize: number; verifiedRatio: number; failing: string[] }>;
      }
    ).waves[0];
    expect(wave?.slug).toBe("2026-01-baseline");
    expect(wave?.scopeSize).toBe(4);
    // A ratio, not a percentage — one pass of four in scope.
    expect(wave?.verifiedRatio).toBeCloseTo(0.25);
    expect(wave?.failing).toEqual(["example.backups.inspect-status"]);
  });

  it("maps a changed file to the mechanic documenting it", async () => {
    const { text } = await call("mechanics_impact", {
      app: "example",
      files: ["src/jobs/prune-snapshots.ts"],
    });
    const res = JSON.parse(text) as { hits: Array<{ id: string }> };
    expect(res.hits.map((h) => h.id)).toEqual(["example.maintenance.prune-old-snapshots"]);
  });

  it("names what would have worked when asked for something that is not there", async () => {
    const unknownApp = await call("mechanics_list", { app: "nope" });
    expect(unknownApp.isError).toBe(true);
    expect(unknownApp.text).toContain("example");

    const unknownKind = await call("mechanics_coverage", { app: "example", kind: "route" });
    expect(unknownKind.isError).toBe(true);
    expect(unknownKind.text).toContain("cli-command, scheduled-job");
  });

  // The only place a decision record is retrieved through a real MCP client
  // against a real repo root. `decisions.test.ts` proves the rules; this
  // proves an agent asking "why is this like this" about a file it is holding
  // gets the answer back, which is the entire delivery channel.
  it("retrieves a decision by the file an agent is about to touch", async () => {
    await writeDecisionRecord(repo, "2026-01-snapshot-format", ["src/commands/backup.ts"]);
    try {
      const byPath = await call("mechanics_decisions", { path: "src/commands/backup.ts" });
      const hit = JSON.parse(byPath.text) as {
        count: number;
        decisions: Array<{ id: string; headline: string; sections: Record<string, string> }>;
      };
      expect(hit.count).toBe(1);
      expect(hit.decisions[0]?.id).toBe("2026-01-snapshot-format");
      expect(hit.decisions[0]?.headline).toBe("Write snapshots as tar.zst.");
      expect(Object.keys(hit.decisions[0]?.sections ?? {})).toEqual([
        "Context",
        "Decision",
        "Rationale",
        "Consequences",
      ]);

      const miss = await call("mechanics_decisions", { path: "src/jobs/prune-snapshots.ts" });
      expect((JSON.parse(miss.text) as { count: number; total: number }).count).toBe(0);
      expect((JSON.parse(miss.text) as { total: number }).total).toBe(1);
    } finally {
      await fs.rm(path.join(repo, ".docket"), { recursive: true, force: true });
    }
  });
});

/**
 * A decision record with `affects.paths` pointing wherever the caller says.
 * Written as raw text rather than through `writeDecision` on purpose: this
 * suite's whole job is to exercise the shipped artefacts from outside, and a
 * hand-authored file is what a user actually commits.
 */
async function writeDecisionRecord(root: string, id: string, paths: string[]): Promise<void> {
  const dir = path.join(root, ".docket", "decisions");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${id}.md`),
    [
      "---",
      "status: accepted",
      "date: 2026-01-05",
      "decidedBy: [alex]",
      "affects:",
      "  specs: [example.backups.create-snapshot]",
      `  paths: [${paths.map((p) => JSON.stringify(p)).join(", ")}]`,
      "---",
      "",
      "## Context",
      "",
      "Snapshot format was never written down.",
      "",
      "## Decision",
      "",
      "Write snapshots as tar.zst.",
      "",
      "## Rationale",
      "",
      "gzip was rejected: restore time dominated the window.",
      "",
      "## Consequences",
      "",
      "zstd is now a hard runtime dependency.",
      "",
    ].join("\n"),
    "utf8"
  );
}

/**
 * The staleness gate, run through the real CLI. This is the rule that stops
 * the decision folder from rotting, and it only counts if `mechanics check`
 * actually exits non-zero on it.
 */
describe("template decision records", () => {
  afterAll(async () => {
    await fs.rm(path.join(repo, ".docket"), { recursive: true, force: true });
  });

  it("passes check when the paths still resolve", async () => {
    await writeDecisionRecord(repo, "2026-01-snapshot-format", ["src/commands/*.ts"]);
    const { code, stdout, stderr } = await mechanics(["check", "--app=example"]);
    expect(`${stdout}${stderr}`).toContain("decisions: 1 record(s) ok");
    expect(code).toBe(0);
  });

  it("fails check when an accepted record points at deleted code", async () => {
    await writeDecisionRecord(repo, "2026-01-snapshot-format", ["src/deleted/**"]);
    const { code, stdout, stderr } = await mechanics(["check", "--app=example"]);
    const out = `${stdout}${stderr}`;
    expect(out).toContain("matches no files");
    expect(out).toContain("supersede it or reject it");
    expect(code).toBe(1);
  });
});
