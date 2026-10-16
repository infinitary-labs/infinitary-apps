import type {
  DecisionAnswer,
  DecisionCaller,
  DecisionQuestion,
  DecisionState,
} from "@shared/decisions";
import { classifyOpenRouter } from "../pi/decisionModels";
import type { ModelRuntime } from "../pi/types";
import {
  abstentionOf,
  DECIDE_TIMEOUT_MS,
  type DecisionModel,
  type DecisionRun,
  failedAnswer,
  questionVersion,
} from "./decisionModel";

export class OpenRouterDecisionModel implements DecisionModel {
  readonly native = true;
  readonly id = "openrouter";
  readonly pick: string;
  constructor(
    private readonly options: {
      model: string;
      selectAccount: (taskId: string) => string | undefined;
      runtimeFor: (accountId: string) => Promise<ModelRuntime>;
      onUnauthorized?: (accountId: string) => Promise<unknown>;
      baseUrl?: string;
    },
  ) {
    this.pick = `openrouter/${options.model}`;
  }

  async decide(
    caller: DecisionCaller,
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
        questionVersion(question, JSON.stringify(served[id])),
      ]),
    );
    const source = `openrouter/${this.options.model}`;
    const fail = (reason: string): DecisionRun => ({
      answers: Object.fromEntries(
        Object.entries(questions).map(([id, question]) => [
          id,
          failedAnswer(question, reason, versions[id] ?? question.version, source),
        ]),
      ),
      usage: [],
    });
    const stopReason = () =>
      signal.aborted && signal.reason?.name !== "TimeoutError" ? "aborted" : "timeout";
    if (signal.aborted) return fail(stopReason());
    if (Object.values(questions).some((question) => question.type !== "choice"))
      return fail("unsupported-question");
    const bound = AbortSignal.any([signal, AbortSignal.timeout(DECIDE_TIMEOUT_MS)]);
    // Covers account runtime creation too, even when it ignores cancellation.
    let stop!: () => void;
    const stopped = new Promise<DecisionRun>((resolve) => {
      stop = () => resolve(fail(stopReason()));
      bound.addEventListener("abort", stop, { once: true });
    });
    const work = async (): Promise<DecisionRun> => {
      const accountId = this.options.selectAccount(caller.taskId ?? caller.purpose);
      if (!accountId) return fail("no-account");
      const runtime = await this.options.runtimeFor(accountId);
      if (bound.aborted) return fail(stopReason());
      const call = await classifyOpenRouter(
        runtime,
        this.options.model,
        {
          state: Object.fromEntries(
            Object.entries(state.facts).filter(([, value]) => value !== null && value !== ""),
          ),
          questions: served,
        },
        bound,
        DECIDE_TIMEOUT_MS,
        this.options.baseUrl,
      );
      if (!call) return fail("no-model");
      const { result, status, oversized, served: answeredBy } = call;
      // Recorded under the model the reply says answered (an alias such as
      // `~typesafe/jev-latest` resolves to a dated model), else the pick.
      const usage = call.usage
        ? [
            {
              accountId,
              model: { provider: "openrouter", id: this.options.model },
              usage: answeredBy
                ? { ...call.usage, models: [{ ...call.usage, model: answeredBy }] }
                : call.usage,
            },
          ]
        : [];
      if (result.stopReason !== "stop") {
        // A reply past the limit is refused unread whatever its status, as
        // Jev's is, so it is never a verdict on the credential.
        if (status === 401 && !oversized)
          void this.options.onUnauthorized?.(accountId).catch(() => {});
        const reason = bound.aborted
          ? stopReason()
          : oversized
            ? "oversized"
            : status === 401
              ? "unauthorized"
              : status === 402
                ? "no-credit"
                : status === 429
                  ? "rate-limited"
                  : status === 529
                    ? "overloaded"
                    : status === 200
                      ? "schema"
                      : "provider";
        return { ...fail(reason), usage };
      }
      const answers: Record<string, DecisionAnswer> = {};
      for (const [id, question] of Object.entries(questions)) {
        const answer = result.answers[id];
        const version = versions[id] ?? question.version;
        const servedSource = `openrouter/${answeredBy ?? result.model}`;
        if (
          answer?.type !== "choice" ||
          !Object.hasOwn(served[id]?.criteria ?? {}, answer.choice) ||
          !Number.isFinite(answer.confidence) ||
          answer.confidence < 0 ||
          answer.confidence > 1
        ) {
          answers[id] = failedAnswer(question, "schema", version, servedSource);
        } else {
          const abstained = answer.confidence < 0.6;
          answers[id] = {
            value: abstained ? abstentionOf(question) : answer.choice,
            outcome: abstained ? "abstained" : "answered",
            source: servedSource,
            version,
            detail: `p=${answer.confidence.toFixed(2)}${abstained ? " below 0.6" : ""}`,
          };
        }
      }
      return { answers, usage };
    };
    try {
      return await Promise.race([work().catch(() => fail("provider")), stopped]);
    } finally {
      bound.removeEventListener("abort", stop);
    }
  }
}
