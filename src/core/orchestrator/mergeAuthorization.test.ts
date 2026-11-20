import type { AttachmentRef } from "@shared/attachments";
import { repairImpact, wireRepairImpact } from "@shared/checkRepair";
import { describe, expect, it } from "vitest";
import { standingApproval } from "../../../tests/helpers/settleHarness";
import type { MergeAuthorization, MergeWait } from "../storage/taskRecords";
import {
  FAILED_BATCH_NOTE,
  isCaptainGuidance,
  keptFeedLine,
  keptNote,
  parseRepairAssessment,
  putInFront,
  waitingInLine,
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

// INF-4497 finding 2: only a change waiting in the batch line or the host's
// merge queue is quiet on the line's account; any other wait stays the crew's.
describe("the line a kept merge waits in", () => {
  const head = "a".repeat(40);
  const waitingOn = (on: MergeWait, at = head) => ({ on, head: at, at: 1 });
  const kept = (mergeAuthorization: MergeAuthorization) => ({
    mode: "queue-pr" as const,
    mergeAuthorization,
  });

  it("names the batch line or the host's merge queue the approval waits in at its version", () => {
    for (const line of ["queue", "host-queue"] as const) {
      const approval = standingApproval({ waiting: waitingOn(line) });
      expect(waitingInLine(kept(approval))).toEqual({ approval, line });
    }
  });

  it("reads no line for any other wait, a reading of an older version, or an approval that ended", () => {
    expect(waitingInLine(undefined)).toBeUndefined();
    expect(waitingInLine(kept(standingApproval()))).toBeUndefined();
    for (const on of ["checks", "conflict", "protected", "host-removed", "refused"] as const)
      expect(waitingInLine(kept(standingApproval({ waiting: waitingOn(on) }))), on).toBeUndefined();
    expect(
      waitingInLine(kept(standingApproval({ waiting: waitingOn("queue", "b".repeat(40)) }))),
    ).toBeUndefined();
    expect(
      waitingInLine(kept(standingApproval({ status: "consumed", waiting: waitingOn("queue") }))),
    ).toBeUndefined();
  });

  it("reads no line while another approval on the task waits on something else", () => {
    const behind = standingApproval({ id: "approval-2", waiting: waitingOn("conflict") });
    expect(
      waitingInLine(kept(standingApproval({ waiting: waitingOn("queue"), queued: [behind] }))),
    ).toBeUndefined();
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
  // The captain's wait and the first mate's note name the batch as the merger.
  it("names the batch a kept merge waits in", () => {
    expect(keptFeedLine("queue", "GitHub")).toBe(
      "Waiting for the batch check: this version merges with your other approved changes, as one batch pull request. Your merge is kept. The app merges the batch after its checks pass.",
    );
    expect(keptNote("queue", "feedbeef", "GitHub")).toContain(
      "feedbeef is in line for one batch pull request, as one commit of its own, and the host merges that pull request once its checks pass",
    );
  });

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

  // INF-3208: a failed batch is what holds the kept approval, and no checks
  // override passes a batch, so the first mate offers no Merge anyway and
  // hears what clears it before the ordinary repair words.
  it("tells the first mate a failed batch takes a fix in a new version, never Merge anyway", () => {
    const note = keptNote("checks", "feedbeef", "GitHub", "red", FAILED_BATCH_NOTE);
    expect(note).toContain("the checks failed and the merge waits for a fix");
    expect(note).toContain(FAILED_BATCH_NOTE);
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

// F3 regression: rotating approvals must not hide pending task-wide removal effects.
it("retains a pending queue removal at the front when another approval rotates in", () => {
  const first = standingApproval();
  const pending = { target: first.target, head: first.approvedHead };
  first.queueRemovals = [pending];
  first.queued = [
    standingApproval({
      id: "other",
      target: {
        ...first.target,
        prNumber: (first.target.prNumber as number) + 1,
        branch: "fm/task-other",
      },
    }),
  ];
  const rotated = putInFront(first, 0, true);
  expect(rotated?.queueRemovals).toEqual([pending]);
  expect(rotated?.queued?.[0]?.queueRemovals).toBeUndefined();
});
