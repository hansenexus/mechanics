/**
 * Round-trips a real MCP client against the real server over the SDK's
 * in-memory transport. That is the point: the tool bodies are trivial, the
 * wiring is not — a wrong `inputSchema` shape or a handler returning the wrong
 * content envelope fails here and nowhere else.
 *
 * Runs against the committed console manifest rather than a fixture. The
 * manifest is drift-gated in CI, so it is real data that cannot silently rot,
 * and it exercises the server at the size it will actually see.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import { createMechanicsMcpServer } from "./mcp";

let client: Client;

beforeAll(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([
    client.connect(clientTransport),
    createMechanicsMcpServer().connect(serverTransport),
  ]);
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
  return { isError: Boolean(res.isError), text };
}

async function callJson(name: string, args: Record<string, unknown> = {}) {
  const { isError, text } = await call(name, args);
  expect(isError, text).toBe(false);
  return JSON.parse(text);
}

// In the source monorepo this suite runs against a committed manifest. The
// extracted repo carries no corpus of its own — the template smoke
// (template.test.ts) drives the MCP end to end from a temp corpus instead.
import { existsSync as gateExists } from "node:fs";
import gatePath from "node:path";
import { loadLayout } from "./layout";

const HAS_CORPUS = (() => {
  try {
    const layout = loadLayout();
    return gateExists(
      gatePath.join(layout.repoRoot, layout.manifestsDir, "console.mechanics.json")
    );
  } catch {
    return false;
  }
})();

describe.skipIf(!HAS_CORPUS)("mechanics MCP", () => {
  it("advertises exactly the read tools, and no writer", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "mechanics_coverage",
      "mechanics_get",
      "mechanics_impact",
      "mechanics_list",
      "mechanics_wave_status",
    ]);
    // A verdict is a judgment and `pass` needs evidence; an MCP tool that let a
    // model mark its own work green is the one thing this server must not grow.
    expect(tools.some((t) => t.name.includes("record"))).toBe(false);
  });

  it("lists onboarded apps when asked for no app in particular", async () => {
    const out = await callJson("mechanics_list");
    expect(out.onboardedApps).toContain("console");
  });

  it("filters a list without losing the unfiltered total", async () => {
    const all = await callJson("mechanics_list", { app: "console" });
    const p0 = await callJson("mechanics_list", { app: "console", priority: "p0" });
    expect(p0.total).toBe(all.total);
    expect(p0.count).toBeLessThan(all.count);
    expect(p0.mechanics.every((m: { priority: string }) => m.priority === "p0")).toBe(true);
  });

  it("returns the body sections, which is why `get` exists at all", async () => {
    const list = await callJson("mechanics_list", { app: "console" });
    const first = list.mechanics[0];
    const got = await callJson("mechanics_get", { app: "console", id: first.id });
    expect(got.id).toBe(first.id);
    expect(Object.keys(got.sections)).toEqual(
      expect.arrayContaining(["Story", "Acceptance Criteria"])
    );
    expect(got.claims).toBeTypeOf("object");
  });

  it("resolves an alias and says that it did", async () => {
    const list = await callJson("mechanics_list", { app: "console" });
    const withAlias = await (async () => {
      for (const m of list.mechanics) {
        const full = await callJson("mechanics_get", { app: "console", id: m.id });
        if (full.aliases.length > 0) return full;
      }
      return null;
    })();
    if (!withAlias) return; // corpus has no renames right now — nothing to assert
    const viaAlias = await callJson("mechanics_get", { app: "console", id: withAlias.aliases[0] });
    expect(viaAlias.id).toBe(withAlias.id);
    expect(viaAlias.resolvedFromAlias).toBe(withAlias.aliases[0]);
  });

  it("reports coverage per surface kind, carrying the labels", async () => {
    const out = await callJson("mechanics_coverage", { app: "console" });
    const kinds = out.surfaces.map((s: { kind: string }) => s.kind);
    expect(kinds).toEqual(["route", "api-route", "convex-function", "cron", "http-endpoint"]);
    const route = out.surfaces.find((s: { kind: string }) => s.kind === "route");
    expect(route.total).toBeGreaterThan(0);
    expect(route.unclaimed).toBeInstanceOf(Array);
  });

  it("maps explicit files to the mechanics claiming them", async () => {
    const out = await callJson("mechanics_impact", {
      app: "console",
      files: ["apps/console/src/components/features/logs/log-stream.tsx"],
    });
    expect(out.changedFiles).toHaveLength(1);
    expect(out.hits.length).toBeGreaterThan(0);
    expect(out.hits[0].reasons.length).toBeGreaterThan(0);
  });

  it("ignores changed files belonging to another app", async () => {
    const out = await callJson("mechanics_impact", {
      app: "console",
      files: ["apps/otherapp/src/app/page.tsx", "packages/ui/index.ts"],
    });
    expect(out.changedFiles).toEqual([]);
    expect(out.hits).toEqual([]);
  });

  it("summarizes waves with the failing ones broken out", async () => {
    const out = await callJson("mechanics_wave_status", { app: "console" });
    expect(out.waves.length).toBeGreaterThan(0);
    for (const wave of out.waves) {
      expect(wave.verifiedRatio).toBeGreaterThanOrEqual(0);
      expect(wave.verifiedRatio).toBeLessThanOrEqual(1);
      expect(wave.failing).toBeInstanceOf(Array);
    }
  });

  describe("errors name what would have worked", () => {
    it("unknown app lists the onboarded ones", async () => {
      const { isError, text } = await call("mechanics_list", { app: "nope" });
      expect(isError).toBe(true);
      expect(text).toContain("console");
    });

    it("unknown surface kind lists the kinds this app has", async () => {
      const { isError, text } = await call("mechanics_coverage", {
        app: "console",
        kind: "worker",
      });
      expect(isError).toBe(true);
      expect(text).toContain("route, api-route, convex-function");
    });

    it("unknown mechanic id says it is not an alias either", async () => {
      const { isError, text } = await call("mechanics_get", {
        app: "console",
        id: "console.nope.nope",
      });
      expect(isError).toBe(true);
      expect(text).toContain("alias");
    });

    it("unknown wave lists the waves this app has", async () => {
      const { isError, text } = await call("mechanics_wave_status", {
        app: "console",
        wave: "nope",
      });
      expect(isError).toBe(true);
      expect(text).toContain("Waves:");
    });
  });
});
