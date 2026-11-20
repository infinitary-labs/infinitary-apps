import type { TaskRecord } from "../storage/taskRecords";

/**
 * The model a task's user named (`override_model_id`) beside the model that
 * took it (FI3-444). A start never falls back to another model: it waits for
 * a computer that serves the named model (`evaluatePlacement`, `routesNamed`).
 * The Firstmate still hears which model took a started task, so it never
 * reports the named model on its own word. `took` is the record's dispatched
 * model, `provider/id`, or null when none is recorded.
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
 * Whether a start has news about its model: the model that took it is not
 * the one named, or no model is recorded to confirm it. A start on the named
 * model says nothing the first mate's own call did not, so it wakes no one;
 * the crew list carries the model instead (INF-5123).
 */
export function namedModelDiffers(model: NamedModel): boolean {
  return !servedNamed(model);
}

/** Whether a routing choice is the named model, matched as `servedNamed` matches it. */
export function routesNamed(named: string, choice?: { provider: string; id: string }): boolean {
  return servedNamed({ named, took: choice ? `${choice.provider}/${choice.id}` : null });
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
