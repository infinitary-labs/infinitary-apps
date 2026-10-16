import { createHash } from "node:crypto";
import type { CutOff } from "@shared/authFailure";
import { isCustomApiProvider } from "@shared/customApi";
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
  DECISION_STATE_VERSION,
  decisionKeyRejectedNote,
  parseDecisionOffering,
} from "@shared/decisions";
import type { FmUsage } from "@shared/events";
import { backendForProvider } from "@shared/providers";
import type { ModelsCatalogView, Slot } from "@shared/quota";
import type { ModelRuntime } from "../pi/types";
import { orderCandidates } from "../routing/candidates";
import type { ModelCapabilityLookup } from "../routing/capability";
import { SessionBinder } from "../session/binding";
import type { ModelSession, SessionBinding, SessionFactories } from "../session/session";
import { questionSessionSpec } from "./questionSession";

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
 *   64-token Pi session, the same fail-soft discipline. A consumer that
 *   pins its served bytes (`adapterInstruction`, `adapterText`) gets the
 *   same call it got before this class existed, sha for sha.
 * - `DecisionModels` is the CORE-WIDE service (the captain's annotation,
 *   report section 10): registered once in `services.ts` and handed to
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
export const DECIDE_TIMEOUT_MS = 15_000;

/** What one call burned, for the service to attribute. */
export type DecisionUsage = {
  accountId?: string;
  model?: { provider: string; id: string };
  usage: FmUsage;
};

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

/** The abstention, or the first option when a question declared none. */
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

/** Every failure wears the same coat: the abstention, with the reason on the record. */
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

/** The adapter's single user message: the consumer's pinned text, else the facts. */
export function renderAdapterState(state: DecisionState): string {
  if (state.adapterText !== undefined) return state.adapterText;
  return Object.entries(state.facts)
    .filter(([, value]) => value !== null && value !== "")
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
}

export type AdaptedDecisionModelOptions = {
  /** A neutral cwd for the stateless session (the firstmate home). */
  homeDir: string;
  /**
   * The routable pool, already narrowed to the slotted pool by the caller,
   * each model carrying its slot so the walk can rank them cheapest-first.
   * Pi-served and Claude-served models compete in one walk (W1 S10, the
   * owner's Q3 a); an account that serves nothing right now (a standing
   * cut-off, no client) has no models here.
   */
  availableModels: () => Array<{ provider: string; id: string; slot?: Slot }>;
  /**
   * What a named offering may bind: every signed-in model, slot or no slot,
   * because a model that is not in use is still available and naming it is
   * its own placement - the same pool the picker lists from. Absent: the
   * routable pool above.
   */
  namedModels?: () => Array<{ provider: string; id: string }>;
  /** Resolves a candidate's def so it is checked before it is bound. */
  capabilityFor?: ModelCapabilityLookup;
  quotaModels: () => ModelsCatalogView | undefined;
  /** AccountSelector.selectForSpawn, so the burn is attributable. */
  selectAccount: (taskId: string, piProviderId: string) => string | undefined;
  /** The flagship account answers only as a last resort. */
  flagshipAccountId: () => string | null;
  runtimeFor: (accountId: string) => Promise<ModelRuntime>;
  /** Unneeded when the candidate pool is Claude-only. */
  baseRuntime?: ModelRuntime;
  /**
   * Which offering the user pinned, or `auto` for the walk (report section
   * 5.1, the captain's Q5 A). A pin that cannot be bound falls back to the
   * walk rather than refusing to answer.
   */
  offering?: () => string;
  /**
   * The session factory per backend, each opening the question's one-shot
   * session (`questionSessionSpec`). A backend with no factory answers
   * nothing, so its models are passed over in the walk.
   */
  sessions: Partial<SessionFactories>;
  /**
   * Records a typed cut-off the call observed on the account that served it
   * (W1 S7): whoever observes one records it, and the account then leaves
   * the pool until a fact changes.
   */
  noteCutOff?: (accountId: string, cutOff: CutOff) => void;
  /** Ensures the home dir exists before a session is created; tests skip it. */
  prepareHome?: () => Promise<void>;
};

/** One candidate bound: the model and the binding its session is opened on. */
type BoundCandidate = { model: { provider: string; id: string }; binding: SessionBinding };

/**
 * The adapter: any chat model in the routable pool qualifies as a decision
 * model - Pi-served in process, or Claude-served on the machine's own
 * client (W1 S10) - because a typed question renders as a byte-stable
 * instruction plus the state as one user message, the abstention is offered
 * as a word among the others, and the answer is one word parsed by code.
 *
 * Everything about it is shaped by one rule, inherited unchanged from S3: a
 * broken decision model must cost quota, never correctness. So it never
 * throws, never blocks its caller past the wall clock, and every way it can
 * fail - no signed-in model, a dead account store, a provider error, a
 * timeout, an answer that is not one of the options - resolves to the
 * question's abstention.
 *
 * What it must never do: see the premium slot (the walk refuses it
 * outright), or run twice for the same row (the caller's business).
 */
export class AdaptedDecisionModel implements DecisionModel {
  readonly id = "adapted";
  readonly native = false;
  private readonly sessions: Partial<SessionFactories>;
  private readonly binder: SessionBinder;

  constructor(private readonly options: AdaptedDecisionModelOptions) {
    this.sessions = options.sessions;
    this.binder = new SessionBinder({
      runtimeFor: (accountId) => options.runtimeFor(accountId),
      baseRuntime: options.baseRuntime,
    });
  }

  /**
   * One bounded call PER QUESTION: a chat model answers one word, so a
   * question set is a sequence rather than the single call a native model
   * fans out. The app asks one question today; a consumer that asks several
   * pays for several, which is the honest cost of the adapter path and one
   * of the reasons a native model is worth having.
   */
  async decide(
    caller: DecisionCaller,
    state: DecisionState,
    questions: Record<string, DecisionQuestion>,
    signal: AbortSignal,
  ): Promise<DecisionRun> {
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
   * The wall clock and the caller's signal bound the WHOLE call - creating
   * the session as well as its one turn. A Claude-served session spawns the
   * machine's client and waits out a sign-in in progress before it can
   * answer, so a clock that started only once the session existed would
   * not be the caller's bound. Whatever is still running when a bound fires
   * is let go of, never waited for.
   */
  private async ask(
    caller: DecisionCaller,
    state: DecisionState,
    question: DecisionQuestion,
    signal: AbortSignal,
  ): Promise<{ answer: DecisionAnswer; usage?: DecisionUsage }> {
    const instruction = renderAdapterInstruction(question);
    const version = questionVersion(question, instruction);
    if (signal.aborted) return { answer: failedAnswer(question, stopReason(signal), version) };
    const bound = await this.resolveBinding(caller.taskId ?? caller.purpose);
    if (!bound) return { answer: failedAnswer(question, "no-model", version) };
    const { model, binding } = bound;
    const factory = this.sessions[binding.backend];
    if (!factory) return { answer: failedAnswer(question, "no-model", version) };
    const source = `${model.provider}/${model.id}`;
    let burned: DecisionUsage | undefined;
    let session: ModelSession | undefined;
    let unsubscribe: (() => void) | undefined;
    /** Which bound ended the call: our own wall clock, or the caller's. */
    let ended = "";
    let stop!: () => void;
    const stopped = new Promise<undefined>((resolve) => {
      stop = () => resolve(undefined);
    });
    const end = (reason: string) => {
      ended ||= reason;
      stop();
      void session?.abort().catch(() => {});
    };
    const timer = setTimeout(() => end("timeout"), DECIDE_TIMEOUT_MS);
    const onAbort = () => end(stopReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      // The caller's signal can fire while the binding resolves, and a
      // listener added after the fact never runs.
      if (signal.aborted) {
        return { answer: failedAnswer(question, stopReason(signal), version, source) };
      }
      await this.options.prepareHome?.();
      const creating = factory.open(
        questionSessionSpec({ homeDir: this.options.homeDir, binding, model, instruction }),
      );
      session = await Promise.race([creating, stopped]);
      if (!session) {
        // A session that arrives after the bound is let go of at once.
        void creating.then(
          (late) => late.dispose(),
          () => {},
        );
        return { answer: failedAnswer(question, ended, version, source) };
      }
      // Asking before the prompt is the only way to honor a bound without
      // spending the call: an abort() lands on a request not yet made.
      if (ended) return { answer: failedAnswer(question, ended, version, source) };
      let answer = "";
      let failure = "";
      unsubscribe = session.subscribe((event) => {
        if (event.type === "turn_closed") {
          const text = event.text?.trim();
          if (text) answer = text;
          return;
        }
        // A provider-failed turn RESOLVES rather than throwing, so the
        // session's `turn_failed` is the only place the failure shows. Without
        // this the adapter would read an empty answer as an unparseable one
        // and hide a provider outage as a parse miss.
        if (event.type === "turn_failed") {
          failure = "provider";
          // A typed cut-off is a fact on the account that served the call,
          // recorded by whoever observes it (W1 S7).
          if (event.cutOff && binding.accountId) {
            this.options.noteCutOff?.(binding.accountId, event.cutOff);
          }
        }
        if (event.type === "turn_end" && event.usage) {
          burned = {
            ...(binding.accountId ? { accountId: binding.accountId } : {}),
            model,
            usage: event.usage,
          };
        }
      });
      const prompting = session.prompt(renderAdapterState(state));
      // A session whose abort does not settle its turn still cannot hold the
      // caller past the bound.
      prompting.catch(() => {});
      await Promise.race([prompting, stopped]);
      if (ended) return { answer: failedAnswer(question, ended, version, source), ...wrap(burned) };
      if (failure) {
        return { answer: failedAnswer(question, failure, version, source), ...wrap(burned) };
      }
      const value = parseOption(answer, adapterOptions(question));
      if (!value) {
        return { answer: failedAnswer(question, "unparsed", version, source), ...wrap(burned) };
      }
      return {
        answer: {
          value,
          outcome: value === question.abstain ? "abstained" : "answered",
          source,
          version,
        },
        ...wrap(burned),
      };
    } catch (caught) {
      // Session creation and the prompt itself both land here; the reason is
      // recorded rather than the message, which can carry a provider's prose.
      return {
        answer: failedAnswer(
          question,
          ended || (caught instanceof Error && caught.name === "AbortError" ? "timeout" : "error"),
          version,
          source,
        ),
        ...wrap(burned),
      };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      unsubscribe?.();
      session?.dispose();
    }
  }

  /**
   * The binding, cheapest serviceable first: the supervision session's walk
   * reused (`orderCandidates` low-first over the routable pool), so premium
   * is never a candidate, a candidate whose def cannot carry the turn is
   * skipped, and a dead account store is tried past. Pi-served and
   * Claude-served models compete in that one walk (the owner's Q3 a); a
   * model whose backend has no session factory is passed over. The
   * flagship account is held back while anything else can bind and spent
   * only as the last resort - on a single-account install, one cheap
   * decision on the flagship is pennies against the alternative.
   *
   * A user who NAMED an offering is honored first; naming a model is its own
   * placement, so a premium offering, or one that is not in use, is allowed
   * there as it is everywhere a user names one. A named offering that cannot
   * bind falls through to the walk rather than refusing to answer, and the
   * row says so (`pinState`).
   */
  private async resolveBinding(attribution: string): Promise<BoundCandidate | undefined> {
    const pinned = parseDecisionOffering(this.options.offering?.() ?? "auto");
    if (pinned) {
      const bound = await this.bind(pinned, attribution);
      if (bound) return bound;
      if (!fallsBack(pinned)) return undefined;
    }
    const flagship = this.options.flagshipAccountId();
    let lastResort: { model: { provider: string; id: string }; accountId: string } | undefined;
    for (const model of this.candidateModels()) {
      if (!this.answers(model)) continue;
      const accountId = this.options.selectAccount(attribution, model.provider);
      if (!accountId) {
        const unmanaged = this.unmanaged(model);
        if (unmanaged) return unmanaged;
        continue;
      }
      if (flagship && accountId === flagship) {
        lastResort ??= { model, accountId };
        continue;
      }
      try {
        return await this.bindAccount(model, accountId);
      } catch {
        // A dead account store: try the next candidate.
      }
    }
    if (lastResort) {
      try {
        return await this.bindAccount(lastResort.model, lastResort.accountId);
      } catch {
        // The flagship store is dead too: nothing can answer.
      }
    }
    return undefined;
  }

  /**
   * What a pinned offering comes to right now, by the checks a call makes
   * before it picks an account: a signed-in account serves it and its
   * backend has a session factory. A dead account store still only shows
   * at the call, which then falls back the same way. A string that names
   * no offering is the walk, as it is at the call.
   */
  pinState(offering: string): DecisionPinState {
    const pinned = parseDecisionOffering(offering);
    if (!pinned) return "fallback";
    if (this.canBind(pinned)) return "ready";
    return fallsBack(pinned) ? "fallback" : "held";
  }

  private canBind(model: { provider: string; id: string }): boolean {
    const pool = this.options.namedModels?.() ?? this.options.availableModels();
    return (
      pool.some((entry) => entry.provider === model.provider && entry.id === model.id) &&
      this.answers(model)
    );
  }

  /** Binds one named offering, or nothing when its account or store is gone. */
  private async bind(
    model: { provider: string; id: string },
    attribution: string,
  ): Promise<BoundCandidate | undefined> {
    if (!this.canBind(model)) return undefined;
    const accountId = this.options.selectAccount(attribution, model.provider);
    if (!accountId) return this.unmanaged(model);
    try {
      return await this.bindAccount(model, accountId);
    } catch {
      return undefined;
    }
  }

  /** Whether the model's backend has a factory to answer on. */
  private answers(model: { provider: string }): boolean {
    return this.sessions[backendForProvider(model.provider)] !== undefined;
  }

  /**
   * A model no account manages: an unmanaged (custom/models.json) provider
   * rides the base runtime. A client-served provider has no such runtime -
   * its login IS the account - so without one it cannot answer.
   */
  private unmanaged(model: { provider: string; id: string }): BoundCandidate | undefined {
    if (backendForProvider(model.provider) !== "pi" || !this.options.baseRuntime) return undefined;
    return { model, binding: this.binder.base() };
  }

  /** The binding on one account; a Pi account's runtime is built, and may throw. */
  private async bindAccount(
    model: { provider: string; id: string },
    accountId: string,
  ): Promise<BoundCandidate> {
    return { model, binding: await this.binder.bindAccount(accountId, model.provider) };
  }

  private candidateModels(): { provider: string; id: string }[] {
    return orderCandidates({
      available: this.options.availableModels(),
      catalog: this.options.quotaModels()?.models ?? [],
      // The cheap tier by design: this is the one grain that must never
      // cost more than the work it is sorting.
      buckets: ["low", "medium", "high"],
      ...(this.options.capabilityFor ? { capabilityFor: this.options.capabilityFor } : {}),
    }).models;
  }
}

/**
 * Whether the walk may answer for a named offering that cannot bind. An
 * explicitly named custom connection never silently migrates its
 * background request to another account when paused or disconnected.
 */
function fallsBack(model: { provider: string }): boolean {
  return !isCustomApiProvider(model.provider);
}

/**
 * Why the caller's signal ended the call: its deadline (`AbortSignal.timeout`,
 * which the spawn path passes and which runs out before the adapter's own
 * clock) is a timeout on the record; anything else is the caller aborting.
 */
function stopReason(signal: AbortSignal): "timeout" | "aborted" {
  const reason = signal.reason as { name?: unknown } | undefined;
  return reason?.name === "TimeoutError" ? "timeout" : "aborted";
}

function wrap(usage: DecisionUsage | undefined): { usage?: DecisionUsage } {
  return usage ? { usage } : {};
}

/** The key store as this service needs it: presence and one read, nothing else. */
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
  /** Records the decision's burn under the work that caused it. */
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

  /** Which model would answer right now, for a surface that wants to say so. */
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
    caller: DecisionCaller,
    state: DecisionState,
    questions: Record<string, DecisionQuestion>,
    signal: AbortSignal,
  ): Promise<Record<string, DecisionAnswer>> {
    const native = this.nativeModel();
    if (!native) return this.run(this.options.adapted, caller, state, questions, signal);

    const answers = await this.run(native, caller, state, questions, signal);
    const retry = Object.entries(questions).filter(([id]) => answers[id]?.outcome === "failed");
    if (retry.length === 0) return answers;
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

  /** What the Decisions group renders. Never carries a key or part of one. */
  view(): DecisionsView {
    const settings = this.options.settings.getDecisions();
    const pinned =
      settings.answerer.kind === "adapted" && settings.answerer.offering !== "auto"
        ? (this.options.pinState?.(settings.answerer.offering) ?? "ready")
        : undefined;
    return {
      settings,
      stateVersion: DECISION_STATE_VERSION,
      ...(pinned ? { pinned } : {}),
      openrouter: {
        models: this.options.openrouter?.signedIn() ? this.options.openrouter.models() : [],
        state: !this.options.openrouter?.signedIn()
          ? "signed-out"
          : settings.egress.openrouter?.enabled &&
              (settings.egress.openrouter.consentedVersion ?? -1) >= DECISION_STATE_VERSION
            ? "ready"
            : "off",
        consented: (settings.egress.openrouter?.consentedVersion ?? -1) >= DECISION_STATE_VERSION,
        last:
          settings.answerer.kind === "openrouter"
            ? (this.last.get(`openrouter/${settings.answerer.model}`) ?? null)
            : null,
      },
      natives: DECISION_MODEL_CATALOG.map((row) => {
        const egress = settings.egress[row.id];
        const keyStored = this.options.keys?.has(row.id) ?? false;
        const consented = (egress?.consentedVersion ?? -1) >= DECISION_STATE_VERSION;
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
   * Stores the user's own key and accepts the consent copy in one act - the
   * turn-on form takes both, so a switch on with no key is impossible.
   */
  setKey(id: DecisionModelId, key: string): DecisionsView {
    this.options.keys?.set(id, key);
    this.rejected.delete(id);
    this.cachedNative = undefined;
    const settings = this.options.settings.getDecisions();
    this.options.settings.setDecisions({
      ...settings,
      egress: {
        ...settings.egress,
        [id]: { enabled: true, consentedVersion: DECISION_STATE_VERSION },
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
        (egress.consentedVersion ?? -1) < DECISION_STATE_VERSION ||
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
    if ((egress.consentedVersion ?? -1) < DECISION_STATE_VERSION) return undefined;
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
