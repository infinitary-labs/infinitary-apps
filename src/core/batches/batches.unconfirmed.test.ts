import type { BatchChange } from "@shared/batches";
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
    await home.pass();
    expect(home.host.merges).toHaveLength(1);

    home.host.land(31, "rebase");
    await home.pass();
    expect(home.record().open).toBeUndefined();
    expect(home.place(PARSER)).toMatchObject({ state: "merged" });
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
