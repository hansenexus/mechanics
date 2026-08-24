/**
 * The board as a self-contained HTML page.
 *
 * One renderer serves two commands. `run serve` sends it with an SSE endpoint
 * attached, so the page follows the file watcher live; `run report` inlines
 * the state and drops the socket, producing a single file you can attach to a
 * PR or open six months later. Same markup either way — a report that drifts
 * from the live board is worse than no report.
 *
 * No external requests: styles and script are inline, evidence is served from
 * the same origin. That is not aesthetic preference — a board that needs a CDN
 * cannot be opened on a locked-down machine or from a file:// URL.
 */

import type { RunState } from "./docket-types";

/**
 * What the page needs on top of the reduced state: the order's declared
 * criteria, so criteria nobody has evaluated yet render as pending instead of
 * silently not existing. A board that only shows what was checked flatters
 * the work.
 */
export type BoardRun = RunState & { exitCriteria: string[]; links?: { issue?: number } };

/**
 * Everything interpolated into the page passes through here. Run titles,
 * criterion ids and block reasons are author-controlled text that reaches the
 * page verbatim; without escaping, a title containing markup would execute.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** JSON safe to embed in a <script> block — `</script>` inside a string would
 * otherwise close the element early. */
export function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/-->/g, "--\\u003e");
}

export type RenderOptions = {
  /** Attach the SSE client. False produces a standalone file. */
  live: boolean;
  generatedAt: string;
  title?: string;
};

const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #ffffff; --fg: #16161a; --muted: #6b7280; --line: #e5e7eb;
  --panel: #f9fafb; --accent: #2563eb;
  --working: #16a34a; --waiting: #d97706; --stalled: #dc2626; --done: #6b7280;
  --idle: #0284c7;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0c0d10; --fg: #e8e8ea; --muted: #9096a2; --line: #23252b;
    --panel: #14161a; --accent: #60a5fa;
    --working: #4ade80; --waiting: #fbbf24; --stalled: #f87171; --done: #7c828e;
    --idle: #38bdf8;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 14px/1.5 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
}
main { max-width: 1100px; margin: 0 auto; padding: 32px 20px 64px; }
header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 4px; }
h1 { font-size: 20px; margin: 0; letter-spacing: -0.01em; }
.sub { color: var(--muted); font-size: 13px; margin-bottom: 24px; }
.live { margin-left: auto; font-size: 12px; color: var(--muted); }
.live b { color: var(--working); }
.runs { display: flex; flex-direction: column; gap: 8px; }
.run {
  border: 1px solid var(--line); border-radius: 10px; background: var(--panel);
  overflow: hidden;
}
/* Flex rather than a fixed grid: the meta group wraps to its own line on a
   narrow viewport instead of crushing the title into one word per line. */
.row {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 12px 14px; cursor: pointer;
  width: 100%; border: 0; background: none; color: inherit; text-align: left;
  font: inherit;
}
.row:hover { background: color-mix(in srgb, var(--accent) 7%, transparent); }
.dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.dot.working { background: var(--working); }
.dot.waiting { background: var(--waiting); }
.dot.idle    { background: var(--idle); }
.dot.stalled { background: var(--stalled); }
.dot.done    { background: var(--done); }
.title { font-weight: 550; flex: 1 1 220px; min-width: 0; }
.title span, .title small { display: block; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.title small { font-weight: 400; color: var(--muted); font-size: 12px; }
.meta { display: flex; align-items: center; gap: 14px; flex: 0 0 auto;
  margin-left: auto; }
.meta > * { white-space: nowrap; }
.meta .phase-now { width: 74px; }
.meta .crit { width: 118px; display: flex; gap: 6px; align-items: center; }
.meta .pr { width: 40px; text-align: right; }
.meta .state { width: 128px; }
.meta .age { width: 62px; text-align: right; }
@media (max-width: 720px) {
  .meta { margin-left: 21px; flex-wrap: wrap; gap: 10px 14px; }
  .title { flex: 1 1 100%; }
}
.mono { font-variant-numeric: tabular-nums; font-size: 13px; color: var(--muted); }
.bar { display: flex; gap: 3px; align-items: center; flex: none; }
.cell { width: 16px; height: 6px; border-radius: 2px; background: var(--line); }
.cell.on { background: var(--working); }
.state { font-size: 13px; }
/* waiting and stalled are bold because they are the two that want you;
   idle is coloured but not bold — it is information, not a summons. */
.state.waiting { color: var(--waiting); font-weight: 550; }
.state.stalled { color: var(--stalled); font-weight: 550; }
.state.idle    { color: var(--idle); }
.detail { display: none; padding: 4px 14px 18px; border-top: 1px solid var(--line); }
.run[open] .detail { display: block; }
.phases { display: flex; flex-wrap: wrap; gap: 6px; margin: 14px 0; }
.phase {
  font-size: 12px; padding: 3px 9px; border-radius: 999px;
  border: 1px solid var(--line); color: var(--muted);
}
.phase.now { border-color: var(--accent); color: var(--accent); font-weight: 550; }
.phase.past { opacity: 0.55; }
h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em;
     color: var(--muted); margin: 18px 0 8px; font-weight: 600; }
ul.crit { list-style: none; padding: 0; margin: 0; display: flex;
          flex-direction: column; gap: 5px; }
ul.crit li { display: flex; gap: 9px; align-items: baseline; font-size: 13px; }
.verdict { width: 13px; flex: none; }
.verdict.pass { color: var(--working); }
.verdict.fail, .verdict.blocked { color: var(--stalled); }
.verdict.na { color: var(--muted); }
.pending { color: var(--muted); }
.ev { color: var(--muted); font-size: 12px; }
.shots { display: flex; flex-wrap: wrap; gap: 10px; }
.shots a { display: block; border: 1px solid var(--line); border-radius: 6px;
           overflow: hidden; }
.shots img { display: block; width: 168px; height: 108px; object-fit: cover; }
.note { color: var(--muted); font-size: 13px; }
.warn { color: var(--waiting); font-size: 13px; }
.empty { color: var(--muted); padding: 40px 0; text-align: center; }
`;

const CLIENT = `
const fmtAge = (iso) => {
  if (!iso) return "—";
  const ms = Date.now() - Date.parse(iso);
  if (!isFinite(ms) || ms < 0) return "—";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  return h < 24 ? h + "h" : Math.floor(h / 24) + "d";
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const stateLabel = (r) =>
  r.result ? "done (" + r.result + ")"
  : r.liveness === "waiting" ? "waiting — " + ((r.blocked && r.blocked.needs) || "human")
  : r.liveness === "idle" ? "idle — " + ((r.idle && r.idle.reason) || "turn ended")
  : r.liveness;

function bar(r) {
  const total = r.progress.total || 0;
  const on = total === 0 ? 0 : Math.round((r.progress.met / total) * 5);
  let out = '<span class="bar">';
  for (let i = 0; i < 5; i++) out += '<span class="cell' + (i < on ? " on" : "") + '"></span>';
  return out + '</span> <span class="mono">' + r.progress.met + "/" + total + "</span>";
}

function detail(r) {
  const idx = r.phase ? r.phases.indexOf(r.phase) : -1;
  const phases = r.phases.map((p, i) => {
    const cls = p === r.phase ? "now" : idx > -1 && i < idx ? "past" : "";
    return '<span class="phase ' + cls + '">' + esc(p) + "</span>";
  }).join("");

  const seen = new Set(r.criteria.map((c) => c.criterion));
  const rows = r.criteria.map((c) => {
    const k = c.verdict === "pass" ? "pass" : c.verdict === "n-a" ? "na" : c.verdict;
    const mark = c.verdict === "pass" ? "✓" : c.verdict === "n-a" ? "–" : "✗";
    const ev = c.evidence ? '<span class="ev">' + esc(c.evidence) + "</span>" : "";
    return '<li><span class="verdict ' + k + '">' + mark + "</span><span>" +
      esc(c.criterion) + "</span>" + ev + "</li>";
  });
  for (const c of r.exitCriteria || []) {
    if (!seen.has(c)) {
      rows.push('<li><span class="verdict pending">○</span><span class="pending">' +
        esc(c) + "</span></li>");
    }
  }

  const shots = (r.evidence || []).filter((e) => e.kind === "screenshot");
  const gallery = shots.length
    ? '<h3>Evidence</h3><div class="shots">' + shots.map((e) => {
        const href = "/evidence/" + encodeURIComponent(r.run) + "/" +
          e.path.replace(/^evidence\\//, "").split("/").map(encodeURIComponent).join("/");
        return '<a href="' + href + '" target="_blank" rel="noopener">' +
          '<img loading="lazy" src="' + href + '" alt="' + esc(e.path) + '"></a>';
      }).join("") + "</div>"
    : "";

  const blocked = r.blocked
    ? '<p class="warn">Blocked: ' + esc(r.blocked.reason) +
      " (needs " + esc(r.blocked.needs) + ")</p>"
    : "";
  const decisions = (r.decisions || []).length
    ? "<h3>Decisions</h3><ul class=\\"crit\\">" + r.decisions.map((d) =>
        "<li><span></span><span>" + esc(d.decision) + "</span></li>").join("") + "</ul>"
    : "";
  const malformed = r.malformed
    ? '<p class="warn">' + r.malformed +
      " unparseable line(s) in events.jsonl — likely a killed writer</p>"
    : "";

  return '<div class="detail">' + blocked + '<div class="phases">' + phases + "</div>" +
    "<h3>Exit criteria</h3><ul class=\\"crit\\">" +
    (rows.length ? rows.join("") : '<li class="note">none declared</li>') +
    "</ul>" + decisions + gallery + malformed + "</div>";
}

function render(runs) {
  const host = document.getElementById("runs");
  if (!runs.length) {
    host.innerHTML = '<p class="empty">No runs yet — <code>bun mechanics run new --title="…"</code></p>';
    return;
  }
  host.innerHTML = runs.map((r) =>
    '<div class="run" data-run="' + esc(r.run) + '">' +
      '<button class="row" type="button">' +
        '<span class="dot ' + r.liveness + '"></span>' +
        '<span class="title"><span>' + esc(r.title) + "</span><small>" +
          esc(r.run) + "</small></span>" +
        '<span class="meta">' +
          '<span class="mono phase-now">' + esc(r.phase || "—") + "</span>" +
          '<span class="crit">' + bar(r) + "</span>" +
          '<span class="mono pr">' + (r.git && r.git.pr ? "#" + r.git.pr : "—") + "</span>" +
          '<span class="state ' + r.liveness + '">' + esc(stateLabel(r)) + "</span>" +
          '<span class="mono age">' + fmtAge(r.lastEventAt) + "</span>" +
        "</span>" +
      "</button>" + detail(r) +
    "</div>").join("");

  for (const el of host.querySelectorAll(".run")) {
    if (open.has(el.dataset.run)) el.setAttribute("open", "");
    el.querySelector(".row").addEventListener("click", () => {
      const id = el.dataset.run;
      if (open.has(id)) { open.delete(id); el.removeAttribute("open"); }
      else { open.add(id); el.setAttribute("open", ""); }
    });
  }
}

const open = new Set();
async function refresh() {
  try {
    const res = await fetch("/api/runs");
    render(await res.json());
  } catch (err) {
    /* server went away; the SSE reconnect will bring us back */
  }
}
`;

export function renderPage(runs: BoardRun[], opts: RenderOptions): string {
  const title = opts.title ?? "docket";
  const bootstrap = opts.live
    ? `refresh();
       setInterval(refresh, 15000);
       const es = new EventSource("/api/stream");
       es.onmessage = refresh;
       es.onerror = () => {};`
    : `render(${embedJson(runs)});`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<main>
  <header>
    <h1>${escapeHtml(title)}</h1>
    <span class="live">${opts.live ? "<b>●</b> live" : `generated ${escapeHtml(opts.generatedAt)}`}</span>
  </header>
  <p class="sub">Work orders in flight — docket/1</p>
  <div id="runs" class="runs"></div>
</main>
<script>
${CLIENT}
${bootstrap}
</script>
</body>
</html>
`;
}
