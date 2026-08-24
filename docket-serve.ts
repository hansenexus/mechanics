/**
 * `mechanics run serve` — the board in a browser, following the file watcher.
 *
 * The server is deliberately small: it reads the same `.docket/` tree the TUI
 * reads, folds it with the same reducer, and pushes a "something changed"
 * ping over SSE. The page then refetches. No diffing protocol, no state on
 * the server — which means a crashed server loses nothing and a reload is
 * always correct.
 *
 * Binds to 127.0.0.1 only. A board exposes branch names, PR numbers, block
 * reasons and screenshots of unreleased work; it has no auth and must not be
 * reachable off the machine. This is not configurable on purpose.
 */

import { promises as fs, watch } from "node:fs";
import path from "node:path";
import { readEvents } from "./docket-events";
import type { BoardRun } from "./docket-html";
import { renderPage } from "./docket-html";
import { listRunIds, loadOrder, runDir, runsRoot } from "./docket-order";
import { reduceRun } from "./docket-state";
import { RUN_ID_RE } from "./docket-types";

const HOST = "127.0.0.1";

export async function collectBoard(repoRoot: string): Promise<BoardRun[]> {
  const runs: BoardRun[] = [];
  for (const id of await listRunIds(repoRoot)) {
    try {
      const order = await loadOrder(repoRoot, id);
      const { events, malformed } = await readEvents(repoRoot, id);
      runs.push({
        ...reduceRun(order, events, { malformed }),
        exitCriteria: order.exitCriteria,
        // Order-only metadata the event reducer never sees: boards join
        // card -> run through the linked issue (#424 PR3).
        ...(order.links ? { links: order.links } : {}),
      });
    } catch {
      // A single broken order must not blank the whole board.
    }
  }
  return runs;
}

const CONTENT_TYPES: Record<string, string> = {
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".json": "application/json",
};

/**
 * Resolve a request path inside one run's evidence directory, or null.
 *
 * The guard is `path.resolve` + a prefix check rather than a `..` blacklist:
 * encoded traversal, symlink-ish segments and absolute paths all collapse to
 * something outside the root, and the prefix check catches every one. A
 * blacklist would not.
 */
export function resolveEvidencePath(repoRoot: string, runId: string, rest: string): string | null {
  if (!RUN_ID_RE.test(runId)) return null;
  const root = path.resolve(runDir(repoRoot, runId), "evidence");
  const target = path.resolve(root, rest);
  // `root + sep` so `/evidence-secrets` cannot pass as a prefix of `/evidence`.
  return target === root || target.startsWith(root + path.sep) ? target : null;
}

export type ServeOptions = {
  repoRoot: string;
  port: number;
};

export function startServer(opts: ServeOptions) {
  const listeners = new Set<(data: string) => void>();

  const server = Bun.serve({
    hostname: HOST,
    port: opts.port,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/") {
        return new Response(
          renderPage(await collectBoard(opts.repoRoot), {
            live: true,
            generatedAt: new Date().toISOString(),
          }),
          { headers: { "content-type": "text/html; charset=utf-8" } }
        );
      }

      if (url.pathname === "/api/runs") {
        return Response.json(await collectBoard(opts.repoRoot));
      }

      if (url.pathname === "/api/stream") {
        const stream = new ReadableStream({
          start(controller) {
            const send = (data: string) => {
              try {
                controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`));
              } catch {
                listeners.delete(send);
              }
            };
            listeners.add(send);
            send("hello");
            req.signal.addEventListener("abort", () => {
              listeners.delete(send);
              try {
                controller.close();
              } catch {
                // already closed
              }
            });
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        });
      }

      const evidence = url.pathname.match(/^\/evidence\/([^/]+)\/(.+)$/);
      if (evidence) {
        const [, rawRun, rawRest] = evidence;
        const runId = decodeURIComponent(rawRun ?? "");
        const rest = (rawRest ?? "")
          .split("/")
          .map((s) => decodeURIComponent(s))
          .join("/");
        const target = resolveEvidencePath(opts.repoRoot, runId, rest);
        if (!target) return new Response("forbidden", { status: 403 });
        const file = Bun.file(target);
        if (!(await file.exists())) return new Response("not found", { status: 404 });
        const type = CONTENT_TYPES[path.extname(target).toLowerCase()];
        return new Response(file, type ? { headers: { "content-type": type } } : undefined);
      }

      return new Response("not found", { status: 404 });
    },
  });

  // One watcher over the whole tree; every change is the same "refetch" ping,
  // debounced so a burst of appends does not fan out to a burst of reloads.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: ReturnType<typeof watch> | undefined;
  try {
    watcher = watch(runsRoot(opts.repoRoot), { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        for (const send of listeners) send("changed");
      }, 120);
    });
  } catch {
    // No `.docket/runs` yet — the page's 15s poll covers it until there is.
  }

  return {
    url: `http://${HOST}:${server.port}`,
    stop: () => {
      watcher?.close();
      clearTimeout(timer);
      server.stop(true);
    },
  };
}

export async function writeReport(repoRoot: string, out: string): Promise<string> {
  const html = renderPage(await collectBoard(repoRoot), {
    live: false,
    generatedAt: new Date().toISOString(),
  });
  const target = path.resolve(repoRoot, out);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, html, "utf8");
  return target;
}
