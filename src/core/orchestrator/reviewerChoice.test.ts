import type { DecisionAnswer } from "@shared/decisions";
import { describe, expect, it, vi } from "vitest";
import {
  askReviewerChoice,
  type ReviewerChoiceInput,
  type ReviewerChoiceModel,
  type ReviewerChoiceModels,
  readReviewerPick,
  reviewerChoiceOptions,
} from "./reviewerChoice";

// INF-5021's approved plan: the decision model's answer becomes a pick only
// as the plan says - a model a direction calls for, a wait only for a model
// that cannot review now and a direction that says to wait, else the usual pick.

const sol: ReviewerChoiceModel = {
  key: "openai-codex/gpt-6.2-sol",
  name: "GPT-6.2 Sol",
  levels: ["high"],
};
const opus: ReviewerChoiceModel = {
  key: "anthropic-claude/claude-opus-5-5",
  name: "Opus 5.5",
  levels: ["high"],
  miss: "its allowance is spent",
};
const models = [sol, opus];
const idOf = (model: ReviewerChoiceModel) =>
  reviewerChoiceOptions(models).find((option) => option.key === model.key)?.id as string;
const answered = (value: string): DecisionAnswer => ({
  value,
  outcome: "answered",
  source: "jev/jev-1",
  version: "rv1-test",
});

describe("readReviewerPick", () => {
  it("prefers the model a direction calls for when it can review now", () => {
    expect(readReviewerPick(models, { reviewer: answered(idOf(sol)) })).toEqual({
      mode: "prefer",
      key: sol.key,
      source: "jev/jev-1",
    });
  });

  it("waits for a model that cannot review now only when the second answer says wait, else keeps it as a preference with why", () => {
    expect(
      readReviewerPick(models, { reviewer: answered(idOf(opus)), ifNotNow: answered("wait") }),
    ).toEqual({ mode: "wait", key: opus.key, why: opus.miss, source: "jev/jev-1" });
    expect(
      readReviewerPick(models, { reviewer: answered(idOf(opus)), ifNotNow: answered("usual") }),
    ).toEqual({ mode: "prefer", key: opus.key, why: opus.miss, source: "jev/jev-1" });
  });

  it("leaves the usual pick for usual, an abstention or a failed call", () => {
    expect(readReviewerPick(models, { reviewer: answered("usual") })).toBeUndefined();
    expect(
      readReviewerPick(models, {
        reviewer: { value: "unsure", outcome: "abstained", version: "rv1-test" },
      }),
    ).toBeUndefined();
    expect(
      readReviewerPick(models, {
        reviewer: { value: "unsure", outcome: "failed", reason: "timeout", version: "rv1-test" },
      }),
    ).toBeUndefined();
  });
});

describe("askReviewerChoice", () => {
  const input: ReviewerChoiceInput = {
    builder: {
      title: "Fix the merge card's checks strip",
      goal: "The checks strip shows the newest run.",
      delivers: "change",
      project: "infinitary",
      model: "Opus 5.5",
      rigor: "Default",
    },
    started: "first-mate",
    usual: "GPT-6.2 Sol (openai-codex/gpt-6.2-sol)",
    directions: ["Independent reviews run on GPT-6.2 Sol."],
    models,
  };
  const decider = (allowed: boolean) => {
    const decide = vi.fn(async () => ({ reviewer: answered(idOf(sol)) }));
    const reader: ReviewerChoiceModels = { allowsUse: () => allowed, decide };
    return { reader, decide };
  };

  it("asks with the directions and reads the pick", async () => {
    const { reader, decide } = decider(true);
    const pick = await askReviewerChoice(reader, "t1", input, new AbortController().signal);
    expect(pick).toMatchObject({ mode: "prefer", key: sol.key });
    expect(decide).toHaveBeenCalledOnce();
  });

  it("asks nothing with no standing directions, no models or the use switched off", async () => {
    const signal = new AbortController().signal;
    for (const [allowed, asked] of [
      [true, { ...input, directions: [] }],
      [true, { ...input, models: [] }],
      [false, input],
    ] as const) {
      const { reader, decide } = decider(allowed);
      expect(await askReviewerChoice(reader, "t1", asked, signal)).toBeUndefined();
      expect(decide).not.toHaveBeenCalled();
    }
  });
});
