/**
 * Regenerate the README screenshots from the `examples/perch` corpus.
 *
 *   bun run docs:shots
 *
 * Every pixel here comes from actually running the CLI: the terminal cards
 * hold captured stdout verbatim, and the report card is the real
 * `mechanics report --html` page. Nothing is drawn by hand, so a screenshot
 * that stops matching the tool is a screenshot that fails to regenerate rather
 * than one that quietly lies.
 *
 * The drift-gate shot needs a corpus that has drifted, so it edits a mechanic,
 * captures the failure, and restores the file — in a `finally`, because
 * leaving the example dirty would be a worse outcome than a missing shot.
 *
 * Requires `agent-browser` on PATH (https://github.com/anthropics/agent-browser)
 * and its browser installed (`agent-browser install`).
 *
 * The card HTML links Google Fonts, which is the one place in this repo that
 * is allowed to: the output is a committed PNG, so the request happens on the
 * machine regenerating the shots and never on a reader's. Without it the cards
 * would be set in the system mono while the site sets the same text in Fira
 * Code, and the two would stop being pictures of each other.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE = path.join(ROOT, "examples", "perch");
const CLI = path.join(ROOT, "cli.ts");
const OUT = path.join(ROOT, "docs", "images");
const WORK = path.join(ROOT, ".shots");

const VIEWPORT = { width: 1180 };
/** Shorter than any card, so `--full` always grows to the real content. */
const MIN_HEIGHT = 80;
const SESSION = "mechanics-shots";

/**
 * Run the CLI in the example repo and return what a terminal would show.
 *
 * Through a shell with `2>&1` rather than reading two pipes: warnings go to
 * stderr and the summary to stdout, so concatenating the two streams would put
 * the summary above its own warnings and misrepresent what the command
 * actually prints.
 */
function cli(args) {
  const cmd = ["bun", CLI, ...args].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  const res = spawnSync("sh", ["-c", `${cmd} 2>&1`], {
    cwd: EXAMPLE,
    encoding: "utf8",
    // The CLI suppresses colour when stdout is not a TTY, which this is not.
    // Asking for it back means the cards show the terminal's real palette
    // rather than a second guess at which words deserve which colour.
    env: { ...process.env, FORCE_COLOR: "1" },
  });
  if (res.error) throw res.error;
  return (res.stdout ?? "").replace(/^\n+/, "").replace(/\n+$/, "");
}

function ab(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("agent-browser", args, {
      env: { ...process.env, AGENT_BROWSER_SESSION: SESSION },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`agent-browser ${args[0]} failed: ${err}`))
    );
  });
}

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** SGR code → class. Only the codes the CLI actually emits. */
const SGR = { 1: "b", 2: "dim", 31: "bad", 32: "ok", 33: "warn" };

/**
 * Convert the captured ANSI into spans.
 *
 * This used to guess — regexes over the plain text deciding which lines looked
 * like warnings. It drifted the moment the CLI's output changed shape: a line
 * containing "3 fail" was painted red end to end, bars were left grey, and the
 * screenshots stopped matching the terminal. Reading the escapes the CLI
 * already emits means the card cannot disagree with the tool.
 */
function ansiToHtml(text) {
  let out = "";
  let open = 0;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: parsing SGR escapes is the point
  const re = /\u001b\[(\d+)m/g;
  let last = 0;
  let m = re.exec(text);
  while (m !== null) {
    out += escapeHtml(text.slice(last, m.index));
    const code = Number(m[1]);
    if (code === 0) {
      out += "</span>".repeat(open);
      open = 0;
    } else if (SGR[code]) {
      out += `<span class="${SGR[code]}">`;
      open += 1;
    }
    last = m.index + m[0].length;
    m = re.exec(text);
  }
  out += escapeHtml(text.slice(last));
  return out + "</span>".repeat(open);
}

/** One terminal card: a prompt line, then the captured output. */
function terminalPage(cards) {
  const blocks = cards
    .map(
      (c) => `<section class="card">
  <div class="chrome"><i></i><i></i><i></i><span>${escapeHtml(c.caption)}</span></div>
  <pre><span class="prompt">$</span> <span class="cmd">${escapeHtml(c.command)}</span>
${ansiToHtml(c.output)}</pre>
</section>`
    )
    .join("\n");

  return `<!doctype html>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@400;500;600;700&family=Fira+Code:wght@400;500&display=swap">
<style>
  /* Slate's dark ground — the same values the site's TerminalCard component
     uses, so a card on the site and the PNG beside it are the same picture. */
  :root {
    --bg: #101014; --panel: #191b1e; --line: #2a2d32; --fg: #f0f1f3;
    --text: #b9bbc1; --muted: #8b8e96; --dim: #55575e;
    --ok: #37b99f; --warn: #e0b45c; --bad: #e8837a; --accent: #37b99f;
    --mono: "Fira Code", ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text); padding: 28px;
    font: 14px/1.5 "Bricolage Grotesque", ui-sans-serif, -apple-system,
          "Segoe UI", system-ui, sans-serif;
  }
  .card {
    border: 1px solid var(--line); border-radius: 12px; background: var(--panel);
    overflow: hidden; margin-bottom: 20px;
  }
  .card:last-child { margin-bottom: 0; }
  .chrome {
    display: flex; align-items: center; gap: 7px;
    padding: 12px 17px; border-bottom: 1px solid var(--line);
  }
  .chrome i {
    width: 10px; height: 10px; border-radius: 50%; background: #34363c;
    flex: none;
  }
  .chrome span { margin-left: 9px; color: var(--muted); font-family: var(--mono);
                 font-size: 11.5px; }
  pre {
    margin: 0; padding: 17px 20px; overflow-x: auto;
    font-family: var(--mono);
    font-size: 12.5px; line-height: 1.75; white-space: pre; color: var(--text);
  }
  .prompt { color: var(--accent); }
  .cmd { color: var(--fg); font-weight: 500; }
  .ok { color: var(--ok); }
  .warn { color: var(--warn); }
  .bad { color: var(--bad); }
  .b { font-weight: 600; color: var(--fg); }
  .dim { color: var(--dim); }
</style>
${blocks}
`;
}

/**
 * Shoot the page at its own height.
 *
 * `--full` expands to the document but never shrinks below the viewport, so a
 * short page shot at a tall viewport ends up as a card floating in a field of
 * empty background. Starting from a deliberately short viewport means the
 * expansion always does the work and the image is exactly the content.
 */
async function shoot(htmlPath, pngPath) {
  await ab(["set", "viewport", String(VIEWPORT.width), String(MIN_HEIGHT)]);
  await ab(["open", `file://${htmlPath}`]);
  await ab(["screenshot", "--full", pngPath]);
  console.log(`  ${path.relative(ROOT, pngPath)}`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(WORK, { recursive: true });

  const mechanicPath = path.join(EXAMPLE, "mechanics", "monitors", "create-monitor.md");
  const pristine = readFileSync(mechanicPath, "utf8");

  try {
    console.log("capturing CLI output…");
    const coverage = cli(["coverage", "--app=perch"]);
    const check = cli(["check", "--app=perch"]);

    // Drift only exists once something has drifted.
    writeFileSync(
      mechanicPath,
      pristine.replace(
        "## Edge Cases",
        "- **AC5** Given a monitor is created, When the workspace has no status page,\n" +
          "  Then one is published automatically.\n\n## Edge Cases"
      )
    );
    const drift = cli(["build", "--all", "--check"]);
    writeFileSync(mechanicPath, pristine);

    const gate = cli(["build", "--all", "--check"]);
    if (!gate.includes("up to date")) {
      throw new Error(`example left dirty after the drift shot:\n${gate}`);
    }

    console.log("rendering…");
    const covHtml = path.join(WORK, "coverage.html");
    writeFileSync(
      covHtml,
      terminalPage([
        {
          caption: "Coverage: what the app ships, against what the corpus claims",
          command: "mechanics coverage --app=perch",
          output: coverage,
        },
      ])
    );

    const gateHtml = path.join(WORK, "gate.html");
    writeFileSync(
      gateHtml,
      terminalPage([
        {
          caption: "The drift gate: an edited mechanic with a stale manifest",
          command: "mechanics build --all --check",
          output: drift,
        },
        {
          caption: "Validation: the corpus parses, and every gap is named",
          command: "mechanics check --app=perch",
          output: check,
        },
      ])
    );

    const reportHtml = path.join(WORK, "report.html");
    cli(["report", "--html", `--out=${reportHtml}`]);

    // Light, not dark. The terminal cards paint their own dark ground whatever
    // the media query says, so this only decides which way the report goes —
    // and Slate's report is a grey canvas with white cards. Shooting it dark
    // would put a near-black slab in the middle of a light page.
    console.log("shooting (light, 1180px)…");
    await ab(["set", "media", "light"]);

    await shoot(covHtml, path.join(OUT, "coverage.png"));
    await shoot(gateHtml, path.join(OUT, "drift-gate.png"));
    await shoot(reportHtml, path.join(OUT, "report.png"));

    await ab(["close"]).catch(() => {});
  } finally {
    // Whatever happened above, the example must not be left edited.
    writeFileSync(mechanicPath, pristine);
    rmSync(WORK, { recursive: true, force: true });
  }
}

await main();
