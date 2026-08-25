/**
 * The auto lane, and the things it must refuse.
 *
 * Two groups matter more than the rest: `assertNoForbiddenOp`, which is the
 * MAY-NEVER list made executable, and the rollback, which is the whole
 * justification for letting a machine write anything at all. If a "mechanical"
 * fix can leave `check` red, it was never mechanical.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  annotateSpec,
  applyAutoFix,
  assertNoForbiddenOp,
  DEFAULT_ALLOWED_OPS,
  ignoreKey,
  insertPaths,
  narrowIgnoreGlob,
  planAutoFix,
} from "./fix";
import type { AutoOp, Gap } from "./gaps";
import { clearLayoutCache } from "./layout";

const made: string[] = [];

afterEach(async () => {
  clearLayoutCache();
  await Promise.all(made.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function tmpRepo(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mechanics-fix-")));
  made.push(dir);
  await write(
    dir,
    "mechanics.config.yaml",
    "apps:\n  - slug: demo\n    dir: .\n    adapters: []\n"
  );
  return dir;
}

async function write(root: string, rel: string, body: string): Promise<void> {
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, "utf8");
}

function gap(op: AutoOp, over: Partial<Gap> = {}): Gap {
  return {
    key: `k:${op.kind}:${op.file}`,
    gap: "missing-claim-path",
    lane: "auto",
    app: "demo",
    subject: "x",
    title: "t",
    detail: "d",
    suggestion: "s",
    severity: "p2",
    op,
    ...over,
  };
}

const addPaths = (file: string, paths: string[]): AutoOp => ({
  kind: "add-paths",
  file,
  mechanic: "demo.area.thing",
  paths,
});

// ---------------------------------------------------------------------------

describe("planAutoFix", () => {
  it("leaves annotate-spec off by default — it is the only op that writes app source", () => {
    const plan = planAutoFix("demo", [
      gap({ kind: "annotate-spec", file: "e2e/a.spec.ts", mechanic: "demo.a.b" }),
    ]);
    expect(plan.ops).toEqual([]);
    expect(plan.deferred[0]?.reason).toContain("not enabled");
    expect(DEFAULT_ALLOWED_OPS).not.toContain("annotate-spec");
  });

  it("includes it when asked for by name", () => {
    const plan = planAutoFix(
      "demo",
      [gap({ kind: "annotate-spec", file: "e2e/a.spec.ts", mechanic: "demo.a.b" })],
      { allow: ["annotate-spec"] }
    );
    expect(plan.ops).toHaveLength(1);
  });

  it("refuses a second op on the same file rather than ordering them", () => {
    // Both ops were computed against the file as it is NOW. Applying them in
    // sequence means the second is reasoning about a file that no longer
    // matches its precondition, and the failure would be silent.
    const plan = planAutoFix("demo", [
      gap(addPaths("mechanics/a/one.md", ["src/a.ts"])),
      gap(addPaths("mechanics/a/one.md", ["src/b.ts"]), { key: "second" }),
    ]);
    expect(plan.ops).toHaveLength(1);
    expect(plan.deferred[0]?.reason).toContain("re-run");
  });

  it("ignores propose-lane gaps entirely", () => {
    const g = gap(addPaths("mechanics/a/one.md", ["src/a.ts"]), { lane: "propose" });
    expect(planAutoFix("demo", [g]).ops).toEqual([]);
  });
});

describe("assertNoForbiddenOp — the MAY-NEVER list, in code", () => {
  // Monorepo-shaped on purpose: with no config on disk the layout falls back to
  // discovery mode, so the app root is `<repo>/apps/demo` and corpus paths are
  // repo-relative while app files are not. That mix is what the guard is for.
  const ctx = { app: "demo", repoRoot: "/repo", corpusDir: "apps/demo/mechanics" };

  it("refuses a mechanic edit outside the corpus dir", () => {
    expect(() => assertNoForbiddenOp(addPaths("apps/demo/src/app/page.tsx", ["a"]), ctx)).toThrow(
      /must live under apps\/demo\/mechanics\//
    );
  });

  it("refuses any path that escapes the app tree", () => {
    expect(() =>
      assertNoForbiddenOp(addPaths("apps/demo/mechanics/../../../etc/passwd", ["a"]), ctx)
    ).toThrow(/outside the app tree/);
  });

  it("refuses a widening dressed up as a narrowing", () => {
    // This is the sharp one. `narrow-ignore` is only defensible because it
    // cannot excuse anything new; an op that adds a member is the exact move
    // that makes a gap disappear without anyone deciding it should.
    expect(() =>
      assertNoForbiddenOp(
        {
          kind: "narrow-ignore",
          file: "apps/demo/mechanics/_config.yaml",
          surfaceKind: "worker",
          glob: "src/workers/_*.ts",
          literals: ["src/workers/_debug.ts", "src/workers/brand-new.ts"],
        },
        {
          ...ctx,
          ignoreMatchesBefore: new Map([
            [ignoreKey("worker", "src/workers/_*.ts"), ["src/workers/_debug.ts"]],
          ]),
        }
      )
    ).toThrow(/refusing to widen/);
  });

  it("refuses replacing an ignore with nothing — deleting one is a judgment", () => {
    expect(() =>
      assertNoForbiddenOp(
        {
          kind: "narrow-ignore",
          file: "apps/demo/mechanics/_config.yaml",
          surfaceKind: "worker",
          glob: "src/workers/_*.ts",
          literals: [],
        },
        ctx
      )
    ).toThrow(/refusing to replace/);
  });

  it("permits the narrowing it exists for", () => {
    expect(() =>
      assertNoForbiddenOp(
        {
          kind: "narrow-ignore",
          file: "apps/demo/mechanics/_config.yaml",
          surfaceKind: "worker",
          glob: "src/workers/_*.ts",
          literals: ["src/workers/_debug.ts"],
        },
        {
          ...ctx,
          ignoreMatchesBefore: new Map([
            [
              ignoreKey("worker", "src/workers/_*.ts"),
              ["src/workers/_debug.ts", "src/workers/_old.ts"],
            ],
          ]),
        }
      )
    ).not.toThrow();
  });
});

describe("the text edits are surgical", () => {
  const DOC = `---\ntitle: "Thing"\nkind: user-facing\nroles: [viewer]\n---\n\n## Story\n\nBody.\n`;

  it("inserts paths without reflowing the rest of the frontmatter", () => {
    const out = insertPaths(DOC, ["src/a.ts", "src/b.ts"]);
    expect(out).toContain('title: "Thing"');
    expect(out).toContain('paths:\n  - "src/a.ts"\n  - "src/b.ts"\n---');
    expect(out.endsWith("Body.\n")).toBe(true);
  });

  it("refuses a doc that already declares paths", () => {
    expect(() => insertPaths(insertPaths(DOC, ["src/a.ts"]), ["src/b.ts"])).toThrow(/already/);
  });

  it("replaces one ignore entry at its own indent, leaving comments intact", () => {
    const cfg = [
      "coverage:",
      "  enforce: warn",
      "  ignore:",
      "    worker:",
      "      # debug helpers, not surfaces",
      '      - "src/workers/_*.ts"',
      "",
    ].join("\n");
    const out = narrowIgnoreGlob(cfg, "src/workers/_*.ts", [
      "src/workers/_a.ts",
      "src/workers/_b.ts",
    ]);
    expect(out).toContain("# debug helpers, not surfaces");
    expect(out).toContain('      - "src/workers/_a.ts"\n      - "src/workers/_b.ts"');
    expect(out).not.toContain("_*.ts");
  });

  it("refuses when the glob appears twice — picking one would edit an unseen line", () => {
    const cfg = '    a:\n      - "g"\n    b:\n      - "g"\n';
    expect(() => narrowIgnoreGlob(cfg, "g", ["x"])).toThrow(/exactly one/);
  });

  it("annotates below a shebang, so the file stays executable", () => {
    const out = annotateSpec("#!/usr/bin/env bun\nimport x;\n", "demo.a.b");
    expect(out.split("\n")[0]).toBe("#!/usr/bin/env bun");
    expect(out.split("\n")[1]).toBe("// @mechanic demo.a.b");
  });

  it("is idempotent — re-annotating an annotated spec changes nothing", () => {
    const once = annotateSpec("import x;\n", "demo.a.b");
    expect(annotateSpec(once, "demo.a.b")).toBe(once);
  });
});

describe("applyAutoFix", () => {
  async function corpus(root: string): Promise<void> {
    await write(
      root,
      "mechanics/_config.yaml",
      "testGlobs: []\ne2eRunner: bun-script\ncoverage:\n  enforce: warn\n  ignore: {}\n"
    );
    await write(root, "mechanics/area/_area.yaml", "title: Area\norder: 1\n");
    await write(
      root,
      "mechanics/area/thing.md",
      [
        "---",
        "title: Thing",
        "kind: user-facing",
        "roles: [viewer]",
        "nonFunctional:",
        "  - perf",
        "---",
        "",
        "## Story",
        "",
        "As a viewer, I can x so that y.",
        "",
        "## Acceptance Criteria",
        "",
        "- **AC1** Given a When b Then c.",
        "",
        "## Edge Cases",
        "",
        "- None.",
        "",
        "## Error States",
        "",
        "- None.",
        "",
      ].join("\n")
    );
  }

  it("writes nothing on a dry run", async () => {
    const root = await tmpRepo();
    await corpus(root);
    const before = await fs.readFile(path.join(root, "mechanics/area/thing.md"), "utf8");
    const plan = planAutoFix("demo", [gap(addPaths("mechanics/area/thing.md", ["src/a.ts"]))]);
    const res = await applyAutoFix(plan, root, { dryRun: true });
    expect(res.written).toEqual(["mechanics/area/thing.md"]);
    expect(await fs.readFile(path.join(root, "mechanics/area/thing.md"), "utf8")).toBe(before);
  });

  it("applies the edit and rebuilds the manifest", async () => {
    const root = await tmpRepo();
    await corpus(root);
    await write(root, "src/a.ts", "export const a = 1;\n");
    const plan = planAutoFix("demo", [gap(addPaths("mechanics/area/thing.md", ["src/a.ts"]))]);
    const res = await applyAutoFix(plan, root);
    expect(res.revertedBecause).toBeUndefined();
    expect(await fs.readFile(path.join(root, "mechanics/area/thing.md"), "utf8")).toContain(
      'paths:\n  - "src/a.ts"'
    );
    expect(res.manifestChanged).toBe(true);
  });

  it("restores every byte when the edit leaves the corpus invalid", async () => {
    const root = await tmpRepo();
    await corpus(root);
    const file = path.join(root, "mechanics/area/thing.md");
    const before = await fs.readFile(file, "utf8");

    // `nonFunctional` is a closed enum, so replacing its one list entry parses
    // as YAML and then fails the schema — exactly the shape of breakage a
    // planner bug would produce, reached by hand because the planner itself
    // cannot currently emit one.
    const bad: AutoOp = {
      kind: "narrow-ignore",
      file: "mechanics/area/thing.md",
      surfaceKind: "nonFunctional",
      glob: "perf",
      literals: ["not-a-real-tag"],
    };
    const res = await applyAutoFix({ app: "demo", ops: [bad], deferred: [] }, root);

    expect(res.revertedBecause).toBeDefined();
    expect(res.applied).toEqual([]);
    expect(await fs.readFile(file, "utf8")).toBe(before);
  });
});

describe("narrow-ignore preserves coverage exactly", () => {
  it("leaves the manifest byte-identical, which is the whole safety argument", async () => {
    // The op is only defensible because it freezes today's behaviour rather
    // than guessing what the glob was MEANT to excuse. That claim is checkable:
    // build the manifest before and after and require the coverage block to be
    // unchanged. If it ever differs, the op stopped being mechanical.
    const root = await tmpRepo();
    await write(
      root,
      "mechanics/_config.yaml",
      [
        "testGlobs: []",
        "e2eRunner: bun-script",
        "coverage:",
        "  enforce: warn",
        "  ignore:",
        "    worker:",
        "      # debug helpers, not surfaces",
        '      - "src/workers/_*.ts"',
        "",
      ].join("\n")
    );
    await fs.writeFile(
      path.join(root, "mechanics.config.yaml"),
      [
        "apps:",
        "  - slug: demo",
        "    dir: .",
        "    adapters: []",
        "    surfaces:",
        "      - kind: worker",
        '        globs: ["src/workers/*.ts"]',
        "manifestsDir: .mechanics/manifests",
        "",
      ].join("\n"),
      "utf8"
    );
    await write(root, "src/workers/_debug.ts", "export {};\n");
    await write(root, "src/workers/_scratch.ts", "export {};\n");
    await write(root, "src/workers/sweep.ts", "export {};\n");
    clearLayoutCache();

    const { buildManifest } = await import("./manifest");
    const before = (await buildManifest("demo", root)).manifest.coverage;

    const op: AutoOp = {
      kind: "narrow-ignore",
      file: "mechanics/_config.yaml",
      surfaceKind: "worker",
      glob: "src/workers/_*.ts",
      literals: ["src/workers/_debug.ts", "src/workers/_scratch.ts"],
    };
    const res = await applyAutoFix({ app: "demo", ops: [op], deferred: [] }, root);
    expect(res.revertedBecause).toBeUndefined();
    clearLayoutCache();

    const after = (await buildManifest("demo", root)).manifest.coverage;
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));

    // And the comment above it survived, because the edit is one line, not a
    // YAML round-trip.
    const cfg = await fs.readFile(path.join(root, "mechanics/_config.yaml"), "utf8");
    expect(cfg).toContain("# debug helpers, not surfaces");
    expect(cfg).not.toContain("_*.ts");
  });
});
