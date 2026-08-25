/**
 * The generators, run through the REAL schemas.
 *
 * Both scaffold templates once emitted files the tool then refused to load:
 * `stubMarkdown` wrote a top-level `routes:` key that `mechanicFrontmatterSchema`
 * (`.strict()`) has never had, and the per-app config template wrote
 * `ignoreRoutes`/`ignoreApiRoutes`/`ignoreConvexFunctions` where
 * `appConfigSchema` (`.strict()`) has `coverage.ignore` as a kind-keyed record.
 * Both shipped because they lived in `cli.ts`, which ends in a top-level
 * `await main()` and so cannot be imported by a test at all.
 *
 * These assertions are deliberately about the CLASS, not the two instances: a
 * generated file is checked by parsing it with the same code the CLI parses it
 * with, so any future key that drifts out of the schema fails here.
 */

import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { appConfigYaml, detect } from "./init";
import { parseMechanicFile } from "./parser";
import { planScaffold, routeToStub, stubMarkdown } from "./scaffold";
import { appConfigSchema, mechanicFrontmatterSchema } from "./schema";

const CTX = { appSlug: "example", mechanicsDir: "mechanics" };

describe("the scaffolded mechanic stub", () => {
  it("parses with no errors — a stub the tool rejects is worse than no stub", () => {
    const { doc, errors } = parseMechanicFile(
      stubMarkdown("/pricing"),
      "mechanics/pricing/index.md",
      CTX
    );
    expect(errors).toEqual([]);
    expect(doc).not.toBeNull();
  });

  it("puts the route under `claims.route`, which is where coverage looks for it", () => {
    // The old spelling was a top-level `routes:`. It matched no schema key, so
    // the claim was invisible: the stub was written FOR an unclaimed route and
    // left it unclaimed.
    const { doc } = parseMechanicFile(stubMarkdown("/pricing"), "mechanics/pricing/index.md", CTX);
    expect(doc?.frontmatter.claims).toEqual({ route: ["/pricing"] });
  });

  it("rejects any key the strict frontmatter schema does not declare", () => {
    const fm = YAML.parse(stubMarkdown("/pricing").split("---")[1] ?? "");
    const parsed = mechanicFrontmatterSchema.safeParse(fm);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("survives dynamic and catch-all segments, which are not legal filenames", () => {
    expect(routeToStub("/orders/[id]")).toEqual({ area: "orders", slug: "id" });
    expect(routeToStub("/docs/[...slug]")).toEqual({ area: "docs", slug: "slug" });
    expect(routeToStub("/")).toEqual({ area: "overview", slug: "home" });

    for (const route of ["/orders/[id]", "/docs/[...slug]", "/"]) {
      const { area, slug } = routeToStub(route);
      const { errors } = parseMechanicFile(
        stubMarkdown(route),
        `mechanics/${area}/${slug}.md`,
        CTX
      );
      expect(errors, `${route} should scaffold to a parseable stub`).toEqual([]);
    }
  });
});

describe("the scaffolded per-app config", () => {
  it("parses under the strict app config schema", () => {
    // `scaffold` and `init` now share ONE template. Two generators for one
    // strict schema is the second source of truth that produced the bug: the
    // copy nobody looked at kept emitting keys the schema had already dropped.
    const det = detect(process.cwd(), process.cwd());
    const parsed = appConfigSchema.safeParse(YAML.parse(appConfigYaml(det)));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("spells the ignore map as a kind-keyed record, not per-kind top-level keys", () => {
    const cfg = YAML.parse(appConfigYaml(detect(process.cwd(), process.cwd())));
    expect(cfg.coverage).toEqual({ enforce: "warn", ignore: {} });
    expect(cfg).not.toHaveProperty("ignoreRoutes");
  });
});

describe("planScaffold", () => {
  it("numbers areas by first appearance, so re-running does not churn the diff", () => {
    const plan = planScaffold(["/billing/invoices", "/orders/list", "/billing/plans"]);
    expect(plan.areas.map((a) => a.area)).toEqual(["billing", "orders"]);
    expect(plan.areas[0]?.content).toContain("order: 1");
    expect(plan.areas[1]?.content).toContain("order: 2");
    expect(planScaffold(["/billing/invoices", "/orders/list", "/billing/plans"])).toEqual(plan);
  });

  it("emits one stub per route, addressed by area and slug", () => {
    const plan = planScaffold(["/billing/invoices", "/orders/list"]);
    expect(plan.stubs.map((s) => s.relPath)).toEqual(["billing/invoices.md", "orders/list.md"]);
  });

  it("produces a corpus that parses end to end", () => {
    const plan = planScaffold(["/", "/login", "/orders/[id]", "/settings/team/members"]);
    for (const stub of plan.stubs) {
      const { errors } = parseMechanicFile(stub.content, `mechanics/${stub.relPath}`, CTX);
      expect(errors, stub.relPath).toEqual([]);
    }
  });
});
