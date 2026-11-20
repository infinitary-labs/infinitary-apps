import { z } from "zod";

/**
 * The mediated fetch verb's wire shapes (D6, proposal section 5.3): what a
 * frame may ask the host to send on its behalf, and what comes back. These
 * are the request/response halves of `inf.fetch`, and of the core channel
 * that carries it - one definition for both ends.
 *
 * The core refuses every call (`src/core/plugins/mediatedFetch.ts`): the
 * per-plugin hosts and keys are retired, and a panel reaches a service
 * outside the captain's projects through an integration. The shapes stay
 * until a major contract change removes the channel and the verb.
 */

/** The methods the verb's request shape names. */
export const NET_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;

/** The bound a fetch answer's body is shaped to (proposal section 5.2). */
export const NET_BOUNDS = { responseMaxBytes: 1_048_576 } as const;

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

/** Headers the plugin may never set: the host owns credentials and identity. */
export const RESERVED_REQUEST_HEADERS = [
  "authorization",
  "cookie",
  "host",
  "origin",
  "proxy-authorization",
  "referer",
  "user-agent",
] as const;

export const mediatedFetchRequestSchema = z.strictObject({
  method: z.enum(NET_METHODS).default("GET"),
  /** Absolute path on the aliased origin; the host joins it to the origin. */
  path: z
    .string()
    .min(1)
    .max(2_048)
    .regex(/^\/(?![/\\])/, "an absolute path"),
  query: z.record(z.string().min(1).max(256), z.string().max(2_048)).optional(),
  headers: z
    .record(z.string().regex(HEADER_NAME), z.string().max(4_096))
    .optional()
    .refine(
      (headers) =>
        !headers ||
        Object.keys(headers).every(
          (name) => !(RESERVED_REQUEST_HEADERS as readonly string[]).includes(name.toLowerCase()),
        ),
      "a reserved header",
    ),
  body: z.string().max(65_536).optional(),
});
export type MediatedFetchRequest = z.infer<typeof mediatedFetchRequestSchema>;

export const MEDIATED_FETCH_ERROR_CODES = [
  /** No served grant names this plugin and alias. */
  "capability_not_granted",
  /** The alias is granted but the method is not. */
  "method_not_granted",
  "timeout",
  "network",
  "oversized",
  "rate_limited",
] as const;
export type MediatedFetchErrorCode = (typeof MEDIATED_FETCH_ERROR_CODES)[number];

export const mediatedFetchResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    status: z.number().int().min(100).max(599),
    headers: z.record(z.string(), z.string()),
    /** Text, bounded by NET_BOUNDS.responseMaxBytes at the executor. */
    body: z.string().max(NET_BOUNDS.responseMaxBytes),
  }),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.enum(MEDIATED_FETCH_ERROR_CODES), message: z.string().max(500) }),
  }),
]);
export type MediatedFetchResult = z.infer<typeof mediatedFetchResultSchema>;

/** One call as it crosses the core channel: who asks, for which alias, what. */
export const mediatedFetchCallSchema = z.strictObject({
  pluginId: z.string().min(2).max(64),
  alias: z.string().min(1).max(32),
  request: mediatedFetchRequestSchema,
});
export type MediatedFetchCall = z.infer<typeof mediatedFetchCallSchema>;
