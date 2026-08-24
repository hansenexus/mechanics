/**
 * Integration tests against the fixture repo at `fixtures/repo` — corpus
 * discovery, test-link discovery, coverage, manifest determinism, and wave
 * rollups, end to end.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeCoverage, inventoryAppKinds } from "./coverage";
import { discoverCorpus, discoverTestLinks } from "./discover";
import { buildManifest, loadMechanicDoc, manifestJson } from "./manifest";
import { loadWaves, summarizeWave, validateWaveAgainstCorpus } from "./waves";

const FIXTURE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "repo");

describe("discoverCorpus (fixture)", () => {
  it("finds config, areas, and docs with no errors", async () => {
    const corpus = await discoverCorpus("testapp", FIXTURE_ROOT);
    expect(corpus.errors).toEqual([]);
    expect(corpus.config?.e2eRunner).toBe("bun-script");
    expect(corpus.areas.get("core")?.title).toBe("Core");
    expect(corpus.docs.map((d) => d.id)).toEqual([
      "testapp.core.nightly-sync",
      "testapp.core.view-thing",
    ]);
  });
});

describe("discoverTestLinks (fixture)", () => {
  it("finds annotation and describe-title links", async () => {
    const corpus = await discoverCorpus("testapp", FIXTURE_ROOT);
    if (!corpus.config) throw new Error("fixture config missing");
    const links = await discoverTestLinks("testapp", corpus.config, FIXTURE_ROOT);
    const forView = links.get("testapp.core.view-thing");
    expect(forView?.map((l) => l.via).sort()).toEqual(["annotation", "describe-title"]);
    expect(forView?.[0]?.spec).toBe("apps/testapp/e2e/thing.spec.ts");
  });
});

describe("buildManifest (fixture)", () => {
  it("builds a clean manifest with full coverage accounting", async () => {
    const { manifest, errors, warnings } = await buildManifest("testapp", FIXTURE_ROOT);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(manifest.mechanicCount).toBe(2);

    // /thing claimed; /dev/tools unclaimed but ignored by "/dev/*".
    expect(manifest.coverage.route).toEqual({
      total: 2,
      claimed: 1,
      ignored: 1,
      unclaimed: [],
    });
    expect(manifest.coverage["api-route"]?.claimed).toBe(1);
    // things.list + things.sync claimed, things.seedThings ignored, internal excluded.
    expect(manifest.coverage["convex-function"]).toEqual({
      total: 3,
      claimed: 2,
      ignored: 1,
      unclaimed: [],
    });
    expect(manifest.coverage.cron?.claimed).toBe(1);

    const view = manifest.mechanics.find((m) => m.id === "testapp.core.view-thing");
    expect(view?.tests).toHaveLength(2);
    expect(manifest.testCoverage).toEqual({ withTests: 1, manualOnly: 1, untested: 0 });
  });

  it("is byte-stable across rebuilds (determinism contract)", async () => {
    const a = await buildManifest("testapp", FIXTURE_ROOT);
    const b = await buildManifest("testapp", FIXTURE_ROOT);
    expect(manifestJson(a.manifest)).toBe(manifestJson(b.manifest));
  });
});

describe("loadMechanicDoc (fixture)", () => {
  it("loads a doc by manifest source path", async () => {
    const loaded = await loadMechanicDoc(
      "testapp",
      "apps/testapp/mechanics/core/view-thing.md",
      FIXTURE_ROOT
    );
    expect(loaded?.doc.id).toBe("testapp.core.view-thing");
    expect(loaded?.body).toContain("## Story");
    expect(loaded?.body).not.toContain("title: View the thing");
  });

  it("refuses paths outside the app's mechanics tree", async () => {
    expect(
      await loadMechanicDoc("testapp", "apps/other/mechanics/core/x.md", FIXTURE_ROOT)
    ).toBeNull();
    expect(
      await loadMechanicDoc("testapp", "apps/testapp/mechanics/../../../package.json", FIXTURE_ROOT)
    ).toBeNull();
  });
});

describe("waves (fixture)", () => {
  it("loads, validates, and summarizes with absent-entry-=-pending", async () => {
    const { manifest } = await buildManifest("testapp", FIXTURE_ROOT);
    const { waves, errors } = await loadWaves("testapp", FIXTURE_ROOT);
    expect(errors).toEqual([]);
    expect(waves).toHaveLength(1);
    const wave = waves[0];
    if (!wave) throw new Error("fixture wave missing");

    expect(validateWaveAgainstCorpus(wave, manifest.mechanics, "testapp")).toEqual([]);

    const summary = summarizeWave(wave, manifest.mechanics);
    expect(summary.scopeSize).toBe(2);
    expect(summary.counts).toEqual({ pending: 1, pass: 0, fail: 0, blocked: 0, "n-a": 1 });
    expect(summary.verifiedRatio).toBeCloseTo(0.5);
  });
});

describe("kind-keyed claims", () => {
  it("reports a claim under a kind no adapter provides, and says which exist", async () => {
    const docs = (await discoverCorpus("testapp", FIXTURE_ROOT)).docs;
    const inventory = await inventoryAppKinds("testapp", FIXTURE_ROOT);
    const doc = docs[0];
    if (!doc) throw new Error("fixture has no docs");

    const { danglingClaims } = await computeCoverage(
      [{ ...doc, frontmatter: { ...doc.frontmatter, claims: { worker: ["mailer"] } } }],
      inventory,
      { testGlobs: [], e2eRunner: "bun-script", coverage: { enforce: "warn", ignore: {} } },
      "testapp",
      FIXTURE_ROOT
    );

    expect(danglingClaims).toHaveLength(1);
    // The message has to distinguish "the route is missing" from "routes are not
    // a thing here" — they send you to completely different places.
    expect(danglingClaims[0]).toContain('unknown surface kind "worker"');
    expect(danglingClaims[0]).toContain("route, api-route, convex-function");
  });

  it("carries the surface list into the manifest so consumers can render it", async () => {
    const { manifest } = await buildManifest("testapp", FIXTURE_ROOT);
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.surfaces.map((s) => s.kind)).toEqual([
      "route",
      "api-route",
      "convex-function",
      "cron",
      "http-endpoint",
    ]);
    expect(manifest.surfaces.find((s) => s.kind === "convex-function")?.label).toBe(
      "Convex function"
    );
  });

  it("sorts claim kinds and items so a reordered frontmatter block is a no-op", async () => {
    const { manifest } = await buildManifest("testapp", FIXTURE_ROOT);
    const view = manifest.mechanics.find((m) => m.id === "testapp.core.view-thing");
    expect(Object.keys(view?.claims ?? {})).toEqual(["api-route", "convex-function", "route"]);
  });
});
