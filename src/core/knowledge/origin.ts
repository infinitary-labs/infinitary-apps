/**
 * Code-stamped origin for durable notes. The model never writes this
 * column: the host classifies the turn's wake and the tool plumbing stamps
 * the closed set. Unknown defaults to `agent` (least trusted), never
 * `captain-turn`.
 */

import type { ServedOrigin } from "@shared/servedFrame";

export type KnowledgeOrigin = "captain-turn" | "agent" | `crewmate-report:${string}`;

/**
 * The kind of wake a turn served: exactly the served frame's origin
 * (`ServedOrigin`, `src/shared/servedFrame.ts`), where `captain` is the
 * captain's own words.
 */
export type WakeKind = ServedOrigin;

export type ClassifiedWake = {
  origin: KnowledgeOrigin;
  canCreate: boolean;
  kind: WakeKind;
};

/** What classification reads off a served message: its stamped origin and ref. */
export type WakeSource = { origin: ServedOrigin | null; ref: string | null };

const CREWMATE_REPORT_ORIGIN = /^crewmate-report:([a-z0-9-]+)$/;

/** Closed-set stamp: unknown values become `agent`, never `captain-turn`. */
export function stampOrigin(value: string): KnowledgeOrigin {
  if (value === "captain-turn" || value === "agent") return value;
  if (CREWMATE_REPORT_ORIGIN.test(value)) return value as KnowledgeOrigin;
  return "agent";
}

/** Trust rank, lower = less trusted. Mixed batches keep the least trusted. */
function originRank(origin: KnowledgeOrigin): number {
  if (origin === "captain-turn") return 2;
  if (origin.startsWith("crewmate-report:")) return 1;
  return 0;
}

/**
 * Classify one served message (an inbox row, or the supervision session's
 * wake) from the origin its emitter stamped - never from the wording of the
 * payload, which may quote `[user]` or `[fm-op]` from anywhere. A missing
 * origin is `agent`, the least trusted; a crewmate report's note origin
 * names the task in the row's ref, and a report without a well-formed task
 * ref is plain `agent`.
 */
export function classifyWake(source: WakeSource): ClassifiedWake {
  switch (source.origin) {
    case "captain":
      return { origin: "captain-turn", canCreate: true, kind: "captain" };
    case "scheduled":
      return { origin: "agent", canCreate: false, kind: "scheduled" };
    case "supervision":
      return { origin: "agent", canCreate: false, kind: "supervision" };
    case "crewmate-report": {
      const origin = stampOrigin(`crewmate-report:${source.ref ?? ""}`);
      if (origin !== "agent") return { origin, canCreate: true, kind: "crewmate-report" };
      return { origin: "agent", canCreate: true, kind: "agent" };
    }
    default:
      return { origin: "agent", canCreate: true, kind: "agent" };
  }
}

/**
 * A drained inbox batch may mix wakes. Origin is the least trusted of the
 * set; create is refused if any row is a scheduled or supervision wake.
 */
export function classifyInboxBatch(rows: WakeSource[]): ClassifiedWake {
  if (rows.length === 0) {
    return { origin: "agent", canCreate: false, kind: "agent" };
  }
  const classified = rows.map(classifyWake);
  const canCreate = classified.every((wake) => wake.canCreate);
  let origin: KnowledgeOrigin = classified[0]?.origin ?? "agent";
  let kind: WakeKind = classified[0]?.kind ?? "agent";
  for (const wake of classified) {
    if (originRank(wake.origin) < originRank(origin)) {
      origin = wake.origin;
      kind = wake.kind;
    }
  }
  if (!canCreate && kind !== "scheduled" && kind !== "supervision") {
    kind = classified.find((wake) => !wake.canCreate)?.kind ?? "agent";
  }
  return { origin, canCreate, kind };
}
