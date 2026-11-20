import { CARD_REPLY_MAX_CHARS } from "@shared/cards";
import * as m from "@shared/i18n/messages.generated";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useShellStore } from "../app/store";
import { card, DECIDE, picture, resetShell } from "../app/storeTestKit";
import { returnWordsOf } from "./returnWords";

/**
 * What Return control carries from the docked request's field. The captain's
 * choice on INF-4587's review: "Both: the plain limit line and pictures
 * sent as a reply".
 */
describe("returnWordsOf", () => {
  const state = () => useShellStore.getState();
  const ask = card({
    id: "ask",
    status: "ready",
    actions: DECIDE,
    author: "crewmate",
    taskId: "t1",
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetShell();
  });

  it("carries the field's words alone when it holds nothing else", async () => {
    state().applyCards([ask]);
    state().setReplyDraft("ask", "  Signed in.  ");
    expect(await returnWordsOf("ask")).toEqual({ words: "Signed in." });
  });

  it("holds the return with a plain line when the words are past a reply's limit", async () => {
    const reply = vi.fn();
    vi.stubGlobal("window", { infinitary: { cards: { reply } } });
    state().applyCards([ask]);
    state().setReplyDraft("ask", "a".repeat(CARD_REPLY_MAX_CHARS + 1));
    state().attachReplyImages("ask", [picture("page")]);
    expect(await returnWordsOf("ask")).toEqual({ refusal: m.cardBrowserReturnWordsTooLong() });
    expect(reply).not.toHaveBeenCalled();
  });

  it("sends a picture with its words as an ordinary reply first, so the return carries none", async () => {
    const reply = vi.fn(async (cardId: string, _payload: unknown) => ({ cardId, messages: [] }));
    vi.stubGlobal("window", { infinitary: { cards: { reply } } });
    state().applyCards([ask]);
    state().setReplyDraft("ask", "This is the form I see.");
    state().attachReplyImages("ask", [picture("page")]);
    expect(await returnWordsOf("ask")).toEqual({ words: "" });
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]?.[1]).toMatchObject({
      text: "This is the form I see.",
      images: [{ mimeType: "image/png", data: "page" }],
    });
  });

  it("keeps the browser when the reply is refused, the field as it was", async () => {
    const reply = vi.fn(async () => {
      throw new Error("Card is closed");
    });
    vi.stubGlobal("window", { infinitary: { cards: { reply } } });
    state().applyCards([ask]);
    state().setReplyDraft("ask", "Look at this.");
    state().attachReplyImages("ask", [picture("page")]);
    expect(await returnWordsOf("ask")).toEqual({ held: true });
    expect(state().replyDrafts.ask).toBe("Look at this.");
  });
});
