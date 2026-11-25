import { z } from "zod";
import { secretStateSchema } from "./secrets";

/**
 * The shapes a computer that runs work and its home exchange for a task's
 * Secrets uses there (docs/secrets.md, "On a computer that runs work"),
 * beside the work requests that carry them (`work.ts`).
 */

/**
 * The captain's secrets as a task on another computer lists them: each
 * one's reference, name, saved version and environment label, and nothing
 * else - no value, receipt or use crosses to that computer.
 */
export const placedSecretsSchema = z.object({
  secrets: z.array(
    z.object({
      ref: z.string(),
      label: z.string(),
      version: z.string(),
      environment: z.string().optional(),
    }),
  ),
});

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
 * names, places, the references it replaces, a reason, the asker's own id
 * and, from a computer whose home lists `secret-ask-how`, its how-to, or the
 * withdrawal of a waiting ask by that id. It never carries a value:
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
    /** How the captain gets the secrets, an HTML fragment the home checks and draws (`secret-ask-how.md`). */
    how: z.string().optional(),
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

/**
 * A bring's source as the computer that runs work bound it there
 * (docs/secrets.md, "Bringing secrets from another tool"): the program by its
 * real path and digest, the interpreter its `#!` line names, the arguments as
 * the asker wrote them and the folder by its real path; or the file by its
 * real path and digest. The home shows it on its card and hands it back for
 * the run, and that computer checks every digest again before it runs.
 */
const placedBringSourceSchema = z.union([
  z.strictObject({
    kind: z.literal("run"),
    program: boundSecretFileSchema,
    interpreter: boundSecretFileSchema.extend({ arg: z.string().optional() }).strict().optional(),
    argv: z.array(z.string().max(4096)).min(1).max(256),
    folder: z.string().min(1),
  }),
  z.strictObject({ kind: z.literal("file"), file: boundSecretFileSchema }),
]);
const placedBringReadsSchema = z.enum(["value", "lines", "env0", "json"]);

/**
 * What a computer that runs work asks of the home's Secrets to bring
 * secrets from another tool there (`secret-brings-elsewhere.md`;
 * docs/secrets.md, "Bringing secrets from another tool"). `bring` raises
 * the home's own card for a source bound there; `next` waits for the
 * captain's press and answers what to run and read, `deliver` sends what it
 * read once, and `status` and `cancel` take the asker's id. Only `deliver`
 * carries values, each in base64, and only for the names `next` asked for.
 */
export const placedSecretBringInputSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("bring"),
    id: z.string().min(1),
    reason: z.string().min(1),
    from: z.strictObject({
      tool: z.string().min(1),
      reads: placedBringReadsSchema,
      secrets: z
        .array(
          z.strictObject({
            name: z.string(),
            as: z.string().optional(),
            place: z.string().optional(),
            replace: z.string().optional(),
          }),
        )
        .optional(),
      trim: z.literal("newline").optional(),
    }),
    source: placedBringSourceSchema,
  }),
  z.strictObject({ op: z.literal("status"), id: z.string().min(1) }),
  z.strictObject({ op: z.literal("cancel"), id: z.string().min(1) }),
  z.strictObject({ op: z.literal("next"), id: z.string().min(1) }),
  z.strictObject({
    op: z.literal("deliver"),
    id: z.string().min(1),
    run: z.string().min(1),
    result: z.union([
      z.strictObject({
        values: z.record(
          z.string(),
          z.union([
            z.strictObject({ value: z.string() }),
            z.strictObject({ cannot: z.enum(["empty", "too-large", "not-text"]) }),
          ]),
        ),
      }),
      z.strictObject({
        failed: z.strictObject({
          exitCode: z.number().int().optional(),
          signal: z.string().optional(),
        }),
      }),
      z.strictObject({ ended: z.enum(["changed", "too-large", "invalid-json"]) }),
    ]),
  }),
]);
export type PlacedSecretBringInput = z.infer<typeof placedSecretBringInputSchema>;

/** How a bring ended, as its asker hears it: names, places, references and outcomes, never a value. */
const placedBringEndedSchema = z.union([
  z.strictObject({
    bring: z.string(),
    state: z.literal("kept"),
    secrets: z.array(
      z.strictObject({
        name: z.string(),
        place: z.string(),
        outcome: z.enum([
          "kept",
          "skipped",
          "not-found",
          "empty",
          "too-large",
          "not-text",
          "changed",
        ]),
        ref: z.string().optional(),
        version: z.number().int().optional(),
      }),
    ),
  }),
  z.strictObject({ bring: z.string(), state: z.literal("not-brought") }),
  z.strictObject({
    bring: z.string(),
    state: z.literal("failed"),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    why: z.string(),
  }),
  z.strictObject({ bring: z.string(), state: z.literal("changed") }),
  z.strictObject({ bring: z.string(), state: z.literal("expired") }),
  z.strictObject({ bring: z.string(), state: z.literal("withdrawn"), why: z.string() }),
]);

/**
 * What the home answers: a bring waiting for the captain or unavailable with
 * the home's words; its status; whether a withdrawal found it waiting; what
 * to run and read once the captain pressed, `wait` to ask again, or `over`
 * once the bring ended; and `ok` for a delivery.
 */
export const placedSecretBringAnswerSchema = z.union([
  z.strictObject({
    bring: z.union([
      z.strictObject({ bring: z.string(), state: z.literal("waiting") }),
      z.strictObject({ bring: z.string(), state: z.literal("unavailable"), help: z.string() }),
    ]),
  }),
  z.strictObject({
    status: z
      .union([
        z.strictObject({ bring: z.string(), state: z.literal("waiting") }),
        placedBringEndedSchema,
      ])
      .nullable(),
  }),
  z.strictObject({ withdrawn: z.boolean() }),
  z.strictObject({
    run: z.strictObject({
      run: z.string().min(1),
      source: placedBringSourceSchema,
      reads: placedBringReadsSchema,
      trim: z.literal("newline").optional(),
      names: z.array(z.string()).nullable(),
    }),
  }),
  z.strictObject({ wait: z.literal(true) }),
  z.strictObject({ over: z.literal(true) }),
  z.strictObject({ ok: z.literal(true) }),
]);
export type PlacedSecretBringAnswer = z.infer<typeof placedSecretBringAnswerSchema>;
