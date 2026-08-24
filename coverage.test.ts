import { describe, expect, it } from "vitest";
import { claimMatches, normalizeRoutePattern, pageFileToRoute } from "./coverage";
import { globToRegExp } from "./fsutil";

describe("normalizeRoutePattern", () => {
  it("strips route groups, parallel slots, and a leading [locale]", () => {
    expect(normalizeRoutePattern("/[locale]/(dashboard)/observe")).toBe("/observe");
    expect(normalizeRoutePattern("/(dashboard)/apps/[app]")).toBe("/apps/[app]");
    expect(normalizeRoutePattern("/(auth)/login")).toBe("/login");
    expect(normalizeRoutePattern("/(dashboard)/@modal/photo")).toBe("/photo");
    expect(normalizeRoutePattern("/")).toBe("/");
    expect(normalizeRoutePattern("/[locale]/(marketing)")).toBe("/");
  });
});

describe("pageFileToRoute", () => {
  it("maps src/app-relative page files to normalized routes", () => {
    expect(pageFileToRoute("(dashboard)/observe/page.tsx")).toBe("/observe");
    expect(pageFileToRoute("page.tsx")).toBe("/");
    expect(pageFileToRoute("(dashboard)/apps/[app]/page.tsx")).toBe("/apps/[app]");
    expect(pageFileToRoute("review/[slug]/page.tsx")).toBe("/review/[slug]");
  });
});

describe("claimMatches", () => {
  it("matches exact and subtree wildcard claims", () => {
    expect(claimMatches("/observe", "/observe")).toBe(true);
    expect(claimMatches("/observe", "/observe/trading-bot")).toBe(false);
    expect(claimMatches("/apps/[app]/*", "/apps/[app]")).toBe(true);
    expect(claimMatches("/apps/[app]/*", "/apps/[app]/pods")).toBe(true);
    expect(claimMatches("/apps/[app]/*", "/apps-other")).toBe(false);
  });
});

describe("globToRegExp", () => {
  it("handles *, **, and ? with anchoring", () => {
    expect(globToRegExp("/dev/*").test("/dev/tools")).toBe(true);
    expect(globToRegExp("/dev/*").test("/dev/tools/deep")).toBe(false);
    expect(globToRegExp("/dev/**").test("/dev/tools/deep")).toBe(true);
    expect(globToRegExp("things.seed*").test("things.seedThings")).toBe(true);
    expect(globToRegExp("things.seed*").test("things.list")).toBe(false);
    expect(globToRegExp("e2e/**/*.spec.ts").test("e2e/thing.spec.ts")).toBe(true);
    expect(globToRegExp("e2e/**/*.spec.ts").test("e2e/deep/thing.spec.ts")).toBe(true);
    expect(globToRegExp("e2e/**/*.spec.ts").test("src/thing.spec.ts")).toBe(false);
    expect(
      globToRegExp("apps/console/src/components/features/observe/**").test(
        "apps/console/src/components/features/observe/log-panel.tsx"
      )
    ).toBe(true);
  });
});
