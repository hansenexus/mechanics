/**
 * The published docket/1 conformance vectors, run against this implementation.
 *
 * Two jobs, and they are different. It proves the reference implementation
 * conforms to its own spec — the usual thing. It also proves the VECTORS are
 * right, which matters more: they are the artifact another harness will
 * implement against, and a vector file nobody executes is a list of claims.
 *
 * Deliberately driven from the serialized wire lines rather than in-memory
 * objects. A second implementation gets exactly these bytes, so anything the
 * parser does — payload keys sitting beside the base fields, unknown types
 * surviving, a bad line counting as malformed — is under test here too.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseEventLine } from "./docket-events";
import { reduceRun } from "./docket-state";
import type { DocketEvent, DocketOrder } from "./docket-types";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VECTORS = path.join(HERE, "spec", "docket-1.vectors.json");

interface Vector {
  name: string;
  why: string;
  order: DocketOrder;
  now: string;
  /** Wire-format lines, exactly as they appear in an `events.jsonl`. */
  events: Record<string, unknown>[];
  expect: Record<string, unknown>;
}

const suite = JSON.parse(readFileSync(VECTORS, "utf8")) as {
  proto: string;
  cases: Vector[];
};

describe("docket/1 conformance vectors", () => {
  it("declares the protocol version it tests", () => {
    expect(suite.proto).toBe("docket/1");
    expect(suite.cases.length).toBeGreaterThan(0);
  });

  it("gives every case a reason, so a failure says what broke and why it matters", () => {
    for (const c of suite.cases) {
      expect(c.why, `case "${c.name}" has no rationale`).toBeTruthy();
    }
  });

  for (const vector of suite.cases) {
    it(vector.name, () => {
      // Round-trip through the wire format: the vectors ship as lines, and a
      // reader that only works on pre-parsed objects has not been tested.
      const events: DocketEvent[] = vector.events.map((raw, i) => {
        const parsed = parseEventLine(JSON.stringify(raw));
        expect(parsed, `${vector.name}: line ${i + 1} is not a conforming event`).not.toBeNull();
        return parsed as DocketEvent;
      });

      const state = reduceRun(vector.order, events, { now: new Date(vector.now) });

      for (const [key, want] of Object.entries(vector.expect)) {
        switch (key) {
          case "criteria": {
            // Only the asserted fields — the state carries `at` and `by` too,
            // which are timestamps and actors the vector should not pin.
            const got = state.criteria.map((c) => ({ criterion: c.criterion, verdict: c.verdict }));
            expect(got, vector.why).toEqual(want);
            break;
          }
          case "blocked": {
            expect(
              { reason: state.blocked?.reason, needs: state.blocked?.needs },
              vector.why
            ).toEqual(want);
            break;
          }
          case "claimActive": {
            expect(state.claim !== undefined, vector.why).toBe(want);
            break;
          }
          default:
            expect(state[key as keyof typeof state], vector.why).toEqual(want);
        }
      }
    });
  }
});
