import { CLASSIFIABLE_KINDS, type Deliverable, type WorkKind } from "@shared/routingPolicy";

/**
 * The seam between "what is this work" and the deterministic tier table
 * (captain-approved design 2026-09-18, report section 3.5). One interface
 * so the S3 implementation - one bounded call on the user's cheapest
 * slotted model - and any later one are interchangeable, and so the
 * choice of implementation is a `services.ts` wiring decision rather than
 * a call-site one. `source` names which answered.
 */
export type KindInput = {
  /**
   * The task this classification is for. The verdict itself never reads it -
   * it is how the burn lands in `usage_events` under the work that caused
   * it, and how the account decision is attributable (design section 3.4).
   */
  taskId: string;
  title: string;
  goal: string;
  userWords: string;
  /**
   * What the work delivers, as the host derived it from the Firstmate's
   * declaration (`deliverableFor`): the classifier is offered only that
   * branch's kinds (INF-1430 piece 1). Absent on a crewmate's follow-up,
   * which declares nothing and whose kind decides its deliverable, so every
   * kind is offered.
   */
  deliverable?: Exclude<Deliverable, "operation">;
  constraints?: string;
  repoName?: string;
  delivery?: string;
  basis?: { key: string; title: string; outcomeHead: string };
};

export type KindVerdict = {
  kind: WorkKind;
  /** Which implementation answered, e.g. `none`, `classifier:xai/grok-4.6`. */
  source: string;
  /** The question's fingerprint, so a verdict is attributable. */
  version: string;
  model?: string;
  /**
   * Free prose for the routing record: a native decision model's own
   * certainty, or the note that one failed and the adapter answered in its
   * place (S7b). Absent on an ordinary answer, so the default record writes
   * no extra reason line.
   *
   * There is deliberately no `confidence` here. The adapter path cannot
   * supply one honestly (the captain's call, S7 design section 10), and a
   * field one implementation fakes and the other fills is exactly the kind
   * later code learns to trust. A native model's certainty decides, inside
   * that implementation, whether the answer becomes the abstention - which
   * `resolveKind` then routes high like any other abstention.
   */
  detail?: string;
};

export interface KindClassifier {
  classify(input: KindInput, signal: AbortSignal): Promise<KindVerdict>;
}

/**
 * The implementation S1 ships: it classifies nothing, so every shape is
 * `unclear` and R8 routes it high. It is not a stub for tests only - it
 * is the honest answer when no classifier is wired, and it is what S2
 * runs on until S3 lands the real one.
 */
export const noneKindClassifier: KindClassifier = {
  async classify(): Promise<KindVerdict> {
    return { kind: "unclear", source: "none", version: "none-1" };
  },
};

/**
 * The `kind_source` prefixes the classifier path writes: one for a verdict
 * it read off a model, one for its abstention, one for each way it failed,
 * and one for the rules that decide the tier ABOVE the kind, where asking
 * would change nothing. They are the audit vocabulary S5 counts, so they
 * live beside the seam rather than in whichever module writes them.
 */
export const KIND_SOURCE = {
  classified: "classifier:",
  abstained: "classifier-abstained:",
  failed: "classifier-failed:",
  skipped: "skipped:",
} as const;

/**
 * Whether the classifier path already spoke for this shape, so a queued row
 * classified at commission is never classified again at dispatch (design
 * section 3.4: "never consulted twice for the same row"). `none` and
 * `legacy-judgment` are not establishments - the first is the honest answer
 * that nobody asked, the second a row written before any of this existed.
 */
export function kindEstablished(kindSource: string | undefined): boolean {
  if (!kindSource) return false;
  return Object.values(KIND_SOURCE).some((prefix) => kindSource.startsWith(prefix));
}

/**
 * A verdict is taken at its word. The implementation has already decided
 * whether it is sure enough: an adapter that cannot tell answers the
 * question's abstention, and a native model that measures its certainty
 * answers the abstention below its own floor. There is no second guess
 * here - a floor at this layer could only re-judge a number the interface
 * deliberately does not carry (S7b, the captain's call).
 */
export function resolveKind(verdict: KindVerdict): WorkKind {
  if (verdict.kind === "unclear") return "unclear";
  if (!isClassifiable(verdict.kind)) return "unclear";
  return verdict.kind;
}

function isClassifiable(kind: WorkKind): boolean {
  return (CLASSIFIABLE_KINDS as ReadonlyArray<WorkKind>).includes(kind);
}
