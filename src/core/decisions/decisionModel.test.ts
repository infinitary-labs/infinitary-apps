import {
  DEFAULT_DECISIONS,
  type DecisionQuestion,
  type DecisionsSettings,
} from "@shared/decisions";
import {
  DECISION_APPROVAL_VERSION,
  DECISION_FIRST_APPROVAL_VERSION,
  type DecisionUseSwitches,
} from "@shared/decisionUses";
import { describe, expect, it, vi } from "vitest";
import { CARD_READINGS } from "./cardReader";
import {
  AdaptedDecisionModel,
  adapterOptions,
  type DecisionModel,
  DecisionModels,
  type DecisionRun,
  failedAnswer,
  parseOption,
  questionVersion,
  renderAdapterInstruction,
  renderAdapterState,
} from "./decisionModel";
import { EVENT_SCREEN_QUESTION } from "./eventScreen";

/**
 * The class itself, away from any consumer (S7a): what a question renders
 * to when nobody pinned its bytes, how an answer is fingerprinted, and the
 * two rules the service owes every caller - it never throws, and a native
 * model that cannot answer is answered for by the adapter rather than by
 * silence.
 */

const QUESTION: DecisionQuestion = {
  type: "choice",
  instructions: "Which way does this go?",
  criteria: { left: "towards the door", right: "away from it" },
  abstain: "unsure",
  version: "q1",
};

const WITH_ABSTAIN: DecisionQuestion = {
  ...QUESTION,
  criteria: { ...QUESTION.criteria, unsure: "cannot tell" },
};

describe("parseOption", () => {
  it("reads a bare word in any casing or punctuation", () => {
    expect(parseOption("left", ["left", "right"])).toBe("left");
    expect(parseOption(" Right.\n", ["left", "right"])).toBe("right");
    expect(parseOption("LEFT", ["left", "right"])).toBe("left");
  });

  it("honors an unambiguous word wrapped in a sentence", () => {
    expect(parseOption("This one goes left.", ["left", "right"])).toBe("left");
  });

  it("refuses an answer naming two options, or none", () => {
    expect(parseOption("either left or right", ["left", "right"])).toBeUndefined();
    expect(parseOption("I am not able to answer that", ["left", "right"])).toBeUndefined();
    expect(parseOption("", ["left", "right"])).toBeUndefined();
  });

  // A hermetic run of the event screen found a hyphenated option read back as
  // its last word, so "no-match" came back as "match": every option of the
  // event screen and the reader check must read back as itself.
  it("reads back every option of the event screen and the reader check as itself", () => {
    for (const question of [EVENT_SCREEN_QUESTION, ...Object.values(CARD_READINGS)]) {
      const options = adapterOptions(question);
      for (const option of options) expect(parseOption(option, options)).toBe(option);
    }
  });
});

describe("rendering a question the consumer did not pin", () => {
  it("serves the instructions, every option with what it means, and the closed list", () => {
    const served = renderAdapterInstruction(WITH_ABSTAIN);
    expect(served).toContain("Which way does this go?");
    expect(served).toContain("left - towards the door");
    expect(served).toContain("unsure - cannot tell");
    expect(served).toContain("Answer with exactly one of: left, right, unsure.");
  });

  it("serves a pinned instruction verbatim instead", () => {
    const pinned = renderAdapterInstruction({ ...QUESTION, adapterInstruction: "Say left." });
    expect(pinned).toBe("Say left.");
  });

  it("renders facts as named lines, dropping the ones with nothing to say", () => {
    expect(renderAdapterState({ facts: { a: "one", b: null, c: 2, d: "" } })).toBe("a: one\nc: 2");
  });

  it("serves pinned state text verbatim instead", () => {
    expect(renderAdapterState({ facts: { a: "one" }, adapterText: "[work]\na" })).toBe("[work]\na");
  });
});

describe("questionVersion", () => {
  it("stamps the consumer's contract number and the proof of the bytes served", () => {
    const served = renderAdapterInstruction(QUESTION);
    expect(questionVersion(QUESTION, served)).toMatch(/^q1-[0-9a-f]{12}$/);
    // Two implementations serving different bytes get different stamps,
    // which is the honest answer - they did not ask the same thing.
    expect(questionVersion(QUESTION, served)).not.toBe(questionVersion(QUESTION, "other"));
  });
});

function model(
  id: string,
  native: boolean,
  run: (questions: Record<string, DecisionQuestion>) => DecisionRun,
): DecisionModel {
  return {
    id,
    native,
    decide: async (_caller, _state, questions) => run(questions),
  };
}

function answering(id: string, native: boolean, value: string, tokens = 0): DecisionModel {
  return model(id, native, (questions) => ({
    answers: Object.fromEntries(
      Object.keys(questions).map((key) => [
        key,
        { value, outcome: "answered" as const, source: `${id}/v1`, version: "q1-abc" },
      ]),
    ),
    usage: tokens ? [{ model: { provider: id, id: "v1" }, usage: { input: tokens } }] : [],
  }));
}

function failing(id: string, native: boolean, reason: string): DecisionModel {
  return model(id, native, (questions) => ({
    answers: Object.fromEntries(
      Object.entries(questions).map(([key, question]) => [
        key,
        failedAnswer(question, reason, "q1-abc", `${id}/v1`),
      ]),
    ),
    usage: [],
  }));
}

type RecordUsage = NonNullable<ConstructorParameters<typeof DecisionModels>[0]["recordUsage"]>;

function serviceWith(
  adapted: DecisionModel,
  native?: DecisionModel,
  settings: DecisionsSettings = DEFAULT_DECISIONS,
  recordUsage?: RecordUsage,
): DecisionModels {
  return new DecisionModels({
    settings: settingsPort(settings),
    adapted,
    ...(native ? { createNative: () => native } : {}),
    ...(recordUsage ? { recordUsage } : {}),
    ...(native ? KEY_PORT : {}),
  });
}

function settingsPort(
  initial: DecisionsSettings,
  initialUses: DecisionUseSwitches = {},
): {
  getDecisions(): DecisionsSettings;
  setDecisions(next: DecisionsSettings): void;
  getDecisionUses(): DecisionUseSwitches;
  setDecisionUses(next: DecisionUseSwitches): void;
} {
  let value = initial;
  let uses = initialUses;
  return {
    getDecisions: () => value,
    setDecisions: (next) => {
      value = next;
    },
    getDecisionUses: () => uses,
    setDecisionUses: (next) => {
      uses = next;
    },
  };
}

/** The stored key's value, distinctive so a view can be checked for it. */
const STORED_KEY = "ts-live-1234567890";

const KEY_PORT = {
  keys: {
    has: () => true,
    read: () => STORED_KEY,
    set: () => {},
    remove: () => {},
  },
};

const NATIVE_SETTINGS: DecisionsSettings = {
  version: 1,
  answerer: { kind: "native", id: "jev" },
  egress: { jev: { enabled: true, consentedVersion: DECISION_APPROVAL_VERSION } },
};

describe("DecisionModels", () => {
  it("uses the adapter by default, which is what the app already did", async () => {
    const answers = await serviceWith(answering("adapted", false, "left")).decide(
      { purpose: "test", use: "kind" },
      { facts: {} },
      { q: QUESTION },
      new AbortController().signal,
    );
    expect(answers.q).toMatchObject({ value: "left", outcome: "answered" });
  });

  it("stays on the adapter when the row names a native model that is not available", async () => {
    // Off by default is enforced in code, not by remembering to check: with
    // no native model there is no client, no endpoint and no request.
    const adapted = answering("adapted", false, "left");
    const answers = await new DecisionModels({
      settings: settingsPort(NATIVE_SETTINGS),
      adapted,
      ...KEY_PORT,
    }).decide(
      { purpose: "test", use: "kind" },
      { facts: {} },
      { q: QUESTION },
      new AbortController().signal,
    );
    expect(answers.q?.source).toBe("adapted/v1");
  });

  it("lets the adapter answer when a native model fails, and says so on the record", async () => {
    const answers = await serviceWith(
      answering("adapted", false, "left"),
      failing("jev", true, "rate-limited"),
      NATIVE_SETTINGS,
    ).decide(
      { purpose: "test", use: "kind" },
      { facts: {} },
      { q: QUESTION },
      new AbortController().signal,
    );
    expect(answers.q).toMatchObject({ value: "left", outcome: "answered", source: "adapted/v1" });
    expect(answers.q?.detail).toBe(
      "decision model jev failed: rate-limited; answered by adapted:adapted/v1",
    );
  });

  it("never throws: a model that does is still an abstention with a reason", async () => {
    const thrower: DecisionModel = {
      id: "adapted",
      native: false,
      decide: async () => {
        throw new Error("boom");
      },
    };
    const answers = await serviceWith(thrower).decide(
      { purpose: "test", use: "kind" },
      { facts: {} },
      { q: QUESTION },
      new AbortController().signal,
    );
    expect(answers.q).toMatchObject({ value: "unsure", outcome: "failed", reason: "error" });
  });

  it("spends under the caller's task, or under its purpose when there is no task", async () => {
    const recordUsage = vi.fn();
    const service = serviceWith(
      answering("adapted", false, "left", 120),
      undefined,
      DEFAULT_DECISIONS,
      recordUsage,
    );
    await service.decide(
      { purpose: "kind", use: "kind", taskId: "task-9" },
      { facts: {} },
      { q: QUESTION },
      new AbortController().signal,
    );
    await service.decide(
      { purpose: "fleet-sort", use: "kind" },
      { facts: {} },
      { q: QUESTION },
      new AbortController().signal,
    );
    expect(recordUsage.mock.calls[0]?.[0]).toMatchObject({ taskId: "task-9" });
    expect(recordUsage.mock.calls[1]?.[0]).toMatchObject({ taskId: "fleet-sort" });
  });

  it("keeps the last native answer on the row, and never a key", async () => {
    const service = new DecisionModels({
      settings: settingsPort(NATIVE_SETTINGS),
      adapted: answering("adapted", false, "left"),
      createNative: () => answering("jev", true, "right", 42),
      ...KEY_PORT,
    });
    await service.decide(
      { purpose: "test", use: "kind" },
      { facts: {} },
      { q: QUESTION },
      new AbortController().signal,
    );
    const row = service.view().natives.find((native) => native.id === "jev");
    expect(row).toMatchObject({ state: "ready", keyStored: true, consented: true });
    expect(row?.last).toMatchObject({ value: "right", tokens: 42 });
    // The view is pushed to the window and read by Settings: it carries
    // whether a key is stored, never the key.
    expect(JSON.stringify(service.view())).not.toContain(STORED_KEY);
  });

  it("says key rejected once, on the vendor's own 401 and nothing else", async () => {
    const notes: string[] = [];
    const service = new DecisionModels({
      settings: settingsPort(NATIVE_SETTINGS),
      adapted: answering("adapted", false, "left"),
      createNative: () => failing("jev", true, "key-rejected"),
      onNote: (text) => notes.push(text),
      ...KEY_PORT,
    });
    const ask = () =>
      service.decide(
        { purpose: "test", use: "kind" },
        { facts: {} },
        { q: QUESTION },
        new AbortController().signal,
      );
    await ask();
    await ask();
    expect(service.view().natives[0]?.state).toBe("key-rejected");
    // Once per key: a standing state the row already carries is not news
    // every time the tick comes round.
    expect(notes).toHaveLength(1);
  });

  it("a rate limit is transient: the row keeps saying ready", async () => {
    const service = new DecisionModels({
      settings: settingsPort(NATIVE_SETTINGS),
      adapted: answering("adapted", false, "left"),
      createNative: () => failing("jev", true, "rate-limited"),
      ...KEY_PORT,
    });
    await service.decide(
      { purpose: "test", use: "kind" },
      { facts: {} },
      { q: QUESTION },
      new AbortController().signal,
    );
    expect(service.view().natives[0]?.state).toBe("ready");
  });

  it("an unconsented or switched-off egress reaches no endpoint at all", async () => {
    const built: string[] = [];
    const off = (egress: DecisionsSettings["egress"]) =>
      new DecisionModels({
        settings: settingsPort({ ...NATIVE_SETTINGS, egress }),
        adapted: answering("adapted", false, "left"),
        createNative: () => {
          built.push("native");
          return answering("jev", true, "right");
        },
        ...KEY_PORT,
      });
    const egressCases: Array<DecisionsSettings["egress"]> = [
      {},
      { jev: { enabled: false, consentedVersion: DECISION_APPROVAL_VERSION } },
      { jev: { enabled: true } },
    ];
    for (const egress of egressCases) {
      const answers = await off(egress).decide(
        { purpose: "test", use: "kind" },
        { facts: {} },
        { q: QUESTION },
        new AbortController().signal,
      );
      expect(answers.q?.source).toBe("adapted/v1");
    }
    expect(built).toEqual([]);
  });

  it("removing a native model takes the key, the egress and the pick with it", async () => {
    const removed: string[] = [];
    const service = new DecisionModels({
      settings: settingsPort(NATIVE_SETTINGS),
      adapted: answering("adapted", false, "left"),
      createNative: () => answering("jev", true, "right"),
      keys: {
        has: () => removed.length === 0,
        read: () => (removed.length === 0 ? STORED_KEY : undefined),
        set: () => {},
        remove: (id) => removed.push(id),
      },
    });
    const view = service.removeKey("jev");
    expect(removed).toEqual(["jev"]);
    expect(view.settings.answerer).toEqual({ kind: "adapted", offering: "auto" });
    expect(view.settings.egress.jev).toBeUndefined();
    expect(view.natives[0]?.state).toBe("absent");
  });
});

it("does not move an unavailable named custom decision connection to another account", async () => {
  const selectAccount = vi.fn(() => "other-account");
  const runtimeFor = vi.fn(async () => {
    throw new Error("Must not bind another account");
  });
  const adapter = new AdaptedDecisionModel({
    homeDir: "/synthetic",
    availableModels: () => [{ provider: "xai", id: "grok-4.7", slot: "low" }],
    quotaModels: () => undefined,
    selectAccount,
    flagshipAccountId: () => null,
    runtimeFor,
    offering: () => "fm-custom-0123456789abcdef/operator-model",
    sessions: {
      pi: {
        backend: "pi",
        controlProfile: {
          steer: "native",
          interruptGranularity: "turn",
          quotaEvents: false,
          backgroundWork: "host",
          failureSignals: "text",
        },
        open: async () => {
          throw new Error("Must not open another account");
        },
      },
    },
  });
  const result = await adapter.decide(
    { purpose: "synthetic" },
    { facts: { text: "Synthetic question" } },
    { q: QUESTION },
    new AbortController().signal,
  );
  expect(result.answers.q).toMatchObject({ outcome: "failed", reason: "no-model" });
  expect(selectAccount).not.toHaveBeenCalled();
  expect(runtimeFor).not.toHaveBeenCalled();
});

describe("what a pinned offering comes to", () => {
  const PI_FACTORY = {
    pi: {
      backend: "pi" as const,
      controlProfile: {
        steer: "native" as const,
        interruptGranularity: "turn" as const,
        quotaEvents: false,
        backgroundWork: "host" as const,
        failureSignals: "text" as const,
      },
      open: async () => {
        throw new Error("Must not open a session to read a state");
      },
    },
  };

  function adapterServing(named: { provider: string; id: string }[]): AdaptedDecisionModel {
    return new AdaptedDecisionModel({
      homeDir: "/synthetic",
      // The slotted pool the walk reads: only the cheap model has a level.
      availableModels: () => [{ provider: "xai", id: "grok-cheap", slot: "low" }],
      namedModels: () => named,
      quotaModels: () => undefined,
      selectAccount: () => "acct_a",
      flagshipAccountId: () => null,
      runtimeFor: async () => {
        throw new Error("Must not bind an account to read a state");
      },
      sessions: PI_FACTORY,
    });
  }

  it("is ready while a signed-in account serves it, in use or not", () => {
    const adapter = adapterServing([
      { provider: "xai", id: "grok-cheap" },
      { provider: "xai", id: "grok-unslotted" },
    ]);
    expect(adapter.pinState("xai/grok-unslotted")).toBe("ready");
    expect(adapter.pinState("xai/grok-cheap")).toBe("ready");
  });

  it("falls back to the walk when nothing serves it, and holds a named custom connection", () => {
    const adapter = adapterServing([{ provider: "xai", id: "grok-cheap" }]);
    expect(adapter.pinState("xai/retired-model")).toBe("fallback");
    expect(adapter.pinState("fm-custom-0123456789abcdef/operator-model")).toBe("held");
    // A string that names no offering is the walk, as it is at the call.
    expect(adapter.pinState("not-an-offering")).toBe("fallback");
  });

  it("falls back for a served model whose backend has no session to answer on", () => {
    const adapter = adapterServing([{ provider: "anthropic-claude", id: "claude-haiku-4-5" }]);
    expect(adapter.pinState("anthropic-claude/claude-haiku-4-5")).toBe("fallback");
  });

  it("reaches the view only while a specific model is pinned", () => {
    const pinState = vi.fn((offering: string) =>
      offering === "xai/grok-unslotted" ? ("ready" as const) : ("fallback" as const),
    );
    const settings = settingsPort(DEFAULT_DECISIONS);
    const service = new DecisionModels({
      settings,
      adapted: answering("adapted", false, "left"),
      pinState,
    });
    expect(service.view()).not.toHaveProperty("pinned");
    expect(pinState).not.toHaveBeenCalled();

    const pin = (offering: string) =>
      service.setSettings({ ...DEFAULT_DECISIONS, answerer: { kind: "adapted", offering } });
    expect(pin("xai/grok-unslotted").pinned).toBe("ready");
    expect(pin("xai/retired-model").pinned).toBe("fallback");
    expect(
      service.setSettings({ ...NATIVE_SETTINGS, answerer: { kind: "native", id: "jev" } }),
    ).not.toHaveProperty("pinned");
  });
});

/**
 * Intent: the approved correction plan expands the fact set only after
 * explicit permission, never through a native-provider fallback or old view.
 * The in-memory model port records actual dispatches; it does not pretend
 * to establish live classification quality. This service owns the gate.
 */
describe("the uses' switches", () => {
  const replyCheck = { purpose: "Reply checks", use: "reply-checks" as const };
  const state = {
    facts: {
      latest_captain_reply:
        "For later work in this project, propose the exact wording before keeping it.",
    },
  };
  const signal = () => new AbortController().signal;
  const ask = (service: DecisionModels) =>
    service.decide(replyCheck, state, { q: WITH_ABSTAIN }, signal());
  /** A person who turned Jev on from the first approval screen. */
  const OLD_JEV: DecisionsSettings = {
    ...NATIVE_SETTINGS,
    egress: { jev: { enabled: true, consentedVersion: DECISION_FIRST_APPROVAL_VERSION } },
  };

  it("asks no model while reply checks are off, and asks again once they are on", async () => {
    // Intent: the captain's plan - turning reply checks off stops new checks.
    const adapted = answering("adapted", false, "left");
    const dispatch = vi.spyOn(adapted, "decide");
    const service = serviceWith(adapted);
    expect((await ask(service)).q?.source).toBe("adapted/v1");
    service.setUse({ id: "reply-checks", on: false });
    expect(service.allowsUse("reply-checks")).toBe(false);
    expect((await ask(service)).q).toMatchObject({
      value: "unsure",
      outcome: "failed",
      reason: "use-off",
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    service.setUse({ id: "reply-checks", on: true });
    expect((await ask(service)).q?.source).toBe("adapted/v1");
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("refuses to turn task classification off, and keeps it on an older Jev approval", async () => {
    // Intent: the captain asked that a mandated use such as task
    // classification cannot be switched off, and that an older approval keeps it working.
    const service = serviceWith(
      answering("adapted", false, "left"),
      answering("jev", true, "right"),
      OLD_JEV,
    );
    expect(() => service.setUse({ id: "kind", on: false })).toThrow(/always on/);
    expect(service.view().uses?.find((use) => use.id === "kind")?.on).toBe(true);
    const answers = await service.decide(
      { purpose: "kind", use: "kind" },
      { facts: { title: "Add a toolbar" } },
      { q: QUESTION },
      signal(),
    );
    expect(answers.q?.source).toBe("jev/v1");
  });

  it("holds reply checks under an older Jev approval, asking no model, until the person allows them once", async () => {
    // Intent: the captain asked that people who turned Jev on under the old
    // approval screen get reply checks off until they consent, and that the
    // checks never fall back to their own models meanwhile.
    const adapted = answering("adapted", false, "left");
    const dispatch = vi.spyOn(adapted, "decide");
    const readKey = vi.fn(() => STORED_KEY);
    const settings = settingsPort(OLD_JEV);
    const service = new DecisionModels({
      settings,
      adapted,
      createNative: () => answering("jev", true, "right"),
      keys: { ...KEY_PORT.keys, read: readKey },
    });
    expect(service.view().uses?.find((use) => use.id === "reply-checks")).toMatchObject({
      on: false,
      needsApproval: true,
    });
    expect((await ask(service)).q?.reason).toBe("use-off");
    expect(dispatch).not.toHaveBeenCalled();
    expect(readKey).not.toHaveBeenCalled();

    // The dialog's OK names the screen it showed; never past this home's own.
    const view = service.setUse({
      id: "reply-checks",
      on: true,
      approve: DECISION_APPROVAL_VERSION + 1,
    });
    expect(view.settings.egress.jev).toEqual({
      enabled: true,
      consentedVersion: DECISION_APPROVAL_VERSION,
    });
    expect(view.uses?.find((use) => use.id === "reply-checks")).toMatchObject({
      on: true,
      needsApproval: false,
    });
    expect((await ask(service)).q?.source).toBe("jev/v1");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("lets the person's own models answer for a Jev or OpenRouter model approved on the new screen", async () => {
    // Intent: the new approval screen says the person's own models answer
    // when the decision model cannot, for every use.
    const offering = {
      id: "typesafe/jev-1.13",
      name: "Jev 1.13",
      vendor: "TypeSafe",
      inputPrice: 0.042,
    };
    const adapted = answering("adapted", false, "left");
    const create = vi.fn(() => failing("openrouter", true, "no-credit"));
    const service = new DecisionModels({
      settings: settingsPort({
        ...DEFAULT_DECISIONS,
        answerer: { kind: "openrouter", model: offering.id },
        egress: { openrouter: { enabled: true, consentedVersion: DECISION_APPROVAL_VERSION } },
      }),
      adapted,
      openrouter: { models: () => [offering], signedIn: () => true, create },
    });
    expect((await ask(service)).q).toMatchObject({ source: "adapted/v1", outcome: "answered" });
    expect(create).toHaveBeenCalledExactlyOnceWith(offering.id);
  });

  it("does not send a new fallback call after reply checks are turned off during the first call", async () => {
    // Intent: the captain's plan - turning reply checks off stops new checks;
    // a request already sent cannot be unsent.
    const settings = settingsPort(NATIVE_SETTINGS);
    const adapted = answering("adapted", false, "left");
    const dispatch = vi.spyOn(adapted, "decide");
    const native = model("jev", true, (questions) => {
      settings.setDecisionUses({ "reply-checks": { on: false } });
      return {
        answers: { q: failedAnswer(questions.q as DecisionQuestion, "rate-limited", "test") },
        usage: [],
      };
    });
    const service = new DecisionModels({
      settings,
      adapted,
      createNative: () => native,
      ...KEY_PORT,
    });
    expect((await ask(service)).q?.reason).toBe("use-off");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("records a key call or an older view's write as the first approval screen", () => {
    // Intent: the captain's version rule - an approval made from an older
    // computer counts as old.
    const service = serviceWith(
      answering("adapted", false, "left"),
      answering("jev", true, "right"),
      { ...DEFAULT_DECISIONS, answerer: { kind: "native", id: "jev" } },
    );
    const view = service.setKey("jev", STORED_KEY);
    expect(view.stateVersion).toBe(DECISION_FIRST_APPROVAL_VERSION);
    expect(view.approvalVersion).toBe(DECISION_APPROVAL_VERSION);
    expect(view.settings.egress.jev?.consentedVersion).toBe(DECISION_FIRST_APPROVAL_VERSION);
    expect(view.uses?.find((use) => use.id === "reply-checks")?.needsApproval).toBe(true);
  });
});
