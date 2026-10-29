import type { z } from "zod";
import { deliverableSchema, workKindSchema } from "./routingPolicy";
import { taskKindSchema } from "./tasks";
import { usageWorkKindSchema } from "./usage";

/**
 * The open lists (docs/contract.md, "The version rule"; INF-1649, the
 * captain's "Yes, for what phones and views read"): closed sets a view
 * reads, each with what it shows for a member it does not know. A newer
 * home may add a member to one of these without breaking views, so its
 * major's file can say `Views: keep.`; a new member of any other closed
 * set still breaks them.
 *
 * Only reading leans on this list. The home reads what it is asked as
 * published, and a computer that runs work stays on the home's own major.
 */
export const VIEW_OPEN_LISTS: ReadonlyArray<{
  list: z.ZodEnum;
  /** What a view shows instead: a member of the list, or null where the field may be empty. */
  unknown: string | null;
}> = [
  // A task of a kind this view does not know is a task like any other.
  { list: taskKindSchema, unknown: "work" },
  // What it delivers: before the axis existed, everything was a change.
  { list: deliverableSchema, unknown: "change" },
  // Its whole-task kind: one this view cannot name is unclear.
  { list: workKindSchema, unknown: "unclear" },
  // Usage's kinds: a kind the list does not know is "Other task work".
  { list: usageWorkKindSchema, unknown: null },
];

type Issue = {
  code: string;
  path: PropertyKey[];
  values?: unknown[];
  errors?: Issue[][];
};

/**
 * Reads what a home sent against a published schema, keeping a member of
 * an open list this build does not know as that list's stand-in. Returns
 * the parsed value, or the strict parse's failure when the value breaks
 * the schema in any other way.
 */
export function readKeepingUnknown<T extends z.ZodType>(
  schema: T,
  value: unknown,
): ReturnType<T["safeParse"]> {
  let parsed = schema.safeParse(value);
  if (parsed.success) return parsed as ReturnType<T["safeParse"]>;
  const first = parsed;
  let copy: unknown;
  // Each pass replaces at least one unknown member, and a value holds finitely many.
  for (;;) {
    copy ??= structuredClone(value);
    if (!replaceUnknown(copy, parsed.error.issues as Issue[], [])) break;
    parsed = schema.safeParse(copy);
    if (parsed.success) return parsed as ReturnType<T["safeParse"]>;
  }
  return first as ReturnType<T["safeParse"]>;
}

/** Replaces each unknown member an issue points at; true when it replaced one. */
function replaceUnknown(root: unknown, issues: Issue[], prefix: PropertyKey[]): boolean {
  let replaced = false;
  for (const issue of issues) {
    const path = [...prefix, ...issue.path];
    if (issue.code === "invalid_union") {
      for (const branch of issue.errors ?? [])
        replaced = replaceUnknown(root, branch, path) || replaced;
      continue;
    }
    if (issue.code !== "invalid_value" || !issue.values || path.length === 0) continue;
    const open = openListOf(issue.values);
    if (!open) continue;
    const parent = at(root, path.slice(0, -1));
    const key = path[path.length - 1] as PropertyKey;
    if (parent === null || typeof parent !== "object") continue;
    const current = (parent as Record<PropertyKey, unknown>)[key];
    if (typeof current !== "string" || issue.values.includes(current)) continue;
    (parent as Record<PropertyKey, unknown>)[key] = open.unknown;
    replaced = true;
  }
  return replaced;
}

function openListOf(values: unknown[]) {
  return VIEW_OPEN_LISTS.find(
    ({ list }) =>
      list.options.length === values.length &&
      list.options.every((member) => values.includes(member)),
  );
}

function at(root: unknown, path: PropertyKey[]): unknown {
  let here = root;
  for (const key of path) {
    if (here === null || typeof here !== "object") return undefined;
    here = (here as Record<PropertyKey, unknown>)[key];
  }
  return here;
}
