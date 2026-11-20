import { z } from "zod";
import { secretStateSchema } from "./secrets";

/**
 * The shapes a computer that runs work and its home exchange for a task's
 * Secrets uses there (docs/secrets.md, "On a computer that runs work"),
 * beside the work requests that carry them (`work.ts`).
 */

/** A file a recipient there binds, by its real path and the digest of what runs. */
const boundSecretFileSchema = z.strictObject({
  path: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

/**
 * Every fact a use on a computer that runs work binds there (docs/secrets.md,
 * "On a computer that runs work"): the program, the interpreter its `#!` line
 * names and each file argument by real path and digest, the arguments, the
 * folder, and which variable gets which secret, as that computer's recipient
 * bound them. The home shows and journals them and binds a saved decision to
 * them and to the computer; the computer checks them again right before the
 * program starts.
 */
export const secretRecipientFactsSchema = z.strictObject({
  executable: boundSecretFileSchema.extend({ copied: z.boolean() }),
  interpreter: boundSecretFileSchema
    .extend({ copied: z.boolean(), arg: z.string().optional() })
    .optional(),
  argv: z.array(z.string()).min(1),
  inputs: z.array(boundSecretFileSchema.extend({ index: z.number().int().positive() })),
  cwd: z.string().min(1),
  env: z.record(z.string(), z.string()),
  delivery: z.literal("environment"),
});

/** A use's receipt as the home answers it there: its request and state, never a value. */
const placedSecretReceiptSchema = z.strictObject({
  request: z.string().min(1),
  state: secretStateSchema,
  exitCode: z.number().int().optional(),
});

/**
 * What a computer that runs work asks of the home's Secrets for its task
 * (docs/secrets.md, "On a computer that runs work"): the pre-check of a run
 * it bound, a use of it, a receipt, a cancellation, and how the program it
 * started ended. Each repeats safely: an intent answers its first receipt,
 * and an end is taken once.
 */
export const placedSecretUseInputSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("check"), facts: secretRecipientFactsSchema }),
  z.strictObject({
    op: z.literal("inject"),
    id: z.string().min(1),
    reason: z.string().min(1),
    facts: secretRecipientFactsSchema,
  }),
  z.strictObject({ op: z.literal("status"), request: z.string().min(1) }),
  z.strictObject({ op: z.literal("cancel"), request: z.string().min(1) }),
  z.strictObject({
    op: z.literal("ended"),
    request: z.string().min(1),
    result: z.union([
      z.strictObject({ exitCode: z.number().int() }),
      z.strictObject({ signal: z.string() }),
      z.strictObject({ outcome: z.enum(["changed", "undeliverable", "failed", "lost"]) }),
    ]),
  }),
]);
export type PlacedSecretUseInput = z.infer<typeof placedSecretUseInputSchema>;
export const placedSecretUseAnswerSchema = z.union([
  z.strictObject({
    check: z.union([
      z.strictObject({ problem: z.enum(["secret", "unavailable"]) }),
      z.strictObject({ decision: z.enum(["never", "ask", "allow"]) }),
    ]),
  }),
  z.strictObject({ receipt: placedSecretReceiptSchema.nullable() }),
  z.strictObject({ ok: z.literal(true) }),
]);
export type PlacedSecretUseAnswer = z.infer<typeof placedSecretUseAnswerSchema>;
/**
 * The values an approved use hands its program there, by variable, each in
 * base64, given once; or the state the use reached without them (`taken`
 * when an earlier ask already took them).
 */
export const placedSecretTakeAnswerSchema = z.union([
  z.strictObject({ values: z.record(z.string(), z.string()) }),
  z.strictObject({ state: z.union([secretStateSchema, z.literal("taken")]) }),
]);
export type PlacedSecretTakeAnswer = z.infer<typeof placedSecretTakeAnswerSchema>;

/** A kept secret as an ask's asker hears it: its reference, name, place and version, never a value. */
const placedKeptSecretSchema = z.strictObject({
  ref: z.string().min(1),
  name: z.string(),
  place: z.string(),
  version: z.number().int(),
});

/**
 * What a computer that runs work asks of the home's Secrets to keep a secret
 * for its task (docs/secrets.md, "Asking to keep a secret"): an ask by its
 * names, places, the references it replaces, a reason and the asker's own id,
 * or the withdrawal of a waiting ask by that id. It never carries a value:
 * the captain types it into the home's own card. Each repeats safely: asking
 * again with a waiting ask's id raises nothing new.
 */
export const placedSecretAskInputSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("ask"),
    id: z.string().min(1),
    reason: z.string().min(1),
    secrets: z
      .array(
        z.strictObject({
          name: z.string().optional(),
          place: z.string().optional(),
          replace: z.string().optional(),
        }),
      )
      .min(1),
  }),
  z.strictObject({ op: z.literal("cancel"), id: z.string().min(1) }),
]);
export type PlacedSecretAskInput = z.infer<typeof placedSecretAskInputSchema>;
/**
 * What the home answers at once: the ask waiting for the captain, already
 * kept with its references, or unavailable with the home's words; or whether
 * a withdrawal found a waiting ask. Whether the captain kept it reaches the
 * task once, through its inbox.
 */
export const placedSecretAskAnswerSchema = z.union([
  z.strictObject({
    ask: z.union([
      z.strictObject({ ask: z.string(), state: z.literal("waiting") }),
      z.strictObject({
        ask: z.string(),
        state: z.literal("kept"),
        secrets: z.array(placedKeptSecretSchema),
      }),
      z.strictObject({ ask: z.string(), state: z.literal("unavailable"), help: z.string() }),
    ]),
  }),
  z.strictObject({ withdrawn: z.boolean() }),
]);
export type PlacedSecretAskAnswer = z.infer<typeof placedSecretAskAnswerSchema>;
