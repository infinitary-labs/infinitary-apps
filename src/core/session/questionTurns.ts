import type { CutOff } from "@shared/authFailure";
import { isCustomApiProvider } from "@shared/customApi";
import type { FmUsage } from "@shared/events";
import { backendForProvider } from "@shared/providers";
import type { ModelsCatalogView, Slot } from "@shared/quota";
import type { ModelRuntime } from "../pi/types";
import { orderCandidates } from "../routing/candidates";
import type { ModelCapabilityLookup } from "../routing/capability";
import { SessionBinder } from "./binding";
import { questionSessionSpec } from "./questionSession";
import type { ModelSession, SessionBinding, SessionFactories } from "./session";

/** Hard wall clock per question: a caller waits no longer than this. */
export const QUESTION_TIMEOUT_MS = 15_000;

/** What one question burned, for its caller to attribute. */
export type QuestionUsage = {
  accountId?: string;
  model?: { provider: string; id: string };
  usage: FmUsage;
};

/** One question's answer text, or why there was none. */
export type QuestionTurn =
  | { text: string; source: string; usage?: QuestionUsage }
  | { failed: string; source?: string; usage?: QuestionUsage };

/** What a named model comes to right now: it answers, the walk answers for it, or nothing does. */
export type QuestionPinState = "ready" | "fallback" | "held";

export type QuestionTurnsOptions = {
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
   * What a named model may bind: every signed-in model, slot or no slot,
   * because a model that is not in use is still available and naming it is
   * its own placement - the same pool the picker lists from. Absent: the
   * routable pool above.
   */
  namedModels?: () => Array<{ provider: string; id: string }>;
  /** Resolves a candidate's def so it is checked before it is bound. */
  capabilityFor?: ModelCapabilityLookup;
  quotaModels: () => ModelsCatalogView | undefined;
  /** AccountSelector.selectForSpawn, so the burn is attributable. */
  selectAccount: (
    taskId: string,
    piProviderId: string,
  ) => string | undefined | Promise<string | undefined>;
  /** The flagship account answers only as a last resort. */
  flagshipAccountId: () => string | null;
  runtimeFor: (accountId: string) => Promise<ModelRuntime>;
  /** Unneeded when the candidate pool is Claude-only. */
  baseRuntime?: ModelRuntime;
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
 * One bounded question to the person's own cheapest chat model: the walk
 * and the one-question session that the adapted decision model asks its
 * one word through, and that a program's ask() asks its JSON through. It
 * reads no decision setting; a caller that names a model passes it in.
 *
 * Everything about it is shaped by one rule, inherited unchanged from S3: a
 * broken question must cost quota, never correctness. So it never throws,
 * never blocks its caller past the wall clock, and every way it can fail - no
 * signed-in model, a dead account store, a provider error, a timeout -
 * resolves to a short reason. It never sees the premium slot unless a caller
 * names a premium model.
 */
export class QuestionTurns {
  private readonly binder: SessionBinder;

  constructor(private readonly options: QuestionTurnsOptions) {
    this.binder = new SessionBinder({
      runtimeFor: (accountId) => options.runtimeFor(accountId),
      baseRuntime: options.baseRuntime,
    });
  }

  /**
   * One bounded turn of the question session: its answer's text, or why
   * there was none - `no-model`, a bound (`timeout`, `aborted`), `provider`
   * or `error`. The wall clock and the caller's signal bound the WHOLE
   * call - creating the session as well as its one turn. A Claude-served
   * session spawns the machine's client and waits out a sign-in in progress
   * before it can answer, so a clock that started only once the session
   * existed would not be the caller's bound. Whatever is still running when
   * a bound fires is let go of, never waited for.
   */
  async turn(input: {
    /** The task, or the caller's purpose, the burn is attributed to. */
    attribution: string;
    instruction: string;
    text: string;
    signal: AbortSignal;
    /** A JSON answer, whose length is its own rather than a word's. */
    json?: boolean;
    /** A model the person named, tried before the walk. */
    named?: { provider: string; id: string };
  }): Promise<QuestionTurn> {
    const { signal } = input;
    if (signal.aborted) return { failed: stopReason(signal) };
    const bound = await this.resolveBinding(input.attribution, input.named);
    if (!bound) return { failed: "no-model" };
    const { model, binding } = bound;
    const factory = this.options.sessions[binding.backend];
    if (!factory) return { failed: "no-model" };
    const source = `${model.provider}/${model.id}`;
    let burned: QuestionUsage | undefined;
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
    const timer = setTimeout(() => end("timeout"), QUESTION_TIMEOUT_MS);
    const onAbort = () => end(stopReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      // The caller's signal can fire while the binding resolves, and a
      // listener added after the fact never runs.
      if (signal.aborted) return { failed: stopReason(signal), source };
      await this.options.prepareHome?.();
      const creating = factory.open(
        questionSessionSpec({
          homeDir: this.options.homeDir,
          binding,
          model,
          instruction: input.instruction,
          ...(input.json ? { json: true } : {}),
        }),
      );
      session = await Promise.race([creating, stopped]);
      if (!session) {
        // A session that arrives after the bound is let go of at once.
        void creating.then(
          (late) => late.dispose(),
          () => {},
        );
        return { failed: ended, source };
      }
      // Asking before the prompt is the only way to honor a bound without
      // spending the call: an abort() lands on a request not yet made.
      if (ended) return { failed: ended, source };
      let answer = "";
      let failure = "";
      unsubscribe = session.subscribe((event) => {
        if (event.type === "turn_closed") {
          const closed = event.text?.trim();
          if (closed) answer = closed;
          return;
        }
        // A provider-failed turn RESOLVES rather than throwing, so the
        // session's `turn_failed` is the only place the failure shows. Without
        // this a caller would read an empty answer as an unparseable one and
        // hide a provider outage as a parse miss.
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
      const prompting = session.prompt(input.text);
      // A session whose abort does not settle its turn still cannot hold the
      // caller past the bound.
      prompting.catch(() => {});
      await Promise.race([prompting, stopped]);
      if (ended) return { failed: ended, source, ...wrap(burned) };
      if (failure) return { failed: failure, source, ...wrap(burned) };
      return { text: answer, source, ...wrap(burned) };
    } catch (caught) {
      // Session creation and the prompt itself both land here; the reason is
      // recorded rather than the message, which can carry a provider's prose.
      return {
        failed:
          ended || (caught instanceof Error && caught.name === "AbortError" ? "timeout" : "error"),
        source,
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
   * question on the flagship is pennies against the alternative.
   *
   * A model the person NAMED is honored first; naming a model is its own
   * placement, so a premium model, or one that is not in use, is allowed
   * there as it is everywhere a person names one. A named model that cannot
   * bind falls through to the walk rather than refusing to answer, and the
   * caller can say so (`pinState`).
   */
  private async resolveBinding(
    attribution: string,
    named: { provider: string; id: string } | undefined,
  ): Promise<BoundCandidate | undefined> {
    if (named) {
      const bound = await this.bind(named, attribution);
      if (bound) return bound;
      if (!fallsBack(named)) return undefined;
    }
    const flagship = this.options.flagshipAccountId();
    let lastResort: { model: { provider: string; id: string }; accountId: string } | undefined;
    for (const model of this.candidateModels()) {
      if (!this.answers(model)) continue;
      const selecting = this.options.selectAccount(attribution, model.provider);
      const accountId = selecting instanceof Promise ? await selecting : selecting;
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
   * What a named model comes to right now, by the checks a call makes
   * before it picks an account: a signed-in account serves it and its
   * backend has a session factory. A dead account store still only shows
   * at the call, which then falls back the same way. No named model is the
   * walk, as it is at the call.
   */
  pinState(named: { provider: string; id: string } | undefined): QuestionPinState {
    if (!named) return "fallback";
    if (this.canBind(named)) return "ready";
    return fallsBack(named) ? "fallback" : "held";
  }

  private canBind(model: { provider: string; id: string }): boolean {
    const pool = this.options.namedModels?.() ?? this.options.availableModels();
    return (
      pool.some((entry) => entry.provider === model.provider && entry.id === model.id) &&
      this.answers(model)
    );
  }

  /** Binds one named model, or nothing when its account or store is gone. */
  private async bind(
    model: { provider: string; id: string },
    attribution: string,
  ): Promise<BoundCandidate | undefined> {
    if (!this.canBind(model)) return undefined;
    const selecting = this.options.selectAccount(attribution, model.provider);
    const accountId = selecting instanceof Promise ? await selecting : selecting;
    if (!accountId) return this.unmanaged(model);
    try {
      return await this.bindAccount(model, accountId);
    } catch {
      return undefined;
    }
  }

  /**
   * Whether the model's backend has a factory to answer on. Antigravity's
   * runs crewmates only, so it never answers a question
   * (docs/antigravity-client.md).
   */
  private answers(model: { provider: string }): boolean {
    const backend = backendForProvider(model.provider);
    return backend !== "antigravity" && this.options.sessions[backend] !== undefined;
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
 * Whether the walk may answer for a named model that cannot bind. An
 * explicitly named custom connection never silently migrates its
 * background request to another account when paused or disconnected.
 */
function fallsBack(model: { provider: string }): boolean {
  return !isCustomApiProvider(model.provider);
}

/**
 * Why the caller's signal ended the call: its deadline (`AbortSignal.timeout`,
 * which the spawn path passes and which runs out before the walk's own
 * clock) is a timeout on the record; anything else is the caller aborting.
 */
function stopReason(signal: AbortSignal): "timeout" | "aborted" {
  const reason = signal.reason as { name?: unknown } | undefined;
  return reason?.name === "TimeoutError" ? "timeout" : "aborted";
}

function wrap(usage: QuestionUsage | undefined): { usage?: QuestionUsage } {
  return usage ? { usage } : {};
}
