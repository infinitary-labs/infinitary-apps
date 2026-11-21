import type { PlacedSpec } from "@shared/work";
import { expect, it, vi } from "vitest";
import { askReopen, type ReopenProgress, reopenedSpec } from "./placedSpecs";

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
    openedThere: false,
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
