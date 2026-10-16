import type { AttachmentRef } from "@shared/attachments";
import { describe, expect, it } from "vitest";
import { isCaptainGuidance } from "./mergeAuthorization";
import {
  GUIDANCE_MARK_WORDS,
  renderWake,
  replyWordsSpan,
  rowAttachments,
  type TypedWake,
  withAttachmentsKept,
  withGuidanceMark,
} from "./wakes";

describe("the captain's guidance on a kept merge (FI3-662)", () => {
  const reply: TypedWake = {
    facts: {
      kind: "thread-reply",
      card: { id: "card-1", title: "Rename it?" },
      words: "Keep its name.",
    },
  };

  it("is read from who sent a steer and its typed kind, never from the words", () => {
    // His reply, his choice and his ask to explain a card are his guidance.
    expect(isCaptainGuidance({ actor: "captain" }, reply)).toBe(true);
    expect(
      isCaptainGuidance(
        { actor: "captain" },
        {
          facts: {
            kind: "card-choice",
            to: "crewmate",
            source: "chrome",
            card: { title: "Rename it?" },
            choice: { id: "keep", label: "Keep the name" },
          },
        },
      ),
    ).toBe(true);
    expect(
      isCaptainGuidance(
        { actor: "captain" },
        { facts: { kind: "crewmate-tab-line", words: "Keep its name." } },
      ),
    ).toBe(true);
    // The Firstmate's steer is his guidance only in a turn that carries his words.
    expect(isCaptainGuidance({ actor: "firstmate", captainWords: true }, "Keep it.")).toBe(true);
    expect(isCaptainGuidance({ actor: "firstmate" }, "Bring it up to date.")).toBe(false);
    // A close is not a choice, Continue is the host's nudge, and the host's own steers are not his.
    expect(
      isCaptainGuidance(
        { actor: "captain" },
        { facts: { kind: "card-closed", card: { id: "card-1", title: "Rename it?" } } },
      ),
    ).toBe(false);
    expect(
      isCaptainGuidance({ actor: "captain" }, { facts: { kind: "idle-nudge", thread: false } }),
    ).toBe(false);
    expect(isCaptainGuidance({ actor: "supervisor" }, "The checks finished.")).toBe(false);
  });

  it("rides the message after his words, inside the pictures it keeps", () => {
    const marked = withGuidanceMark(reply, 2);
    const text = renderWake(marked);
    expect(text.startsWith(renderWake(reply))).toBe(true);
    expect(text).toContain(`${GUIDANCE_MARK_WORDS} 2 `);
    // The record still finds his words where the unmarked reply put them.
    const span = replyWordsSpan(reply);
    expect(span && text.slice(span.from, span.to)).toBe("Keep its name.");
    // Pictures wrap outside the mark, so the lane still reads them.
    const picture: AttachmentRef = {
      id: "a1",
      kind: "image",
      name: "hinge.png",
      mimeType: "image/png",
      bytes: 3,
      sha256: "a".repeat(64),
      file: "m1/hinge.png",
    };
    const kept = withAttachmentsKept(marked, [picture]);
    expect(renderWake(kept)).toContain(`${GUIDANCE_MARK_WORDS} 2 `);
    expect(
      rowAttachments([{ facts: kept.facts } as Parameters<typeof rowAttachments>[0][number]]),
    ).toEqual([picture]);
    // A prose steer is marked the same way.
    expect(renderWake(withGuidanceMark("Keep it.", 1))).toMatch(
      new RegExp(`^Keep it\\.\\n\\n.*${GUIDANCE_MARK_WORDS} 1 `),
    );
  });
});
