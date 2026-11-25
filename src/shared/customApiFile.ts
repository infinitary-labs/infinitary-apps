import { z } from "zod";
import { customCompactionSchema, customModelInputSchema, customProtocolSchema } from "./customApi";

/**
 * Something in a connection file Infinitary reads but never uses, said
 * beside its connection or model. A key, sign-in, environment name or
 * command stays out of every request: each computer keeps its own key.
 */
export const customFileWarningSchema = z.enum([
  /** `apiKey`: the key is typed on each computer instead. */
  "key",
  "oauth",
  "auth-header",
  /** A header value naming an environment variable (`$`) or a command (`!`). */
  "header-reference",
  "model-overrides",
  "sampling",
  /** A model's own `baseUrl` or `api` that differs from its connection's. */
  "model-address",
  "model-headers",
  /** Another Pi setting Infinitary does not read, such as `promptCache`. */
  "unused",
  /** Kept history and the summary's room do not fit the model's window. */
  "compaction",
]);
export type CustomFileWarning = z.infer<typeof customFileWarningSchema>;

/** Why an entry is not a connection at all. */
export const customFileRefusalSchema = z.enum([
  /** Its name is a provider Pi has built in, which it would repoint. */
  "built-in",
  "address",
  /** No `api`, or one Infinitary does not speak. */
  "protocol",
  /** A setting has the wrong shape, such as a model without an id or one listed twice. */
  "invalid",
]);
export type CustomFileRefusal = z.infer<typeof customFileRefusalSchema>;

/**
 * A connection as the file defines it, in the form's own shapes. A limit the
 * file leaves out is zero, unknown, for the server's list to fill. A secret
 * header carries no value: each computer types its own.
 */
export const customFileDefinitionSchema = z.object({
  label: z.string().min(1).max(64),
  baseUrl: z.string().max(4096),
  protocol: customProtocolSchema,
  headers: z.array(
    z.object({ name: z.string().max(128), secret: z.boolean(), value: z.string().optional() }),
  ),
  compaction: customCompactionSchema.optional(),
  models: z.array(customModelInputSchema),
});
export type CustomFileDefinition = z.infer<typeof customFileDefinitionSchema>;

export const customFileConnectionSchema = z.object({
  /** The provider's key in the file: the connection's identity there. */
  name: z.string(),
  refused: customFileRefusalSchema.optional(),
  warnings: z.array(
    z.object({
      kind: customFileWarningSchema,
      model: z.string().optional(),
      /** The file's own key, such as `apiKey` or `promptCache`. */
      key: z.string().max(128).optional(),
    }),
  ),
  definition: customFileDefinitionSchema.optional(),
});
export type CustomFileConnection = z.infer<typeof customFileConnectionSchema>;

/**
 * The connection file this computer reads (Settings → Intelligence): its
 * path, its connections as last read, and why the newest read failed, if it
 * did; a failed read keeps the last good one.
 */
export const customApiFileViewSchema = z.object({
  path: z.string().nullable(),
  failure: z.enum(["missing", "unreadable", "invalid"]).optional(),
  connections: z.array(customFileConnectionSchema),
});
export type CustomApiFileView = z.infer<typeof customApiFileViewSchema>;
