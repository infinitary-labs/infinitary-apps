import { z } from "zod";
import { type DecisionUseId, decisionUseViewSchema } from "./decisionUses";

/**
 * Decision models (S7, captain-approved design `fm3000-decision-models-s7-
 * design-s1/report.md`, sections 2 and 5).
 *
 * A DECISION MODEL answers one typed, bounded question about a piece of
 * state and returns one value from the closed set the question declared.
 * It generates no text, calls no tool, holds no session, and reads nothing
 * it was not handed. That is the exact opposite of an intelligence slot,
 * which holds models that DO work in a session with tools - which is why
 * this is a fifth GROUP on the Models board and not a fifth `Slot`, and
 * why nothing here reaches `PROVIDER_CATALOG`, the account vault, the
 * routing pool or a quota window (report section 4).
 *
 * Two things are deliberately absent from the interface, on the captain's
 * own call (report section 10, his annotation): `confidence` and any
 * probability distribution. The adapter path cannot supply one honestly,
 * and a field one implementation fakes and the other fills is the kind of
 * interface later code learns to trust. A native model that measures its
 * own certainty keeps it INSIDE its implementation, uses it to decide
 * when to answer the question's declared abstention, and writes it to the
 * record as free-text `detail` - never as a typed answer field.
 */

/** A native decision model's id. One row today. */
export const decisionModelIdSchema = z.literal("jev");
export type DecisionModelId = z.infer<typeof decisionModelIdSchema>;

/**
 * The shapes a typed question can take. A yes/no question is a two-option
 * `choice`; it needs no third shape. `score` is here because the class is
 * defined by it, not because the app asks one yet.
 */
export const decisionQuestionTypeSchema = z.enum(["choice", "score"]);
export type DecisionQuestionType = z.infer<typeof decisionQuestionTypeSchema>;

/**
 * One typed question. `criteria` is the closed option set, keyed by the id
 * the answer comes back as; the order it is written in is the order both
 * implementations serve it.
 *
 * `abstain` names the option that means "I cannot tell". It is an ordinary
 * member of the set as far as the consumer is concerned, but each
 * implementation honours it in its own way: the adapter offers it as a word
 * among the others, while a native model never SEES it - so its own
 * distribution is over the real options - and the implementation returns it
 * when its certainty is under the catalog row's floor.
 *
 * Every consumer owns its question text the way S3 owns its instruction:
 * `version` is that consumer's contract number, and the service stamps the
 * answer with `<version>-<sha12 of what was actually served>`, so a verdict
 * recorded months ago still says which question was asked and to whom.
 */
export const decisionQuestionSchema = z.object({
  type: decisionQuestionTypeSchema,
  /** What the model is being asked, in the consumer's own words. */
  instructions: z.string().min(1),
  /** option id -> what that option means. Insertion order is serving order. */
  criteria: z.record(z.string().min(1), z.string().min(1)),
  /** The option that means "I cannot tell". */
  abstain: z.string().min(1).optional(),
  /** The consumer's contract number for this question, e.g. `kc1`. */
  version: z.string().min(1),
  /**
   * The exact instruction the ADAPTER serves as its system prompt. A
   * consumer whose wording was tuned against a chat model pins it here, so
   * the served bytes - and therefore the answer's fingerprint - do not move
   * when the class is introduced around it. Without it the adapter renders
   * `instructions` and `criteria` itself.
   */
  adapterInstruction: z.string().min(1).optional(),
});
export type DecisionQuestion = z.infer<typeof decisionQuestionSchema>;

/** A fact's value: named, bounded, and never a nested structure to get lost in. */
export const decisionFactSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/**
 * The state a question is evaluated against: named, bounded facts and
 * nothing the caller did not clip. TypeSafe's own guidance is an object
 * "so each part of the state has a descriptive name and its relationships
 * remain clear"; the same shape keeps what each use sends named fact by
 * fact in its consumer's code.
 */
export const decisionStateSchema = z.object({
  facts: z.record(z.string().min(1), decisionFactSchema),
  /**
   * The same facts as the adapter's single user message. A consumer whose
   * wording was tuned against a chat model pins it here for the same reason
   * `adapterInstruction` exists; without it the adapter renders `facts` as
   * `name: value` lines.
   */
  adapterText: z.string().optional(),
});
export type DecisionState = z.infer<typeof decisionStateSchema>;

/**
 * How an answer came about. This is the one field that replaces what
 * `confidence` used to be asked to carry: a consumer needs to tell a model
 * that said "I cannot tell" from a call that never happened, and both of
 * those from an answer, because the three are different facts about the
 * world. `failed` always still carries a `value` - the question's
 * abstention - so no caller ever has to handle an absent answer.
 */
export const decisionOutcomeSchema = z.enum(["answered", "abstained", "failed"]);
export type DecisionOutcome = z.infer<typeof decisionOutcomeSchema>;

export const decisionAnswerSchema = z.object({
  /** One id from the question's `criteria`; the abstention when it could not be told. */
  value: z.string(),
  outcome: decisionOutcomeSchema,
  /**
   * Who answered: `xai/grok-4.6` through the adapter, `jev/jev-1.13.0`
   * natively. Absent only when nothing could be bound at all.
   */
  source: z.string().optional(),
  /** `<question version>-<sha12 of the served question>`. */
  version: z.string(),
  /**
   * The short machine word for a failure - `timeout`, `no-model`,
   * `provider`, `unparsed`, `rate-limited` - so a caller can record WHY
   * without parsing prose. Present only when `outcome` is `failed`.
   */
  reason: z.string().optional(),
  /**
   * Free prose for the record: a native model's own certainty (`p=0.93`),
   * the note that a native call failed and the adapter answered in its
   * place. Never parsed by a caller and never a typed field in disguise.
   */
  detail: z.string().optional(),
});
export type DecisionAnswer = z.infer<typeof decisionAnswerSchema>;

/**
 * Who is asking, for the ledger and the record. `taskId` is how the burn
 * lands in `usage_events` under the work that caused it; a caller with no
 * task spends under its own `purpose`, the way the Firstmate's own burn
 * lands under `firstmate`.
 */
export type DecisionCaller = {
  purpose: string;
  taskId?: string;
  /**
   * Which listed use asks (`src/shared/decisionUses.ts`). The service
   * requires it, and checks that use's switch and the answering model's
   * approval before any model or key is read.
   */
  use?: DecisionUseId;
};

/**
 * One approval screen's rows, as the consent dialog shows them: what is
 * shared and with whom, what the person can change, and what it costs.
 */
export type DecisionConsentText = readonly [shared: string, choice: string, cost: string];

/**
 * The native decision models this app knows. NOT a `PROVIDER_CATALOG` row:
 * there is no backend, no role, no account and no quota window here - one
 * endpoint, one pinned model alias, and the certainty below which the
 * implementation answers the question's abstention instead.
 */
export const DECISION_MODEL_CATALOG = [
  {
    id: "jev",
    name: "Jev",
    vendor: "TypeSafe",
    endpoint: "https://api.typesafe.ai/v1/systemone",
    /** Pinned in code: the app never fetches a catalog from the vendor. */
    model: "jev-latest",
    /** Below this the implementation answers the question's abstention. */
    abstainBelow: 0.6,
    /** Where the user's own key comes from, for the turn-on form. */
    keysUrl: "https://console.typesafe.ai/keys",
  },
] as const;

export type DecisionModelCatalogRow = (typeof DECISION_MODEL_CATALOG)[number];

export function decisionModelRow(id: DecisionModelId): DecisionModelCatalogRow {
  const row = DECISION_MODEL_CATALOG.find((entry) => entry.id === id);
  if (!row) throw new Error(`unknown decision model ${id}`);
  return row;
}

/**
 * The feed's note, once per key, when a native model's vendor rejects the
 * key (its own 401): the row says key rejected and the user's own models
 * answer until the key is replaced. `name` is the model's catalog name.
 */
export function decisionKeyRejectedNote(name: string): string {
  return `${name} rejected the key - decisions are running on your own models until it is replaced`;
}

/**
 * Which model answers typed decisions. `adapted` is one of the user's OWN
 * subscription models - reached through that account's provider exactly as
 * a crewmate turn is, so it adds no outbound destination - with `auto`
 * meaning the S3 walk (cheapest slotted first). `native` is a catalog row,
 * usable only while its egress is on and its key is stored.
 */
export const decisionAnswererSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("adapted"),
    offering: z.union([z.literal("auto"), z.string().min(1)]),
  }),
  z.strictObject({ kind: z.literal("native"), id: decisionModelIdSchema }),
  z.strictObject({ kind: z.literal("openrouter"), model: z.string().min(1) }),
]);
export type DecisionAnswerer = z.infer<typeof decisionAnswererSchema>;

/** Per Jev or OpenRouter: whether it may answer, and which approval screen the person saw. */
export const decisionEgressSchema = z.strictObject({
  enabled: z.boolean(),
  /** The approval screen accepted (`DECISION_APPROVAL_VERSION`); absent means never. */
  consentedVersion: z.number().int().optional(),
});
export type DecisionEgress = z.infer<typeof decisionEgressSchema>;

/**
 * The `decisions` settings row. The KEY is deliberately not here: it lives
 * in its own 0700 directory under userData (`src/core/decisions/jev/
 * jevKeyStore.ts`), so this row can be read, logged and exported without
 * carrying a secret, and `egress` is independent of `answerer` so turning a
 * native model off never loses the pick or the key.
 */
export const decisionsSettingsSchema = z.strictObject({
  version: z.literal(1),
  answerer: decisionAnswererSchema,
  /** Keyed by `DecisionModelId` or `openrouter`; an absent entry is off and unapproved. */
  egress: z.record(z.string().min(1), decisionEgressSchema),
});
export type DecisionsSettings = z.infer<typeof decisionsSettingsSchema>;

/**
 * The default IS today's behaviour, byte for byte: the adapter's own walk
 * over the cheapest slotted model, and no native endpoint in existence
 * until the user acts twice (paste a key, turn it on).
 */
export const DEFAULT_DECISIONS: DecisionsSettings = {
  version: 1,
  answerer: { kind: "adapted", offering: "auto" },
  egress: {},
};

/**
 * The approval screen for a native model (`DECISION_APPROVAL_VERSION`), in
 * plain words. A decision model is treated like the person's other models:
 * it may be asked about anything a listed use sends, so the screen names
 * the kinds of content rather than promising less, and approving it covers
 * every use in the list. It states what Infinitary sends and to whom, and
 * makes no claim on the vendor's behalf about what happens next.
 */
export function decisionConsent(row: DecisionModelCatalogRow): DecisionConsentText {
  return [
    `${row.name} (${row.vendor}) answers Infinitary's decision questions, like your other models. Questions can include task details, your replies, nearby conversation and code.`,
    `Turn off any use in the Decisions list, or remove ${row.name}.`,
    `${row.vendor} charges your key per token. If ${row.name} cannot answer, your own models answer instead.`,
  ];
}

/** A native model's row state on the Models board (report section 5.2). */
export const decisionRowStateSchema = z.enum(["absent", "off", "ready", "key-rejected"]);
export type DecisionRowState = z.infer<typeof decisionRowStateSchema>;

/**
 * What a pinned offering ("Use a specific model") comes to right now:
 * `ready` while it can answer, `fallback` when it cannot and the cheapest
 * slotted model answers in its place, `held` when it cannot and nothing
 * does - a named custom connection never moves to another account.
 */
export const decisionPinStateSchema = z.enum(["ready", "fallback", "held"]);
export type DecisionPinState = z.infer<typeof decisionPinStateSchema>;

/** A choice-capable classifier in the signed-in OpenRouter account's Pi catalog. */
export const openRouterDecisionOfferingSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  vendor: z.string(),
  inputPrice: z.number(),
});
export type OpenRouterDecisionOffering = z.infer<typeof openRouterDecisionOfferingSchema>;

/** The same approval screen for a model reached through the person's OpenRouter account. */
export function openRouterDecisionConsent(model: OpenRouterDecisionOffering): DecisionConsentText {
  return [
    `${model.name} (${model.vendor}) answers Infinitary's decision questions through OpenRouter, like your other models. Questions can include task details, your replies, nearby conversation and code.`,
    "Turn off any use in the Decisions list, or choose another decision model.",
    `Your OpenRouter account pays per input token; output is free. If ${model.name} cannot answer, your own models answer instead.`,
  ];
}

/** The Decisions row's line while an OpenRouter pick answers. */
export function openRouterDecisionLine(model: Pick<OpenRouterDecisionOffering, "name">): string {
  return `${model.name} · OpenRouter · on`;
}

/** The Decisions group's derived availability and last answer, never credentials. */
export const decisionsViewSchema = z.strictObject({
  settings: decisionsSettingsSchema,
  /**
   * The first approval screen's version, which an older view writes when it
   * turns Jev or OpenRouter on: it never approves a newer screen by echoing
   * a newer number.
   */
  stateVersion: z.number().int(),
  /** The approval screen this home shows (`DECISION_APPROVAL_VERSION`); absent on an older home. */
  approvalVersion: z.number().int().optional(),
  /** Every way this home uses decision models, with its switch; absent on an older home. */
  uses: z.array(decisionUseViewSchema).optional(),
  /**
   * Whether the pinned offering is the model answering, so the row names
   * it only while it is. Absent unless a specific model is pinned.
   */
  pinned: decisionPinStateSchema.optional(),
  openrouter: z
    .strictObject({
      models: z.array(openRouterDecisionOfferingSchema),
      state: z.enum(["off", "ready", "signed-out"]),
      consented: z.boolean(),
      last: z
        .strictObject({ value: z.string(), tokens: z.number().int(), at: z.number() })
        .nullable(),
    })
    .optional(),
  natives: z.array(
    z.strictObject({
      id: decisionModelIdSchema,
      name: z.string(),
      vendor: z.string(),
      keysUrl: z.string(),
      state: decisionRowStateSchema,
      /** Whether a key is stored at all; never the key. */
      keyStored: z.boolean(),
      /** Whether the person has approved it on any approval screen. */
      consented: z.boolean(),
      /** The last answer this model gave, for the row's mono line. */
      last: z
        .strictObject({ value: z.string(), tokens: z.number().int(), at: z.number() })
        .nullable(),
    }),
  ),
});
export type DecisionsView = z.infer<typeof decisionsViewSchema>;

/**
 * The offering key an adapted pin names: the same `provider/id` shape the
 * model-slot record uses, so the Decisions group and the slot groups speak
 * one vocabulary.
 */
export function decisionOfferingKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

/** Splits an offering key back into its parts; undefined when it is `auto`. */
export function parseDecisionOffering(
  offering: string,
): { provider: string; id: string } | undefined {
  if (offering === "auto") return undefined;
  const slash = offering.indexOf("/");
  if (slash <= 0 || slash === offering.length - 1) return undefined;
  return { provider: offering.slice(0, slash), id: offering.slice(slash + 1) };
}
