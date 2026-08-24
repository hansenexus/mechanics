#!/usr/bin/env bun
/**
 * mechanics MCP server — stdio, read-only.
 *
 *   bun mechanics mcp
 *
 * The corpus is only worth writing if the agents doing the work can read it
 * mid-task. Grepping markdown gets an agent the prose and none of the
 * structure: not which criteria exist, not whether a route is claimed, not
 * which mechanics a diff touches. These five tools answer exactly the questions
 * that come up while changing an app.
 *
 * **Everything reads the committed manifest, never a rebuild.** A rebuild walks
 * the whole app tree — a second or more on a big app — and an agent asking "what
 * mechanics exist" must not pay that. The manifest is drift-gated in CI, so it
 * is as current as the branch is.
 *
 * **Read-only, deliberately.** `mechanics_record` (writing verdicts into a
 * wave) is in the plan and is not here: a verdict is a judgment, `pass`
 * requires evidence, and an MCP tool that lets a model mark its own work green
 * without one is precisely the failure the wave format exists to prevent.
 * Verdicts go through `mechanics verify` or the docket CLI, where the evidence
 * requirement is enforced.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { REPO_ROOT } from "./fsutil";
import { mapImpact } from "./impact";
import { appPath } from "./layout";
import { loadManifest, loadMechanicDoc, onboardedApps } from "./manifest";
import type { MechanicsManifest } from "./types";
import { loadWaves, summarizeWave } from "./waves";

/** Every tool answers in JSON: agents filter and re-read it, prose they cannot. */
function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/**
 * A discriminated union rather than `{ manifest?, error? }`: the compiler then
 * refuses every path that forgets to handle the miss, which on a server whose
 * whole job is answering questions about apps is the mistake worth making
 * impossible.
 */
type ManifestLookup = { ok: true; manifest: MechanicsManifest } | { ok: false; error: string };

async function requireManifest(app: string): Promise<ManifestLookup> {
  const manifest = await loadManifest(app);
  if (manifest) return { ok: true, manifest };
  const known = (await onboardedApps()).join(", ") || "(none)";
  return { ok: false, error: `"${app}" has no committed manifest. Onboarded apps: ${known}` };
}

export function createMechanicsMcpServer(): McpServer {
  const server = new McpServer({ name: "mechanics", version: "0.1.0" });

  server.registerTool(
    "mechanics_list",
    {
      title: "List mechanics",
      description:
        "Documented behaviours for an app, optionally filtered. Returns ids, titles, areas, " +
        "criteria counts and test links — not the bodies. Omit `app` to list onboarded apps.",
      inputSchema: {
        app: z.string().optional().describe("App slug; omit to list onboarded apps"),
        area: z.string().optional().describe("Only this area"),
        status: z.enum(["draft", "active", "deprecated"]).optional(),
        priority: z.enum(["p0", "p1", "p2"]).optional(),
        untested: z
          .boolean()
          .optional()
          .describe("Only mechanics with no discovered test link and no manual-only hint"),
      },
    },
    async ({ app, area, status, priority, untested }) => {
      if (!app) return json({ onboardedApps: await onboardedApps() });
      const found = await requireManifest(app);
      if (!found.ok) return fail(found.error);

      const rows = found.manifest.mechanics
        .filter((m) => !area || m.area === area)
        .filter((m) => !status || m.status === status)
        .filter((m) => !priority || m.priority === priority)
        .filter((m) => !untested || (m.tests.length === 0 && m.verify !== "manual-only"))
        .map((m) => ({
          id: m.id,
          title: m.title,
          area: m.area,
          kind: m.kind,
          status: m.status,
          priority: m.priority,
          criteria: m.criteria,
          destructive: m.destructive,
          tests: m.tests.map((t) => t.spec),
          verify: m.verify,
        }));

      return json({
        app,
        count: rows.length,
        total: found.manifest.mechanicCount,
        mechanics: rows,
      });
    }
  );

  server.registerTool(
    "mechanics_get",
    {
      title: "Get one mechanic",
      description:
        "Full record for one mechanic: claims, paths, acceptance criteria, and the markdown body " +
        "(story, ACs, edge cases, error states). This is what to read before changing the " +
        "behaviour it documents.",
      inputSchema: {
        app: z.string().describe("App slug"),
        id: z.string().describe("Mechanic id, e.g. console.observe.logs-tab"),
      },
    },
    async ({ app, id }) => {
      const found = await requireManifest(app);
      if (!found.ok) return fail(found.error);

      // An alias is the whole point of aliases: a rename must not break the
      // annotation or the agent that memorised the old id.
      const mechanic =
        found.manifest.mechanics.find((m) => m.id === id) ??
        found.manifest.mechanics.find((m) => m.aliases.includes(id));
      if (!mechanic) return fail(`"${id}" is not a mechanic in ${app} (nor an alias of one)`);

      const loaded = await loadMechanicDoc(app, mechanic.source);
      return json({
        ...mechanic,
        ...(mechanic.id === id ? {} : { resolvedFromAlias: id }),
        sections: loaded?.doc.sections ?? null,
      });
    }
  );

  server.registerTool(
    "mechanics_coverage",
    {
      title: "Coverage gaps",
      description:
        "Per-surface-kind coverage for an app: how much is claimed, ignored, and — the useful " +
        "part — exactly which items no mechanic claims. Ask before adding a route or a public " +
        "function, so it lands documented.",
      inputSchema: {
        app: z.string().describe("App slug"),
        kind: z
          .string()
          .optional()
          .describe("Only this surface kind (route, api-route, convex-function, …)"),
      },
    },
    async ({ app, kind }) => {
      const found = await requireManifest(app);
      if (!found.ok) return fail(found.error);
      const { manifest } = found;

      const surfaces = manifest.surfaces.filter((s) => !kind || s.kind === kind);
      if (kind && surfaces.length === 0) {
        const known = manifest.surfaces.map((s) => s.kind).join(", ");
        return fail(`${app} has no surface kind "${kind}". It provides: ${known}`);
      }

      return json({
        app,
        surfaces: surfaces.map((s) => ({
          kind: s.kind,
          label: s.label,
          ...(manifest.coverage[s.kind] ?? { total: 0, claimed: 0, ignored: 0, unclaimed: [] }),
        })),
        testCoverage: manifest.testCoverage,
      });
    }
  );

  server.registerTool(
    "mechanics_wave_status",
    {
      title: "Wave status",
      description:
        "Verification rollups for an app's waves: scope size, per-status counts, percent " +
        "verified, and which mechanics are still pending or failing.",
      inputSchema: {
        app: z.string().describe("App slug"),
        wave: z.string().optional().describe("One wave slug; omit for all"),
      },
    },
    async ({ app, wave }) => {
      const found = await requireManifest(app);
      if (!found.ok) return fail(found.error);

      const { waves, errors } = await loadWaves(app);
      const selected = wave ? waves.filter((w) => w.wave === wave) : waves;
      if (wave && selected.length === 0) {
        const known = waves.map((w) => w.wave).join(", ") || "(none)";
        return fail(`${app} has no wave "${wave}". Waves: ${known}`);
      }

      return json({
        app,
        ...(errors.length > 0 ? { errors } : {}),
        waves: selected.map((w) => {
          const summary = summarizeWave(w, found.manifest.mechanics);
          const byStatus = (s: string) =>
            w.verifications.filter((v) => v.status === s).map((v) => v.mechanic);
          return {
            ...summary,
            failing: byStatus("fail"),
            blocked: byStatus("blocked"),
          };
        }),
      });
    }
  );

  server.registerTool(
    "mechanics_impact",
    {
      title: "Which mechanics does this diff touch",
      description:
        "Map changed files to the mechanics documenting them, via `paths:` globs plus route and " +
        "Convex-module heuristics. Pass explicit files, or a git base ref to diff against HEAD.",
      inputSchema: {
        app: z.string().describe("App slug"),
        files: z
          .array(z.string())
          .optional()
          .describe("Repo-relative changed files; takes precedence over `base`"),
        base: z
          .string()
          .optional()
          .describe("Git ref to diff against HEAD (default origin/master) when `files` is omitted"),
      },
    },
    async ({ app, files, base }) => {
      const found = await requireManifest(app);
      if (!found.ok) return fail(found.error);

      let changed = files;
      if (!changed) {
        const ref = base ?? "origin/master";
        const proc = Bun.spawn(["git", "diff", "--name-only", `${ref}...HEAD`], {
          cwd: REPO_ROOT,
          stdout: "pipe",
          stderr: "pipe",
        });
        const out = await new Response(proc.stdout).text();
        if ((await proc.exited) !== 0) {
          const err = (await new Response(proc.stderr).text()).trim();
          return fail(`git diff against "${ref}" failed: ${err || "unknown error"}`);
        }
        changed = out.split("\n").filter(Boolean);
      }

      const result = mapImpact(found.manifest, appPath(app, REPO_ROOT), changed);
      return json({ app, ...result });
    }
  );

  return server;
}

/** Entry point for `bun mechanics mcp`. */
export async function runMechanicsMcp(): Promise<void> {
  const server = createMechanicsMcpServer();
  await server.connect(new StdioServerTransport());
}
