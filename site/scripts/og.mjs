/**
 * Regenerate the site's og:image.
 *
 *   node scripts/og.mjs      (from site/)
 *
 * Same approach as `scripts/shots.mjs` in the repo root: render real HTML with
 * the tool's own tokens and screenshot it, rather than drawing a card by hand
 * in an image editor. The numbers in it are perch's real numbers.
 *
 * Requires `agent-browser` on PATH and its browser installed
 * (`agent-browser install`). The output is committed, because CI has no
 * browser and the image changes about once a year.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "../public/og.png");
const WORK = path.resolve(HERE, "../.og");
const SESSION = "mechanics-og";

const HTML = `<!doctype html>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@400;500;600;700&family=Fira+Code:wght@400;500&display=swap">
<style>
  /* Slate's dark ground. A share card lands on someone else's timeline with
     no theme of ours around it, so it commits to one — the terminal's, which
     is the half of the palette that does not change between themes. The faces
     fall back to the system stack: this renders in a headless browser with no
     network guaranteed. */
  :root {
    --bg: #101014; --panel: #191b1e; --line: #2a2d32; --fg: #f0f1f3;
    --text: #b9bbc1; --muted: #8b8e96; --dim: #55575e;
    --ok: #37b99f; --warn: #e0b45c; --accent: #37b99f;
    --sans: "Bricolage Grotesque", ui-sans-serif, -apple-system, "Segoe UI",
            system-ui, sans-serif;
    --mono: "Fira Code", ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    width: 1200px; height: 630px; background: var(--bg); color: var(--fg);
    font: 16px/1.5 var(--sans);
    display: grid; grid-template-columns: 1fr 470px; align-items: center;
    gap: 56px; padding: 64px 64px 64px 72px;
  }
  .mark { font-size: 18px; font-weight: 700; color: var(--fg);
          letter-spacing: -0.02em; margin-bottom: 26px; }
  h1 { font-size: 62px; line-height: 1.04; letter-spacing: -0.035em;
       font-weight: 700; margin: 0 0 22px; }
  p { font-size: 23px; line-height: 1.42; color: var(--muted); margin: 0;
      max-width: 20ch; }
  p b { color: var(--fg); font-weight: 600; }
  .url { position: absolute; left: 72px; bottom: 52px; font-size: 17px;
         color: var(--dim); font-family: var(--mono); }
  .card { border-radius: 14px; background: var(--panel); overflow: hidden;
          box-shadow: 0 20px 50px -28px rgba(0, 0, 0, 0.6); }
  .chrome { display: flex; align-items: center; gap: 7px; padding: 13px 17px;
            border-bottom: 1px solid var(--line); }
  .chrome i { width: 11px; height: 11px; border-radius: 50%;
              background: #34363c; }
  pre { margin: 0; padding: 20px 22px; font-family: var(--mono);
        font-size: 15px; line-height: 1.78; white-space: pre;
        color: var(--text); }
  .ok { color: var(--ok); } .warn { color: var(--warn); }
  .dim { color: var(--dim); } .b { font-weight: 600; color: var(--fg); }
</style>
<body>
  <div>
    <div class="mark">mechanics</div>
    <h1>did we keep<br>every behaviour?</h1>
    <p>Behaviour specs with a <b>coverage ratchet</b>.</p>
    <div class="url">mechanics.hansenexus.dev</div>
  </div>
  <section class="card">
    <div class="chrome"><i></i><i></i><i></i></div>
<pre><span class="b">38/42</span> surfaces covered

 route            10/12  <span class="ok">—————————</span><span class="dim">—</span> <span class="warn">2 gaps</span>
 api-route         4/5   <span class="ok">————————</span><span class="dim">——</span> <span class="warn">1 gap</span>
 convex-function  16/17  <span class="ok">—————————</span><span class="dim">—</span> <span class="warn">1 gap</span>
 cron              3/3   <span class="ok">——————————</span> <span class="dim">100%</span>
 http-endpoint     2/2   <span class="ok">——————————</span> <span class="dim">100%</span>

 <span class="warn">⚠ route</span>           /login
 <span class="warn">⚠ api-route</span>       /api/webhooks/stripe</pre>
  </section>
</body>
`;

function ab(args) {
  const r = spawnSync("agent-browser", ["--session", SESSION, ...args], { stdio: "inherit" });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`agent-browser ${args[0]} exited ${r.status}`);
}

mkdirSync(WORK, { recursive: true });
mkdirSync(path.dirname(OUT), { recursive: true });
const page = path.join(WORK, "og.html");
writeFileSync(page, HTML);

// Exactly 1200x630 at 2x, which is what every card renderer wants. No
// `--full` here: the body is already the card, so growing to the document
// would only add whatever the viewport did not cover.
ab(["set", "viewport", "1200", "630", "2"]);
ab(["open", `file://${page}`]);
ab(["screenshot", OUT]);

console.log(`og: ${path.relative(process.cwd(), OUT)}`);
