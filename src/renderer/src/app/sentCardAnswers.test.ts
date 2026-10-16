import type { Card, CardAnswer } from "@shared/cards";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useShellStore } from "./store";
import { unsentAnswers } from "./unsentAnswers";

const card: Card = {
  id: "sent",
  title: "Settings",
  body: "<p>Choose</p>",
  author: "firstmate",
  meta: "firstmate",
  createdAt: 1,
  priority: 50,
  status: "ready",
  actions: [{ id: "more", label: "More" }],
};
const old: CardAnswer[] = [{ name: "tone", values: ["warm"], changed: true }];
const answers: CardAnswer[] = [{ name: "tone", values: ["plain"], changed: true }];
const reading = { answered: 1, of: 1, changed: 1, picked: 1, answers };
const state = () => useShellStore.getState();
const reset = () =>
  useShellStore.setState({
    cards: [card],
    cardAnswers: { sent: reading },
    sentCardAnswers: {},
    threads: {},
    threadsLoaded: {},
    replyDrafts: {},
    replyImages: {},
    replyPastes: {},
    sendingReplies: {},
    pendingCardActions: {},
    thisMac: null,
  });
beforeEach(reset);
afterEach(() => {
  reset();
  vi.unstubAllGlobals();
});

it("keeps refused footer answers unsent and clears their baseline when the choice closes", async () => {
  const act = vi.fn().mockResolvedValueOnce({ refusal: "Try again" }).mockResolvedValue({});
  vi.stubGlobal("window", { infinitary: { cards: { act } } });
  state().applyThread("sent", [
    { id: 1, cardId: "sent", who: "captain", at: 1, text: "Old", answers: old },
  ]);
  await state().actOnCard("sent", "more", "chrome", undefined, async () => reading);
  expect(state().sentCardAnswers.sent).toEqual(old);
  await state().actOnCard("sent", "more", "chrome", undefined, async () => reading);
  expect(act).toHaveBeenLastCalledWith("sent", "more", "chrome", { answers }, expect.anything());
  expect(state().cards).toEqual([]);
  expect(state().sentCardAnswers.sent).toBeUndefined();
});

it("advances the reply baseline only on acceptance and recovers saved reply answers", async () => {
  const reply = vi
    .fn()
    .mockRejectedValueOnce(new Error("Not sent"))
    .mockResolvedValue({
      cardId: "sent",
      messages: [{ id: 2, cardId: "sent", who: "captain", at: 2, text: "Use these", answers }],
    });
  vi.stubGlobal("window", {
    infinitary: { cards: { reply }, app: { firstRun: async () => null } },
  });
  state().setReplyDraft("sent", "Use these");
  await state().sendReply("sent", async () => reading);
  expect(state().sentCardAnswers.sent).toBeUndefined();
  await state().sendReply("sent", async () => reading);
  expect(state().sentCardAnswers.sent).toEqual(answers);
  const messages = state().threads.sent ?? [];
  reset();
  state().applyThread("sent", messages);
  expect(unsentAnswers(card, reading, state().sentCardAnswers.sent)).toBe(0);
});
