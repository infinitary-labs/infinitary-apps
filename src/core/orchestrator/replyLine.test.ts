import { AUTOMATIC_EMOTE_WORDS } from "@shared/emotes";
import { describe, expect, it } from "vitest";
import { replyLine, startedReply } from "./replyLine";

describe("the reply line beside the captain's last message", () => {
  it("uses the latest authored reply", () => {
    const facts = { latest: "On it", acted: true, thread: "A card thread" };
    expect(replyLine(facts)).toBe("On it");
    facts.latest = "The alpha is cut";
    expect(replyLine(facts)).toBe("The alpha is cut");
    facts.latest = AUTOMATIC_EMOTE_WORDS.tuck;
    expect(replyLine(facts)).toBe("Noted");
  });

  it("says what happened when work started", () => {
    expect(startedReply("Promote the alpha")).toBe("Started: Promote the alpha");
    expect(replyLine({ app: startedReply("Promote the alpha"), acted: true })).toBe(
      "Started: Promote the alpha",
    );
  });

  it("puts authored words ahead of every app-written reply", () => {
    for (const app of [
      startedReply("Promote the alpha"),
      ...Object.values(AUTOMATIC_EMOTE_WORDS),
    ]) {
      expect(replyLine({ latest: "Started the release", app, acted: true })).toBe(
        "Started the release",
      );
    }
    expect(replyLine({ app: "Noted", thread: "A card thread", acted: true })).toBe("Noted");
  });

  it("uses a words-only card thread or Got it only when nothing else replied", () => {
    expect(replyLine({ thread: "The alpha is cut", acted: true })).toBe("The alpha is cut");
    expect(replyLine({ acted: true })).toBe("Got it");
    expect(replyLine({})).toBeUndefined();
  });
});
