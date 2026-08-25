/**
 * The provider seam, and the edit protocol that gives a bare model the same
 * reach as a harness.
 *
 * Network-free by design: `probeProvider` and `runProvider` are pointed at a
 * local stub server, and harness providers at a stub script on disk. A test
 * that needs Ollama running is a test that fails on CI for reasons unrelated
 * to the code.
 */

import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyEdits,
  BUILTIN_PROVIDERS,
  type EditPlan,
  parseEditPlan,
  probeProvider,
  resolveProvider,
  runProvider,
} from "./agents";

const made: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(made.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function tmp(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mechanics-agents-")));
  made.push(dir);
  return dir;
}

/** A stub endpoint that answers like Ollama or like OpenAI. */
async function stubServer(
  handler: (url: string) => { status?: number; body: unknown }
): Promise<string> {
  const server = createServer((req, res) => {
    const { status = 200, body } = handler(req.url ?? "");
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  return `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
}

/** An executable that behaves like a one-shot agent harness. */
async function stubBinary(dir: string, name: string, script: string): Promise<string> {
  const file = path.join(dir, name);
  await fs.writeFile(file, `#!/bin/sh\n${script}\n`, "utf8");
  await fs.chmod(file, 0o755);
  return file;
}

// ---------------------------------------------------------------------------

describe("probeProvider", () => {
  it("reports a missing harness by name rather than failing later", async () => {
    // The worst state to be in is a configured provider that is not there: the
    // pipeline appears to hang, or dies deep inside a dispatch.
    const probe = await probeProvider({
      name: "nope",
      kind: "harness",
      command: "definitely-not-a-real-binary-xyz",
    });
    expect(probe.available).toBe(false);
    expect(probe.detail).toContain("not on PATH");
  });

  it("finds a harness that is on PATH", async () => {
    const probe = await probeProvider({ name: "sh", kind: "harness", command: "sh" });
    expect(probe.available).toBe(true);
    expect(probe.detail).toContain("sh");
  });

  it("lists what an ollama endpoint has loaded", async () => {
    const base = await stubServer(() => ({
      body: { models: [{ name: "qwen2.5-coder:7b" }, { name: "gemma3:12b" }] },
    }));
    const probe = await probeProvider({
      name: "ollama",
      kind: "model",
      baseUrl: base,
      api: "ollama",
    });
    expect(probe.available).toBe(true);
    expect(probe.models).toEqual(["qwen2.5-coder:7b", "gemma3:12b"]);
  });

  it("lists what an OpenAI-compatible endpoint has loaded", async () => {
    const base = await stubServer(() => ({ body: { data: [{ id: "local-model" }] } }));
    const probe = await probeProvider({
      name: "lmstudio",
      kind: "model",
      baseUrl: base,
      api: "openai",
    });
    expect(probe.models).toEqual(["local-model"]);
  });

  it("reports an unreachable endpoint instead of throwing", async () => {
    const probe = await probeProvider({
      name: "dead",
      kind: "model",
      baseUrl: "http://127.0.0.1:1",
      api: "openai",
    });
    expect(probe.available).toBe(false);
    expect(probe.detail).toContain("unreachable");
  });
});

describe("runProvider", () => {
  it("passes the prompt as an argument when the template names it", async () => {
    const dir = await tmp();
    await stubBinary(dir, "fake-agent", 'echo "GOT:$2"');
    const reply = await runProvider(
      {
        name: "fake",
        kind: "harness",
        command: path.join(dir, "fake-agent"),
        args: ["-p", "{prompt}"],
      },
      "do the thing",
      { cwd: dir }
    );
    expect(reply.text.trim()).toBe("GOT:do the thing");
  });

  it("falls back to stdin when the template does not name the prompt", async () => {
    // `codex exec` and friends differ here, and a prompt silently delivered
    // nowhere is an agent that runs with no instructions.
    const dir = await tmp();
    await stubBinary(dir, "stdin-agent", "cat");
    const reply = await runProvider(
      { name: "fake", kind: "harness", command: path.join(dir, "stdin-agent"), args: [] },
      "from stdin",
      { cwd: dir }
    );
    expect(reply.text.trim()).toBe("from stdin");
  });

  it("surfaces a non-zero exit with its stderr", async () => {
    const dir = await tmp();
    await stubBinary(dir, "angry", 'echo "boom" >&2; exit 3');
    await expect(
      runProvider(
        { name: "fake", kind: "harness", command: path.join(dir, "angry"), args: [] },
        "x",
        { cwd: dir }
      )
    ).rejects.toThrow(/exited 3.*boom/s);
  });

  it("still reports the exit when the harness dies before reading its prompt", async () => {
    // The test above raced this: a short prompt usually fits the pipe buffer,
    // so the write lands even though nobody is reading, and the EPIPE only
    // fires some of the time. A prompt larger than the buffer cannot be
    // absorbed, so the write is guaranteed to fail against a process that has
    // already gone — which used to surface as an unhandled exception that took
    // the whole run down instead of this rejection.
    const dir = await tmp();
    await stubBinary(dir, "deaf", 'echo "nope" >&2; exit 4');
    await expect(
      runProvider(
        { name: "fake", kind: "harness", command: path.join(dir, "deaf"), args: [] },
        "x".repeat(1_000_000),
        { cwd: dir }
      )
    ).rejects.toThrow(/exited 4.*nope/s);
  });

  it("talks to an ollama endpoint", async () => {
    const base = await stubServer(() => ({ body: { response: "hi from ollama" } }));
    const reply = await runProvider(
      { name: "ollama", kind: "model", baseUrl: base, api: "ollama", model: "m" },
      "x",
      { cwd: "/tmp" }
    );
    expect(reply.text).toBe("hi from ollama");
    expect(reply.kind).toBe("model");
  });

  it("talks to an OpenAI-compatible endpoint", async () => {
    const base = await stubServer(() => ({
      body: { choices: [{ message: { content: "hi from openai" } }] },
    }));
    const reply = await runProvider(
      { name: "lmstudio", kind: "model", baseUrl: base, api: "openai", model: "m" },
      "x",
      { cwd: "/tmp" }
    );
    expect(reply.text).toBe("hi from openai");
  });
});

describe("parseEditPlan", () => {
  const PLAN = '{"summary":"s","edits":[{"op":"create","path":"a.ts","content":"x"}]}';

  it("accepts a bare object", () => {
    expect(parseEditPlan(PLAN)?.edits).toHaveLength(1);
  });

  it("digs the object out of a code fence", () => {
    expect(parseEditPlan(`\`\`\`json\n${PLAN}\n\`\`\``)?.summary).toBe("s");
  });

  it("digs it out of surrounding prose", () => {
    // Small models prefix "Sure!" and append an explanation. Neither is worth
    // failing a run over.
    expect(parseEditPlan(`Sure! Here you go:\n${PLAN}\nHope that helps.`)?.summary).toBe("s");
  });

  it("returns null for a reply with no usable object", () => {
    // "It said nothing usable" and "it proposed no edits" are different
    // answers, so an empty plan is never invented.
    expect(parseEditPlan("I cannot help with that.")).toBeNull();
  });

  it("rejects an object that does not match the schema", () => {
    expect(parseEditPlan('{"summary":"s","edits":[{"op":"delete","path":"a"}]}')).toBeNull();
  });

  it("accepts an explicitly empty edit list", () => {
    expect(parseEditPlan('{"summary":"nothing to do","edits":[]}')?.edits).toEqual([]);
  });
});

describe("applyEdits", () => {
  const plan = (edits: EditPlan["edits"]): EditPlan => ({ summary: "s", edits });

  it("replaces an exact single match", async () => {
    const root = await tmp();
    await fs.writeFile(path.join(root, "a.ts"), 'const a = "hello";\n', "utf8");
    const res = await applyEdits(
      root,
      plan([{ op: "replace", path: "a.ts", find: '"hello"', replace: '"hallo"' }])
    );
    expect(res.written).toEqual(["a.ts"]);
    expect(await fs.readFile(path.join(root, "a.ts"), "utf8")).toBe('const a = "hallo";\n');
  });

  it("refuses an anchor that matches more than once", async () => {
    // The reason the protocol uses exact substrings instead of a patch format:
    // a model that got the anchor wrong fails loudly here, rather than editing
    // whichever line happened to be at the offset it guessed.
    const root = await tmp();
    await fs.writeFile(path.join(root, "a.ts"), "x\nx\n", "utf8");
    const res = await applyEdits(
      root,
      plan([{ op: "replace", path: "a.ts", find: "x", replace: "y" }])
    );
    expect(res.applied).toEqual([]);
    expect(res.refused[0]?.reason).toContain("matched 2 times");
    expect(await fs.readFile(path.join(root, "a.ts"), "utf8")).toBe("x\nx\n");
  });

  it("refuses an anchor that matches nothing", async () => {
    const root = await tmp();
    await fs.writeFile(path.join(root, "a.ts"), "x\n", "utf8");
    const res = await applyEdits(
      root,
      plan([{ op: "replace", path: "a.ts", find: "zzz", replace: "y" }])
    );
    expect(res.refused[0]?.reason).toContain("matched 0 times");
  });

  it("refuses a path that escapes the root", async () => {
    const root = await tmp();
    const res = await applyEdits(
      root,
      plan([{ op: "create", path: "../escaped.ts", content: "x" }])
    );
    expect(res.applied).toEqual([]);
    expect(res.refused[0]?.reason).toContain("escapes");
  });

  it("refuses to create over an existing file", async () => {
    const root = await tmp();
    await fs.writeFile(path.join(root, "a.ts"), "keep me\n", "utf8");
    const res = await applyEdits(root, plan([{ op: "create", path: "a.ts", content: "clobber" }]));
    expect(res.refused[0]?.reason).toContain("already exists");
    expect(await fs.readFile(path.join(root, "a.ts"), "utf8")).toBe("keep me\n");
  });

  it("rolls the whole batch back when verification fails", async () => {
    // A model provider cannot check its own work, so the check lives here —
    // and it is all-or-nothing, because half an applied plan is a state
    // nobody reasoned about.
    const root = await tmp();
    await fs.writeFile(path.join(root, "a.ts"), "original\n", "utf8");
    const res = await applyEdits(
      root,
      plan([
        { op: "replace", path: "a.ts", find: "original", replace: "changed" },
        { op: "create", path: "b.ts", content: "new file" },
      ]),
      { verify: async () => "typecheck failed" }
    );
    expect(res.revertedBecause).toBe("typecheck failed");
    expect(res.applied).toEqual([]);
    expect(await fs.readFile(path.join(root, "a.ts"), "utf8")).toBe("original\n");
    // A created file is removed, not left behind as an empty husk.
    await expect(fs.access(path.join(root, "b.ts"))).rejects.toThrow();
  });

  it("writes nothing on a dry run", async () => {
    const root = await tmp();
    await fs.writeFile(path.join(root, "a.ts"), "original\n", "utf8");
    const res = await applyEdits(
      root,
      plan([{ op: "replace", path: "a.ts", find: "original", replace: "changed" }]),
      { dryRun: true }
    );
    expect(res.written).toEqual(["a.ts"]);
    expect(await fs.readFile(path.join(root, "a.ts"), "utf8")).toBe("original\n");
  });
});

describe("the guard hook", () => {
  it("refuses an edit the domain policy bars, and says why", async () => {
    const root = await tmp();
    await fs.writeFile(path.join(root, "a.ts"), "keep\n", "utf8");
    const res = await applyEdits(
      root,
      { summary: "s", edits: [{ op: "replace", path: "a.ts", find: "keep", replace: "gone" }] },
      { guard: () => "not allowed here" }
    );
    expect(res.applied).toEqual([]);
    expect(res.refused[0]?.reason).toBe("not allowed here");
    expect(await fs.readFile(path.join(root, "a.ts"), "utf8")).toBe("keep\n");
  });

  it("guards creates as well as replaces", async () => {
    const root = await tmp();
    const res = await applyEdits(
      root,
      { summary: "s", edits: [{ op: "create", path: "new.ts", content: "x" }] },
      { guard: () => "no new files" }
    );
    expect(res.refused[0]?.reason).toBe("no new files");
    await expect(fs.access(path.join(root, "new.ts"))).rejects.toThrow();
  });
});

describe("resolveProvider", () => {
  it("names the built-ins when asked for one that does not exist", () => {
    expect(() => resolveProvider("gpt5")).toThrow(
      /built in are: claude, codex, qwen, ollama, lmstudio/
    );
  });

  it("lets a caller override the model without editing the registry", () => {
    // Which model is on this machine is a fact about the machine. A repo that
    // pins one is a repo that fails on everybody else's laptop.
    const spec = resolveProvider("ollama", { model: "llama3.2" });
    expect(spec.model).toBe("llama3.2");
    expect(BUILTIN_PROVIDERS.ollama?.model).not.toBe("llama3.2");
  });

  it("ignores undefined overrides rather than blanking the default", () => {
    const spec = resolveProvider("ollama", { model: undefined });
    expect(spec.model).toBe(BUILTIN_PROVIDERS.ollama?.model);
  });
});
