import type {
  DecisionAnswer,
  DecisionCaller,
  DecisionModelCatalogRow,
  DecisionQuestion,
  DecisionState,
} from "@shared/decisions";
import { classifyTypeSafe, TYPESAFE_INPUT_PRICE_PER_MTOK } from "../../pi/decisionModels";
import {
  createQuotaHttp,
  isAuthFailure,
  isRateLimited,
  isSuccess,
  type QuotaHttp,
} from "../../quota/http";
import {
  abstentionOf,
  type DecisionModel,
  type DecisionRun,
  failedAnswer,
  questionVersion,
} from "../decisionModel";

/**
 * Jev, natively (S7b, design section 3): TypeSafe's System One model serves
 * the typed question as its API, so this implementation sends the state and
 * the questions and reads one option back. It generates no text, so there
 * is nothing to parse out of prose, and the vendor's own contract says the
 * answer is always one of the supplied options.
 *
 * Four rules this file exists to keep:
 *
 * - **One bounded request.** The same transport posture the quota sensor
 *   proved: a 15 s timeout, the caller's own cancel, a 64 KB body cap
 *   checked before anything is parsed, transport failures named in our own
 *   vocabulary rather than collapsed into "error".
 * - **An unrecognised body is never an answer.** It is `schema`, the
 *   Grok meter's rule - a shape we do not understand is a failure, not a
 *   window and not a verdict.
 * - **Certainty stays inside.** Jev's `confidence` never crosses the
 *   `DecisionAnswer` interface (the captain's call). It is used here, and
 *   only here, to decide when the answer becomes the question's declared
 *   abstention, and it is written to the record as free-text `detail`.
 * - **The abstention is withheld from the model.** Jev never sees it, so
 *   its distribution is over the real options; this implementation returns
 *   the abstention itself when the floor is not cleared.
 *
 * The key is the user's own, read from `DecisionKeyStore` for the one
 * purpose of putting it in an Authorization header, and it appears in no
 * log, no argv and no error message this file produces.
 */

/** TypeSafe's approved rate remains configuration of Pi's classifier. */
export const JEV_INPUT_PRICE_PER_MTOK = TYPESAFE_INPUT_PRICE_PER_MTOK;

/** The most options one Choice may carry, per the vendor's reference. */
export const JEV_MAX_OPTIONS = 255;

export type JevDecisionModelOptions = {
  row: DecisionModelCatalogRow;
  /** Reads the user's own key. Undefined means no key, which means no request. */
  key: () => string | undefined;
  /** Dev/e2e endpoint override; a packaged build never reaches this. */
  endpoint?: string;
  http?: QuotaHttp;
};

export class JevDecisionModel implements DecisionModel {
  readonly native = true;
  private readonly http: QuotaHttp;

  constructor(private readonly options: JevDecisionModelOptions) {
    this.http = options.http ?? createQuotaHttp();
  }

  get id(): string {
    return this.options.row.id;
  }

  /**
   * One HTTP call for the whole question set: the vendor evaluates several
   * questions "in parallel and in isolation against the same state", and
   * "adding questions barely changes the response time" - which is the one
   * property the adapter cannot match.
   */
  async decide(
    _caller: DecisionCaller,
    state: DecisionState,
    questions: Record<string, DecisionQuestion>,
    signal: AbortSignal,
  ): Promise<DecisionRun> {
    const served = Object.fromEntries(
      Object.entries(questions).map(([id, question]) => [
        id,
        {
          type: "choice" as const,
          instructions: question.instructions,
          criteria: Object.fromEntries(
            Object.entries(question.criteria).filter(([option]) => option !== question.abstain),
          ),
        },
      ]),
    );
    const versions = Object.fromEntries(
      Object.entries(questions).map(([id, question]) => [
        id,
        questionVersion(question, JSON.stringify(served[id] ?? {})),
      ]),
    );
    const fail = (reason: string): DecisionRun => ({
      answers: Object.fromEntries(
        Object.entries(questions).map(([id, question]) => [
          id,
          failedAnswer(question, reason, versions[id] ?? question.version, this.source()),
        ]),
      ),
      usage: [],
    });

    const key = this.options.key();
    if (!key) return fail("no-key");
    if (signal.aborted) return fail("aborted");
    const oversized = Object.entries(questions).find(
      ([, question]) => Object.keys(question.criteria).length > JEV_MAX_OPTIONS,
    );
    if (oversized) return fail("too-many-options");

    if (Object.values(questions).some((question) => question.type !== "choice"))
      return fail("unsupported-question");
    const bound = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    const call = await classifyTypeSafe({
      model: this.options.row.model,
      endpoint: this.endpoint(),
      key,
      context: {
        state: Object.fromEntries(
          Object.entries(state.facts).filter(([, value]) => value !== null && value !== ""),
        ),
        questions: served,
      },
      signal: bound,
      timeoutMs: 15_000,
      http: this.http,
    });
    if (bound.aborted)
      return fail(signal.aborted && signal.reason?.name !== "TimeoutError" ? "aborted" : "timeout");
    if (call.failure) return fail(call.failure);
    const status = call.status ?? 0;
    if (isAuthFailure(status)) return fail("key-rejected");
    if (isRateLimited(status)) return fail("rate-limited");
    if (status === 422) return fail("rejected");
    if (status === 529) return fail("overloaded");
    if (!isSuccess(status)) return fail(`http-${status}`);
    const servedModel = call.served ?? this.options.row.model;
    const source = `${this.options.row.id}/${servedModel}`;
    const usage = call.usage
      ? [
          {
            model: { provider: this.options.row.vendor.toLowerCase(), id: servedModel },
            usage: call.usage,
          },
        ]
      : [];
    if (call.result.stopReason !== "stop") return { ...fail("schema"), usage };
    const answers: Record<string, DecisionAnswer> = {};
    for (const [id, question] of Object.entries(questions)) {
      const version = versions[id] ?? question.version;
      const answer = call.result.answers[id];
      const value = answer?.type === "choice" ? answer.choice : undefined;
      if (
        !value ||
        !Object.hasOwn(served[id]?.criteria ?? {}, value) ||
        answer?.type !== "choice" ||
        !Number.isFinite(answer.confidence) ||
        answer.confidence < 0 ||
        answer.confidence > 1
      ) {
        // The vendor contracts that the answer is one of the options it was
        // given; anything else is a shape we do not understand.
        answers[id] = failedAnswer(question, "schema", version, source);
        continue;
      }
      const confidence = answer?.confidence;
      const detail = typeof confidence === "number" ? `p=${confidence.toFixed(2)}` : undefined;
      if (typeof confidence === "number" && confidence < this.options.row.abstainBelow) {
        answers[id] = {
          value: abstentionOf(question),
          outcome: "abstained",
          source,
          version,
          detail: `${detail} below ${this.options.row.abstainBelow}`,
        };
        continue;
      }
      answers[id] = {
        value,
        outcome: "answered",
        source,
        version,
        ...(detail ? { detail } : {}),
      };
    }
    return { answers, usage };
  }

  private endpoint(): string {
    return this.options.endpoint ?? this.options.row.endpoint;
  }

  private source(): string {
    return `${this.options.row.id}/${this.options.row.model}`;
  }
}
