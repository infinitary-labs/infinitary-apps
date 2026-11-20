import { Errors, type XSchema } from "typebox/schema";

/**
 * A task's typed result (INF-799 piece 1, docs/task-record.md "A typed
 * result"). The first mate declares the shape a task's report must carry
 * (`result_schema` on the work shape), and the host checks each report's
 * `result` against it. A typed fact is the host's to hold, so a mismatch is
 * refused, never parsed out of prose: the refusal names the first failing
 * field, and the crewmate reports again.
 *
 * The check is JSON Schema, read by the validator the app already ships
 * (typebox's `Schema`); nothing here reads a schema's meaning or names a
 * recipe.
 */

/** Why a declared result shape cannot be used, or undefined when it can. */
export function resultSchemaRefusal(schema: unknown): string | undefined {
  if (!isPlainObject(schema))
    return 'result_schema must be a JSON Schema object, such as {"type":"object","properties":{...},"required":[...]}.';
  if (schema.type !== "object")
    return 'result_schema must have an object at its root: give it "type": "object".';
  try {
    // A schema the validator cannot read throws here, before any task holds it.
    Errors(schema as XSchema, {});
  } catch (caught) {
    return `result_schema is not a JSON Schema the host can check: ${caught instanceof Error ? caught.message : String(caught)}.`;
  }
  return undefined;
}

/**
 * Why a report's result does not fit the declared shape, naming the first
 * failing field, or undefined when it fits.
 */
export function resultRefusal(
  schema: Record<string, unknown>,
  result: unknown,
): string | undefined {
  const [ok, errors] = Errors(schema as XSchema, result);
  if (ok) return undefined;
  const first = errors[0];
  if (!first) return "result does not fit your task's result shape.";
  const field = fieldOf(first.instancePath);
  const missing = (first.params as { requiredProperties?: unknown } | undefined)
    ?.requiredProperties;
  if (Array.isArray(missing) && typeof missing[0] === "string")
    return `${field}.${missing[0]} is missing.`;
  return `${field} ${first.message}.`;
}

/** The field a validation error is about, as a reader writes it: `result.files[0]`. */
function fieldOf(instancePath: string): string {
  return instancePath
    .split("/")
    .slice(1)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce(
      (written, segment) =>
        /^\d+$/.test(segment) ? `${written}[${segment}]` : `${written}.${segment}`,
      "result",
    );
}

/** What opens a typed result on a report wake and in a brief that builds on it. */
export const RESULT_WORDS = "Its result, as declared:";

/** The result as the brief and the wake show it: compact JSON. */
export function resultText(result: unknown): string {
  return JSON.stringify(result);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
