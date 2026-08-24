/**
 * Screens module tests: slug encoding (incl. uniqueness over the LIVE console
 * route inventory — a real collision must fail here before it corrupts a
 * capture), path-guard hardening, index schema strictness, fixture loading,
 * soft validation, and non-interference with the corpus walkers.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { inventoryRoutes } from "./coverage";
import { discoverCorpus } from "./discover";
import {
  listScreenWaves,
  loadScreensForWave,
  orderCheckpoints,
  resolveScreenPath,
  routeToScreenSlug,
  screensIndexJson,
  screensIndexSchema,
  validateScreens,
} from "./screens";
import { loadWaves } from "./waves";

const FIXTURE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "repo");

import { existsSync as gateExists } from "node:fs";
import gatePath from "node:path";
import { loadLayout as loadRepoLayout } from "./layout";

const HAS_CONSOLE = (() => {
  try {
    const layout = loadRepoLayout();
    return gateExists(
      gatePath.join(layout.repoRoot, layout.manifestsDir, "console.mechanics.json")
    );
  } catch {
    return false;
  }
})();

describe("routeToScreenSlug", () => {
  it("encodes route patterns like the scaffold sanitizer", () => {
    expect(routeToScreenSlug("/")).toBe("home");
    expect(routeToScreenSlug("/apps/[app]")).toBe("apps-app");
    expect(routeToScreenSlug("/admin/deploy/[jobId]")).toBe("admin-deploy-jobid");
    expect(routeToScreenSlug("/observe/trading-bot")).toBe("observe-trading-bot");
    expect(routeToScreenSlug("/dev/review/[appSlug]/composable/[...componentPath]")).toBe(
      "dev-review-appslug-composable-componentpath"
    );
  });

  // Only meaningful inside a repo with a committed console corpus.
  it.skipIf(!HAS_CONSOLE)(
    "produces unique slugs over the live console route inventory",
    async () => {
      const routes = await inventoryRoutes("console");
      const seen = new Map<string, string>();
      for (const route of routes) {
        const slug = routeToScreenSlug(route);
        const clash = seen.get(slug);
        expect(clash, `slug collision: ${route} vs ${clash} → ${slug}`).toBeUndefined();
        seen.set(slug, route);
      }
      expect(seen.size).toBeGreaterThan(0);
    }
  );
});

describe("orderCheckpoints", () => {
  it("pins before first, after last, rest lexicographic", () => {
    expect(orderCheckpoints(["after", "mid-b", "before", "mid-a"])).toEqual([
      "before",
      "mid-a",
      "mid-b",
      "after",
    ]);
  });
});

describe("resolveScreenPath", () => {
  const ok = ["testapp", "2026-01-test", "before", "thing.webp"];

  it("resolves a shape-valid request under the screens root", () => {
    const p = resolveScreenPath(ok, FIXTURE_ROOT);
    expect(p).toBe(
      path.join(FIXTURE_ROOT, "apps/testapp/mechanics/waves/screens/2026-01-test/before/thing.webp")
    );
  });

  it("rejects malformed requests", () => {
    expect(resolveScreenPath(ok.slice(0, 3), FIXTURE_ROOT)).toBeNull();
    expect(resolveScreenPath([...ok, "extra"], FIXTURE_ROOT)).toBeNull();
    expect(resolveScreenPath(["testapp", "..", "before", "thing.webp"], FIXTURE_ROOT)).toBeNull();
    expect(
      resolveScreenPath(["Testapp", "2026-01-test", "before", "x.webp"], FIXTURE_ROOT)
    ).toBeNull();
    expect(
      resolveScreenPath(["testapp", "2026-01-test", "before", "index.json"], FIXTURE_ROOT)
    ).toBeNull();
    expect(
      resolveScreenPath(["testapp", "2026-01-test", "before", "../x.webp"], FIXTURE_ROOT)
    ).toBeNull();
    expect(
      resolveScreenPath(["testapp", "2026-01-test", "before", "thing.txt"], FIXTURE_ROOT)
    ).toBeNull();
  });
});

describe("screensIndexSchema", () => {
  const valid = {
    schemaVersion: 1,
    app: "testapp",
    wave: "2026-01-test",
    checkpoint: "before",
    capturedAt: "2026-01-02",
    viewport: "1440x900",
    routes: [{ route: "/thing", slug: "thing", file: "thing.webp", status: "captured" }],
  };

  it("parses a valid index and defaults fullPage", () => {
    const parsed = screensIndexSchema.parse(valid);
    expect(parsed.fullPage).toBe(false);
  });

  it("is strict and enforces captured⇒file", () => {
    expect(screensIndexSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    expect(
      screensIndexSchema.safeParse({
        ...valid,
        routes: [{ route: "/thing", slug: "thing", status: "captured" }],
      }).success
    ).toBe(false);
  });

  it("serializes sorted with a trailing newline", () => {
    const out = screensIndexJson(
      screensIndexSchema.parse({
        ...valid,
        routes: [
          { route: "/z", slug: "z", status: "skipped", reason: "n/a" },
          { route: "/a", slug: "a", status: "missing", reason: "x" },
        ],
      })
    );
    expect(out.endsWith("\n")).toBe(true);
    expect(out.indexOf('"/a"')).toBeLessThan(out.indexOf('"/z"'));
  });
});

describe("fixture screens tree", () => {
  it("lists waves and loads checkpoints ordered before → after", async () => {
    expect(await listScreenWaves("testapp", FIXTURE_ROOT)).toEqual(["2026-01-test"]);
    const { checkpoints } = await loadScreensForWave("testapp", "2026-01-test", FIXTURE_ROOT);
    expect(checkpoints.map((c) => c.checkpoint)).toEqual(["before", "after"]);
    const [before, after] = checkpoints;
    expect(before?.index?.routes).toHaveLength(2);
    expect(before?.files).toEqual(["orphan.webp", "thing.webp"]);
    expect(after?.index).toBeNull();
    expect(after?.errors.join(" ")).toContain("missing index.json");
  });

  it("validateScreens warns (never errors) on every soft finding", async () => {
    const warnings = await validateScreens("testapp", ["2026-01-test"], FIXTURE_ROOT);
    const joined = warnings.join("\n");
    expect(joined).toContain("orphan.webp is not referenced");
    expect(joined).toContain("1 route(s) missing screenshots");
    expect(joined).toContain("missing index.json");
    // Known wave → no unknown-wave warning.
    expect(joined).not.toContain("unknown wave");
  });

  it("flags screens for a wave with no wave file", async () => {
    const warnings = await validateScreens("testapp", [], FIXTURE_ROOT);
    expect(warnings.join("\n")).toContain('screens for unknown wave "2026-01-test"');
  });

  it("does not interfere with corpus or wave discovery", async () => {
    const corpus = await discoverCorpus("testapp", FIXTURE_ROOT);
    expect(corpus.errors).toEqual([]);
    const { errors } = await loadWaves("testapp", FIXTURE_ROOT);
    expect(errors).toEqual([]);
  });
});
