import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AdapterContext,
  buildInventory,
  buildProvenance,
  convexFunctionRegExp,
  createConvexAdapter,
  createGenericGlobAdapter,
  createNextjsAppRouterAdapter,
  defaultAdapters,
  type SurfaceAdapter,
} from "./adapters";

let repo: string;
let appDir: string;

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "mechanics-adapters-"));
  appDir = path.join(repo, "apps", "demo");
  await fs.mkdir(appDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(repo, { recursive: true, force: true });
});

async function write(rel: string, content: string): Promise<void> {
  const target = path.join(appDir, rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

async function ctx(files: string[]): Promise<AdapterContext> {
  return { appSlug: "demo", appDir, repoRoot: repo, files };
}

/** A fixed adapter is enough to test the registry without touching disk. */
function stub(name: string, kinds: string[], items: Record<string, string[]>): SurfaceAdapter {
  return {
    name,
    kinds: kinds.map((k) => ({ kind: k, label: k })),
    inventory: async () => items,
  };
}

describe("buildInventory", () => {
  it("merges adapters, dedupes and sorts", async () => {
    const inv = await buildInventory(
      [
        stub("a", ["route"], { route: ["/b", "/a", "/b"] }),
        stub("b", ["job"], { job: ["nightly"] }),
      ],
      await ctx([])
    );
    expect(inv.items.route).toEqual(["/a", "/b"]);
    expect(inv.items.job).toEqual(["nightly"]);
    expect(inv.kinds.map((k) => k.kind)).toEqual(["route", "job"]);
  });

  it("gives a declared-but-unfound kind an empty array, never undefined", async () => {
    const inv = await buildInventory(
      [stub("a", ["route", "job"], { route: ["/a"] })],
      await ctx([])
    );
    expect(inv.items.job).toEqual([]);
  });

  it("drops a kind an adapter never declared — items and kinds stay in lockstep", async () => {
    const inv = await buildInventory(
      [stub("a", ["route"], { route: ["/a"], smuggled: ["x"] })],
      await ctx([])
    );
    expect(inv.items.smuggled).toBeUndefined();
    expect(Object.keys(inv.items)).toEqual(["route"]);
  });

  it("refuses two adapters claiming one kind, and names both", async () => {
    await expect(
      buildInventory(
        [stub("nextjs", ["route"], {}), stub("generic-glob", ["route"], {})],
        await ctx([])
      )
    ).rejects.toThrow(/"nextjs" and "generic-glob"/);
  });
});

describe("nextjs-app-router adapter", () => {
  it("finds api routes and falls back to a page walk with no routes manifest", async () => {
    const files = [
      "src/app/page.tsx",
      "src/app/(dashboard)/observe/page.tsx",
      "src/app/api/health/route.ts",
      "src/app/api/webhooks/stripe/route.ts",
      "src/app/layout.tsx",
    ];
    const inv = await createNextjsAppRouterAdapter().inventory(await ctx(files));
    expect(inv.route).toEqual(["/", "/observe"]);
    expect(inv["api-route"]).toEqual(["/api/health", "/api/webhooks/stripe"]);
  });

  it("prefers the dev-routes manifest, normalized the same way", async () => {
    const manifestDir = path.join(repo, "packages", "dev-routes", "manifests");
    await fs.mkdir(manifestDir, { recursive: true });
    await fs.writeFile(
      path.join(manifestDir, "demo.routes.json"),
      JSON.stringify({ routes: [{ pattern: "/[locale]/(marketing)/pricing" }] }),
      "utf8"
    );
    const inv = await createNextjsAppRouterAdapter().inventory(
      await ctx(["src/app/somewhere-else/page.tsx"])
    );
    expect(inv.route).toEqual(["/pricing"]);
  });
});

describe("convex adapter", () => {
  it("finds exported functions, crons and http paths", async () => {
    await write(
      "convex/things.ts",
      "export const list = query({});\nexport const add = mutation({});"
    );
    await write(
      "convex/crons.ts",
      'crons.daily("nightly sweep", {});\ncrons.interval("ping", {});'
    );
    await write("convex/http.ts", 'http.route({ path: "/webhook", method: "POST" });');
    const inv = await createConvexAdapter().inventory(
      await ctx(["convex/things.ts", "convex/crons.ts", "convex/http.ts"])
    );
    expect(inv["convex-function"]).toEqual(["things.list", "things.add"]);
    expect(inv.cron).toEqual(["nightly sweep", "ping"]);
    expect(inv["http-endpoint"]).toEqual(["/webhook"]);
  });

  it("skips generated code and helpers — neither is a claimable surface", async () => {
    await write("convex/_generated/api.ts", "export const x = query({});");
    await write("convex/lib/util.ts", "export const helper = query({});");
    await write("convex/things.test.ts", "export const spec = query({});");
    const inv = await createConvexAdapter().inventory(
      await ctx(["convex/_generated/api.ts", "convex/lib/util.ts", "convex/things.test.ts"])
    );
    expect(inv["convex-function"]).toEqual([]);
  });

  it("returns empty for an app with no convex directory at all", async () => {
    const inv = await createConvexAdapter().inventory(await ctx(["src/app/page.tsx"]));
    expect(inv["convex-function"]).toEqual([]);
    expect(inv.cron).toEqual([]);
    expect(inv["http-endpoint"]).toEqual([]);
  });
});

describe("generic-glob adapter", () => {
  it("declares the config's kinds and returns matching paths verbatim", async () => {
    const adapter = createGenericGlobAdapter([
      { kind: "cli-command", label: "CLI command", globs: ["src/commands/**/*.ts"] },
      { kind: "migration", globs: ["db/migrate/*.sql"] },
    ]);
    expect(adapter.kinds.map((k) => k.kind)).toEqual(["cli-command", "migration"]);
    expect(adapter.kinds[1]?.label).toBe("migration");

    const inv = await adapter.inventory(
      await ctx([
        "src/commands/deploy.ts",
        "src/commands/nested/rollback.ts",
        "src/lib/helper.ts",
        "db/migrate/001_init.sql",
      ])
    );
    expect(inv["cli-command"]).toEqual([
      "src/commands/deploy.ts",
      "src/commands/nested/rollback.ts",
    ]);
    expect(inv.migration).toEqual(["db/migrate/001_init.sql"]);
  });

  it("composes with the built-ins, which is the whole point", async () => {
    const inv = await buildInventory(
      [
        ...defaultAdapters(),
        createGenericGlobAdapter([{ kind: "worker", globs: ["workers/*.ts"] }]),
      ],
      await ctx(["src/app/page.tsx", "workers/mailer.ts"])
    );
    expect(inv.items.route).toEqual(["/"]);
    expect(inv.items.worker).toEqual(["workers/mailer.ts"]);
    expect(inv.kinds.map((k) => k.kind)).toEqual([
      "route",
      "api-route",
      "convex-function",
      "cron",
      "http-endpoint",
      "worker",
    ]);
  });
});

describe("legacy claim keys", () => {
  it("every built-in kind still maps to the frontmatter key it is claimed under", async () => {
    const pairs = defaultAdapters()
      .flatMap((a) => a.kinds)
      .map((k) => [k.kind, k.legacyClaimKey]);
    expect(pairs).toEqual([
      ["route", "routes"],
      ["api-route", "apiRoutes"],
      ["convex-function", "convexFunctions"],
      ["cron", "crons"],
      ["http-endpoint", "httpEndpoints"],
    ]);
  });
});

describe("provenance: item → the file that produced it", () => {
  it("maps a route and an API route back to their handler files", async () => {
    const files = ["src/app/page.tsx", "src/app/orders/page.tsx", "src/app/api/hooks/route.ts"];
    const prov = await createNextjsAppRouterAdapter().provenance?.(await ctx(files));
    expect(prov?.route).toEqual({
      "/": ["src/app/page.tsx"],
      "/orders": ["src/app/orders/page.tsx"],
    });
    expect(prov?.["api-route"]).toEqual({ "/api/hooks": ["src/app/api/hooks/route.ts"] });
  });

  it("maps a convex function to its module, and a cron to crons.ts", async () => {
    await write("convex/monitors.ts", "export const list = query(() => {});\n");
    await write("convex/crons.ts", 'crons.daily("nightly-sweep", {}, api.x.y);\n');
    const prov = await createConvexAdapter().provenance?.(
      await ctx(["convex/monitors.ts", "convex/crons.ts"])
    );
    expect(prov?.["convex-function"]).toEqual({ "monitors.list": ["convex/monitors.ts"] });
    expect(prov?.cron).toEqual({ "nightly-sweep": ["convex/crons.ts"] });
  });

  it("is the identity for a glob-declared kind, where the item IS the file", async () => {
    const files = ["src/workers/sweep.ts", "src/workers/mail.ts"];
    const adapter = createGenericGlobAdapter([{ kind: "worker", globs: ["src/workers/*.ts"] }]);
    expect(await adapter.provenance?.(await ctx(files))).toEqual({
      worker: {
        "src/workers/sweep.ts": ["src/workers/sweep.ts"],
        "src/workers/mail.ts": ["src/workers/mail.ts"],
      },
    });
  });

  it("omits an item it cannot answer for rather than guessing a file", async () => {
    // A route present only in the dev-routes manifest has no page file behind
    // it. The honest answer is silence: a guessed path would land in a
    // mechanic's `paths:` and `check` would then bless it as established fact.
    await fs.mkdir(path.join(repo, "packages", "dev-routes", "manifests"), { recursive: true });
    await fs.writeFile(
      path.join(repo, "packages", "dev-routes", "manifests", "demo.routes.json"),
      JSON.stringify({ routes: [{ pattern: "/generated-only" }] }),
      "utf8"
    );
    const c = await ctx(["src/app/page.tsx"]);
    const adapter = createNextjsAppRouterAdapter();
    expect((await adapter.inventory(c)).route).toContain("/generated-only");
    expect(Object.keys((await adapter.provenance?.(c))?.route ?? {})).toEqual(["/"]);
  });

  it("contributes nothing for an adapter that does not implement it", async () => {
    const bare = stub("bare", ["thing"], { thing: ["a"] });
    expect(await buildProvenance([bare], await ctx([]))).toEqual({});
  });
});

describe("adapter options: convex wrappers and dir", () => {
  it("counts listed wrapper builders as public functions, keyed by the path under dir", async () => {
    await write(
      "convex/modules/lexilink/status.ts",
      [
        "export const get = spaceQuery({});",
        "export const set = spaceMutation({});",
        "export const plain = query({});",
        "export const sweep = internalQuery({});",
        "export const unlisted = guestQuery({});",
      ].join("\n")
    );
    const c = await ctx(["convex/modules/lexilink/status.ts"]);
    const adapter = createConvexAdapter({ wrappers: ["spaceQuery", "spaceMutation"] });
    expect((await adapter.inventory(c))["convex-function"]).toEqual([
      "modules/lexilink/status.get",
      "modules/lexilink/status.set",
      "modules/lexilink/status.plain",
    ]);
    expect((await adapter.provenance?.(c))?.["convex-function"]).toEqual({
      "modules/lexilink/status.get": ["convex/modules/lexilink/status.ts"],
      "modules/lexilink/status.set": ["convex/modules/lexilink/status.ts"],
      "modules/lexilink/status.plain": ["convex/modules/lexilink/status.ts"],
    });
  });

  it("never counts a wrapper by default, nor an internal builder unless it is listed", async () => {
    await write(
      "convex/things.ts",
      "export const a = spaceQuery({});\nexport const b = internalMutation({});"
    );
    const c = await ctx(["convex/things.ts"]);
    expect((await createConvexAdapter().inventory(c))["convex-function"]).toEqual([]);
    expect(
      (await createConvexAdapter({ wrappers: ["internalMutation"] }).inventory(c))[
        "convex-function"
      ]
    ).toEqual(["things.b"]);
  });

  it("matches a wrapper name exactly — no prefix, suffix or regex leakage", async () => {
    const re = convexFunctionRegExp(["$wrap", "spaceQuery"]);
    const hits = (src: string) => [...src.matchAll(re)].map((m) => m[1]);
    expect(hits("export const a = $wrap({});")).toEqual(["a"]);
    expect(hits("export const b = Xwrap({});")).toEqual([]);
    expect(hits("export const c = spaceQueryX({});")).toEqual([]);
    expect(hits("export const d = mySpaceQuery({});")).toEqual([]);
  });

  it("reads functions, exclusions, crons and http from the configured dir", async () => {
    await write("backend/convex/things.ts", "export const list = query({});");
    await write("backend/convex/lib/util.ts", "export const helper = query({});");
    await write("backend/convex/_generated/api.ts", "export const x = query({});");
    await write("backend/convex/things.test.ts", "export const spec = query({});");
    await write("backend/convex/crons.ts", 'crons.daily("nightly", {});');
    await write("backend/convex/http.ts", 'http.route({ path: "/hook", method: "POST" });');
    // The default dir is no longer looked at once another is configured.
    await write("convex/stray.ts", "export const ignored = query({});");
    await write("convex/crons.ts", 'crons.daily("stray-cron", {});');
    const files = [
      "backend/convex/things.ts",
      "backend/convex/lib/util.ts",
      "backend/convex/_generated/api.ts",
      "backend/convex/things.test.ts",
      "backend/convex/crons.ts",
      "backend/convex/http.ts",
      "convex/stray.ts",
      "convex/crons.ts",
    ];
    const adapter = createConvexAdapter({ dir: "./backend/convex/" });
    const inv = await adapter.inventory(await ctx(files));
    // crons.ts and http.ts are modules too, as they are today — they export
    // nothing a builder made, so they contribute no functions.
    expect(inv["convex-function"]).toEqual(["things.list"]);
    expect(inv.cron).toEqual(["nightly"]);
    expect(inv["http-endpoint"]).toEqual(["/hook"]);
    const prov = await adapter.provenance?.(await ctx(files));
    expect(prov?.cron).toEqual({ nightly: ["backend/convex/crons.ts"] });
    expect(prov?.["http-endpoint"]).toEqual({ "/hook": ["backend/convex/http.ts"] });
  });

  it("with no options, behaves exactly as the hardcoded adapter did", async () => {
    await write("convex/things.ts", "export const list = query({});");
    const c = await ctx(["convex/things.ts"]);
    expect(await createConvexAdapter({}).inventory(c)).toEqual(
      await createConvexAdapter().inventory(c)
    );
    expect(convexFunctionRegExp().source).toBe(
      /export\s+const\s+(\w+)\s*=\s*(?:query|mutation|action)\s*\(/.source
    );
  });
});

describe("adapter options: nextjs-app-router appDir", () => {
  const files = [
    "apps/web/src/app/page.tsx",
    "apps/web/src/app/[locale]/(app)/classes/page.tsx",
    "apps/web/src/app/api/health/route.ts",
    // Outside the configured dir: the default location is no longer looked at.
    "src/app/stray/page.tsx",
    "src/app/api/stray/route.ts",
  ];

  it("derives routes and API routes from the configured dir", async () => {
    const adapter = createNextjsAppRouterAdapter({ appDir: "apps/web/src/app" });
    const inv = await adapter.inventory(await ctx(files));
    expect(inv.route).toEqual(["/", "/classes"]);
    expect(inv["api-route"]).toEqual(["/api/health"]);
  });

  it("maps provenance back to files under the configured dir", async () => {
    const adapter = createNextjsAppRouterAdapter({ appDir: "./apps/web/src/app/" });
    const prov = await adapter.provenance?.(await ctx(files));
    expect(prov?.route).toEqual({
      "/": ["apps/web/src/app/page.tsx"],
      "/classes": ["apps/web/src/app/[locale]/(app)/classes/page.tsx"],
    });
    expect(prov?.["api-route"]).toEqual({
      "/api/health": ["apps/web/src/app/api/health/route.ts"],
    });
  });

  it("still prefers the dev-routes manifest over the configured dir", async () => {
    const manifestDir = path.join(repo, "packages", "dev-routes", "manifests");
    await fs.mkdir(manifestDir, { recursive: true });
    await fs.writeFile(
      path.join(manifestDir, "demo.routes.json"),
      JSON.stringify({ routes: [{ pattern: "/(marketing)/pricing" }] }),
      "utf8"
    );
    const adapter = createNextjsAppRouterAdapter({ appDir: "apps/web/src/app" });
    expect((await adapter.inventory(await ctx(files))).route).toEqual(["/pricing"]);
  });
});
