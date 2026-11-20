import { z } from "zod";
import type {
  SqlAnswer,
  SqlParam,
  SqlQuery,
  SqlRefusal,
  SqlRefusalCode,
  SqlRows,
  SqlViewName,
} from "./personal/contracts";

/**
 * The data surface (plugin data surface, Phase B; docs/ui-plugins.md "The
 * record, through SQL"): a read-only SQL query over VERSIONED VIEWS of the
 * app's own record. The views are the published contract - the tables keep
 * migrating underneath, and only `src/core/storage/views.ts` writes view
 * SQL - and a plugin names them exactly (`v_usage_v1`): there is no plain
 * name and no aliasing (captain's B5 b). A view whose shape has to break
 * ships as the next `_vN` beside the old one, which stays published for two
 * releases; an additive change keeps the name and bumps `v_version_v1`'s
 * minor.
 *
 * This file is the wire half both sides agree on: the names, the caps, the
 * request and answer schemas, the refusal codes. The engine that enforces
 * them - read-only connection, authorizer, caps - is the core's
 * (`src/core/sql/`), and the public types are the personal contract's
 * (`src/shared/personal/contracts.ts`), which is what an extension author
 * reads.
 */

/** Every view this version publishes, in the order the docs list them. */
export const SQL_VIEWS = [
  "v_version_v1",
  "v_tasks_v1",
  "v_task_events_v1",
  "v_usage_v1",
  "v_feed_v1",
  "v_quota_windows_v1",
  "v_routing_v1",
  "v_placements_v1",
  "v_projects_v1",
  "v_repos_v1",
] as const satisfies readonly SqlViewName[];

/** The major and minor `v_version_v1` reports; see the file comment for when each moves. */
export const SQL_VIEWS_MAJOR = 1;
export const SQL_VIEWS_MINOR = 2;

/** What a versioned view name looks like, published or not. */
export const SQL_VIEW_NAME_PATTERN = /^v_[a-z][a-z0-9_]*_v[1-9][0-9]*$/;

export function isPublishedView(name: string): name is SqlViewName {
  return (SQL_VIEWS as readonly string[]).includes(name);
}

/**
 * A declared view name. The shape is checked here and the membership where
 * the grant is admitted, so a manifest naming a view this version no longer
 * publishes is refused with a sentence that says so, not a schema error.
 * A pattern rather than a custom check, so the published contract
 * (docs/contract.md) can say what it admits; the type names the published
 * views, whose membership is checked at the grant.
 */
export const sqlViewNameSchema = z.string().regex(SQL_VIEW_NAME_PATTERN, {
  message: "a versioned view name, such as v_usage_v1",
}) as z.ZodType<SqlViewName, string>;

/** The caps every query runs under, whoever asks. */
export const SQL_LIMITS = {
  /** UTF-8 bytes of SQL text. */
  textBytes: 4_096,
  params: 32,
  /** UTF-8 bytes of one string param. */
  paramBytes: 4_096,
  rows: 2_000,
  /** UTF-8 bytes of the rows, as JSON. */
  resultBytes: 262_144,
  /** Wall time of one statement before it is stopped. */
  timeMs: 250,
} as const;

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export const sqlParamSchema: z.ZodType<SqlParam> = z.union([
  z
    .string()
    .refine((value) => utf8Bytes(value) <= SQL_LIMITS.paramBytes, "a param is at most 4 KB"),
  z.number().finite(),
  z.null(),
]);

const sqlTextSchema = z
  .string()
  .min(1)
  .refine((value) => utf8Bytes(value) <= SQL_LIMITS.textBytes, "a query is at most 4 KB");

/** What a subscriber passes: the `sql` read's args, strict. */
export const sqlQuerySchema: z.ZodType<SqlQuery> = z.strictObject({
  sql: sqlTextSchema,
  params: z.array(sqlParamSchema).max(SQL_LIMITS.params).optional(),
});

/**
 * What reaches the core: the query plus the views the asking plugin was
 * GRANTED. The host adds `views` from the manifest; a subscriber never
 * writes it, and a request with none reaches nothing.
 */
export const sqlRequestSchema = z.strictObject({
  sql: sqlTextSchema,
  params: z.array(sqlParamSchema).max(SQL_LIMITS.params).optional(),
  views: z.array(sqlViewNameSchema).max(64),
});
export type SqlRequest = z.infer<typeof sqlRequestSchema>;

export const SQL_REFUSAL_CODES = [
  "sql_view_not_declared",
  "sql_not_readonly",
  "sql_invalid",
  "sql_timeout",
  "sql_too_large",
] as const satisfies readonly SqlRefusalCode[];

const sqlValueSchema = z.union([z.string(), z.number(), z.null()]);

export const sqlRowsSchema: z.ZodType<SqlRows> = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), sqlValueSchema)),
  truncated: z.boolean(),
  elapsedMs: z.number(),
});

export const sqlRefusalSchema: z.ZodType<SqlRefusal> = z.object({
  refused: z.enum(SQL_REFUSAL_CODES),
  message: z.string(),
});

export const sqlAnswerSchema: z.ZodType<SqlAnswer> = z.union([sqlRefusalSchema, sqlRowsSchema]);

export function isSqlRefusal(answer: SqlAnswer): answer is SqlRefusal {
  return "refused" in answer;
}

export function sqlRefusal(refused: SqlRefusalCode, message: string): SqlRefusal {
  return { refused, message };
}

/**
 * Whether two answers say the same thing: the same rows in the same order
 * (and the same refusal). `elapsedMs` is how long it took, not what it
 * says, so a re-run that found nothing new is not news to a subscriber.
 */
export function sameSqlAnswer(a: unknown, b: unknown): boolean {
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const left = a as Partial<SqlRows & SqlRefusal>;
  const right = b as Partial<SqlRows & SqlRefusal>;
  if ("refused" in left || "refused" in right) {
    return left.refused === right.refused && left.message === right.message;
  }
  return (
    left.truncated === right.truncated &&
    JSON.stringify(left.columns) === JSON.stringify(right.columns) &&
    JSON.stringify(left.rows) === JSON.stringify(right.rows)
  );
}
