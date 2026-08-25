/**
 * The corpus as a self-contained HTML page.
 *
 * Console has a private dashboard for this; every other project has the CLI
 * table and nothing to hand anyone. `mechanics report --html` is the portable
 * answer: one file, no build step, no server, no external request — openable
 * from `file://`, attachable to a PR, readable in six months.
 *
 * It renders COVERAGE, not runs. `docket-html.ts` renders runs — liveness,
 * criteria, evidence — and the two look alike on purpose but answer different
 * questions: "is this work moving?" versus "is this behaviour documented and
 * verified?". What carries over is the shape, not the code: inline styles and
 * markup, zero requests, one file.
 *
 * It reads the COMMITTED manifests, never a rebuild — the same choice the MCP
 * makes, and for the same reason. The manifest is drift-gated, so it is as
 * current as the branch, and a report is a snapshot of the branch.
 */

import { escapeHtml } from "./docket-html";
import type { ManifestMechanic, MechanicsManifest, WaveFile } from "./types";
import { summarizeWave } from "./waves";

export interface ReportApp {
  manifest: MechanicsManifest;
  waves: WaveFile[];
}

export interface ReportOptions {
  generatedAt: string;
  /** Branch or sha the page describes, when the caller knows it. */
  revision?: string;
  title?: string;
}

const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #ffffff; --fg: #16161a; --muted: #6b7280; --line: #e5e7eb;
  --panel: #f9fafb; --accent: #2563eb;
  --ok: #16a34a; --warn: #d97706; --bad: #dc2626; --off: #6b7280;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0c0d10; --fg: #e8e8ea; --muted: #9096a2; --line: #23252b;
    --panel: #14161a; --accent: #60a5fa;
    --ok: #4ade80; --warn: #fbbf24; --bad: #f87171; --off: #7c828e;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 14px/1.5 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
}
main { max-width: 1100px; margin: 0 auto; padding: 32px 20px 64px; }
h1 { font-size: 20px; margin: 0 0 4px; letter-spacing: -0.01em; }
h2 { font-size: 17px; margin: 40px 0 2px; letter-spacing: -0.01em; }
h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em;
     color: var(--muted); margin: 22px 0 8px; font-weight: 600; }
.sub { color: var(--muted); font-size: 13px; }
.mono { font-variant-numeric: tabular-nums; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th {
  text-align: left; font-weight: 600; font-size: 12px; color: var(--muted);
  text-transform: uppercase; letter-spacing: 0.05em;
  border-bottom: 1px solid var(--line); padding: 6px 8px;
}
td { padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
tr:last-child td { border-bottom: 0; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.panel {
  border: 1px solid var(--line); border-radius: 10px; background: var(--panel);
  padding: 4px 14px; margin-top: 8px;
}
/* A bar, not a number: 40/40 and 19/28 read identically in a column of
   figures, and the gap is the whole point of the page. */
.bar { display: block; height: 6px; border-radius: 3px; background: var(--line);
       overflow: hidden; min-width: 90px; }
.bar i { display: block; height: 100%; background: var(--ok); }
.bar.gap i { background: var(--warn); }
/* Nothing to cover is not full coverage — an empty track says so. */
.bar.empty { opacity: 0.45; }
/* The summary band: the page's answer, above the page's evidence. */
.band {
  border: 1px solid var(--line); border-radius: 10px; background: var(--panel);
  padding: 16px 18px 12px; margin-top: 14px;
}
.lede { margin: 0 0 14px; font-size: 15px; line-height: 1.5; max-width: 62ch; }
.lede strong { font-weight: 650; }
.meter-row {
  display: grid; grid-template-columns: minmax(120px, 220px) 1fr 62px;
  gap: 12px; align-items: center; padding: 4px 0; font-size: 12.5px;
}
.meter-l { color: var(--muted); }
.meter {
  display: block; height: 7px; border-radius: 4px; background: var(--line);
  overflow: hidden;
}
.meter i { display: block; height: 100%; background: var(--ok); }
.meter i.gap { background: var(--warn); }
.meter.empty { opacity: 0.45; }
.meter-n { text-align: right; color: var(--muted); }
@media (max-width: 560px) {
  .meter-row { grid-template-columns: 1fr 56px; }
  .meter-row .meter { grid-column: 1 / -1; order: 3; }
}
.hint { font-weight: 400; text-transform: none; letter-spacing: 0; }
.pill {
  display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 999px;
  border: 1px solid var(--line); color: var(--muted); white-space: nowrap;
}
.pill.p0 { border-color: var(--bad); color: var(--bad); }
.pill.draft { border-color: var(--warn); color: var(--warn); }
.pill.deprecated { text-decoration: line-through; }
.pill.destructive { border-color: var(--bad); color: var(--bad); }
.st-pass { color: var(--ok); }
.st-fail, .st-blocked { color: var(--bad); font-weight: 550; }
.st-pending { color: var(--muted); }
.st-na { color: var(--muted); }
.untested { color: var(--warn); }
details { margin: 6px 0 10px; }
summary { cursor: pointer; color: var(--muted); font-size: 13px; }
summary:hover { color: var(--fg); }
details ul { margin: 8px 0 0; padding-left: 20px; color: var(--muted);
             font-size: 13px; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.filter {
  margin: 10px 0 0; padding: 6px 10px; width: 100%; max-width: 340px;
  border: 1px solid var(--line); border-radius: 7px;
  background: var(--bg); color: var(--fg); font: inherit; font-size: 13px;
}
.empty { color: var(--muted); padding: 8px 0; }
footer { margin-top: 48px; color: var(--muted); font-size: 12px;
         border-top: 1px solid var(--line); padding-top: 12px; }
`;

/**
 * Filtering is the one thing worth a script: a corpus of 64 mechanics is a lot
 * to scan by eye. Everything else is plain markup and `<details>`, so the page
 * is fully readable with scripting off — which a report handed to someone else
 * has to be.
 */
const CLIENT = `
for (const box of document.querySelectorAll("[data-filter]")) {
  const table = document.getElementById(box.dataset.filter);
  if (!table) continue;
  box.addEventListener("input", () => {
    const q = box.value.trim().toLowerCase();
    for (const row of table.tBodies[0].rows) {
      row.hidden = q !== "" && !row.dataset.search.includes(q);
    }
  });
}
`;

/**
 * A bar for `done of total`, with the label spelled out rather than left to
 * the reader.
 *
 * Two things this gets right that the obvious version does not. A surface with
 * nothing in it renders EMPTY, not full — a green bar next to `0/0` reads as
 * "all covered" when the honest answer is "nothing to cover". And the label
 * says what the fill means, because the fill counts claimed *and* ignored
 * while the column beside it counts only claimed: without the words, `56/57`
 * next to a full bar looks like a bug.
 */
function bar(done: number, total: number, label: string): string {
  if (total === 0) {
    return `<span class="bar empty" role="img" aria-label="0 of 0 ${label}"></span>`;
  }
  const pct = Math.round((done / total) * 100);
  const gap = done < total;
  return `<span class="bar${gap ? " gap" : ""}" role="img" aria-label="${done} of ${total} ${label}"><i style="width:${pct}%"></i></span>`;
}

function surfacesTable(manifest: MechanicsManifest): string {
  if (manifest.surfaces.length === 0) {
    return `<p class="empty">No adapters declared for this app — nothing to cover.</p>`;
  }
  const rows = manifest.surfaces.map((s) => {
    const b = manifest.coverage[s.kind] ?? { total: 0, claimed: 0, ignored: 0, unclaimed: [] };
    return `<tr>
      <td><code>${escapeHtml(s.kind)}</code></td>
      <td>${escapeHtml(s.label)}</td>
      <td class="num">${b.claimed}/${b.total}</td>
      <td>${bar(b.claimed + b.ignored, b.total, "covered")}</td>
      <td class="num">${b.ignored}</td>
      <td class="num${b.unclaimed.length > 0 ? " untested" : ""}">${b.unclaimed.length}</td>
    </tr>`;
  });

  // The unclaimed items ARE the finding. Collapsed so the page stays scannable,
  // present so nobody has to run the CLI to learn what is missing.
  const gaps = manifest.surfaces
    .map((s) => {
      const items = manifest.coverage[s.kind]?.unclaimed ?? [];
      if (items.length === 0) return "";
      return `<details>
        <summary>${items.length} unclaimed ${escapeHtml(s.label)}${items.length === 1 ? "" : "s"}</summary>
        <ul>${items.map((i) => `<li><code>${escapeHtml(i)}</code></li>`).join("")}</ul>
      </details>`;
    })
    .join("");

  return `<div class="panel"><table>
    <thead><tr>
      <th>Kind</th><th>Surface</th><th class="num">Claimed</th>
      <th>Covered <span class="hint">(claimed + ignored)</span></th>
      <th class="num">Ignored</th><th class="num">Gaps</th>
    </tr></thead>
    <tbody>${rows.join("")}</tbody>
  </table></div>${gaps}`;
}

function mechanicRow(m: ManifestMechanic, areaTitle: string): string {
  const tests =
    m.tests.length > 0
      ? `<span class="mono">${m.tests.length}</span>`
      : m.verify === "manual-only"
        ? `<span class="pill">manual</span>`
        : `<span class="untested">none</span>`;
  const flags = [
    m.status !== "active" ? `<span class="pill ${m.status}">${m.status}</span>` : "",
    m.priority === "p0" ? `<span class="pill p0">p0</span>` : "",
    m.destructive ? `<span class="pill destructive">destructive</span>` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const search = `${m.id} ${m.title} ${areaTitle} ${m.status} ${m.priority}`.toLowerCase();
  return `<tr data-search="${escapeHtml(search)}">
    <td><code>${escapeHtml(m.id)}</code></td>
    <td>${escapeHtml(m.title)} ${flags}</td>
    <td>${escapeHtml(areaTitle)}</td>
    <td class="num">${m.criteria.length}</td>
    <td class="num">${tests}</td>
  </tr>`;
}

function mechanicsTable(manifest: MechanicsManifest): string {
  if (manifest.mechanics.length === 0) {
    return `<p class="empty">No mechanics yet.</p>`;
  }
  const areaTitle = new Map(manifest.areas.map((a) => [a.slug, a.title]));
  // Area order, then id — the same order the corpus reads in, so the page and
  // the directory tree agree.
  const ordered = manifest.areas.flatMap((area) =>
    manifest.mechanics.filter((m) => m.area === area.slug)
  );
  const orphans = manifest.mechanics.filter((m) => !areaTitle.has(m.area));
  const rows = [...ordered, ...orphans]
    .map((m) => mechanicRow(m, areaTitle.get(m.area) ?? m.area))
    .join("");

  const id = `mech-${manifest.appSlug}`;
  return `<input class="filter" type="search" data-filter="${escapeHtml(id)}"
      placeholder="Filter ${manifest.mechanics.length} mechanics…" aria-label="Filter mechanics">
    <div class="panel"><table id="${escapeHtml(id)}">
      <thead><tr>
        <th>ID</th><th>Behaviour</th><th>Area</th>
        <th class="num">ACs</th><th class="num">Tests</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

function wavesSection(app: ReportApp): string {
  if (app.waves.length === 0) {
    return `<h3>Waves</h3><p class="empty">No verification wave has been opened.</p>`;
  }
  const rows = app.waves.map((wave) => {
    const s = summarizeWave(wave, app.manifest.mechanics);
    const verified = s.counts.pass + s.counts["n-a"];
    const trouble = (status: "fail" | "blocked") =>
      wave.verifications.filter((v) => v.status === status).map((v) => v.mechanic);
    const fails = trouble("fail");
    const blocked = trouble("blocked");
    const detail = [
      fails.length > 0
        ? `<div class="st-fail">failing: ${fails.map((f) => `<code>${escapeHtml(f)}</code>`).join(", ")}</div>`
        : "",
      blocked.length > 0
        ? `<div class="st-blocked">blocked: ${blocked.map((b) => `<code>${escapeHtml(b)}</code>`).join(", ")}</div>`
        : "",
    ].join("");
    return `<tr>
      <td><code>${escapeHtml(s.slug)}</code><br><span class="sub">${escapeHtml(s.title)}</span>${detail}</td>
      <td><span class="pill">${escapeHtml(s.status)}</span></td>
      <td class="num">${verified}/${s.scopeSize}</td>
      <td>${bar(verified, s.scopeSize, "verified")}</td>
      <td class="num st-fail">${s.counts.fail || ""}</td>
      <td class="num st-pending">${s.counts.pending || ""}</td>
    </tr>`;
  });
  return `<h3>Waves</h3><div class="panel"><table>
    <thead><tr>
      <th>Wave</th><th>Status</th><th class="num">Verified</th><th></th>
      <th class="num">Fail</th><th class="num">Pending</th>
    </tr></thead>
    <tbody>${rows.join("")}</tbody>
  </table></div>`;
}

/**
 * The page's answer, before the page's evidence.
 *
 * A reader arrives with one question — is this corpus keeping up with the app?
 * — and the tables below answer it only after they have been read and summed.
 * The lede states it in words and the meters show the three ratios it rests
 * on, so scrolling is what you do to check the claim rather than to find it.
 *
 * COVERED counts claimed + ignored: an explicitly excused surface is accounted
 * for, and counting it as a gap would make the ignore list meaningless.
 */
function summaryBand(app: ReportApp): string {
  const m = app.manifest;
  const t = m.testCoverage;

  const buckets = m.surfaces.map((s) => m.coverage[s.kind]).filter((b) => b !== undefined);
  const totals = buckets.reduce(
    (a, b) => ({ covered: a.covered + b.claimed + b.ignored, total: a.total + b.total }),
    { covered: 0, total: 0 }
  );
  const gaps = buckets.reduce((n, b) => n + b.unclaimed.length, 0);
  const pct = (n: number, d: number) => (d === 0 ? 100 : Math.round((n / d) * 100));

  const open = app.waves
    .map((w) => summarizeWave(w, m.mechanics))
    .filter((s) => s.status === "open");
  const failing = open.reduce((n, s) => n + s.counts.fail, 0);
  const verified = open.reduce((n, s) => n + s.counts.pass + s.counts["n-a"], 0);
  const inScope = open.reduce((n, s) => n + s.scopeSize, 0);

  // Each clause is dropped rather than rendered as a zero: "0 gaps remain" is
  // noise, and an app with no open wave should not be told about waves at all.
  // An app with no inventory gets a different sentence entirely — "100% of 0
  // surfaces" is the same lie the empty-bar rule exists to prevent.
  const clauses = [
    totals.total === 0
      ? `<strong>${m.mechanicCount} behaviour${m.mechanicCount === 1 ? "" : "s"}</strong>, and no surface inventory to check them against.`
      : `<strong>${m.mechanicCount} behaviour${m.mechanicCount === 1 ? "" : "s"}</strong> account for <strong>${pct(totals.covered, totals.total)}%</strong> of ${totals.total} shipped surface${totals.total === 1 ? "" : "s"}.`,
    gaps > 0
      ? `<span class="untested">${gaps} gap${gaps === 1 ? "" : "s"}</span> remain.`
      : `Every surface is claimed or explicitly ignored.`,
    open.length > 0
      ? `${open.length === 1 ? "One wave is" : `${open.length} waves are`} open at <strong>${verified}/${inScope}</strong>${failing > 0 ? `, with <span class="st-fail">${failing} failing</span>` : ""}.`
      : "",
  ].filter(Boolean);

  const meters: Array<[string, number, number]> = [
    ["Surfaces covered", totals.covered, totals.total],
    ["Behaviours with a linked test", t.withTests, m.mechanicCount],
  ];
  if (open.length > 0) meters.push(["Wave verified", verified, inScope]);

  return `<div class="band">
    <p class="lede">${clauses.join(" ")}</p>
    ${meters
      .map(
        ([label, n, d]) => `<div class="meter-row">
      <span class="meter-l">${escapeHtml(label)}</span>
      <span class="meter${d === 0 ? " empty" : ""}"><i class="${n >= d ? "" : "gap"}" style="width:${d === 0 ? 0 : pct(n, d)}%"></i></span>
      <span class="meter-n mono">${n}/${d}</span>
    </div>`
      )
      .join("")}
  </div>`;
}

function appSection(app: ReportApp): string {
  const m = app.manifest;
  const t = m.testCoverage;
  return `<section>
    <h2>${escapeHtml(m.appSlug)}</h2>
    <p class="sub">${m.areas.length} area${m.areas.length === 1 ? "" : "s"} ·
      ${t.manualOnly} manual-only,
      <span class="${t.untested > 0 ? "untested" : ""}">${t.untested} untested</span></p>
    ${summaryBand(app)}
    <h3>Surface coverage</h3>
    ${surfacesTable(m)}
    ${wavesSection(app)}
    <h3>Behaviours</h3>
    ${mechanicsTable(m)}
  </section>`;
}

export function renderReport(apps: ReportApp[], options: ReportOptions): string {
  const title = options.title ?? "Mechanics coverage";
  const total = apps.reduce((n, a) => n + a.manifest.mechanicCount, 0);
  const body =
    apps.length === 0
      ? `<p class="empty">No onboarded app has a committed manifest yet. Run <code>mechanics build --all</code>.</p>`
      : apps.map(appSection).join("");

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
  <h1>${escapeHtml(title)}</h1>
  <p class="sub">${apps.length} app${apps.length === 1 ? "" : "s"} · ${total} documented behaviour${total === 1 ? "" : "s"}${
    options.revision ? ` · <code>${escapeHtml(options.revision)}</code>` : ""
  }</p>
  ${body}
  <footer>
    Generated ${escapeHtml(options.generatedAt)} from the committed manifests.
    Regenerate with <code>mechanics report --html</code>.
  </footer>
</main>
<script>${CLIENT}</script>
</body>
</html>
`;
}
