/**
 * Fold a finished run's verdicts into its wave file.
 *
 * This is what stops the two systems from being two systems. A wave is the
 * long-lived record of "did this behaviour survive the migration"; a run is
 * the short-lived record of a piece of work. Today the wave only fills when
 * somebody remembers to run `mechanics verify`. After this, shipping a run
 * fills it as a side effect of the work being done.
 *
 * ## Criteria are per-AC, waves are per-mechanic
 *
 * A run scores `console.observe.logs-tab:AC2`; a wave records a verdict for
 * `console.observe.logs-tab` as a whole. So verdicts aggregate, and the
 * aggregate is pessimistic: one failing AC fails the mechanic, and the AC
 * labels that failed are written to `failedCriteria` — which is exactly the
 * handle the wave format already defines for addressing them.
 *
 * ## The rule this inherits rather than reinvents
 *
 * `applySpecResults` refuses to overwrite a standing manual or agent verdict
 * with an e2e result. That rule exists because a human who checked something
 * by hand knows more than a spec run does. A merge coming out of a run obeys
 * it identically: e2e verdicts yield to a standing judgment, while manual and
 * agent verdicts — which are themselves deliberate — may overwrite.
 */

import type { CriterionState, Verdict } from "./docket-types";
import type { VerificationMethod, VerificationStatus, WaveFile, WaveVerification } from "./types";
import { MECHANIC_ID_RE } from "./types";

/** `console.observe.logs-tab:AC2` → its two halves, or null for a free string. */
export function parseCriterionRef(ref: string): { mechanic: string; label: string } | null {
  const at = ref.lastIndexOf(":");
  if (at < 1) return null;
  const mechanic = ref.slice(0, at);
  const label = ref.slice(at + 1);
  if (!MECHANIC_ID_RE.test(mechanic)) return null;
  if (!/^AC[1-9]\d*$/.test(label)) return null;
  return { mechanic, label };
}

export type MergeEntry = {
  mechanic: string;
  status: VerificationStatus;
  method: VerificationMethod;
  evidence?: string;
  failedCriteria?: string[];
  /** Set when the entry was left alone, with the reason. */
  skipped?: "standing-verdict";
};

export type MergePlan = {
  entries: MergeEntry[];
  /** Criteria that are not `<mechanic>:AC<n>` — reported, never silently
   * dropped, because a run whose criteria vanish looks fully merged. */
  unmapped: string[];
};

const METHOD_RANK: Record<VerificationMethod, number> = { e2e: 0, agent: 1, manual: 2 };

function aggregateStatus(verdicts: Verdict[]): VerificationStatus {
  if (verdicts.includes("fail")) return "fail";
  if (verdicts.includes("blocked")) return "blocked";
  if (verdicts.every((v) => v === "n-a")) return "n-a";
  return "pass";
}

/**
 * Pure. `--dry-run` prints exactly this, and the executor applies exactly
 * this — there is no second code path that could disagree.
 */
export function planWaveMerge(
  criteria: CriterionState[],
  wave: WaveFile,
  declared: string[] = []
): MergePlan {
  const byMechanic = new Map<
    string,
    { verdicts: Verdict[]; failed: string[]; evidence: string[]; method: VerificationMethod }
  >();
  const unmapped: string[] = [];

  for (const ref of declared) {
    if (!parseCriterionRef(ref)) unmapped.push(ref);
  }

  for (const c of criteria) {
    const parsed = parseCriterionRef(c.criterion);
    if (!parsed) {
      if (!unmapped.includes(c.criterion)) unmapped.push(c.criterion);
      continue;
    }
    const agg = byMechanic.get(parsed.mechanic) ?? {
      verdicts: [],
      failed: [],
      evidence: [],
      method: "e2e" as VerificationMethod,
    };
    agg.verdicts.push(c.verdict);
    if (c.verdict === "fail" || c.verdict === "blocked") agg.failed.push(parsed.label);
    if (c.evidence) agg.evidence.push(c.evidence);
    // Precedence manual > agent > e2e: the aggregate is as deliberate as its
    // most deliberate part, which is what the overwrite rule keys off.
    const method = c.method ?? "e2e";
    if (METHOD_RANK[method] > METHOD_RANK[agg.method]) agg.method = method;
    byMechanic.set(parsed.mechanic, agg);
  }

  const entries: MergeEntry[] = [];
  for (const [mechanic, agg] of [...byMechanic].sort(([a], [b]) => a.localeCompare(b))) {
    const existing = wave.verifications.find((v) => v.mechanic === mechanic);
    const status = aggregateStatus(agg.verdicts);
    const standing = existing && existing.method !== "e2e" && existing.status !== "pending";

    if (standing && agg.method === "e2e") {
      entries.push({ mechanic, status, method: agg.method, skipped: "standing-verdict" });
      continue;
    }
    entries.push({
      mechanic,
      status,
      method: agg.method,
      ...(agg.evidence.length ? { evidence: [...new Set(agg.evidence)].sort().join(", ") } : {}),
      ...(agg.failed.length ? { failedCriteria: agg.failed.sort() } : {}),
    });
  }

  return { entries, unmapped };
}

/** Apply a plan to a wave. Entries marked `skipped` are left untouched. */
export function applyMergePlan(
  wave: WaveFile,
  plan: MergePlan,
  opts: { verifiedBy: string; date: string }
): WaveFile {
  const verifications = [...wave.verifications];
  for (const entry of plan.entries) {
    if (entry.skipped) continue;
    const next: WaveVerification = {
      mechanic: entry.mechanic,
      status: entry.status,
      method: entry.method,
      ...(entry.evidence !== undefined ? { evidence: entry.evidence } : {}),
      verifiedBy: opts.verifiedBy,
      verifiedAt: opts.date,
      ...(entry.failedCriteria ? { failedCriteria: entry.failedCriteria } : {}),
    };
    const idx = verifications.findIndex((v) => v.mechanic === entry.mechanic);
    if (idx >= 0) verifications[idx] = next;
    else verifications.push(next);
  }
  return { ...wave, verifications };
}

export function describeMergePlan(plan: MergePlan, wave: string, app: string): string {
  const lines = [`wave ${app}/${wave}`, ""];
  if (plan.entries.length === 0) {
    lines.push("  nothing to merge — no criterion resolved to a mechanic");
  }
  for (const e of plan.entries) {
    const failed = e.failedCriteria?.length ? `  failed: ${e.failedCriteria.join(", ")}` : "";
    lines.push(
      e.skipped
        ? `  – ${e.mechanic}  kept (standing ${e.method === "e2e" ? "manual/agent" : e.method} verdict)`
        : `  ${e.status === "pass" ? "✓" : e.status === "n-a" ? "–" : "✗"} ${e.mechanic}  ` +
            `[${e.status}/${e.method}]${failed}`
    );
  }
  if (plan.unmapped.length) {
    lines.push(
      "",
      `  ${plan.unmapped.length} criterion/criteria are free text and cannot map to a mechanic:`,
      ...plan.unmapped.map((u) => `    ${u}`)
    );
  }
  return lines.join("\n");
}
