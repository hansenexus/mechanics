/**
 * The model lane's refusals, and the prompt that frames the work.
 *
 * `forbiddenEdit` is the counterpart to `assertNoForbiddenOp`, and it is not
 * theoretical: the first real run of this pipeline against a local model
 * produced an edit whose own summary was "Promote … from draft to active". It
 * failed only because the path it guessed did not exist.
 */

import { describe, expect, it } from "vitest";
import { buildFixPrompt, forbiddenEdit } from "./autofix";
import type { Gap } from "./gaps";

const gap = (over: Partial<Gap> = {}): Gap => ({
  key: "unclaimed-surface:demo:route:/login",
  gap: "unclaimed-surface",
  lane: "propose",
  app: "demo",
  subject: "/login",
  title: 'unclaimed route "/login"',
  detail: "A surface nothing documents.",
  suggestion: "Claim it from the area that owns it.",
  severity: "p1",
  ...over,
});

const replace = (path: string, replace: string) => ({ op: "replace", path, replace });
const create = (path: string, content: string) => ({ op: "create", path, content });

describe("forbiddenEdit", () => {
  it("refuses a wave file, where verdicts live", () => {
    expect(forbiddenEdit(replace("mechanics/waves/2026-08.yaml", "status: pass"), "x")).toMatch(
      /wave file/
    );
    expect(
      forbiddenEdit(create("apps/x/mechanics/waves/w.yaml", "verifications: []"), null)
    ).toMatch(/wave file/);
  });

  it("refuses promoting a draft to active — that promotion IS the review", () => {
    expect(forbiddenEdit(replace("mechanics/a/b.md", "status: active"), "status: draft\n")).toMatch(
      /promoting a draft/
    );
  });

  it("refuses a NEW mechanic that arrives already active", () => {
    // A model that cannot promote a draft will simply create one that is
    // active to begin with, if you let it.
    expect(forbiddenEdit(create("mechanics/a/b.md", "---\nstatus: active\n---"), null)).toMatch(
      /promoting a draft/
    );
  });

  it("allows a new mechanic that lands as a draft", () => {
    expect(forbiddenEdit(create("mechanics/a/b.md", "---\nstatus: draft\n---"), null)).toBeNull();
  });

  it("refuses touching coverage.ignore", () => {
    expect(
      forbiddenEdit(replace("mechanics/_config.yaml", '  ignore:\n    route: ["/*"]'), "x")
    ).toMatch(/coverage.ignore/);
  });

  it("refuses flipping the ratchet in either direction", () => {
    expect(
      forbiddenEdit(replace("mechanics/_config.yaml", "enforce: error"), "enforce: warn")
    ).toMatch(/ratchet/);
    expect(
      forbiddenEdit(replace("mechanics/_config.yaml", "enforce: warn"), "enforce: error")
    ).toMatch(/ratchet/);
  });

  it("allows ordinary work — this is full autonomy over the tree, minus grading", () => {
    expect(
      forbiddenEdit(create("src/app/login/page.tsx", "export default () => null;"), null)
    ).toBeNull();
    expect(forbiddenEdit(create("e2e/login.spec.ts", "test(...)"), null)).toBeNull();
    expect(forbiddenEdit(replace("src/lib/a.ts", "const x = 2;"), "const x = 1;")).toBeNull();
  });

  it("does not fire when the replacement leaves the line unchanged", () => {
    // Rewriting a config for an unrelated reason must not trip the guard just
    // because the surrounding text mentions enforce.
    const before = "coverage:\n  enforce: warn\n  ignore: {}\n";
    expect(forbiddenEdit(replace("mechanics/_config.yaml", "  enforce: warn"), before)).toBeNull();
  });
});

describe("buildFixPrompt", () => {
  it("states the non-negotiables to the provider as well as enforcing them", () => {
    // The guard is the boundary; the prompt is the courtesy. A model told the
    // rules wastes fewer turns being refused.
    const p = buildFixPrompt(gap(), "", "model");
    expect(p).toContain("status: draft");
    expect(p).toContain("Never add or widen an `ignore` glob");
    expect(p).toContain("Never record a verification verdict");
  });

  it("gives a model the edit protocol and a harness plain instructions", () => {
    expect(buildFixPrompt(gap(), "", "model")).toContain("ONE JSON object");
    expect(buildFixPrompt(gap(), "", "harness")).toContain("Make the change in this worktree");
  });

  it("tells the provider that inventing behaviour is worse than leaving a gap", () => {
    expect(buildFixPrompt(gap(), "", "model")).toMatch(/confident invention is worse/);
  });
});
