import path from "node:path";
import { describe, expect, it } from "vitest";
import { type BoardRun, embedJson, escapeHtml, renderPage } from "./docket-html";
import { resolveEvidencePath } from "./docket-serve";

const REPO = "/tmp/repo";
const RUN = "2026-08-08-demo";

function board(over: Partial<BoardRun> = {}): BoardRun {
  return {
    run: RUN,
    title: "Demo",
    phases: ["scope", "land"],
    phase: "scope",
    criteria: [],
    exitCriteria: ["a:AC1"],
    progress: { met: 0, total: 1 },
    liveness: "working",
    decisions: [],
    proposals: [],
    evidence: [],
    lastEventAt: "2026-08-08T12:00:00.000Z",
    eventCount: 1,
    malformed: 0,
    ...over,
  };
}

describe("escapeHtml", () => {
  it("neutralises markup in author-controlled text", () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes both quote styles, for attribute contexts", () => {
    expect(escapeHtml(`a"b'c`)).toBe("a&quot;b&#39;c");
  });

  it("renders null and undefined as empty, not as the words", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });
});

describe("embedJson", () => {
  it("prevents a string from closing the script element early", () => {
    const out = embedJson({ title: "</script><img onerror=alert(1)>" });
    expect(out).not.toContain("</script>");
    expect(JSON.parse(out).title).toBe("</script><img onerror=alert(1)>");
  });

  it("escapes an HTML comment close, which also terminates a script", () => {
    expect(embedJson({ t: "-->" })).not.toContain("-->");
  });
});

describe("renderPage", () => {
  it("is self-contained — no external origin is referenced", () => {
    const html = renderPage([board()], { live: true, generatedAt: "2026-08-08" });
    expect(html).not.toMatch(/src="https?:/);
    expect(html).not.toMatch(/href="https?:/);
    expect(html).not.toContain("cdn");
  });

  it("does not let a malicious run title reach the page as markup", () => {
    const html = renderPage([board({ title: "<img src=x onerror=alert(1)>" })], {
      live: false,
      generatedAt: "2026-08-08",
    });
    expect(html).not.toContain("<img src=x onerror");
  });

  it("attaches the SSE client only in live mode", () => {
    const live = renderPage([], { live: true, generatedAt: "x" });
    const frozen = renderPage([board()], { live: false, generatedAt: "x" });
    expect(live).toContain("EventSource");
    expect(frozen).not.toContain("EventSource");
    // The frozen page carries its data, so it still works offline.
    expect(frozen).toContain(RUN);
  });
});

describe("resolveEvidencePath", () => {
  const root = path.resolve(REPO, ".docket", "runs", RUN, "evidence");

  it("resolves a normal nested file", () => {
    expect(resolveEvidencePath(REPO, RUN, "screens/verify/a.webp")).toBe(
      path.join(root, "screens/verify/a.webp")
    );
  });

  it("refuses parent traversal", () => {
    expect(resolveEvidencePath(REPO, RUN, "../../../../etc/passwd")).toBeNull();
    expect(resolveEvidencePath(REPO, RUN, "screens/../../order.yaml")).toBeNull();
  });

  it("refuses an absolute path", () => {
    expect(resolveEvidencePath(REPO, RUN, "/etc/passwd")).toBeNull();
  });

  it("refuses a sibling directory that merely shares the prefix", () => {
    expect(resolveEvidencePath(REPO, RUN, "../evidence-private/leak.txt")).toBeNull();
  });

  it("refuses a run id that is not a run id", () => {
    expect(resolveEvidencePath(REPO, "../../../etc", "passwd")).toBeNull();
    expect(resolveEvidencePath(REPO, "not-a-run", "a.webp")).toBeNull();
  });
});

const OPTS = { live: false, generatedAt: "2026-08-08T12:00:00.000Z" };

describe("the embedded client script", () => {
  it("parses as JavaScript", () => {
    // The board's client half is a template literal, so `tsc` never sees it as
    // code and no test reached it either: a stray backtick in a comment inside
    // that literal is a silently broken page. Parsing it here is the cheapest
    // thing that would have caught it.
    const html = renderPage([board()], OPTS);
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script, "renderPage should embed a client script").toBeTruthy();
    expect(() => new Function(script as string)).not.toThrow();
  });

  it("renders open proposals without choking on state.json from before they existed", () => {
    const legacy = { ...board(), proposals: undefined } as unknown as BoardRun;
    expect(() => renderPage([legacy], OPTS)).not.toThrow();
    const html = renderPage(
      [
        board({
          proposals: [
            { proposal: "g1", subject: "/login", status: "open", at: "2026-08-08T12:00:00.000Z" },
          ],
        }),
      ],
      OPTS
    );
    expect(html).toContain("g1");
  });
});
