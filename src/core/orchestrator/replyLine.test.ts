import { AUTOMATIC_EMOTE_WORDS } from "@shared/emotes";
import { describe, expect, it } from "vitest";
import { replyLine, replyWords, startedReply } from "./replyLine";

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

// INF-1103, the captain's Approve and build on INF-1102's plan: the reply
// note shows the words "As the first mate wrote them, with their line breaks".
describe("the reply's words as written, for the reply note", () => {
  it("keeps the closing words' line breaks when they are the line", () => {
    const closing =
      "I've started a read-only crewmate. It's looking at:\n- which Linux checks run today;\n- the security risk.\n";
    expect(replyWords({ closing, acted: true })).toBe(closing.trim());
    expect(replyLine({ closing, acted: true })).toBe(
      "I've started a read-only crewmate. It's looking at: - which Linux checks run today; - the security risk.",
    );
  });

  it("keeps nothing when the line already says it, or the line is not the closing words", () => {
    expect(replyWords({ closing: " Filed INF-9. ", acted: true })).toBeUndefined();
    expect(replyWords({ closing: " \n ", latest: "Cut the alpha?", acted: true })).toBeUndefined();
    expect(replyWords({ closing: "Line one.\nLine two." })).toBeUndefined();
  });
});
