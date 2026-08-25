/**
 * The `examples/perch` corpus is what the README screenshots are pictures of.
 * A screenshot cannot fail CI, so this does: if the example stops parsing, or
 * its manifest drifts, or its deliberate gaps change shape, the numbers in
 * `docs/images/` have stopped describing the tool and the shots need
 * regenerating with `bun run docs:shots`.
 *
 * The gaps are asserted exactly, not loosely. "Some warnings" would pass with
 * an accidental new one, and an accidental gap in the example is how the
 * README ends up advertising a coverage figure nobody chose.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE = path.join(HERE, "examples", "perch");
const CLI = path.join(HERE, "cli.ts");

interface Run {
  code: number;
  out: string;
}

/** stderr merged into stdout: warnings and the summary are one transcript. */
function mechanics(args: string[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [CLI, ...args], {
      cwd: EXAMPLE,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      out += d;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 0, out }));
  });
}

describe("examples/perch", () => {
  it("parses, with only the gaps it means to have", async () => {
    const { code, out } = await mechanics(["check", "--app=perch"]);
    expect(code).toBe(0);
    expect(out).toContain("25 mechanics ok");
    expect(out).toContain("4 warning(s)");
  });

  it("names each deliberate gap, and no others", async () => {
    const { out } = await mechanics(["check", "--app=perch"]);
    const unclaimed = out
      .split("\n")
      .filter((l) => l.includes("unclaimed"))
      .map((l) => l.replace(/^.*unclaimed /, "").replace(/ — .*$/, ""));

    expect(unclaimed.sort()).toEqual([
      'API route "/api/webhooks/stripe"',
      'Convex function "monitors.exportCsv"',
      'route "/"',
      'route "/login"',
    ]);
  });

  it("ships a manifest that matches its tree", async () => {
    const { code, out } = await mechanics(["build", "--all", "--check"]);
    expect(out).toContain("up to date");
    expect(code).toBe(0);
  });

  it("covers every kind both adapters and the config declare", async () => {
    const { out } = await mechanics(["coverage", "--app=perch"]);
    // Two built-in adapters plus one glob-declared kind: the example exists to
    // show them mixed, so losing a kind here is a regression in what it shows.
    for (const kind of [
      "route",
      "api-route",
      "convex-function",
      "cron",
      "http-endpoint",
      "worker",
    ]) {
      expect(out, `coverage should report '${kind}'`).toContain(kind);
    }
    expect(out).toContain("1 ignored");
  });

  it("has a wave in flight, with failures on the board", async () => {
    const { out } = await mechanics(["coverage", "--app=perch"]);
    expect(out).toMatch(/wave 2026-08-redesign \[open\]: \d+\/\d+ verified, [1-9]\d* fail/);
  });
});
