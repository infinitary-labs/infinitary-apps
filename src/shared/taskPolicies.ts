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
