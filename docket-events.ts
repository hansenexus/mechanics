/**
 * `events.jsonl` — append-only, one JSON object per line.
 *
 * Three properties matter more than the format itself:
 *
 * 1. **Crash safety.** A half-written trailing line is expected (a killed
 *    agent, a full disk) and must not poison the log: `readEvents` counts it
 *    as malformed and moves on. This is why the file is JSONL and not a JSON
 *    array — an array cannot survive truncation.
 * 2. **Multi-writer safety.** Hooks, the CLI and CI all append to the same
 *    file. `seq` has to stay gap-free, so allocation happens under an
 *    exclusive lock (`O_EXCL` create, which is atomic on POSIX and on
 *    Windows). The critical section is one read + one append.
 * 3. **Producer separation.** `appendEvent` refuses `criterion.evaluated`
 *    from `actor.kind: "hook"`. A hook observes that something happened; it
 *    cannot judge whether a criterion is met, and a board built on hook
 *    judgments would report green work that nobody checked.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { runDir } from "./docket-order";
import {
  type Actor,
  DOCKET_PROTO,
  type DocketEvent,
  type DocketEventInput,
  KNOWN_EVENT_TYPES,
} from "./docket-types";

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_POLL_MS = 15;

export function eventsPath(repoRoot: string, runId: string): string {
  return path.join(runDir(repoRoot, runId), "events.jsonl");
}

export type ReadEventsResult = {
  events: DocketEvent[];
  /** Lines that were not parseable or lacked the base fields. */
  malformed: number;
};

const BASE_KEYS = new Set(["proto", "ts", "run", "seq", "type", "actor"]);

/**
 * One wire line → an event, or null when the line is not a conforming event.
 *
 * Exported because it is half of what the conformance vectors need: a reader
 * proves itself by parsing the published lines and deriving the published
 * state, and a parser nobody can call cannot be checked.
 */
export function parseEventLine(line: string): DocketEvent | null {
  return toEvent(line);
}

function toEvent(line: string): DocketEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (
    typeof o.proto !== "string" ||
    typeof o.ts !== "string" ||
    typeof o.run !== "string" ||
    typeof o.seq !== "number" ||
    typeof o.type !== "string" ||
    typeof o.actor !== "object" ||
    o.actor === null
  ) {
    return null;
  }
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!BASE_KEYS.has(k)) payload[k] = v;
  return {
    proto: o.proto,
    ts: o.ts,
    run: o.run,
    seq: o.seq,
    type: o.type,
    actor: o.actor as Actor,
    payload,
  };
}

/**
 * Read the log in file order. Events are NOT re-sorted by `seq`: file order is
 * the ground truth, and a producer that mis-allocates `seq` should be visible
 * rather than silently corrected.
 */
export async function readEvents(repoRoot: string, runId: string): Promise<ReadEventsResult> {
  let raw: string;
  try {
    raw = await fs.readFile(eventsPath(repoRoot, runId), "utf8");
  } catch {
    return { events: [], malformed: 0 };
  }
  const events: DocketEvent[] = [];
  let malformed = 0;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    const ev = toEvent(line);
    if (ev) events.push(ev);
    else malformed++;
  }
  return { events, malformed };
}

async function withLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const lock = path.join(dir, ".lock");
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fh = await fs.open(lock, "wx");
      await fh.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() > deadline) {
        // A holder died mid-write. Breaking the lock is better than wedging
        // every future append; the append itself is a single O_APPEND write.
        await fs.rm(lock, { force: true });
        continue;
      }
      await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lock, { force: true });
  }
}

/** Wire form: payload keys sit next to the base fields, per the spec. */
export function serializeEvent(ev: DocketEvent): string {
  return JSON.stringify({
    proto: ev.proto,
    ts: ev.ts,
    run: ev.run,
    seq: ev.seq,
    type: ev.type,
    actor: ev.actor,
    ...ev.payload,
  });
}

export async function appendEvent(
  repoRoot: string,
  runId: string,
  input: DocketEventInput
): Promise<DocketEvent> {
  if (input.type === "criterion.evaluated" && input.actor.kind === "hook") {
    throw new Error(
      "docket: a hook may not emit criterion.evaluated — facts come from hooks, " +
        "judgments from an agent or a human (docket/1 invariant 4)"
    );
  }
  if (
    input.type === "criterion.evaluated" &&
    input.payload?.verdict === "pass" &&
    !input.payload?.evidence
  ) {
    throw new Error("docket: a pass verdict requires evidence (docket/1 invariant 5)");
  }

  const dir = runDir(repoRoot, runId);
  await fs.mkdir(dir, { recursive: true });

  return withLock(dir, async () => {
    const { events } = await readEvents(repoRoot, runId);
    const last = events.at(-1);
    const ev: DocketEvent = {
      proto: DOCKET_PROTO,
      ts: input.ts ?? new Date().toISOString(),
      run: runId,
      seq: (last?.seq ?? 0) + 1,
      type: input.type,
      actor: input.actor,
      payload: input.payload ?? {},
    };
    await fs.appendFile(eventsPath(repoRoot, runId), `${serializeEvent(ev)}\n`, "utf8");
    return ev;
  });
}

/** Unknown types are ignored by consumers, never rejected — kept as a helper
 * so callers can warn about a likely typo without failing the read. */
export function isKnownEventType(type: string): boolean {
  return KNOWN_EVENT_TYPES.has(type);
}
