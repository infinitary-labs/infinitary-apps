import type { CutOff } from "@shared/authFailure";
import { DEFAULT_DECISIONS, type DecisionsSettings } from "@shared/decisions";
import type { FmUsage } from "@shared/events";
import type { ModelsCatalogView } from "@shared/quota";
import { CLASSIFIABLE_KINDS, type WorkKind } from "@shared/routingPolicy";
import { describe, expect, it, vi } from "vitest";
import { readBoundaryCorpus } from "../../../scripts/score-kind-classifier";
import { FAKE_CONTROL_PROFILE, fakeSession } from "../../../tests/helpers/fakeSession";
import {
  AdaptedDecisionModel,
  type AdaptedDecisionModelOptions,
  DecisionModels,
} from "../decisions/decisionModel";
import { buildKindClassifierInstruction } from "../pi/piResources";
import type { ModelRuntime } from "../pi/types";
import type {
  ModelSession,
  SessionBackend,
  SessionEvent,
  SessionFactories,
  SessionSpec,
} from "../session/session";
import {
  buildClassifierPrompt,
  CLASSIFY_TIMEOUT_MS,
  classifierVersion,
  DecisionKindClassifier,
  KIND_QUESTION,
  kindState,
} from "./decisionKindClassifier";
import { KIND_SOURCE } from "./kindClassifier";
import { tierFor } from "./policy";

/**
 * The kind classifier against a stub model - S3's gate, transferred to S7a
 * as the ADAPTER's parity suite (design section 8.2: "zero behaviour
 * change, proven by the transferred parity suite"). Every case below ran
 * green against `ModelKindClassifier` before the class existed and runs
 * green against `DecisionKindClassifier` over `AdaptedDecisionModel` after
 * it: what it reads off an answer, what it does with every way the call can
 * go wrong, which model it binds, and that the burn lands under the task.
 *
 * The one rule every case here is really testing: a classifier that cannot
 * answer must cost quota, never correctness - so `unclear` is always
 * available and always says why.
 */

const RUNTIME = { kind: "runtime" } as unknown as ModelRuntime;

const CATALOG: ModelsCatalogView = {
  // Catalog rows carry QUOTA provider ids; the walk maps them to Pi's.
  models: [
    { provider: "grok", id: "grok-cheap", effectivePercentRemaining: 80 },
    { provider: "grok", id: "grok-strong", effectivePercentRemaining: 80 },
  ],
  at: 0,
} as unknown as ModelsCatalogView;

/** A session that answers once and records what it was asked. */
function stubSession(
  answer: string | { text?: string; failed?: boolean; cutOff?: CutOff },
  options: {
    /** Stays open until abort(); `deaf` stays open even then, like a client that stopped answering. */
    hang?: boolean | "deaf";
    usage?: FmUsage;
  } = {},
): { session: ModelSession; prompts: string[]; disposed: () => number } {
  const prompts: string[] = [];
  let disposals = 0;
  const listeners: Array<(event: SessionEvent) => void> = [];
  const reply = typeof answer === "string" ? { text: answer } : answer;
  const session: ModelSession = {
    ...fakeSession({ sessionId: "classify-1" }),
    isStreaming: () => false,
    modelRef: () => ({ provider: "xai", id: "grok-cheap" }),
    subscribe: (listener) => {
      listeners.push(listener);
      return () => {};
    },
    prompt: async (text: string) => {
      prompts.push(text);
      if (options.hang) {
        // Stays open until abort(), like a real provider that went quiet.
        await new Promise<void>((resolve) => {
          resolveHang = resolve;
        });
        return;
      }
      const events: SessionEvent[] = [
        ...(reply.failed
          ? [
              {
                type: "turn_failed" as const,
                taskId: "firstmate",
                error: "provider down",
                ...(reply.cutOff ? { cutOff: reply.cutOff } : {}),
              },
            ]
          : []),
        {
          type: "turn_end",
          taskId: "firstmate",
          ...(options.usage ? { usage: options.usage } : {}),
        },
        { type: "turn_closed", ...(reply.text ? { text: reply.text } : {}) },
      ];
      for (const event of events) {
        for (const listener of listeners) listener(event);
      }
    },
    steer: async () => {},
    abort: async () => {
      if (options.hang !== "deaf") resolveHang?.();
    },
    dispose: () => {
      disposals += 1;
    },
  };
  let resolveHang: (() => void) | undefined;
  return { session, prompts, disposed: () => disposals };
}

type Open = (spec: SessionSpec) => Promise<ModelSession>;

/** The adapter's factories, each opening whatever the test hands it. */
function factories(opens: { pi: Open; claude?: Open }): SessionFactories {
  const factory = (backend: SessionBackend, open: Open) => ({
    backend,
    controlProfile: FAKE_CONTROL_PROFILE,
    open,
  });
  return {
    pi: factory("pi", opens.pi),
    ...(opens.claude ? { claude: factory("claude", opens.claude) } : {}),
  };
}

function classifierWith(
  session: ModelSession,
  overrides: Partial<AdaptedDecisionModelOptions> = {},
  extras: {
    recordUsage?: DecisionModelsOptionsRecordUsage;
    settings?: DecisionsSettings;
  } = {},
): DecisionKindClassifier {
  const adapted = new AdaptedDecisionModel({
    homeDir: "/tmp/fm-home",
    availableModels: () => [
      { provider: "xai", id: "grok-strong", slot: "high" },
      { provider: "xai", id: "grok-cheap", slot: "low" },
    ],
    quotaModels: () => CATALOG,
    selectAccount: () => "acct_a",
    flagshipAccountId: () => null,
    runtimeFor: async () => RUNTIME,
    baseRuntime: RUNTIME,
    sessions: factories({ pi: async () => session }),
    ...overrides,
  });
  return new DecisionKindClassifier(
    new DecisionModels({
      settings: {
        getDecisions: () => extras.settings ?? DEFAULT_DECISIONS,
        setDecisions: () => {},
      },
      adapted,
      ...(extras.recordUsage ? { recordUsage: extras.recordUsage } : {}),
    }),
  );
}

type DecisionModelsOptionsRecordUsage = NonNullable<
  ConstructorParameters<typeof DecisionModels>[0]["recordUsage"]
>;

const INPUT = {
  taskId: "task-1",
  title: "Bump the linter",
  goal: "Update the linter to the current minor and fix the two new warnings.",
  userWords: "can you bump the linter please",
};

describe("the kind question", () => {
  it("serves the adapter the versioned instruction and the native path the same options", () => {
    expect(KIND_QUESTION.adapterInstruction).toBe(buildKindClassifierInstruction());
    expect(KIND_QUESTION.abstain).toBe("unclear");
    // The eight kinds are the closed option set; `unclear` is the abstention
    // and is deliberately not one of them.
    expect(Object.keys(KIND_QUESTION.criteria)).toEqual([...CLASSIFIABLE_KINDS]);
  });

  it("names the same bounded facts the adapter's message carries", () => {
    const work = {
      ...INPUT,
      constraints: "minimal-diff",
      repoName: "firstmate-3000",
      delivery: "direct-pr",
    };
    const state = kindState(work);
    expect(state.facts).toEqual({
      title: "Bump the linter",
      goal: "Update the linter to the current minor and fix the two new warnings.",
      user_words: "can you bump the linter please",
      how_to_work: "minimal-diff",
      repository: "firstmate-3000 (direct-pr)",
      basis: null,
    });
    expect(state.adapterText).toBe(buildClassifierPrompt(work));
  });
});

describe("buildClassifierPrompt", () => {
  it("carries the work's facts and nothing about tiers or models", () => {
    const prompt = buildClassifierPrompt({
      ...INPUT,
      constraints: "minimal-diff",
      repoName: "firstmate-3000",
      delivery: "direct-pr",
    });
    expect(prompt).toContain("Bump the linter");
    expect(prompt).toContain("can you bump the linter please");
    expect(prompt).toContain("firstmate-3000 (direct-pr)");
    expect(prompt).toContain("minimal-diff");
    expect(prompt).not.toMatch(/premium|high|medium|low|tier|model/i);
  });

  it("bounds every field, so one pathological brief cannot blow the call up", () => {
    const prompt = buildClassifierPrompt({ ...INPUT, userWords: "x".repeat(50_000) });
    expect(prompt.length).toBeLessThan(6_000);
    expect(prompt).toContain("...");
  });

  it("shows a basis when one was given", () => {
    const prompt = buildClassifierPrompt({
      ...INPUT,
      basis: { key: "FM3K-7", title: "The panel spec", outcomeHead: "The spec is agreed." },
    });
    expect(prompt).toContain('FM3K-7 "The panel spec"');
    expect(prompt).toContain("The spec is agreed.");
  });
});

describe("DecisionKindClassifier over the adapter", () => {
  it("returns the kind it read, stamped with the model and the instruction version", async () => {
    const stub = stubSession("chore");
    const verdict = await classifierWith(stub.session).classify(
      INPUT,
      new AbortController().signal,
    );
    expect(verdict.kind).toBe("chore");
    expect(verdict.source).toBe(`${KIND_SOURCE.classified}xai/grok-cheap`);
    // The stamp is the fingerprint of the bytes actually served, which
    // under the default record are S3's bytes: `kc1-<sha12>` unmoved.
    expect(verdict.version).toBe(classifierVersion());
    expect(verdict.model).toBe("xai/grok-cheap");
    expect(stub.disposed()).toBe(1);
  });

  it("serves the instruction and the message S3 served, byte for byte", async () => {
    const createSession = vi.fn(async (_spec: SessionSpec) => stubSession("fix").session);
    const stub = stubSession("fix");
    await classifierWith(stub.session, { sessions: factories({ pi: createSession }) }).classify(
      INPUT,
      new AbortController().signal,
    );
    expect(createSession.mock.calls[0]?.[0]?.instructions.base).toBe(
      buildKindClassifierInstruction(),
    );
  });

  it("accepts retrieval from the adapter without mistaking it for research", async () => {
    const stub = stubSession("retrieval");
    const verdict = await classifierWith(stub.session).classify(
      {
        ...INPUT,
        title: "Read a setting",
        goal: "Quote the configured retry limit.",
        userWords: "What is the retry limit in this project's config?",
      },
      new AbortController().signal,
    );
    expect(verdict).toMatchObject({
      kind: "retrieval",
      source: "classifier:xai/grok-cheap",
      version: classifierVersion(),
    });
  });

  it("maps a native retrieval verdict through the same interface", async () => {
    const decide = vi.fn(async () => ({
      kind: {
        value: "retrieval",
        outcome: "answered",
        source: "jev/jev-1.13.0",
        version: "native-kc2",
      },
    }));
    const classifier = new DecisionKindClassifier({ decide } as unknown as DecisionModels);
    expect(await classifier.classify(INPUT, new AbortController().signal)).toMatchObject({
      kind: "retrieval",
      source: "classifier:jev/jev-1.13.0",
    });
    expect(decide).toHaveBeenCalledWith(
      { purpose: "kind", taskId: INPUT.taskId },
      kindState(INPUT),
      { kind: KIND_QUESTION },
      expect.any(AbortSignal),
    );
  });

  it("records the model's own abstention as an abstention, not a failure", async () => {
    const verdict = await classifierWith(stubSession("unclear").session).classify(
      INPUT,
      new AbortController().signal,
    );
    expect(verdict.kind).toBe("unclear");
    expect(verdict.source).toBe(`${KIND_SOURCE.abstained}xai/grok-cheap`);
  });

  it("fails soft to unclear on an unparseable answer, a provider error, and no model at all", async () => {
    const unparsed = await classifierWith(
      stubSession("fix or implement - hard to say").session,
    ).classify(INPUT, new AbortController().signal);
    expect(unparsed).toMatchObject({ kind: "unclear", source: `${KIND_SOURCE.failed}unparsed` });

    const errored = await classifierWith(stubSession({ text: "", failed: true }).session).classify(
      INPUT,
      new AbortController().signal,
    );
    expect(errored).toMatchObject({ kind: "unclear", source: `${KIND_SOURCE.failed}provider` });

    const none = await classifierWith(stubSession("chore").session, {
      availableModels: () => [],
    }).classify(INPUT, new AbortController().signal);
    expect(none).toMatchObject({ kind: "unclear", source: `${KIND_SOURCE.failed}no-model` });
  });

  it("fails soft when the session cannot even be created", async () => {
    const verdict = await classifierWith(stubSession("chore").session, {
      sessions: factories({
        pi: async () => {
          throw new Error("provider is down");
        },
      }),
    }).classify(INPUT, new AbortController().signal);
    expect(verdict).toMatchObject({ kind: "unclear", source: `${KIND_SOURCE.failed}error` });
    // The provider's prose never reaches the record.
    expect(verdict.source).not.toContain("provider is down");
  });

  it("gives up at its own wall clock instead of holding a dispatch open", async () => {
    vi.useFakeTimers();
    try {
      const stub = stubSession("chore", { hang: true });
      const pending = classifierWith(stub.session).classify(INPUT, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(CLASSIFY_TIMEOUT_MS + 10);
      expect(await pending).toMatchObject({
        kind: "unclear",
        source: `${KIND_SOURCE.failed}timeout`,
      });
      expect(stub.disposed()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("binds the cheapest slotted model and never a premium one", async () => {
    const createSession = vi.fn(async (_spec: SessionSpec) => stubSession("fix").session);
    await classifierWith(stubSession("fix").session, {
      sessions: factories({ pi: createSession }),
      availableModels: () => [
        { provider: "xai", id: "grok-premium", slot: "premium" },
        { provider: "xai", id: "grok-strong", slot: "high" },
        { provider: "xai", id: "grok-cheap", slot: "low" },
      ],
      quotaModels: () =>
        ({
          models: [
            { provider: "grok", id: "grok-premium" },
            { provider: "grok", id: "grok-strong" },
            { provider: "grok", id: "grok-cheap" },
          ],
        }) as unknown as ModelsCatalogView,
    }).classify(INPUT, new AbortController().signal);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0]?.[0]?.model).toEqual({ provider: "xai", id: "grok-cheap" });
    // Bound the way the seat is: a Pi binding on the account that serves it.
    expect(createSession.mock.calls[0]?.[0]?.binding).toEqual({
      backend: "pi",
      accountId: "acct_a",
      runtime: RUNTIME,
    });
  });

  it("honors an offering the user named, premium included - naming a model is its own placement", async () => {
    const createSession = vi.fn(async (_spec: SessionSpec) => stubSession("fix").session);
    await classifierWith(stubSession("fix").session, {
      sessions: factories({ pi: createSession }),
      offering: () => "xai/grok-premium",
      availableModels: () => [
        { provider: "xai", id: "grok-premium", slot: "premium" },
        { provider: "xai", id: "grok-cheap", slot: "low" },
      ],
    }).classify(INPUT, new AbortController().signal);
    expect(createSession.mock.calls[0]?.[0]?.model).toEqual({
      provider: "xai",
      id: "grok-premium",
    });
  });

  it("honors a named offering that is signed in but not in use - naming a model is its own placement", async () => {
    const createSession = vi.fn(async (_spec: SessionSpec) => stubSession("fix").session);
    const verdict = await classifierWith(stubSession("fix").session, {
      sessions: factories({ pi: createSession }),
      offering: () => "xai/grok-unslotted",
      // The slotted pool the walk reads leaves it out; the signed-in pool has it.
      namedModels: () => [
        { provider: "xai", id: "grok-cheap" },
        { provider: "xai", id: "grok-unslotted" },
      ],
    }).classify(INPUT, new AbortController().signal);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0]?.[0]?.model).toEqual({
      provider: "xai",
      id: "grok-unslotted",
    });
    expect(verdict.source).toBe(`${KIND_SOURCE.classified}xai/grok-unslotted`);
  });

  it("falls back to the walk when the named offering is gone, rather than refusing to answer", async () => {
    const createSession = vi.fn(async (_spec: SessionSpec) => stubSession("fix").session);
    const verdict = await classifierWith(stubSession("fix").session, {
      sessions: factories({ pi: createSession }),
      offering: () => "xai/retired-model",
    }).classify(INPUT, new AbortController().signal);
    expect(createSession.mock.calls[0]?.[0]?.model).toEqual({ provider: "xai", id: "grok-cheap" });
    expect(verdict.kind).toBe("fix");
  });

  it("tries past a dead account store, and spends the flagship only as a last resort", async () => {
    const bound: string[] = [];
    await classifierWith(stubSession("plan").session, {
      selectAccount: (_taskId, provider) => (provider === "xai" ? "acct_flagship" : undefined),
      flagshipAccountId: () => "acct_flagship",
      runtimeFor: async (accountId) => {
        bound.push(accountId);
        return RUNTIME;
      },
    }).classify(INPUT, new AbortController().signal);
    // Every candidate resolved to the flagship, so it is used - once, and
    // only after the whole walk found nothing else.
    expect(bound).toEqual(["acct_flagship"]);

    const skipped: string[] = [];
    const verdict = await classifierWith(stubSession("plan").session, {
      selectAccount: () => "acct_dead",
      runtimeFor: async (accountId) => {
        skipped.push(accountId);
        throw new Error("store is gone");
      },
    }).classify(INPUT, new AbortController().signal);
    expect(skipped.length).toBeGreaterThan(0);
    expect(verdict).toMatchObject({ kind: "unclear", source: `${KIND_SOURCE.failed}no-model` });
  });

  it("records the burn under the task and the account that served it", async () => {
    const recordUsage = vi.fn();
    await classifierWith(
      stubSession("research", { usage: { input: 900, output: 3 } }).session,
      {},
      { recordUsage },
    ).classify(INPUT, new AbortController().signal);
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage.mock.calls[0]?.[0]).toMatchObject({
      taskId: "task-1",
      accountId: "acct_a",
      model: { provider: "xai", id: "grok-cheap" },
      usage: { input: 900, output: 3 },
    });
  });
});

describe("the adapter on Claude (W1 S10)", () => {
  const CLAUDE = { provider: "anthropic-claude", id: "claude-haiku-4-5" };
  /** The quota catalog names Claude by its quota id, as it names Grok. */
  const WITH_CLAUDE = {
    models: [
      { provider: "grok", id: "grok-cheap" },
      { provider: "grok", id: "grok-strong" },
      { provider: "claude", id: CLAUDE.id },
    ],
  } as unknown as ModelsCatalogView;
  const selectAccount = (_taskId: string, provider: string) =>
    provider === CLAUDE.provider ? "acct_claude" : "acct_a";

  it("competes in the low-first walk like any provider, bound to its login's account", async () => {
    const pi = vi.fn(async (_spec: SessionSpec) => stubSession("fix").session);
    const claude = vi.fn(async (_spec: SessionSpec) => stubSession("chore").session);
    const verdict = await classifierWith(stubSession("fix").session, {
      sessions: factories({ pi, claude }),
      availableModels: () => [
        { provider: "xai", id: "grok-strong", slot: "high" },
        { ...CLAUDE, slot: "low" },
      ],
      quotaModels: () => WITH_CLAUDE,
      selectAccount,
    }).classify(INPUT, new AbortController().signal);
    expect(pi).not.toHaveBeenCalled();
    expect(claude).toHaveBeenCalledTimes(1);
    expect(claude.mock.calls[0]?.[0]).toMatchObject({
      model: CLAUDE,
      binding: { backend: "claude", accountId: "acct_claude" },
      instructions: { base: buildKindClassifierInstruction() },
    });
    expect(verdict).toMatchObject({
      kind: "chore",
      source: `${KIND_SOURCE.classified}anthropic-claude/claude-haiku-4-5`,
    });
  });

  it("classifies on a machine with only Claude signed in", async () => {
    const recordUsage = vi.fn();
    const verdict = await classifierWith(
      stubSession("fix").session,
      {
        sessions: factories({
          pi: async () => {
            throw new Error("no Pi model should be asked");
          },
          claude: async () => stubSession("research", { usage: { input: 700, output: 2 } }).session,
        }),
        availableModels: () => [{ ...CLAUDE, slot: "low" }],
        quotaModels: () => WITH_CLAUDE,
        selectAccount,
        baseRuntime: undefined,
        runtimeFor: async () => {
          throw new Error("no Pi runtime should be built");
        },
      },
      { recordUsage },
    ).classify(INPUT, new AbortController().signal);
    expect(verdict.kind).toBe("research");
    // The burn lands under the task and the Claude account, like any other.
    expect(recordUsage.mock.calls[0]?.[0]).toMatchObject({
      taskId: "task-1",
      accountId: "acct_claude",
      model: CLAUDE,
      usage: { input: 700, output: 2 },
    });
  });

  it("fails soft for an unmanaged Pi candidate when no base runtime exists", async () => {
    const open = vi.fn(async () => stubSession("fix").session);
    const verdict = await classifierWith(stubSession("fix").session, {
      baseRuntime: undefined,
      selectAccount: () => undefined,
      sessions: factories({ pi: open }),
    }).classify(INPUT, new AbortController().signal);
    expect(open).not.toHaveBeenCalled();
    expect(verdict).toMatchObject({ kind: "unclear", source: `${KIND_SOURCE.failed}no-model` });
  });

  it("passes a Claude model over when no Claude factory is wired", async () => {
    const pi = vi.fn(async (_spec: SessionSpec) => stubSession("fix").session);
    await classifierWith(stubSession("fix").session, {
      sessions: factories({ pi }),
      availableModels: () => [
        { ...CLAUDE, slot: "low" },
        { provider: "xai", id: "grok-strong", slot: "high" },
      ],
      quotaModels: () => WITH_CLAUDE,
      selectAccount,
    }).classify(INPUT, new AbortController().signal);
    expect(pi.mock.calls[0]?.[0]?.model).toEqual({ provider: "xai", id: "grok-strong" });
  });

  it("never binds a Claude model with no account behind it", async () => {
    const claude = vi.fn(async (_spec: SessionSpec) => stubSession("fix").session);
    const verdict = await classifierWith(stubSession("fix").session, {
      sessions: factories({ pi: async () => stubSession("fix").session, claude }),
      availableModels: () => [{ ...CLAUDE, slot: "low" }],
      quotaModels: () => WITH_CLAUDE,
      // A client-served login IS its account: there is no base runtime to fall back on.
      selectAccount: () => undefined,
    }).classify(INPUT, new AbortController().signal);
    expect(claude).not.toHaveBeenCalled();
    expect(verdict).toMatchObject({ kind: "unclear", source: `${KIND_SOURCE.failed}no-model` });
  });

  it("records a typed cut-off on the account that served the call, and fails soft", async () => {
    const noteCutOff = vi.fn();
    const verdict = await classifierWith(stubSession("fix").session, {
      sessions: factories({
        pi: async () => stubSession("fix").session,
        claude: async () => stubSession({ failed: true, cutOff: { class: "refused" } }).session,
      }),
      availableModels: () => [{ ...CLAUDE, slot: "low" }],
      quotaModels: () => WITH_CLAUDE,
      selectAccount,
      noteCutOff,
    }).classify(INPUT, new AbortController().signal);
    expect(noteCutOff).toHaveBeenCalledWith("acct_claude", { class: "refused" });
    expect(verdict).toMatchObject({ kind: "unclear", source: `${KIND_SOURCE.failed}provider` });
  });

  it("records nothing on the account for a failure that is not a cut-off", async () => {
    const noteCutOff = vi.fn();
    await classifierWith(stubSession({ failed: true }).session, { noteCutOff }).classify(
      INPUT,
      new AbortController().signal,
    );
    expect(noteCutOff).not.toHaveBeenCalled();
  });
});

describe("the adapter's wall clock covers the whole call", () => {
  it("gives up on a session still being created, and lets it go when it arrives", async () => {
    vi.useFakeTimers();
    try {
      const late = stubSession("chore");
      let arrive!: (session: ModelSession) => void;
      const pending = classifierWith(late.session, {
        sessions: factories({
          pi: () =>
            new Promise<ModelSession>((resolve) => {
              arrive = resolve;
            }),
        }),
      }).classify(INPUT, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(CLASSIFY_TIMEOUT_MS + 10);
      expect(await pending).toMatchObject({
        kind: "unclear",
        source: `${KIND_SOURCE.failed}timeout`,
      });
      arrive(late.session);
      await vi.advanceTimersByTimeAsync(0);
      expect(late.prompts).toEqual([]);
      expect(late.disposed()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wait on a session whose abort never settles its turn", async () => {
    vi.useFakeTimers();
    try {
      const stub = stubSession("chore", { hang: "deaf" });
      const pending = classifierWith(stub.session).classify(INPUT, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(CLASSIFY_TIMEOUT_MS + 10);
      expect(await pending).toMatchObject({
        kind: "unclear",
        source: `${KIND_SOURCE.failed}timeout`,
      });
      expect(stub.disposed()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records the caller's deadline as a timeout, and its own cancel as an abort", async () => {
    // The spawn path passes `AbortSignal.timeout`, which runs out before
    // the adapter's own clock: its expiry is the timeout it is.
    const deadline = new AbortController();
    const timedOut = classifierWith(stubSession("chore", { hang: true }).session).classify(
      INPUT,
      deadline.signal,
    );
    deadline.abort(new DOMException("The operation timed out.", "TimeoutError"));
    expect(await timedOut).toMatchObject({ source: `${KIND_SOURCE.failed}timeout` });

    const cancel = new AbortController();
    const cancelled = classifierWith(stubSession("chore", { hang: true }).session).classify(
      INPUT,
      cancel.signal,
    );
    cancel.abort();
    expect(await cancelled).toMatchObject({ source: `${KIND_SOURCE.failed}aborted` });
  });

  it("answers the caller's own abort while the session is still being created", async () => {
    const controller = new AbortController();
    const pending = classifierWith(stubSession("chore").session, {
      sessions: factories({ pi: () => new Promise<ModelSession>(() => {}) }),
    }).classify(INPUT, controller.signal);
    controller.abort();
    expect(await pending).toMatchObject({
      kind: "unclear",
      source: `${KIND_SOURCE.failed}aborted`,
    });
  });
});

// Scripted verdicts prove the typed interface and table, never semantic adherence.
describe("boundary verdicts survive the classifier interface", () => {
  const { spawns, labels } = readBoundaryCorpus(
    "tests/fixtures/kind-classifier/retrieval-boundary.jsonl",
  );
  for (const sample of spawns) {
    it(sample.title, async () => {
      const label = labels.get(sample.key)?.kind as WorkKind;
      const stub = stubSession(label);
      const verdict = await classifierWith(stub.session).classify(
        { ...sample, taskId: sample.key },
        new AbortController().signal,
      );
      expect(verdict.kind).toBe(label);
      const routed = tierFor({ kind: verdict.kind, kind_source: verdict.source });
      if (label === "retrieval") expect(routed).toMatchObject({ bucket: "low", rule: "R10" });
      else expect(routed.rule).not.toBe("R10");
      expect(stub.prompts[0]).toContain(sample.userWords);
    });
  }
});
