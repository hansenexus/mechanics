/**
 * The CLI's own entry contract, checked by spawning it the way a shell does.
 *
 * Only the parts a caller can trip over without a corpus: exit codes for the
 * usage screen, and the fact that an unknown subcommand is a failure while an
 * asked-for `--help` is not. Everything that needs a repo to run against is
 * covered by `template.test.ts` instead.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "cli.ts");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run from a directory with no `mechanics.config.yaml` above it. */
function mechanics(args: string[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [CLI, ...args], {
      cwd: path.parse(HERE).root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

describe("cli entry", () => {
  it("prints usage and succeeds when help is asked for", async () => {
    for (const flag of ["--help", "-h", "help"]) {
      const run = await mechanics([flag]);
      expect(run.code, `${flag} should exit 0`).toBe(0);
      expect(run.stdout).toContain("mechanics — app mechanics corpus tooling");
    }
  });

  it("prints usage and succeeds when invoked bare", async () => {
    const run = await mechanics([]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("Usage:");
  });

  it("fails on an unknown subcommand, so a typo cannot pass in a script", async () => {
    const run = await mechanics(["coverge"]);
    expect(run.code).toBe(1);
  });

  it("lists every documented subcommand in the usage screen", async () => {
    const { stdout } = await mechanics(["--help"]);
    for (const cmd of [
      "init",
      "check",
      "build",
      "coverage",
      "report",
      "verify",
      "scaffold",
      "impact",
      "screens",
      "mcp",
      "run",
    ]) {
      expect(stdout, `usage should mention '${cmd}'`).toContain(`mechanics ${cmd}`);
    }
  });
});

describe("cli: the app defaults in a single-app repo", () => {
  /** Run from inside `cwd`, so the repo root is resolved from there. */
  function mechanicsIn(cwd: string, args: string[]): Promise<Run> {
    return new Promise((resolve, reject) => {
      const child = spawn("bun", [CLI, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => {
        stdout += d;
      });
      child.stderr.on("data", (d) => {
        stderr += d;
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    });
  }

  it("runs check and coverage without --app when the config declares one app", async () => {
    const cwd = path.join(HERE, "fixtures", "repo", "single-app");
    const check = await mechanicsIn(cwd, ["check"]);
    expect(check.stderr).not.toContain("pass --app");
    expect(check.code).toBe(0);
    expect(check.stdout).toContain("solo: 1 mechanics ok");

    const coverage = await mechanicsIn(cwd, ["coverage"]);
    expect(coverage.code).toBe(0);
    expect(coverage.stdout).toContain("solo");
  });

  it("still refuses without --app when the config declares several apps", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mechanics-cli-"));
    try {
      await fs.writeFile(
        path.join(root, "mechanics.config.yaml"),
        "apps:\n  - slug: a\n    dir: a\n  - slug: b\n    dir: b\nmanifestsDir: out\n",
        "utf8"
      );
      const run = await mechanicsIn(root, ["check"]);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("check: pass --app=<slug> or --all");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
