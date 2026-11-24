import { createHash } from "node:crypto";
import type {
  DecisionAnswer,
  DecisionCaller,
  DecisionModelCatalogRow,
  DecisionModelId,
  DecisionPinState,
  DecisionQuestion,
  DecisionState,
  DecisionsSettings,
  DecisionsView,
  OpenRouterDecisionOffering,
} from "@shared/decisions";
import {
  DECISION_MODEL_CATALOG,
  decisionKeyRejectedNote,
  parseDecisionOffering,
} from "@shared/decisions";
import {
  DECISION_APPROVAL_VERSION,
  DECISION_FIRST_APPROVAL_VERSION,
  type DecisionUseId,
  type DecisionUseRequest,
  type DecisionUseSwitches,
  decisionApproval,
  decisionUse,
  decisionUseAllowed,
  decisionUsesView,
} from "@shared/decisionUses";
import {
  QUESTION_TIMEOUT_MS,
  QuestionTurns,
  type QuestionTurnsOptions,
  type QuestionUsage,
} from "../session/questionTurns";

/**
 * The decision-model class (S7a, captain-approved design
 * `fm3000-decision-models-s7-design-s1/report.md`, sections 2 and 8.1).
 *
 * Three things live here, and the split is the whole point:
 *
 * - `DecisionModel` is what a model that answers typed questions looks
 *   like. Two implementations qualify: a NATIVE one that serves the typed
 *   question as its API (Jev, S7b), and the ADAPTER, which turns a question
 *   into a chat prompt and parses a word back - which is exactly what S3's
 *   kind classifier already was.
 * - `AdaptedDecisionModel` is that S3 machinery, generalised to a question
 *   and nothing more: the same low-first candidate walk, the same stateless
 *   64-token Pi session for each question, the same fail-soft discipline. A
 *   caller that sets `together` gets one uncapped session for the whole set,
 *   one line per question, and a line it cannot read fails only its own
 *   question. A consumer that
 *   pins its served bytes (`adapterInstruction`, `adapterText`) gets the
 *   same call it got before this class existed, sha for sha.
 * - `DecisionModels` is the CORE-WIDE service (the captain's annotation,
 *   report section 10): registered once in `homeDecisions.ts` and handed to
 *   whichever module needs it, the way `TaskService` is. Adding a consumer
 *   is adding a question - not a model, not a transport, not a setting.
 *
 * Rules every caller gets for free and cannot opt out of: the call is
 * bounded (the caller's own signal, plus the transport's); it NEVER throws
 * - every failure is the question's declared abstention with the short
 * `reason` on the record; the burn lands in `usage_events` under the
 * caller's task; and a
 * native model that cannot answer is answered for by the adapter rather
 * than by silence.
 */

/** Hard wall clock per decision: a caller waits no longer than this. */
export const DECIDE_TIMEOUT_MS = QUESTION_TIMEOUT_MS;

export type DecisionUsage = QuestionUsage;

/** One model's answers to one state, plus what they cost. */
export type DecisionRun = {
  answers: Record<string, DecisionAnswer>;
  usage: DecisionUsage[];
};

export interface DecisionModel {
  /** `adapted`, or the catalog id of a native model. */
  readonly id: string;
  /** Whether it serves the typed question as its own API. */
  readonly native: boolean;
  /** The pick its row's last answer belongs to, when one id serves several (OpenRouter's). */
  readonly pick?: string;
  decide(
    caller: DecisionCaller,
    state: DecisionState,
    questions: Record<string, DecisionQuestion>,
    signal: AbortSignal,
  ): Promise<DecisionRun>;
}

/**
 * The fingerprint an answer is stamped with: the consumer's contract number
 * and the proof of the bytes actually served. Two implementations serving
 * the same question produce two fingerprints, which is the honest answer -
 * they did not ask the same thing.
 */
export function questionVersion(question: DecisionQuestion, served: string): string {
  return `${question.version}-${createHash("sha256").update(served).digest("hex").slice(0, 12)}`;
}

export function abstentionOf(question: DecisionQuestion): string {
  return question.abstain ?? Object.keys(question.criteria)[0] ?? "";
}

/**
 * The words the ADAPTER may answer with: the declared options plus the
 * abstention. A native model never sees the abstention - so its own
 * distribution is over the real options - but a chat model has no
 * distribution to read, so "answer unclear rather than guessing" is the
 * only way it can decline, exactly as S3's instruction has always said.
 */
export function adapterOptions(question: DecisionQuestion): string[] {
  const options = Object.keys(question.criteria);
  if (question.abstain && !options.includes(question.abstain)) options.push(question.abstain);
  return options;
}

export function failedAnswer(
  question: DecisionQuestion,
  reason: string,
  version: string,
  source?: string,
): DecisionAnswer {
  return {
    value: abstentionOf(question),
    outcome: "failed",
    version,
    reason,
    ...(source ? { source } : {}),
  };
}

/**
 * One word, parsed by code, against the question's own option set. A
 * one-word answer is read as it stands; a model that wrapped its answer in
 * a sentence is still honored when exactly ONE option word appears in the
 * whole reply, because an unambiguous answer is an answer whatever
 * punctuation it arrived in. Anything naming two options - "fix or
 * implement" - is not an answer and neither is a reply naming none: both
 * are `undefined`, which the caller records as an unparsed failure.
 */
export function parseOption(answer: string, options: readonly string[]): string | undefined {
  const allowed = new Set(options.map((option) => option.toLowerCase()));
  const words = answer.toLowerCase().match(/[a-z]+/g) ?? [];
  const first = words[0];
  if (words.length === 1 && first && allowed.has(first)) return first;
  const found = [...new Set(words.filter((word) => allowed.has(word)))];
  return found.length === 1 ? found[0] : undefined;
}

/**
 * What the adapter serves as its system prompt: the consumer's pinned text
 * when it has one, else the question rendered - the instructions, the
 * options with what each means, and the closed list to answer from.
 */
export function renderAdapterInstruction(question: DecisionQuestion): string {
  if (question.adapterInstruction) return question.adapterInstruction;
  const options = adapterOptions(question);
  const lines = [question.instructions, "", "The options:"];
  for (const option of options) {
    lines.push(
      `${option} - ${question.criteria[option] ?? "you cannot tell from what you were given"}`,
    );
  }
  lines.push("", `Answer with exactly one of: ${options.join(", ")}.`);
  return lines.join("\n");
}

/**
 * What the adapter serves when a caller asks the whole set in one call
 * (`DecisionCaller.together`): each question as it would be served alone,
 * under its own id, then one reply format for all of them.
 */
export function renderTogetherInstruction(questions: Record<string, DecisionQuestion>): string {
  const ids = Object.keys(questions);
  // i18n-exempt: an instruction served to the decision model, not shown to a person
  const lines = [
    `Answer each of the ${ids.length} questions below about the same input. Judge each one on its own.`,
  ];
  for (const [id, question] of Object.entries(questions)) {
    lines.push("", `[question ${id}]`, renderAdapterInstruction(question));
  }
  // i18n-exempt: an instruction served to the decision model, not shown to a person
  lines.push(
    "",
    `Reply with exactly ${ids.length} lines and nothing else, one per question in the order asked, each written as the question's id, a colon and your answer, such as "${ids[0]}: ${adapterOptions(questions[ids[0] as string] as DecisionQuestion)[0]}".`,
  );
  return lines.join("\n");
}

/**
 * Reads a reply to a set asked in one call: each line that starts with a
 * question's id answers that question, parsed against its own options. A
 * question whose line is missing, repeated or unreadable gets no value, so
 * only that question fails.
 */
export function parseTogether(
  reply: string,
  questions: Record<string, DecisionQuestion>,
): Record<string, string | undefined> {
  const found = new Map<string, string[]>();
  for (const line of reply.split("\n")) {
    const match = line.match(/^[\s*`>#-]*([A-Za-z0-9_-]+)[\s*`]*[:=]\s*(.*)$/);
    if (!match) continue;
    const id = match[1] as string;
    if (!Object.hasOwn(questions, id)) continue;
    found.set(id, [...(found.get(id) ?? []), match[2] as string]);
  }
  return Object.fromEntries(
    Object.entries(questions).map(([id, question]) => {
      const answers = found.get(id);
      return [
        id,
        answers?.length === 1
          ? parseOption(answers[0] as string, adapterOptions(question))
          : undefined,
      ];
    }),
  );
}

/** The adapter's single user message: the consumer's pinned text, else the facts. */
export function renderAdapterState(state: DecisionState): string {
  if (state.adapterText !== undefined) return state.adapterText;
  return Object.entries(state.facts)
    .filter(([, value]) => value !== null && value !== "")
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
}

export type AdaptedDecisionModelOptions = QuestionTurnsOptions & {
  /**
   * Which offering the user pinned, or `auto` for the walk (report section
   * 5.1, the captain's Q5 A). A pin that cannot be bound falls back to the
   * walk rather than refusing to answer.
   */
  offering?: () => string;
};

/**
 * The adapter: any chat model in the routable pool qualifies as a decision
 * model - Pi-served in process, or Claude-served on the machine's own
 * client (W1 S10) - because a typed question renders as a byte-stable
 * instruction plus the state as one user message, the abstention is offered
 * as a word among the others, and the answer is one word parsed by code.
 * The walk and the session are the one-question walk's
 * (`src/core/session/questionTurns.ts`); this class adds the question's
 * rendering, the person's pin and the parse.
 *
 * Everything about it is shaped by one rule, inherited unchanged from S3: a
 * broken decision model must cost quota, never correctness. Every way it can
 * fail - no signed-in model, a dead account store, a provider error, a
 * timeout, an answer that is not one of the options - resolves to the
 * question's abstention.
 */
export class AdaptedDecisionModel implements DecisionModel {
  readonly id = "adapted";
  readonly native = false;
  private readonly turns: QuestionTurns;

  constructor(private readonly options: AdaptedDecisionModelOptions) {
    this.turns = new QuestionTurns(options);
  }

  /**
   * One bounded call PER QUESTION: a chat model answers one word, so a
   * question set is a sequence rather than the single call a native model
   * fans out, and a consumer that asks several pays for several. A caller
   * that sets `together` gets the set in one call instead, one line per
   * question, where a missing or unreadable line fails only its question.
   */
  async decide(
    caller: DecisionCaller,
    state: DecisionState,
    questions: Record<string, DecisionQuestion>,
    signal: AbortSignal,
  ): Promise<DecisionRun> {
    if (caller.together && Object.keys(questions).length > 1)
      return this.askTogether(caller, state, questions, signal);
    const answers: Record<string, DecisionAnswer> = {};
    const usage: DecisionUsage[] = [];
    for (const [id, question] of Object.entries(questions)) {
      const run = await this.ask(caller, state, question, signal);
      answers[id] = run.answer;
      if (run.usage) usage.push(run.usage);
    }
    return { answers, usage };
  }

  /**
   * The whole set in one bounded call, answered one line per question. The
   * reply's length is its own rather than a word's, and each answer is
   * stamped with the fingerprint of the combined instruction it was asked
   * under, since that is what was served.
   */
  private async askTogether(
    caller: DecisionCaller,
    state: DecisionState,
    questions: Record<string, DecisionQuestion>,
    signal: AbortSignal,
  ): Promise<DecisionRun> {
    const instruction = renderTogetherInstruction(questions);
    const named = parseDecisionOffering(this.options.offering?.() ?? "auto");
    const turn = await this.turns.turn({
      attribution: caller.taskId ?? caller.purpose,
      instruction,
      text: renderAdapterState(state),
      signal,
      set: true,
      ...(named ? { named } : {}),
    });
    const usage = turn.usage ? [turn.usage] : [];
    const parsed = "failed" in turn ? undefined : parseTogether(turn.text, questions);
    const answers: Record<string, DecisionAnswer> = {};
    for (const [id, question] of Object.entries(questions)) {
      const version = questionVersion(question, instruction);
      if ("failed" in turn) {
        answers[id] = failedAnswer(question, turn.failed, version, turn.source);
        continue;
      }
      const value = parsed?.[id];
      answers[id] = value
        ? {
            value,
            outcome: value === question.abstain ? "abstained" : "answered",
            source: turn.source,
            version,
          }
        : failedAnswer(question, "unparsed", version, turn.source);
    }
    return { answers, usage };
  }

  private async ask(
    caller: DecisionCaller,
    state: DecisionState,
    question: DecisionQuestion,
    signal: AbortSignal,
  ): Promise<{ answer: DecisionAnswer; usage?: DecisionUsage }> {
    const instruction = renderAdapterInstruction(question);
    const version = questionVersion(question, instruction);
    const named = parseDecisionOffering(this.options.offering?.() ?? "auto");
    const turn = await this.turns.turn({
      attribution: caller.taskId ?? caller.purpose,
      instruction,
      text: renderAdapterState(state),
      signal,
      ...(named ? { named } : {}),
    });
    const usage = turn.usage ? { usage: turn.usage } : {};
    if ("failed" in turn)
      return { answer: failedAnswer(question, turn.failed, version, turn.source), ...usage };
    const value = parseOption(turn.text, adapterOptions(question));
    if (!value) {
      return { answer: failedAnswer(question, "unparsed", version, turn.source), ...usage };
    }
    return {
      answer: {
        value,
        outcome: value === question.abstain ? "abstained" : "answered",
        source: turn.source,
        version,
      },
      ...usage,
    };
  }

  /**
   * What a pinned offering comes to right now (the walk's `pinState`). A
   * string that names no offering is the walk, as it is at the call.
   */
  pinState(offering: string): DecisionPinState {
    return this.turns.pinState(parseDecisionOffering(offering));
  }
}

export type DecisionKeys = {
  has(id: DecisionModelId): boolean;
  read(id: DecisionModelId): string | undefined;
  set(id: DecisionModelId, key: string): void;
  remove(id: DecisionModelId): void;
};

export type DecisionModelsOptions = {
  /** The `decisions` settings row: read fresh on every call, written here. */
  settings: {
    getDecisions(): DecisionsSettings;
    setDecisions(decisions: DecisionsSettings): void;
    /** The person's use switches (`src/shared/decisionUses.ts`): read fresh on every call. */
    getDecisionUses(): DecisionUseSwitches;
    setDecisionUses(switches: DecisionUseSwitches): void;
  };
  /** The user's own keys for native models. Absent in a build with none. */
  keys?: DecisionKeys;
  adapted: DecisionModel;
  /**
   * What a pinned offering comes to right now (`AdaptedDecisionModel.
   * pinState`), so the row names a pick only while it is the model
   * answering. Absent: a pick is taken as answering.
   */
  pinState?: (offering: string) => DecisionPinState;
  /** A classifier reached through an existing signed-in Pi account, not a key store. */
  openrouter?: {
    models: () => OpenRouterDecisionOffering[];
    signedIn: () => boolean;
    create: (model: string) => DecisionModel;
  };
  /**
   * Builds a native model around the user's key. Injectable so a test needs
   * no transport, and absent in a host that serves none - with no factory
   * there is no client, no endpoint and no request, which is how "off by
   * default" is enforced in code rather than by remembering to check.
   */
  createNative?: (row: DecisionModelCatalogRow, key: string) => DecisionModel;
  recordUsage?: (input: { taskId: string } & DecisionUsage) => void;
  /**
   * One feed line, when a native model's key is rejected by its own vendor.
   * Once per key: a rejected credential the user has not replaced is a
   * standing state the row already carries, not news every 15 minutes.
   */
  onNote?: (text: string) => void;
};

/**
 * The core-wide seam (the captain's annotation, report section 10). It owns
 * the `decisions` row, the native model's construction and the row's state;
 * it owns no question, which is what lets any module use it.
 */
export class DecisionModels {
  /** The last answer each native model gave, for its row's mono line. */
  private readonly last = new Map<string, { value: string; tokens: number; at: number }>();
  /** Whether the vendor rejected this key. Cleared when a new key is stored. */
  private readonly rejected = new Set<string>();
  /** Built once per key, so a stored key is not re-read on every decision. */
  private cachedNative: { id: string; key: string; model: DecisionModel } | undefined;

  constructor(private readonly options: DecisionModelsOptions) {}

  active(): DecisionModel {
    return this.nativeModel() ?? this.options.adapted;
  }

  /**
   * One decision. Never throws: every failure is the question's declared
   * abstention with the short reason on the record. A native model that
   * fails is answered for by the adapter - so a vendor outage costs one
   * call on the user's own subscription, never a stall - and the fallback
   * says so on the record rather than quietly looking like an answer.
   */
  async decide(
    caller: DecisionCaller & { use: DecisionUseId },
    state: DecisionState,
    questions: Record<string, DecisionQuestion>,
    signal: AbortSignal,
  ): Promise<Record<string, DecisionAnswer>> {
    const off = () =>
      Object.fromEntries(
        Object.entries(questions).map(([id, question]) => [
          id,
          failedAnswer(question, "use-off", questionVersion(question, question.instructions)),
        ]),
      );
    // A use that is off, or that the answering model's approval predates,
    // asks nothing: no model is read, no key, and the person's own models
    // do not answer in its place. This runs before any model or key is read.
    if (!this.allowsUse(caller.use)) return off();
    const native = this.nativeModel();
    if (!native) return this.run(this.options.adapted, caller, state, questions, signal);

    const answers = await this.run(native, caller, state, questions, signal);
    const retry = Object.entries(questions).filter(([id]) => answers[id]?.outcome === "failed");
    if (retry.length === 0) return answers;
    // A use turned off during the native request cannot start a new
    // fallback call. A completed request cannot be unsent.
    if (!this.allowsUse(caller.use)) return off();
    // One reason line for the record (report section 6 rule 5): a vendor
    // outage costs one call on the user's own subscription, and says so.
    const reasons = [...new Set(retry.map(([id]) => answers[id]?.reason ?? "unknown"))].join(", ");
    const fallback = await this.run(
      this.options.adapted,
      caller,
      state,
      Object.fromEntries(retry),
      signal,
    );
    for (const [id, answer] of Object.entries(fallback)) {
      answers[id] = {
        ...answer,
        detail: [
          `decision model ${native.id} failed: ${reasons}`,
          answer.source ? `answered by adapted:${answer.source}` : "no model could answer",
        ].join("; "),
      };
    }
    return answers;
  }

  /**
   * Whether a listed use may ask now: its switch, and the answering model's
   * approval (`decisionUseAllowed`). An unknown use asks nothing.
   */
  allowsUse(id: DecisionUseId): boolean {
    const use = decisionUse(id);
    if (!use) return false;
    return decisionUseAllowed(
      this.options.settings.getDecisions(),
      this.options.settings.getDecisionUses(),
      use,
    );
  }

  /**
   * One use switched from Settings. An always-on use refuses to turn off.
   * `approve` is the approval screen the person just agreed to in the
   * consent dialog: it raises the answering Jev or OpenRouter approval, never
   * past this home's own screen and never lower than it was. A `needs-ok`
   * use turns on only once its disclosure's version is agreed, which is kept.
   */
  setUse(request: DecisionUseRequest): DecisionsView {
    const use = decisionUse(request.id);
    if (!use) throw new Error(`Infinitary has no decision model use named ${request.id}.`);
    if (use.kind === "always-on") {
      if (!request.on) throw new Error(`${use.name} is always on: Infinitary needs it to work.`);
      return this.view();
    }
    const saved = this.options.settings.getDecisionUses();
    // Agreed once: a later turn-on of the same disclosure asks nothing.
    const agreed = Math.max(request.agreed ?? -1, saved[use.id]?.agreed ?? -1);
    if (request.on && use.kind === "needs-ok" && agreed < (use.disclosure?.version ?? 0))
      throw new Error(`${use.name} turns on only once its disclosure is agreed.`);
    const settings = this.options.settings.getDecisions();
    if (request.on && request.approve !== undefined) {
      const family =
        settings.answerer.kind === "native"
          ? settings.answerer.id
          : settings.answerer.kind === "openrouter"
            ? "openrouter"
            : undefined;
      const approval = decisionApproval(settings);
      if (family && approval !== null) {
        const raised = Math.max(approval, Math.min(request.approve, DECISION_APPROVAL_VERSION));
        if (raised > approval)
          this.setSettings({
            ...settings,
            egress: { ...settings.egress, [family]: { enabled: true, consentedVersion: raised } },
          });
      }
    }
    this.options.settings.setDecisionUses({
      ...saved,
      [use.id]: { on: request.on, ...(use.kind === "needs-ok" && agreed >= 0 ? { agreed } : {}) },
    });
    return this.view();
  }

  /** What the Decisions group renders. Never carries a key or part of one. */
  view(): DecisionsView {
    const settings = this.options.settings.getDecisions();
    const pinned =
      settings.answerer.kind === "adapted" && settings.answerer.offering !== "auto"
        ? (this.options.pinState?.(settings.answerer.offering) ?? "ready")
        : undefined;
    return {
      settings,
      stateVersion: DECISION_FIRST_APPROVAL_VERSION,
      approvalVersion: DECISION_APPROVAL_VERSION,
      uses: decisionUsesView(settings, this.options.settings.getDecisionUses()),
      ...(pinned ? { pinned } : {}),
      openrouter: {
        models: this.options.openrouter?.signedIn() ? this.options.openrouter.models() : [],
        state: !this.options.openrouter?.signedIn()
          ? "signed-out"
          : settings.egress.openrouter?.enabled &&
              (settings.egress.openrouter.consentedVersion ?? -1) >= DECISION_FIRST_APPROVAL_VERSION
            ? "ready"
            : "off",
        consented:
          (settings.egress.openrouter?.consentedVersion ?? -1) >= DECISION_FIRST_APPROVAL_VERSION,
        last:
          settings.answerer.kind === "openrouter"
            ? (this.last.get(`openrouter/${settings.answerer.model}`) ?? null)
            : null,
      },
      natives: DECISION_MODEL_CATALOG.map((row) => {
        const egress = settings.egress[row.id];
        const keyStored = this.options.keys?.has(row.id) ?? false;
        const consented = (egress?.consentedVersion ?? -1) >= DECISION_FIRST_APPROVAL_VERSION;
        return {
          id: row.id,
          name: row.name,
          vendor: row.vendor,
          keysUrl: row.keysUrl,
          keyStored,
          consented,
          state: !keyStored
            ? ("absent" as const)
            : !(egress?.enabled && consented)
              ? ("off" as const)
              : this.rejected.has(row.id)
                ? ("key-rejected" as const)
                : ("ready" as const),
          last: this.last.get(row.id) ?? null,
        };
      }),
    };
  }

  /**
   * Writes the row. The KEY never arrives here - it has its own call - so
   * this one can be logged, exported and pushed without carrying a secret.
   */
  setSettings(next: DecisionsSettings): DecisionsView {
    this.options.settings.setDecisions(next);
    // The client is rebuilt on the next decision: the pick, the egress or
    // the consent may all have moved.
    this.cachedNative = undefined;
    return this.view();
  }

  /**
   * Stores the user's own key and turns the model on. The key call counts
   * as the first approval screen, which every view that sends it has shown:
   * a newer view writes its own screen's approval through setSettings, and
   * an older view never approves a newer screen by echoing a newer number.
   * A key replaced later keeps an approval already given.
   */
  setKey(id: DecisionModelId, key: string): DecisionsView {
    this.options.keys?.set(id, key);
    this.rejected.delete(id);
    this.cachedNative = undefined;
    const settings = this.options.settings.getDecisions();
    const seen = settings.egress[id]?.consentedVersion ?? -1;
    this.options.settings.setDecisions({
      ...settings,
      egress: {
        ...settings.egress,
        [id]: {
          enabled: true,
          consentedVersion: Math.max(seen, DECISION_FIRST_APPROVAL_VERSION),
        },
      },
    });
    return this.view();
  }

  /** "Remove Jev": the key goes, the egress goes off, the pick falls back. */
  removeKey(id: DecisionModelId): DecisionsView {
    this.options.keys?.remove(id);
    this.rejected.delete(id);
    this.last.delete(id);
    this.cachedNative = undefined;
    const settings = this.options.settings.getDecisions();
    const egress = { ...settings.egress };
    delete egress[id];
    this.options.settings.setDecisions({
      ...settings,
      egress,
      answerer:
        settings.answerer.kind === "native" && settings.answerer.id === id
          ? { kind: "adapted", offering: "auto" }
          : settings.answerer,
    });
    return this.view();
  }

  /**
   * The native model, or nothing. Every condition is checked here so there
   * is exactly one answer to "may this endpoint be reached": the row names
   * it, its egress is on, the consent covers what would be sent, a key is
   * stored, and the host serves a factory at all.
   */
  private nativeModel(): DecisionModel | undefined {
    const settings = this.options.settings.getDecisions();
    if (settings.answerer.kind === "openrouter") {
      const egress = settings.egress.openrouter;
      const option = this.options.openrouter;
      if (
        !egress?.enabled ||
        (egress.consentedVersion ?? -1) < DECISION_FIRST_APPROVAL_VERSION ||
        !option?.signedIn()
      )
        return undefined;
      const modelId = settings.answerer.model;
      if (!option.models().some((model) => model.id === modelId)) return undefined;
      return option.create(modelId);
    }
    if (settings.answerer.kind !== "native") return undefined;
    const id = settings.answerer.id;
    const egress = settings.egress[id];
    if (!egress?.enabled) return undefined;
    if ((egress.consentedVersion ?? -1) < DECISION_FIRST_APPROVAL_VERSION) return undefined;
    const key = this.options.keys?.read(id);
    if (!key) return undefined;
    const create = this.options.createNative;
    if (!create) return undefined;
    if (this.cachedNative?.id === id && this.cachedNative.key === key) {
      return this.cachedNative.model;
    }
    const row = DECISION_MODEL_CATALOG.find((entry) => entry.id === id);
    if (!row) return undefined;
    const model = create(row, key);
    this.cachedNative = { id, key, model };
    return model;
  }

  private async run(
    model: DecisionModel,
    caller: DecisionCaller,
    state: DecisionState,
    questions: Record<string, DecisionQuestion>,
    signal: AbortSignal,
  ): Promise<Record<string, DecisionAnswer>> {
    let run: DecisionRun;
    try {
      run = await model.decide(caller, state, questions, signal);
    } catch {
      // A DecisionModel is contracted never to throw; if one does, the
      // service still owes its caller an answer rather than an exception.
      run = {
        answers: Object.fromEntries(
          Object.entries(questions).map(([id, question]) => [
            id,
            failedAnswer(question, "error", questionVersion(question, question.instructions)),
          ]),
        ),
        usage: [],
      };
    }
    for (const burned of run.usage) {
      this.options.recordUsage?.({
        taskId: caller.taskId ?? caller.purpose,
        ...(burned.accountId ? { accountId: burned.accountId } : {}),
        ...(burned.model ? { model: burned.model } : {}),
        usage: burned.usage,
      });
    }
    if (model.native) this.recordNative(model, run);
    return run.answers;
  }

  /** What a native call came to, so the row can say ready or key rejected. */
  private recordNative(model: DecisionModel, run: DecisionRun): void {
    const first = Object.values(run.answers)[0];
    if (!first) return;
    const id = model.id;
    if (first.outcome === "failed") {
      // Only the vendor's own 401 is a verdict on the credential; a rate
      // limit, an outage or a body we could not read are transient and the
      // row keeps saying `ready`.
      if (first.reason === "key-rejected" && !this.rejected.has(id)) {
        this.rejected.add(id);
        const row = DECISION_MODEL_CATALOG.find((entry) => entry.id === id);
        this.options.onNote?.(decisionKeyRejectedNote(row?.name ?? id));
      }
      return;
    }
    const tokens = run.usage.reduce(
      (total, burned) => total + (burned.usage.input ?? 0) + (burned.usage.output ?? 0),
      0,
    );
    // A working answer clears a standing rejection: the row is a state, not
    // a memory, and a replaced key that works says so on its first answer.
    this.rejected.delete(id);
    this.last.set(model.pick ?? id, {
      value: first.value,
      tokens,
      at: Date.now(),
    });
  }
}
