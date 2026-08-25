/**
 * The CLI's own entry contract, checked by spawning it the way a shell does.
 *
 * Only the parts a caller can trip over without a corpus: exit codes for the
 * usage screen, and the fact that an unknown subcommand is a failure while an
 * asked-for `--help` is not. Everything that needs a repo to run against is
 * covered by `template.test.ts` instead.
 */

import { spawn } from "node:child_process";
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
