import { afterEach, expect, it, vi } from "vitest";
import { DECIDE_TIMEOUT_MS } from "./decisionModel";
import { OpenRouterDecisionModel } from "./openRouterDecisionModel";

const questions = {
  kind: {
    type: "choice" as const,
    instructions: "Which kind?",
    criteria: { fix: "fix", chore: "chore" },
    abstain: "unclear",
    version: "test",
  },
};
afterEach(() => vi.restoreAllMocks());

it("honors caller cancellation while the selected account runtime is still being built", async () => {
  const runtimeFor = vi.fn(() => new Promise<never>(() => {}));
  const model = new OpenRouterDecisionModel({
    model: "typesafe/jev-1.13",
    selectAccount: () => "acct",
    runtimeFor,
  });
  const controller = new AbortController();
  const pending = model.decide(
    { purpose: "kind" },
    { facts: { title: "fix" } },
    questions,
    controller.signal,
  );
  expect(runtimeFor).toHaveBeenCalledWith("acct");
  controller.abort();
  expect((await pending).answers.kind).toMatchObject({
    value: "unclear",
    outcome: "failed",
    reason: "aborted",
  });
});

// Finding A makes account selection asynchronous; cancellation must still prevent runtime construction.
it("does not construct a runtime after cancellation overtakes account selection", async () => {
  let selected!: (account: string) => void;
  const account = new Promise<string>((resolve) => {
    selected = resolve;
  });
  const runtimeFor = vi.fn(() => new Promise<never>(() => {}));
  const model = new OpenRouterDecisionModel({
    model: "typesafe/jev-1.13",
    selectAccount: () => account,
    runtimeFor,
  });
  const controller = new AbortController();
  const pending = model.decide(
    { purpose: "kind" },
    { facts: { title: "fix" } },
    questions,
    controller.signal,
  );
  controller.abort();
  expect((await pending).answers.kind?.reason).toBe("aborted");
  selected("acct");
  await account;
  expect(runtimeFor).not.toHaveBeenCalled();
});

it("bounds runtime construction as well as the request to fifteen seconds", async () => {
  const deadline = new AbortController();
  const clock = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  const model = new OpenRouterDecisionModel({
    model: "typesafe/jev-1.13",
    selectAccount: () => "acct",
    runtimeFor: () => new Promise<never>(() => {}),
  });
  const pending = model.decide(
    { purpose: "kind" },
    { facts: {} },
    questions,
    new AbortController().signal,
  );
  expect(clock).toHaveBeenCalledWith(DECIDE_TIMEOUT_MS);
  deadline.abort(new DOMException("Test deadline", "TimeoutError"));
  expect((await pending).answers.kind).toMatchObject({
    value: "unclear",
    outcome: "failed",
    reason: "timeout",
  });
});

it("does not select an account for an already expired caller deadline", async () => {
  const selectAccount = vi.fn(() => "acct");
  const model = new OpenRouterDecisionModel({
    model: "typesafe/jev-1.13",
    selectAccount,
    runtimeFor: () => new Promise<never>(() => {}),
  });
  const caller = new AbortController();
  caller.abort(new DOMException("Caller deadline", "TimeoutError"));
  const run = await model.decide({ purpose: "kind" }, { facts: {} }, questions, caller.signal);
  expect(run.answers.kind?.reason).toBe("timeout");
  expect(selectAccount).not.toHaveBeenCalled();
});
