import { AUTOMATIC_EMOTE_WORDS } from "@shared/emotes";
import { describe, expect, it } from "vitest";
import { replyLine, startedReply } from "./replyLine";

// INF-772's plan, the captain's Approve and build: the closing words first,
// today's typed line as the fallback, and no line when nothing took effect.
describe("the reply line beside the captain's last message", () => {
  it("is the turn's closing words whenever something took effect", () => {
    const closing = "Started the alpha release.";
    for (const facts of [
      { acted: true },
      { latest: "Cut the alpha?", acted: true },
      { app: startedReply("Promote the alpha"), acted: true },
      { app: AUTOMATIC_EMOTE_WORDS.tuck },
    ]) {
      expect(replyLine({ ...facts, closing })).toBe(closing);
    }
  });

  it("keeps the closing words on one line, cutting none of them", () => {
    expect(replyLine({ closing: "  Filed INF-9.\n\nStarted it. ", acted: true })).toBe(
      "Filed INF-9. Started it.",
    );
  });

  it("falls back to the typed line when the turn closed with no words", () => {
    for (const closing of [undefined, "", " \n "]) {
      expect(replyLine({ closing, latest: "Cut the alpha?", app: "Noted", acted: true })).toBe(
        "Cut the alpha?",
      );
      expect(replyLine({ closing, app: startedReply("Promote the alpha"), acted: true })).toBe(
        "Started: Promote the alpha",
      );
      expect(replyLine({ closing, acted: true })).toBe("Got it");
    }
  });

  it("shows no line when nothing took effect, whatever the closing words say", () => {
    expect(replyLine({ closing: "The alpha is 1.4-alpha.2." })).toBeUndefined();
    expect(replyLine({})).toBeUndefined();
  });
});
