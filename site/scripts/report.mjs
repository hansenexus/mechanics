/**
 * Generate the perch report into the built site at `/report/`.
 *
 * The landing page links to a real generated report rather than only a
 * screenshot of one, and this is what makes that link true: it runs the actual
 * CLI against `examples/perch` at build time. The output is one self-contained
 * file with no external requests, so it deploys as a static asset with nothing
 * else attached.
 *
 * Run AFTER `astro build`, because it writes into `dist/`.
 */
import { spawnSync } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const PERCH = path.join(ROOT, "examples/perch");
const OUT = path.resolve(HERE, "../dist/report/index.html");

await stat(path.join(PERCH, "mechanics.config.yaml")).catch(() => {
  throw new Error(`no perch corpus at ${PERCH}`);
});

await mkdir(path.dirname(OUT), { recursive: true });

// The checkout's own CLI, not an installed copy: the site should show what
// this commit produces, not what the last release did.
const result = spawnSync("bun", [path.join(ROOT, "cli.ts"), "report", "--html", `--out=${OUT}`], {
  cwd: PERCH,
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`mechanics report exited ${result.status}`);
}
