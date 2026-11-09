import type { AttachmentRef } from "@shared/attachments";
import { repairImpact, wireRepairImpact } from "@shared/checkRepair";
import { describe, expect, it } from "vitest";
import {
  FAILED_BATCH_NOTE,
  isCaptainGuidance,
  keptFeedLine,
  keptNote,
  parseRepairAssessment,
} from "./mergeAuthorization";
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

describe("a repair's declared impact (INF-493)", () => {
  // `none` was named conflict-only before INF-493. A computer's work request
  // to its home still carries that name, and an assessment asked before the
  // rename answers with it: either way it must keep the captain's approval,
  // never read as no verdict, which ends it.
  it("reads conflict-only, none's older name, as none wherever it arrives", () => {
    expect(wireRepairImpact("none")).toBe("conflict-only");
    expect(repairImpact(wireRepairImpact("none"))).toBe("none");
    expect(repairImpact(wireRepairImpact("changed-work"))).toBe("changed-work");
    expect(repairImpact("only-a-title")).toBeUndefined();
    expect(
      parseRepairAssessment(
        "impact: conflict-only\nThe range-diff lines up the approved commit unchanged on the newer base.",
      ),
    ).toBe("none");
    expect(
      parseRepairAssessment(
        "**impact: none**\nOnly the commit's subject changed; the tree is the same.",
      ),
    ).toBe("none");
    expect(parseRepairAssessment("The repaired change looks the same to me.")).toBe("unstated");
  });
});

// Captain INF-1555 F12: the offer carries readiness; a checks hold names only checks.
describe("kept merge check words", () => {
  // Captain F20/F27: a failed check waits for a fix, not merely another passing read.
  it("names the fix and its fresh-check consequences after failed checks", () => {
    expect(keptFeedLine("checks", "GitHub", "red")).toBe(
      "Your merge waits for a fix: its checks failed. A fix brings a new version with fresh checks: when it changed the work, its crewmate asks you again on a new card; otherwise your merge runs once they pass.",
    );
    expect(keptNote("checks", "feedbeef", "GitHub", "red")).toContain(
      "the checks failed and the merge waits for a fix",
    );
    expect(keptNote("checks", "feedbeef", "GitHub", "red")).not.toContain("Merge anyway");
  });

  // INF-3208: a failed batch check is what holds the kept approval, and no
  // checks override passes the queue, so the first mate offers no Merge
  // anyway and hears what clears it.
  it("tells the first mate a failed batch check takes a fix or the crewmate's answer, never Merge anyway", () => {
    const note = keptNote("checks", "feedbeef", "GitHub", "red", FAILED_BATCH_NOTE);
    expect(note).toContain("the checks failed and the merge waits for a fix");
    expect(note).toContain(
      "No checks override passes the queue, so never offer or ask for Merge anyway on it",
    );
    expect(note).toContain("check_change's answered verdict");
    expect(note.indexOf(FAILED_BATCH_NOTE)).toBeLessThan(note.indexOf("conflictRepair"));
  });

  it("keeps approval for passing checks, preserving the changed-work exception", () => {
    expect(keptFeedLine("checks", "GitHub")).toBe(
      "Your merge waits: the checks have not all passed. Your approval is kept. If a fix changes the work, its crewmate asks you again; otherwise the merge runs when its checks pass.",
    );
    const note = keptNote("checks", "feedbeef", "GitHub");
    expect(note).toContain("the host merges by itself once the gates pass");
    expect(note).toContain(
      "The crewmate reads missing results; the merge runs when its checks pass",
    );
    expect(note).not.toContain("The checks on feedbeef have not all passed");
    expect(keptFeedLine("conflict", "GitHub")).toContain(
      "brought it up to date and its checks pass",
    );
    expect(keptNote("conflict", "feedbeef", "GitHub")).toContain("read the current check facts");
  });
});
