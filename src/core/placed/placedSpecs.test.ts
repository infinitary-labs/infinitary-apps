import type { PlacedSpec } from "@shared/work";
import { expect, it, vi } from "vitest";
import { askReopen, openOutcome, type ReopenProgress, reopenedSpec } from "./placedSpecs";

const STARTER = { provider: "openai-codex", id: "gpt-6.1-starter" };

/** The spec a reopen asks an older computer for, on the model the task had. */
const asked = {
  model: STARTER,
  binding: { backend: "pi", accountId: "acct_codex" },
  thinking: { level: "medium" },
  tools: ["report"],
  instructions: "Fix the footer.",
} as unknown as PlacedSpec;

// INF-5438 round 10 finding 8: an older computer believed to hold the task's
// conversation may open anew instead of reattaching, so what it answers is
// marked refused before it is asked and checked as opened anew: when the
// starter left every level while that open was asked, it takes no words.
it("checks what an older computer holding the conversation answers as opened anew", async () => {
  const progress: ReopenProgress = { asked, anew: false };
  const creating = vi.fn();
  const answer = await askReopen(progress, {
    reattachOnly: false,
    held: true,
    refused: false,
    ours: () => true,
    ask: async () => ({ state: { model: STARTER } }),
    route: async () => undefined,
    letGo: vi.fn(),
    creating,
  });
  expect(answer).toEqual({ state: { model: STARTER } });
  expect(creating).toHaveBeenCalledOnce();
  const letGo = vi.fn();
  const kept = vi.fn(async () => false);
  expect(
    await reopenedSpec(
      progress,
      { model: STARTER },
      { ours: () => true, letGo, refuse: vi.fn(), kept },
    ),
  ).toBe(false);
  expect(kept).toHaveBeenCalledOnce();
  expect(letGo).toHaveBeenCalledOnce();
});

// INF-5438 round 11 finding 6: an older computer that opened the conversation
// again by itself during a cleanup answers it before the home routed it; with
// routing keeping the model, that conversation is still checked as opened
// anew - marked refused first, and let go when the model left every level
// meanwhile - never taken as open without a check.
it("checks a conversation an older computer opened again by itself as opened anew", async () => {
  const progress: ReopenProgress = { asked, anew: false };
  const creating = vi.fn();
  const ask = vi.fn(async () => ({ state: { model: STARTER } }));
  const answer = await askReopen(progress, {
    reattachOnly: false,
    openedThere: { state: { model: STARTER } },
    held: true,
    refused: false,
    ours: () => true,
    ask,
    route: async () => undefined,
    letGo: vi.fn(),
    creating,
  });
  expect(answer).toEqual({ state: { model: STARTER } });
  expect(ask).not.toHaveBeenCalled();
  expect(creating).toHaveBeenCalledOnce();
  expect(progress.anew).toBe(true);
  const letGo = vi.fn();
  expect(
    await reopenedSpec(
      progress,
      { model: STARTER },
      { ours: () => true, letGo, refuse: vi.fn(), kept: async () => false },
    ),
  ).toBe(false);
  expect(letGo).toHaveBeenCalledOnce();
});

// INF-5438 round 11 finding 7: an open's answer is read as exactly one
// outcome; an empty answer, or one the home did not ask for, says nothing
// sure about what opened there and is never leave to open anew.
it("reads an open's answer only as its state, an asked-for needsOpen or an asked-for notOpened", () => {
  const state = { model: STARTER };
  expect(openOutcome({ state }, {})).toEqual({ state });
  expect(openOutcome({ needsOpen: true }, { reattach: true })).toEqual({ needsOpen: true });
  expect(openOutcome({ notOpened: "no sign-in" }, { notOpened: true })).toEqual({
    notOpened: "no sign-in",
  });
  expect(() => openOutcome({}, { reattach: true, notOpened: true })).toThrow("nothing sure");
  expect(() => openOutcome({ needsOpen: true }, {})).toThrow("nothing sure");
  expect(() => openOutcome({ notOpened: "no sign-in" }, {})).toThrow("nothing sure");
  expect(() => openOutcome({ state, needsOpen: true }, { reattach: true })).toThrow("nothing sure");
});
