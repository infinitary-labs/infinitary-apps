import type { ModelsCatalogView } from "@shared/quota";
import { describe, expect, it } from "vitest";
import { FAKE_CONTROL_PROFILE, fakeSession } from "../../../tests/helpers/fakeSession";
import type { ModelRuntime } from "../pi/types";
import type { ModelSession, SessionEvent, SessionSpec } from "../session/session";
import { AdaptedDecisionModel } from "./decisionModel";
import { tagQuestions, tagState } from "./tagQuestion";

/**
 * Piece 2 of the task tags plan: the tagging question is one yes-or-no
 * question per tag built from the tag's name and description, and the
 * person's own models answer the whole set in one call when the asker
 * requests it, where a missing or unreadable line fails only its own
 * question. Every existing use keeps one call per question.
 */

// Three of the tags the captain confirmed for this project.
const TAGS = [
  {
    name: "windows",
    description:
      "The app on a Windows PC: its installer, how it behaves there, or the Windows checks.",
  },
  {
    name: "bug",
    description:
      "Something in the app works wrongly for a person using it: a crash, a freeze, a wrong or missing result, lost data, or a view that breaks.",
  },
  {
    name: "ios",
    description: "The iPhone and iPad app: how it looks and behaves, its checks, or its builds.",
  },
];

const TASK = tagState({
  project: "infinitary",
  title: "Reproduce the Windows unsupported Codex model error",
  goal: "Reproduce why the first mate on the Windows PC picks a model its Codex account cannot use and fails, and find what differs from the Mac.",
});

const RUNTIME = { kind: "runtime" } as unknown as ModelRuntime;
const CATALOG = {
  models: [{ provider: "grok", id: "grok-cheap", effectivePercentRemaining: 80 }],
  at: 0,
} as unknown as ModelsCatalogView;

/** An adapter whose every session answers the next reply in `replies`. */
function adapterReplying(replies: string[]) {
  const opened: SessionSpec[] = [];
  const prompts: string[] = [];
  const adapter = new AdaptedDecisionModel({
    homeDir: "/tmp/fm-home",
    availableModels: () => [{ provider: "xai", id: "grok-cheap", slot: "low" }],
    quotaModels: () => CATALOG,
    selectAccount: () => "acct_a",
    flagshipAccountId: () => null,
    runtimeFor: async () => RUNTIME,
    baseRuntime: RUNTIME,
    sessions: {
      pi: {
        backend: "pi",
        controlProfile: FAKE_CONTROL_PROFILE,
        open: async (spec) => {
          opened.push(spec);
          return replying(replies.shift() ?? "", prompts);
        },
      },
    },
  });
  return { adapter, opened, prompts };
}

function replying(text: string, prompts: string[]): ModelSession {
  const listeners: Array<(event: SessionEvent) => void> = [];
  return {
    ...fakeSession({ sessionId: "tag-1" }),
    isStreaming: () => false,
    subscribe: (listener) => {
      listeners.push(listener);
      return () => {};
    },
    prompt: async (input: string) => {
      prompts.push(input);
      for (const event of [
        { type: "turn_end", taskId: "firstmate" },
        { type: "turn_closed", text },
      ] as SessionEvent[]) {
        for (const listener of listeners) listener(event);
      }
    },
    abort: async () => {},
    dispose: () => {},
  };
}

describe("the tagging question", () => {
  it("asks one yes-or-no question per tag, in name order, from its name and description", () => {
    const { questions, ids } = tagQuestions(TAGS);
    expect(ids).toEqual({ tag1: "bug", tag2: "ios", tag3: "windows" });
    expect(questions.tag3?.instructions).toContain('"windows"');
    expect(questions.tag3?.instructions).toContain(
      "The app on a Windows PC: its installer, how it behaves there, or the Windows checks.",
    );
    expect(Object.keys(questions.tag3?.criteria ?? {})).toEqual(["yes", "no"]);
    expect(questions.tag3?.abstain).toBe("unsure");
  });
});

describe("a set asked in one call on the person's own models", () => {
  it("opens one session, with room for a line per question, and reads each line", async () => {
    const { questions } = tagQuestions(TAGS);
    const { adapter, opened, prompts } = adapterReplying(["tag1: yes\ntag2: no\ntag3: yes"]);
    const run = await adapter.decide(
      { purpose: "tags", together: true },
      TASK,
      questions,
      new AbortController().signal,
    );
    expect(opened).toHaveLength(1);
    expect(prompts).toEqual([TASK.adapterText]);
    expect(opened[0]?.bounds?.request?.maxOutputTokens).toBeUndefined();
    expect(run.answers.tag1).toMatchObject({ value: "yes", outcome: "answered" });
    expect(run.answers.tag2).toMatchObject({ value: "no", outcome: "answered" });
    expect(run.answers.tag3).toMatchObject({ value: "yes", outcome: "answered" });
  });

  it("fails only the question whose line is missing or unreadable", async () => {
    const { questions } = tagQuestions(TAGS);
    const { adapter, opened } = adapterReplying(["tag1: unsure\ntag3: maybe"]);
    const run = await adapter.decide(
      { purpose: "tags", together: true },
      TASK,
      questions,
      new AbortController().signal,
    );
    expect(opened).toHaveLength(1);
    expect(run.answers.tag1).toMatchObject({ value: "unsure", outcome: "abstained" });
    expect(run.answers.tag2).toMatchObject({ outcome: "failed", reason: "unparsed" });
    expect(run.answers.tag3).toMatchObject({ outcome: "failed", reason: "unparsed" });
  });

  it("keeps one call per question, each served alone, when the asker does not request one call", async () => {
    const { questions } = tagQuestions(TAGS.slice(0, 2));
    const { adapter, opened } = adapterReplying(["yes", "no"]);
    const run = await adapter.decide(
      { purpose: "tags" },
      TASK,
      questions,
      new AbortController().signal,
    );
    expect(opened).toHaveLength(2);
    expect(opened[0]?.instructions.base).toContain('"bug"');
    expect(opened[0]?.instructions.base).not.toContain('"windows"');
    expect(opened[0]?.bounds?.request?.maxOutputTokens).toBeDefined();
    expect(run.answers.tag1).toMatchObject({ value: "yes", outcome: "answered" });
    expect(run.answers.tag2).toMatchObject({ value: "no", outcome: "answered" });
  });
});
