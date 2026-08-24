/**
 * What the published tarball would contain.
 *
 * Worth a test because the failure is silent in both directions. Ship too
 * little and the CLI is broken for everyone but us — the template, the spec
 * and the plugin are runtime data, not documentation. Ship too much and this
 * repo's committed manifests go public: `manifests/*.mechanics.json` names
 * every route, public function and area title of private apps, which is
 * exactly what an allowlist is for. Both of those were true before this file
 * existed.
 *
 * `npm pack` is not run here — it is slow and needs a registry-shaped
 * environment. The allowlist is checked against the tree instead, which is the
 * part that actually rots.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import pkg from "./package.json" with { type: "json" };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const files: string[] = pkg.files;

describe("published file set", () => {
  it("ships the runtime data the CLI needs, not just the code", () => {
    // Each of these is loaded at runtime by a command a consumer will run.
    for (const dir of ["template/", "spec/", "plugin/"]) {
      expect(files, `${dir} is runtime data and must ship`).toContain(dir);
      expect(existsSync(path.join(HERE, dir))).toBe(true);
    }
  });

  it("does not ship committed manifests", () => {
    // A consumer's manifests live in the consumer's repo. The source monorepo's
    // copy additionally asserts its own manifests directory exists; the
    // extracted repo carries none at all.
    expect(existsSync(path.join(HERE, "manifests"))).toBe(false);
    expect(files.some((f) => f.startsWith("manifests"))).toBe(false);
    expect(Object.keys(pkg.exports)).not.toContain("./manifests/*");
  });

  it("excludes tests and local tooling config", () => {
    expect(files).toContain("!*.test.ts");
    expect(files).toContain("!vitest.config.ts");
  });

  it("every export path exists and is inside the allowlist", () => {
    for (const [name, target] of Object.entries(pkg.exports as Record<string, string>)) {
      expect(existsSync(path.join(HERE, target)), `${name} → ${target} is missing`).toBe(true);
      // Top-level `*.ts` and the three shipped dirs are the whole allowlist;
      // an export pointing anywhere else would 404 after install.
      const shipped =
        /^\.\/[^/]+\.ts$/.test(target) ||
        ["spec/", "plugin/", "template/"].some((d) => target.startsWith(`./${d}`));
      expect(shipped, `${name} → ${target} is not in "files"`).toBe(true);
    }
  });

  it("declares the metadata a registry listing needs", () => {
    expect(pkg.description.length).toBeGreaterThan(40);
    expect(pkg.license).toBe("MIT");
    expect(pkg.repository.url).toContain("hansenexus/mechanics");
    expect(pkg.bin.mechanics).toBe("./dist/cli.js");
    expect(existsSync(path.join(HERE, "LICENSE"))).toBe(true);
    expect(existsSync(path.join(HERE, "README.md"))).toBe(true);
  });

  it("is the publishable package — this IS the extracted repo", () => {
    // The private workspace copy asserts the inverse (private + workspace
    // scope). Here the package publishes, so the guard flips.
    expect("private" in pkg).toBe(false);
    expect(pkg.name).toBe("@hansenexus/mechanics");
  });
});
