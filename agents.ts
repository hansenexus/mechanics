/**
 * Which agent runs the work, and how it is allowed to change the tree.
 *
 * `run dispatch` used to hardcode `claude`. That was fine while there was one
 * harness worth pointing at and wrong the moment there were several: a repo on
 * a locked-down network, a team standardised on a different CLI, or a machine
 * with a local model and no API budget all want the same pipeline —
 * scan, gaps, propose, fix — driven by whatever they actually have.
 *
 * Two shapes, and the difference is not cosmetic:
 *
 *   **Harness providers** (`claude`, `codex`, `qwen`) are agents already. They
 *   have their own tools, their own file access, their own loop. Handing one a
 *   prompt in a worktree is the whole integration; it edits the tree itself.
 *
 *   **Model providers** (`ollama`, `lmstudio`, any OpenAI-compatible endpoint)
 *   are text in, text out. They cannot open a file. Giving them the same
 *   autonomy means giving them a way to SAY what to change and having this
 *   module make the change — so they answer in a small edit protocol
 *   (`EDIT_SCHEMA` below) which is validated, applied, and rolled back as one
 *   unit if the result does not build.
 *
 * What no provider may do, whatever its kind: record a verification verdict,
 * or accept a proposal. Those are refused in `docket-events.ts` and are not
 * about capability — an agent that edits a thousand files is doing work, and
 * an agent that marks its own work green is doing something else. Providers
 * here are given the first without the second, deliberately.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

export type ProviderKind = "harness" | "model";

export interface ProviderSpec {
  name: string;
  kind: ProviderKind;
  /** Harness providers: the binary to run. */
  command?: string;
  /**
   * Argument template. `{prompt}` is replaced with the full prompt; a spec
   * with no `{prompt}` gets it on stdin instead.
   */
  args?: string[];
  /** Model providers: an OpenAI-compatible `/chat/completions` base URL. */
  baseUrl?: string;
  model?: string;
  /** Ollama's native API differs enough to be worth naming. */
  api?: "openai" | "ollama";
  apiKeyEnv?: string;
}

/**
 * What ships known-good. Every one is overridable and none is privileged —
 * `claude` is first because it is what this repo was built against, not
 * because the format prefers it.
 */
export const BUILTIN_PROVIDERS: Record<string, ProviderSpec> = {
  claude: { name: "claude", kind: "harness", command: "claude", args: ["-p", "{prompt}"] },
  codex: { name: "codex", kind: "harness", command: "codex", args: ["exec", "{prompt}"] },
  qwen: { name: "qwen", kind: "harness", command: "qwen", args: ["-p", "{prompt}"] },
  ollama: {
    name: "ollama",
    kind: "model",
    baseUrl: process.env.OLLAMA_HOST ?? "http://localhost:11434",
    model: process.env.MECHANICS_OLLAMA_MODEL ?? "qwen2.5-coder:7b",
    api: "ollama",
  },
  lmstudio: {
    name: "lmstudio",
    kind: "model",
    baseUrl: process.env.LMSTUDIO_HOST ?? "http://localhost:1234/v1",
    model: process.env.MECHANICS_LMSTUDIO_MODEL,
    api: "openai",
  },
};

export const PROVIDER_NAMES = Object.keys(BUILTIN_PROVIDERS);

/**
 * Enough room for a whole file in a `create` edit. Both APIs cap generation by
 * default — Ollama at 128 tokens — and the failure is silent: a truncated JSON
 * object simply does not parse, so it looks like the model answered badly
 * rather than like it was cut off.
 */
const MAX_MODEL_TOKENS = 8192;

// ---------------------------------------------------------------------------
// availability
// ---------------------------------------------------------------------------

export interface Availability {
  name: string;
  kind: ProviderKind;
  available: boolean;
  /** Why not, when not — the actionable half. */
  detail: string;
  /** Model providers: what the endpoint says it has loaded. */
  models?: string[];
}

/**
 * Probe rather than assume.
 *
 * A provider that is configured but not reachable is the single most confusing
 * state to be in — the pipeline appears to hang, or fails deep inside a
 * dispatch with an error about a socket. Checking up front and saying which of
 * five things is actually usable costs one process spawn and one HTTP GET.
 */
export async function probeProvider(spec: ProviderSpec): Promise<Availability> {
  if (spec.kind === "harness") {
    const found = await which(spec.command ?? spec.name);
    return {
      name: spec.name,
      kind: "harness",
      available: Boolean(found),
      detail: found ?? `\`${spec.command ?? spec.name}\` is not on PATH`,
    };
  }

  const url =
    spec.api === "ollama" ? `${trim(spec.baseUrl)}/api/tags` : `${trim(spec.baseUrl)}/models`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) {
      return { name: spec.name, kind: "model", available: false, detail: `${url} → ${res.status}` };
    }
    const body = (await res.json()) as {
      models?: { name?: string }[];
      data?: { id?: string }[];
    };
    const models = (body.models ?? []).map((m) => m.name ?? "").filter(Boolean);
    const ids = (body.data ?? []).map((m) => m.id ?? "").filter(Boolean);
    const found = [...models, ...ids];
    return {
      name: spec.name,
      kind: "model",
      available: true,
      detail: trim(spec.baseUrl),
      models: found,
    };
  } catch (err) {
    return {
      name: spec.name,
      kind: "model",
      available: false,
      detail: `${trim(spec.baseUrl)} unreachable (${err instanceof Error ? err.message : err})`,
    };
  }
}

export async function probeAll(
  specs: ProviderSpec[] = Object.values(BUILTIN_PROVIDERS)
): Promise<Availability[]> {
  return Promise.all(specs.map(probeProvider));
}

/** First available provider, preferring harnesses — they can edit unaided. */
export async function pickDefaultProvider(): Promise<Availability | null> {
  const all = await probeAll();
  return (
    all.find((a) => a.available && a.kind === "harness") ?? all.find((a) => a.available) ?? null
  );
}

// ---------------------------------------------------------------------------
// the edit protocol, for providers that cannot hold a file
// ---------------------------------------------------------------------------

/**
 * What a model provider is allowed to say.
 *
 * Deliberately tiny. A full patch format would need a model to count context
 * lines correctly, which is exactly the thing they are worst at and the
 * failure is silent — a hunk that applies at the wrong offset produces a file
 * that still parses. `replace` is an exact-substring swap that must match
 * once, so a wrong answer fails loudly instead.
 */
export const editSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("replace"),
      path: z.string().min(1),
      find: z.string().min(1),
      replace: z.string(),
    })
    .strict(),
  z.object({ op: z.literal("create"), path: z.string().min(1), content: z.string() }).strict(),
]);

export const editPlanSchema = z
  .object({
    summary: z.string().min(1),
    edits: z.array(editSchema).max(50),
  })
  .strict();

export type Edit = z.infer<typeof editSchema>;
export type EditPlan = z.infer<typeof editPlanSchema>;

export const EDIT_PROTOCOL = `Reply with ONE JSON object and nothing else — no prose, no code fence:

{"summary": "<one line>", "edits": [
  {"op": "replace", "path": "<repo-relative>", "find": "<exact existing text>", "replace": "<new text>"},
  {"op": "create",  "path": "<repo-relative>", "content": "<whole file>"}
]}

Rules:
- "find" must appear EXACTLY ONCE in the file. Include enough surrounding text
  to be unique. If you cannot be sure, return no edit for that file.
- Paths are relative to the repo root and must stay inside it.
- An empty "edits" array is a valid answer. Returning nothing is better than
  returning a guess.`;

/**
 * Pull the JSON object out of a model's reply.
 *
 * Small models fence their JSON, prefix it with "Sure!", or append an
 * explanation, and none of that is worth failing a run over. Anything that is
 * not a parseable object at all IS worth failing over, which is why this
 * returns null rather than an empty plan — "it said nothing usable" and "it
 * proposed no edits" are different answers.
 */
export function parseEditPlan(reply: string): EditPlan | null {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], sliceBraces(reply), reply].filter(Boolean) as string[];
  for (const raw of candidates) {
    try {
      const parsed = editPlanSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function sliceBraces(s: string): string | null {
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  return start >= 0 && end > start ? s.slice(start, end + 1) : null;
}

export interface ApplyEditsResult {
  applied: Edit[];
  written: string[];
  /** Edits refused, with the reason. Never silently dropped. */
  refused: Array<{ edit: Edit; reason: string }>;
  revertedBecause?: string;
}

/**
 * Apply a model's edit plan inside `root`, or none of it.
 *
 * Same posture as `applyAutoFix`: buffer every original, and if the caller's
 * verification says the tree got worse, put every byte back. A model provider
 * has no way to check its own work, so the check has to live here.
 */
export async function applyEdits(
  root: string,
  plan: EditPlan,
  options: {
    verify?: () => Promise<string | null>;
    dryRun?: boolean;
    /**
     * Domain policy: return a reason to refuse this edit, or null to allow it.
     * A callback so this module stays a transport — what counts as forbidden
     * is a fact about mechanics, not about talking to a model.
     */
    guard?: (edit: Edit, before: string | null) => string | null;
  } = {}
): Promise<ApplyEditsResult> {
  const applied: Edit[] = [];
  const written: string[] = [];
  const refused: ApplyEditsResult["refused"] = [];
  const originals = new Map<string, string | null>();

  for (const edit of plan.edits) {
    const abs = path.resolve(root, edit.path);
    if (!abs.startsWith(`${path.resolve(root)}${path.sep}`)) {
      refused.push({ edit, reason: "path escapes the repo root" });
      continue;
    }
    if (edit.op === "create") {
      if (await exists(abs)) {
        refused.push({ edit, reason: "file already exists — use replace" });
        continue;
      }
      const barred = options.guard?.(edit, null);
      if (barred) {
        refused.push({ edit, reason: barred });
        continue;
      }
      originals.set(abs, null);
      if (!options.dryRun) {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, edit.content, "utf8");
      }
      applied.push(edit);
      written.push(edit.path);
      continue;
    }

    let before: string;
    try {
      before = await fs.readFile(abs, "utf8");
    } catch {
      refused.push({ edit, reason: "file does not exist" });
      continue;
    }
    const barred = options.guard?.(edit, before);
    if (barred) {
      refused.push({ edit, reason: barred });
      continue;
    }
    const hits = before.split(edit.find).length - 1;
    if (hits !== 1) {
      // The whole reason the protocol uses exact substrings: a model that got
      // the anchor wrong fails here rather than editing the wrong line.
      refused.push({ edit, reason: `"find" matched ${hits} times, expected exactly 1` });
      continue;
    }
    originals.set(abs, before);
    if (!options.dryRun) await fs.writeFile(abs, before.replace(edit.find, edit.replace), "utf8");
    applied.push(edit);
    written.push(edit.path);
  }

  if (options.dryRun || !options.verify || applied.length === 0) {
    return { applied, written, refused };
  }

  const problem = await options.verify();
  if (!problem) return { applied, written, refused };

  await Promise.all(
    [...originals].map(([abs, before]) =>
      before === null ? fs.rm(abs, { force: true }) : fs.writeFile(abs, before, "utf8")
    )
  );
  return { applied: [], written: [], refused, revertedBecause: problem };
}

// ---------------------------------------------------------------------------
// running
// ---------------------------------------------------------------------------

export interface RunOptions {
  cwd: string;
  /** Harness providers only: return immediately and let it work in background. */
  detach?: boolean;
  timeoutMs?: number;
}

export interface AgentReply {
  provider: string;
  kind: ProviderKind;
  /** Model providers: the raw text. Harness providers: whatever it printed. */
  text: string;
  /** True when a detached harness was launched and no output was collected. */
  detached: boolean;
}

export async function runProvider(
  spec: ProviderSpec,
  prompt: string,
  options: RunOptions
): Promise<AgentReply> {
  return spec.kind === "harness"
    ? runHarness(spec, prompt, options)
    : {
        provider: spec.name,
        kind: "model",
        text: await runModel(spec, prompt, options),
        detached: false,
      };
}

async function runHarness(
  spec: ProviderSpec,
  prompt: string,
  options: RunOptions
): Promise<AgentReply> {
  const command = spec.command ?? spec.name;
  const template = spec.args ?? ["{prompt}"];
  const usesStdin = !template.some((a) => a.includes("{prompt}"));
  const args = template.map((a) => a.replace("{prompt}", prompt));

  if (options.detach) {
    const child = spawn(command, args, { cwd: options.cwd, detached: true, stdio: "ignore" });
    child.unref();
    return { provider: spec.name, kind: "harness", text: "", detached: true };
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = options.timeoutMs
      ? setTimeout(() => child.kill("SIGKILL"), options.timeoutMs)
      : null;
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`${command}: ${e.message}`));
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${command} exited ${code}${err ? `: ${err.trim()}` : ""}`));
        return;
      }
      resolve({ provider: spec.name, kind: "harness", text: out, detached: false });
    });
    // A harness that exits without reading its prompt — a rejected flag, a
    // wrapper that dies on startup — closes the pipe before this write lands,
    // and Node reports that as an EPIPE on `stdin` with no listener, which is
    // an unhandled exception that takes the whole process down. It took the
    // test runner down too, mid-suite, while it was about to report the REAL
    // failure: the non-zero exit and the stderr saying why.
    //
    // Swallowing it loses nothing. A failed write to a process that is gone is
    // never the interesting fact, and `close` and `error` already hold the
    // exit code and the message that explain what actually happened.
    child.stdin.on("error", () => {});
    if (usesStdin) child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function runModel(spec: ProviderSpec, prompt: string, options: RunOptions): Promise<string> {
  const signal = AbortSignal.timeout(options.timeoutMs ?? 180_000);
  const key = spec.apiKeyEnv ? process.env[spec.apiKeyEnv] : undefined;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;

  if (spec.api === "ollama") {
    const res = await fetch(`${trim(spec.baseUrl)}/api/generate`, {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify({
        model: spec.model,
        prompt,
        stream: false,
        // Ollama defaults `num_predict` to 128 tokens, which truncates a JSON
        // edit plan mid-object — and a truncated object parses as nothing, so
        // the failure reads as "the model said something unusable" rather than
        // "the answer was cut off". Deterministic too: an edit plan is not a
        // place for sampling.
        options: { num_predict: MAX_MODEL_TOKENS, temperature: 0 },
      }),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
    return ((await res.json()) as { response?: string }).response ?? "";
  }

  const res = await fetch(`${trim(spec.baseUrl)}/chat/completions`, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      model: spec.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: MAX_MODEL_TOKENS,
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`${spec.name} ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return body.choices?.[0]?.message?.content ?? "";
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

export const providerSpecSchema = z
  .object({
    name: z.string().min(1),
    kind: z.enum(["harness", "model"]),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    baseUrl: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    api: z.enum(["openai", "ollama"]).optional(),
    apiKeyEnv: z.string().min(1).optional(),
  })
  .strict();

/**
 * Resolve a provider by name, honouring per-run overrides.
 *
 * Model selection is a flag or an environment variable rather than a committed
 * setting: which model is on this machine is a fact about the machine, and a
 * repo that pins one is a repo that fails on everybody else's laptop.
 */
export function resolveProvider(
  name: string,
  overrides: Partial<ProviderSpec> = {},
  registry: Record<string, ProviderSpec> = BUILTIN_PROVIDERS
): ProviderSpec {
  const base = registry[name];
  if (!base) {
    throw new Error(
      `mechanics: unknown agent "${name}" — built in are: ${Object.keys(registry).join(", ")}`
    );
  }
  return { ...base, ...stripUndefined(overrides) };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function trim(url: string | undefined): string {
  return (url ?? "").replace(/\/+$/, "");
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function which(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(process.platform === "win32" ? "where" : "which", [cmd], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) =>
      resolve(code === 0 && out.trim() ? (out.trim().split("\n")[0] ?? null) : null)
    );
  });
}
