import type { TaskRecord } from "../storage/taskStore";

/**
 * The model a task's user named (`override_model_id`) beside the model that
 * took it (FI3-444). A named model routes only when it can serve (rule R0)
 * and otherwise falls back without a word, so a start's answer to the
 * Firstmate says which one took the task - and never lets it report the
 * named model on its own. `took` is the record's dispatched model,
 * `provider/id`, or null when none is recorded.
 */
export type NamedModel = { named: string; took: string | null };

/** Read after a start: absent when no model was named or nothing has started. */
export function namedModelOf(record: Pick<TaskRecord, "model" | "shape">): NamedModel | undefined {
  const named = record.shape?.override_model_id?.trim();
  return named ? { named, took: record.model } : undefined;
}

/**
 * Whether the model that took it is the one named, matched the way the
 * router matches a pin: a `provider/model` key whole, a bare id against the
 * model's own id (which may itself hold a slash).
 */
function servedNamed({ named, took }: NamedModel): boolean {
  if (!took) return false;
  return named.includes("/") ? took === named : took.slice(took.indexOf("/") + 1) === named;
}

/**
 * The words for it, to follow a start: `on X`, `on X: Y was not available`,
 * or that no model is recorded, so the named one is not confirmed.
 */
export function namedModelWords(model: NamedModel): string {
  if (!model.took) return `with no model recorded, so ${model.named} is not confirmed`;
  return servedNamed(model)
    ? `on ${model.took}`
    : `on ${model.took}: ${model.named} was not available`;
}
