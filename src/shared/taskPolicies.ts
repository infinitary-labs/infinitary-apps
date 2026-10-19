import { z } from "zod";
import { autonomyForRecord, deliveryForRecord, type RepoView, repoDeliverySchema } from "./repos";
import { rigorFor, rigorSchema } from "./rigor";

/** Live edits are separate from dispatch stamps and published delivery facts.
 * Absence inherits the original ask; null explicitly resets it to the project.
 * Every accepted edit advances revision, even a repeated ask-first request.
 */
export const taskPolicyEditsSchema = z.object({
  delivery: repoDeliverySchema.nullable().optional(),
  autonomy: z.boolean().nullable().optional(),
  rigor: rigorSchema.nullable().optional(),
});
export type TaskPolicyEdits = z.infer<typeof taskPolicyEditsSchema>;
export const taskPolicyStateSchema = taskPolicyEditsSchema.extend({
  revision: z.number().int().nonnegative(),
});
export type TaskPolicyState = z.infer<typeof taskPolicyStateSchema>;
export type PolicyRepo = Pick<RepoView, "delivery"> &
  Partial<Pick<RepoView, "autonomy" | "rigor" | "kind">>;
export type PolicyRecord = {
  kind?: string;
  status?: string;
  delivery?: { closedPolicies?: EffectiveTaskPolicies } | null;
  shape?: {
    kind?: string;
    kind_source?: string;
    deliverable?: string;
    delivery_ask?: RepoView["delivery"];
    autonomy_ask?: boolean;
    rigor_ask?: NonNullable<RepoView["rigor"]>;
    policies?: TaskPolicyState;
    /** Present on a task that works in place in its project's folder: it ships nothing. */
    in_place?: object;
  } | null;
};
const sourceSchema = z.enum(["task", "project"]);
export const effectiveTaskPoliciesSchema = z.object({
  delivery: z.object({ value: repoDeliverySchema, source: sourceSchema }),
  autonomy: z.object({ value: z.boolean(), source: sourceSchema }),
  rigor: z.object({ value: rigorSchema, source: sourceSchema, requested: rigorSchema }),
  revision: z.number().int().nonnegative(),
});
export type EffectiveTaskPolicies = z.infer<typeof effectiveTaskPoliciesSchema>;

/** The one reading for tools, views, briefs and guards. Dispatch stamps are history. */
export function effectiveTaskPolicies(
  record: PolicyRecord,
  repo?: PolicyRepo,
): EffectiveTaskPolicies | null {
  const shape = record.shape;
  if (
    (record.status === "done" || record.status === "dropped") &&
    record.delivery?.closedPolicies !== undefined
  )
    return record.delivery.closedPolicies;
  if (
    (record.kind !== undefined && record.kind !== "work") ||
    shape?.kind === "review" ||
    shape?.deliverable === "answer" ||
    shape?.in_place !== undefined ||
    repo?.kind === "personal"
  )
    return null;
  const edits = shape?.policies;
  const ask = <T>(edit: T | null | undefined, original: T | undefined): T | undefined =>
    edit === undefined ? original : (edit ?? undefined);
  const deliveryAsk = ask(edits?.delivery, shape?.delivery_ask);
  const autonomyAsk = ask(edits?.autonomy, shape?.autonomy_ask);
  const rigorAsk = ask(
    edits?.rigor,
    shape?.rigor_ask ?? (shape?.kind_source === "legacy-judgment" ? "quick" : undefined),
  );
  const delivery = deliveryForRecord(record, repo?.delivery);
  const rigor =
    rigorFor({ gated: true, delivery, ask: rigorAsk, repoRigor: repo?.rigor ?? undefined }).rigor ??
    "standard";
  return {
    delivery: { value: delivery, source: deliveryAsk === undefined ? "project" : "task" },
    autonomy: {
      value: autonomyForRecord(record, repo?.autonomy),
      source: autonomyAsk === undefined ? "project" : "task",
    },
    rigor: {
      value: rigor,
      source: rigorAsk === undefined ? "project" : "task",
      requested: rigorAsk ?? repo?.rigor ?? "standard",
    },
    revision: edits?.revision ?? 0,
  };
}

/**
 * Where a task runs, as its record's Details reads it (docs/helper.md, "A
 * task's own Runs on"): the place's label ("Mac mini", "Running as
 * Builder", "This Mac") and where the setting came from - the task's own,
 * its parent's, or its project's.
 */
export const taskRunsOnSchema = z.object({
  label: z.string(),
  source: z.enum(["task", "parent", "project"]),
  reason: z.string().optional(),
  candidates: z.array(z.string()).max(65).optional(),
});
export type TaskRunsOn = z.infer<typeof taskRunsOnSchema>;

export const POLICY_SOURCE_WORDS = { task: "This task", project: "Project setting" } as const;
export const RUNS_ON_SOURCE_WORDS = { ...POLICY_SOURCE_WORDS, parent: "Parent task" } as const;
export const POLICY_DELIVERY_WORDS = {
  "direct-pr": "Pull request",
  "local-only": "Local merge",
} as const;
export const POLICY_MERGING_WORDS = { on: "Merges on its own", off: "Asks first" } as const;
export const POLICY_HELPER = "Ask your first mate to change these for this task.";
export const POLICY_CARE_BOUND =
  "Local merge uses Default care; Careful remains requested for pull requests.";

const CARE_RANK = { quick: 0, standard: 1, reviewed: 2 } as const;

/**
 * What the host did because of a policy edit, said in `update_task`'s answer
 * and only for the edit that happened. The tool description no longer
 * restates it on every turn (INF-416 piece H).
 */
export function policyEditConsequences(input: {
  edits: TaskPolicyEdits;
  now: Pick<EffectiveTaskPolicies, "autonomy" | "rigor">;
  before?: Pick<EffectiveTaskPolicies, "rigor"> | null;
  mergeSent: boolean;
}): string {
  const parts: string[] = [];
  if (input.edits.autonomy !== undefined && input.now.autonomy.value === false) {
    parts.push("Asks first cancels unsent merges.");
  }
  if (input.edits.delivery !== undefined) {
    parts.push("A destination change cancels the old approval.");
  }
  if (input.edits.autonomy !== undefined && input.now.autonomy.value === true) {
    parts.push(
      "Self-merging rechecks requirements. Unrelated decisions and a withdrawn approval stay held.",
    );
  }
  if (input.edits.rigor !== undefined && input.before) {
    const next = CARE_RANK[input.now.rigor.value];
    const previous = CARE_RANK[input.before.rigor.value];
    if (next > previous) {
      parts.push(
        "Higher care requires missing validation or review before the next push or merge.",
      );
    } else if (next < previous) {
      parts.push(
        "A lower care removes only policy-owned requirements and keeps counts and history.",
      );
    }
  }
  parts.push(
    "Published work, evidence and the pull request stay. Rules keep this task's overrides.",
  );
  parts.push(
    input.mergeSent
      ? "A merge already sent cannot be stopped; this policy applies to future actions, including a retry if it fails."
      : "Queued work stays queued; existing work and unrelated holds stay in place.",
  );
  return parts.join(" ");
}
