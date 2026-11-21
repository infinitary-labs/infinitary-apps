import { type BatchChange, mergeWait } from "@shared/batches";
import { englishOf } from "@shared/i18n/said";
import { describe, expect, it } from "vitest";
import { passed, REPO, setup } from "../../../tests/helpers/batchesHarness";
import { BATCH_WORDS } from "./batches";

// Intent: INF-5186 piece 5, batches on Bitbucket (the captain's "adding
// bitbucket as another forge integration just like github and gitlab,
// reaching parity as much as possible"). Bitbucket's merge names no version,
// so a batch merge whose outcome Bitbucket did not confirm - a 202, or an
// answer lost after the request left - is never sent again: later passes
// read how it ended. The project and its host are `batchesHarness.ts`, with
// the host's merge naming no version.

const PARSER: BatchChange = {
  taskId: "t-parser",
  branch: "inf/parser-dates",
  head: "5f0c2a9e41b7d3c8a6e2f9b0d4c1a7e3b8f6d2c0",
  title: "fix(parser): read dates with a time zone",
  body: "- Dates with a time zone are read as written.",
  at: 1_000,
};
const EXPORT: BatchChange = {
  taskId: "t-export",
  branch: "inf/export-csv",
  head: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  title: "feat(export): add a CSV export",
  body: "- A report exports as CSV.",
  at: 2_000,
};

/** Two approved changes whose batch #31 passed its checks, its merge sent with no confirmed outcome. */
async function unconfirmedBatch(task?: string) {
  const home = setup();
  home.host.noVersion = true;
  home.approve(PARSER);
  home.approve(EXPORT);
  await home.pass();
  home.host.report([passed("build")]);
  home.host.ready("clean");
  home.host.unconfirmNext = task ? { task } : {};
  await home.pass();
  return home;
}

describe("a batch merge whose outcome the host did not confirm", () => {
  it("keeps the merge, never sends it again while the host is still merging, and finishes once it reads merged", async () => {
    const home = await unconfirmedBatch("31/merge-1");
    const head = home.open().head;
    expect(home.host.merges).toEqual([
      expect.objectContaining({ number: 31, head, way: "rebase" }),
    ]);
    expect(home.open()).toMatchObject({ unconfirmed: { head, mergeTask: "31/merge-1" } });
    expect(home.open().hold).toBeUndefined();

    // Later passes, and the app starting again, read the merge and send nothing.
    await home.pass();
    await home.restart();
    expect(home.host.merges).toHaveLength(1);
    expect(home.open().hold).toBeUndefined();

    home.host.land(31, "rebase");
    await home.pass();
    expect(home.record().open).toBeUndefined();
    expect(home.place(PARSER)).toMatchObject({ state: "merged", receipt: { number: 31 } });
    expect(home.place(EXPORT)).toMatchObject({ state: "merged", receipt: { number: 31 } });
    expect(home.host.merges).toHaveLength(1);
  });

  it("holds with the host's word when its merge failed, and sends only the new version Try again makes", async () => {
    const home = await unconfirmedBatch("31/merge-1");
    const head = home.open().head;
    home.host.refusedTasks.add("31/merge-1");
    await home.pass();
    const detail = BATCH_WORDS.notMerged("GitHub");
    expect(home.open().unconfirmed).toBeUndefined();
    expect(home.open().hold).toMatchObject({ reason: "merge-way", head, detail });
    expect(home.heard.notes.at(-1)).toEqual(BATCH_WORDS.refused("meter", "#31", detail));
    const told = home.heard.notes.length;
    await home.pass();
    expect(home.host.merges).toHaveLength(1);
    expect(home.heard.notes).toHaveLength(told);

    expect(await home.batches.answer(REPO, { action: "try-again", head })).toBeUndefined();
    home.host.report([passed("build")]);
    await home.pass();
    const again = home.heard.pushes.at(-1)?.head;
    expect(again).not.toBe(head);
    expect(home.host.merges.map((merge) => merge.head)).toEqual([head, again]);
  });

  it("holds a merge with no reference whose pull request is still open, sends nothing again, and finishes if the host merges it after all", async () => {
    const home = await unconfirmedBatch();
    const head = home.open().head;
    expect(home.open().unconfirmed).toBeUndefined();
    expect(home.open().hold).toMatchObject({
      reason: "merge-way",
      head,
      detail: BATCH_WORDS.unconfirmed("GitHub"),
    });
    // The host never answered, so the feed says so and never calls the merge refused.
    expect(home.heard.notes.at(-1)).toEqual(BATCH_WORDS.unanswered("meter", "#31", "GitHub"));
    await home.pass();
    expect(home.host.merges).toHaveLength(1);

    home.host.land(31, "rebase");
    await home.pass();
    expect(home.record().open).toBeUndefined();
    expect(home.place(PARSER)).toMatchObject({ state: "merged" });
    expect(home.host.merges).toHaveLength(1);
  });

  // Intent: INF-5566, the captain's answer on INF-5195's review: "Show the
  // wait in Settings and the feed, with Try again", so a merge the host keeps
  // reading as running (Bitbucket reads an expired reference as pending too)
  // never holds the project's batch line silently. No time limit decides it.
  it("shows a merge the host still reads as running as a wait from the first read, says so once, and keeps it across a restart", async () => {
    const home = await unconfirmedBatch("31/merge-1");
    const head = home.open().head;
    await home.pass();
    const wait = mergeWait(home.open());
    expect(wait).toEqual({ head, pending: expect.any(Number) });
    expect(home.open().hold).toBeUndefined();
    expect(home.heard.notes.at(-1)).toEqual(BATCH_WORDS.mergeRunning("meter", "#31", "GitHub"));
    const told = home.heard.notes.length;

    // Later passes, and the app starting again, keep the same wait, say nothing more and send nothing.
    await home.pass();
    await home.restart();
    expect(mergeWait(home.open())).toEqual(wait);
    expect(home.heard.notes).toHaveLength(told);
    expect(home.host.merges).toHaveLength(1);

    // The host finishes it after all: the batch merges and the wait is gone with it.
    home.host.land(31, "rebase");
    await home.pass();
    expect(home.record().open).toBeUndefined();
    expect(home.place(PARSER)).toMatchObject({ state: "merged", receipt: { number: 31 } });
  });

  // The captain's pick on the review of this change: "Try again closes the old
  // pull request and opens a fresh one", so a merge the host may still finish
  // can never take a version whose checks never ran.
  it("answers Try again on a merge still read as running by closing its pull request and combining on a new one, and never sends the first merge again", async () => {
    const home = await unconfirmedBatch("31/merge-1");
    const { head, branch } = home.open();
    await home.pass();
    expect(mergeWait(home.open())).toBeDefined();
    const told = home.heard.notes.length;

    expect(await home.batches.answer(REPO, { action: "try-again", head })).toBeUndefined();
    // The first pull request is closed unmerged and its branch is gone.
    expect(home.host.pulls.get(31)).toMatchObject({ state: "closed", merged: false });
    expect(home.host.branches.has(branch)).toBe(false);
    const again = home.heard.pushes.at(-1);
    expect(again?.branch).not.toBe(branch);
    expect(home.open()).toMatchObject({ number: 32, branch: again?.branch, head: again?.head });
    expect(home.open().members.map((member) => member.taskId)).toEqual([
      PARSER.taskId,
      EXPORT.taskId,
    ]);
    expect(mergeWait(home.open())).toBeUndefined();
    // The feed names only the new pull request, never #31's checks running again.
    expect(home.heard.notes.slice(told)).toEqual([BATCH_WORDS.formed("meter", "#32", 2)]);

    home.host.report([passed("build")]);
    home.host.ready("clean");
    await home.pass();
    expect(home.host.merges.map((merge) => [merge.number, merge.head])).toEqual([
      [31, head],
      [32, again?.head],
    ]);
    expect(home.record().open).toBeUndefined();
    expect(home.place(EXPORT)).toMatchObject({ state: "merged", receipt: { number: 32 } });
  });

  it("keeps the wait when the host does not close its pull request, and records a merge that finished as the close was asked", async () => {
    const home = await unconfirmedBatch("31/merge-1");
    const head = home.open().head;
    await home.pass();
    const wait = mergeWait(home.open());
    const pushes = home.heard.pushes.length;

    home.host.closeRefusal = "GitHub cannot close a pull request while it merges it.";
    await expect(home.batches.answerOrThrow(REPO, { action: "try-again", head })).rejects.toThrow(
      englishOf(BATCH_WORDS.stillOpen("#31", "GitHub")),
    );
    expect(mergeWait(home.open())).toEqual(wait);
    expect(home.host.pulls.get(31)?.state).toBe("open");
    expect(home.heard.pushes).toHaveLength(pushes);
    expect(home.host.merges).toHaveLength(1);

    // The host finishes the merge as it is asked to close the pull request.
    home.host.duringClose = () => home.host.land(31, "rebase");
    expect(await home.batches.answer(REPO, { action: "try-again", head })).toBe(BATCH_WORDS.ended);
    expect(home.record().open).toBeUndefined();
    expect(home.place(PARSER)).toMatchObject({ state: "merged", receipt: { number: 31 } });
    expect(home.heard.pushes).toHaveLength(pushes);
    expect(home.host.merges).toHaveLength(1);
  });

  it("reads the pull request before Try again replaces a wait, so a merge that finished meanwhile is recorded and nothing more is done", async () => {
    const home = await unconfirmedBatch("31/merge-1");
    const head = home.open().head;
    await home.pass();
    const pushes = home.heard.pushes.length;

    home.host.land(31, "rebase");
    expect(await home.batches.answer(REPO, { action: "try-again", head })).toBe(BATCH_WORDS.ended);
    expect(home.record().open).toBeUndefined();
    expect(home.place(PARSER)).toMatchObject({ state: "merged", receipt: { number: 31 } });
    expect(home.heard.pushes).toHaveLength(pushes);
    expect(home.host.merges).toHaveLength(1);
  });

  it("reads the host's merge queue holding it as queued", async () => {
    const home = await unconfirmedBatch("31/queue-1");
    const head = home.open().head;
    home.host.queued.add(31);
    await home.pass();
    expect(home.open()).toMatchObject({ queued: head });
    expect(home.open().unconfirmed).toBeUndefined();
    expect(home.heard.notes.at(-1)).toEqual(BATCH_WORDS.queued("meter", "#31", "GitHub"));
    await home.pass();
    expect(home.host.merges).toHaveLength(1);
  });
});
