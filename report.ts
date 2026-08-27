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

/**
 * Slate. The page is a grey canvas with white cards on it, not white with grey
 * panels — the inversion is what makes a table read as an object you can point
 * at rather than as more page. Every colour below is also in
 * `site/src/styles/tokens.css`; change it here first and mirror it there, so a
 * terminal block on the site and the same block in a generated report are the
 * same colours.
 *
 * The fonts are named, not fetched. This file has to render from `file://` six
 * months from now with no network, so Bricolage Grotesque and Fira Code are a
 * preference that degrades to the system stack rather than a request.
 *
 * Nothing in here may contain a backtick: it is a template literal, and one
 * stray backtick ends the stylesheet mid-rule.
 */
const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #eef0f3; --panel: #ffffff; --fg: #191b1e; --text: #3a3d42;
  --muted: #6e7178; --off: #a9adb5;
  --line: #d9dce1; --rule: #e6e8ec; --track: #e6e8ec;
  --accent: #0f7b6c; --ok: #0f7b6c; --warn: #b3690f; --bad: #c4392e;
  --tint-bad: rgba(196, 57, 46, 0.08);
  --tint-warn: rgba(179, 105, 15, 0.09);
  --tint-off: rgba(110, 113, 120, 0.1);
  --mono: "Fira Code", ui-monospace, SFMono-Regular, Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #101014; --panel: #191b1e; --fg: #f0f1f3; --text: #b9bbc1;
    --muted: #8b8e96; --off: #55575e;
    --line: #2a2d32; --rule: #232529; --track: #2a2d32;
    --accent: #37b99f; --ok: #37b99f; --warn: #e0b45c; --bad: #e8837a;
    --tint-bad: rgba(232, 131, 122, 0.12);
    --tint-warn: rgba(224, 180, 92, 0.12);
    --tint-off: rgba(185, 187, 193, 0.1);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 14px/1.55 "Bricolage Grotesque", ui-sans-serif, -apple-system,
        "Segoe UI", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}
main { max-width: 1100px; margin: 0 auto; padding: 40px 24px 64px; }
/* Title and provenance share a baseline: what the page is, and which tree it
   describes, are one statement. */
.head { display: flex; justify-content: space-between; align-items: baseline;
        gap: 16px; flex-wrap: wrap; }
h1 { font-size: 24px; margin: 0 0 4px; letter-spacing: -0.02em; font-weight: 700;
     color: var(--fg); }
h2 { font-size: 19px; margin: 44px 0 2px; letter-spacing: -0.02em; font-weight: 700;
     color: var(--fg); }
/* Section labels are mono and small: they name the evidence below them, and
   nothing above a table should compete with the table for weight. */
h3 { font-family: var(--mono); font-size: 11px; text-transform: uppercase;
     letter-spacing: 0.1em; color: var(--off); margin: 28px 0 10px;
     font-weight: 500; }
.sub { color: var(--off); font-size: 12.5px; font-family: var(--mono); }
.mono { font-family: var(--mono); font-variant-numeric: tabular-nums;
        font-size: 12.5px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th {
  text-align: left; font-family: var(--mono); font-weight: 500; font-size: 11px;
  color: var(--off); text-transform: uppercase; letter-spacing: 0.08em;
  border-bottom: 1px solid var(--rule); padding: 10px 16px;
}
td { padding: 9px 16px; border-top: 1px solid var(--rule); vertical-align: top;
     color: var(--text); }
thead + tbody tr:first-child td { border-top: 0; }
td.num, th.num { text-align: right; font-family: var(--mono); font-size: 12.5px;
                 font-variant-numeric: tabular-nums; }
.panel {
  border: 1px solid var(--line); border-radius: 12px; background: var(--panel);
  overflow: hidden; margin-top: 8px;
}
/* A bar, not a number: 40/40 and 19/28 read identically in a column of
   figures, and the gap is the whole point of the page. */
.bar { display: block; height: 6px; border-radius: 3px; background: var(--track);
       overflow: hidden; min-width: 90px; }
.bar i { display: block; height: 100%; border-radius: 3px; background: var(--ok); }
/* Coverage is teal whether or not it is complete — the Gaps column beside it
   already names the shortfall, and colouring both says it twice. A wave bar is
   amber when short, because nothing else in that row carries the shortfall. */
.bar.warn i { background: var(--warn); }
/* Nothing to cover is not full coverage — an empty track says so. */
.bar.empty { opacity: 0.45; }
/* The summary band: the page's answer, above the page's evidence. */
.band {
  border: 1px solid var(--line); border-radius: 12px; background: var(--panel);
  padding: 22px 26px 16px; margin-top: 14px;
}
.lede { margin: 0 0 18px; font-size: 16px; line-height: 1.55; max-width: 62ch;
        color: var(--fg); }
.lede strong { font-weight: 700; }
.lede strong.hi { color: var(--accent); }
.meter-row {
  display: grid; grid-template-columns: minmax(120px, 220px) 1fr 62px;
  gap: 14px; align-items: center; padding: 5px 0; font-size: 12.5px;
}
.meter-l { color: var(--muted); font-family: var(--mono); }
.meter {
  display: block; height: 7px; border-radius: 4px; background: var(--track);
  overflow: hidden;
}
.meter i { display: block; height: 100%; border-radius: 4px; background: var(--ok); }
.meter i.warn { background: var(--warn); }
.meter.empty { opacity: 0.45; }
.meter-n { text-align: right; color: var(--muted); font-family: var(--mono); }
@media (max-width: 560px) {
  .meter-row { grid-template-columns: 1fr 56px; }
  .meter-row .meter { grid-column: 1 / -1; order: 3; }
}
.hint { font-weight: 400; text-transform: none; letter-spacing: 0; }
/* Tinted rather than outlined: a row can carry three of these, and three
   ringed pills in a table cell read as controls. */
.pill {
  display: inline-block; font-family: var(--mono); font-size: 10.5px;
  padding: 1px 8px; border-radius: 5px; background: var(--tint-off);
  color: var(--muted); white-space: nowrap;
}
.pill.p0, .pill.destructive { background: var(--tint-bad); color: var(--bad); }
.pill.draft { background: var(--tint-warn); color: var(--warn); }
.pill.deprecated { text-decoration: line-through; }
.st-pass { color: var(--ok); }
.st-fail, .st-blocked { color: var(--bad); font-family: var(--mono); font-size: 12px; }
.st-pending { color: var(--muted); }
.st-na { color: var(--muted); }
.untested { color: var(--warn); }
details { margin: 6px 0 10px; }
summary { cursor: pointer; color: var(--muted); font-size: 13px; }
summary:hover { color: var(--fg); }
details ul { margin: 8px 0 0; padding-left: 20px; color: var(--muted);
             font-size: 13px; }
code { font-family: var(--mono); font-size: 12.5px; }
.filter {
  margin: 10px 0 0; padding: 8px 14px; width: 100%; max-width: 340px;
  border: 1px solid var(--line); border-radius: 8px;
  background: var(--panel); color: var(--fg); font: inherit; font-size: 13px;
}
.filter::placeholder { color: var(--off); }
.filter:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.empty { color: var(--muted); padding: 8px 0; }
footer { margin-top: 32px; color: var(--off); font-size: 12px;
         font-family: var(--mono); border-top: 1px solid var(--line);
         padding-top: 14px; }
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
 * nothing in it renders EMPTY, not full — an accent bar next to `0/0` reads as
 * "all covered" when the honest answer is "nothing to cover". And the label
 * says what the fill means, because the fill counts claimed *and* ignored
 * while the column beside it counts only claimed: without the words, `56/57`
 * next to a full bar looks like a bug.
 *
 * `tone` is which shortfall the bar is allowed to shout about. A coverage bar
 * sits next to a Gaps column that already names the shortfall, so it stays
 * accent-coloured; a wave bar is the only thing in its row carrying "not
 * finished", so it goes amber.
 */
function bar(done: number, total: number, label: string, tone: "cover" | "verify"): string {
  if (total === 0) {
    return `<span class="bar empty" role="img" aria-label="0 of 0 ${label}"></span>`;
  }
  const pct = Math.round((done / total) * 100);
  const short = tone === "verify" && done < total;
  return `<span class="bar${short ? " warn" : ""}" role="img" aria-label="${done} of ${total} ${label}"><i style="width:${pct}%"></i></span>`;
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
      <td>${bar(b.claimed + b.ignored, b.total, "covered", "cover")}</td>
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
      <td>${bar(verified, s.scopeSize, "verified", "verify")}</td>
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
      : `<strong>${m.mechanicCount} behaviour${m.mechanicCount === 1 ? "" : "s"}</strong> account for <strong class="hi">${pct(totals.covered, totals.total)}%</strong> of ${totals.total} shipped surface${totals.total === 1 ? "" : "s"}.`,
    gaps > 0
      ? `<span class="untested">${gaps} gap${gaps === 1 ? "" : "s"}</span> remain.`
      : `Every surface is claimed or explicitly ignored.`,
    open.length > 0
      ? `${open.length === 1 ? "One wave is" : `${open.length} waves are`} open at <strong>${verified}/${inScope}</strong>${failing > 0 ? `, with <span class="st-fail">${failing} failing</span>` : ""}.`
      : "",
  ].filter(Boolean);

  // Same rule as `bar`: the two coverage ratios keep the accent whatever they
  // read, because the gap counts are stated in words directly above them. The
  // wave ratio is the one number with nothing else beside it, so it goes amber
  // the moment it is short.
  const meters: Array<[string, number, number, "cover" | "verify"]> = [
    ["Surfaces covered", totals.covered, totals.total, "cover"],
    ["Behaviours with a linked test", t.withTests, m.mechanicCount, "cover"],
  ];
  if (open.length > 0) meters.push(["Wave verified", verified, inScope, "verify"]);

  return `<div class="band">
    <p class="lede">${clauses.join(" ")}</p>
    ${meters
      .map(
        ([label, n, d, tone]) => `<div class="meter-row">
      <span class="meter-l">${escapeHtml(label)}</span>
      <span class="meter${d === 0 ? " empty" : ""}"><i class="${tone === "verify" && n < d ? "warn" : ""}" style="width:${d === 0 ? 0 : pct(n, d)}%"></i></span>
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
  <div class="head">
    <h1>${escapeHtml(title)}</h1>
    <p class="sub">${apps.length} app${apps.length === 1 ? "" : "s"} · ${total} documented behaviour${total === 1 ? "" : "s"}${
      options.revision ? ` · <code>${escapeHtml(options.revision)}</code>` : ""
    }</p>
  </div>
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
