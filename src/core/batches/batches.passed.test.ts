import type { BatchChange } from "@shared/batches";
import { describe, expect, it } from "vitest";
import { failed, passed, REPO, running, setup } from "../../../tests/helpers/batchesHarness";

// Intent: the captain's fix 2 from the daily velocity review: "Merge a held batch once its
// version passes, even on a rerun, and send a test-only fix declared meanwhile to the next
// batch." The project and its host are `batchesHarness.ts`; the held batch is
// `batches.test.ts`'s, two changes whose checks failed.

const PARSER: BatchChange = {
  taskId: "t-parser",
  branch: "fm/task-parser",
  head: "5f0c2a9e41b7d3c8a6e2f9b0d4c1a7e3b8f6d2c0",
  title: "fix(parser): read dates with a time zone",
  body: "- Dates with a time zone are read as written.",
  at: 1_000,
};
const EXPORT: BatchChange = {
  taskId: "t-export",
  branch: "fm/task-export",
  head: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  title: "feat(export): add a CSV export",
  body: "- A report exports as CSV.",
  at: 2_000,
};

/** A repair's own change, a test-only fix declared the held batch's fix. */
const FIX: BatchChange = {
  taskId: "t-fix",
  branch: "fm/task-fix",
  head: "3c2b1a0918f7e6d5c4b3a2918070f6e5d4c3b2a1",
  title: "test(parser): wait for the date fixture before reading it",
  body: "- The parser's date test waits for its fixture.",
  at: 7_000,
};

/** Two approved changes combined as pull request #31, held on failed checks. */
async function heldBatch() {
  const home = setup();
  home.approve(PARSER);
  home.approve(EXPORT);
  await home.pass();
  home.host.report([passed("build"), failed("unit-tests"), failed("lint")]);
  await home.pass();
  return home;
}

describe("a held batch whose version passes on a rerun", () => {
  it("merges a held version whose failed checks pass on a rerun after its fix was approved, and the fix forms the next batch", async () => {
    const home = await heldBatch();
    const held = home.open();
    expect(await home.batches.declareFix(REPO, FIX.taskId)).toBeUndefined();
    await home.pass();
    expect(home.open().hold).toBeDefined();
    home.host.report([passed("build"), passed("unit-tests"), passed("lint")]);
    home.host.ready("clean");
    home.approve(FIX);
    await home.pass();
    expect(home.host.merges.map((merge) => merge.head)).toEqual([held.head]);
    expect(home.place(PARSER)).toMatchObject({ state: "merged" });
    expect(home.members()).toEqual(["t-fix"]);
    expect(home.open().members[0]?.fix).toBe(true);
    expect(home.heard.combinedOn.at(-1)).toEqual([held.head]);
  });

  it("takes the approved fix at once when the held version's checks still fail, and wakes no repair again", async () => {
    const home = await heldBatch();
    const held = home.open();
    expect(await home.batches.declareFix(REPO, FIX.taskId)).toBeUndefined();
    // The repair ran the failed checks again; they are still running when the fix is approved.
    home.host.report([passed("build"), running("unit-tests"), running("lint")]);
    await home.pass();
    expect(home.open().hold).toBeUndefined();
    home.approve(FIX);
    home.host.report([passed("build"), failed("unit-tests"), passed("lint")]);
    await home.pass();
    expect(home.members()).toEqual(["t-parser", "t-export", "t-fix"]);
    expect(home.open().head).not.toBe(held.head);
    expect(home.host.merges).toEqual([]);
    expect(home.heard.held).toHaveLength(1);
  });

  // The version passed on the project's own rerun of its failed tests, while the host still
  // reads the first attempt's jobs failed, so the repair declares it.
  it("merges a held version its repair declared passed on a rerun, and sends the fix declared with it to the next batch", async () => {
    const home = await heldBatch();
    const held = home.open();
    expect(
      await home.batches.declarePassed(REPO, held.head, FIX.taskId, FIX.taskId),
    ).toBeUndefined();
    expect(home.record().fixes).toEqual([FIX.taskId]);
    // The task that declared it is recorded as the hold's repair, which the Batches panel names.
    expect(home.open().repair).toBe(FIX.taskId);
    // The host still reads the failed jobs; a check still running is waited for.
    home.host.report([passed("build"), failed("unit-tests"), failed("lint"), running("journeys")]);
    home.host.ready("clean");
    await home.pass();
    expect(home.host.merges).toEqual([]);
    expect(home.open().hold).toBeUndefined();

    home.approve(FIX);
    home.host.report([passed("build"), failed("unit-tests"), failed("lint"), passed("journeys")]);
    await home.pass();
    expect(home.host.merges.map((merge) => merge.head)).toEqual([held.head]);
    expect(home.members()).toEqual(["t-fix"]);
    expect(home.open().members[0]?.fix).toBe(true);
  });

  it("holds a version declared passed when a check it did not answer fails", async () => {
    const home = await heldBatch();
    const held = home.open();
    expect(await home.batches.declarePassed(REPO, held.head)).toBeUndefined();
    home.host.report([passed("build"), failed("unit-tests"), failed("lint"), failed("journeys")]);
    home.host.ready("clean");
    await home.pass();
    expect(home.host.merges).toEqual([]);
    expect(home.open().hold).toMatchObject({ head: held.head, checks: ["journeys"] });
  });

  it("refuses a passed declaration for another version, a batch not held for its checks, or one waiting for its fix after a send-back", async () => {
    const home = await heldBatch();
    const held = home.open();
    expect(await home.batches.declarePassed(REPO, PARSER.head)).toBe("other-version");
    await home.batches.answer(
      REPO,
      {
        action: "send-back",
        head: held.head,
        changes: [{ taskId: "t-parser", reason: "its date test fails" }],
      },
      FIX.taskId,
    );
    expect(await home.batches.declarePassed(REPO, held.head)).toBe("sent-back");
    expect(home.open().passed).toBeUndefined();
    const fresh = setup();
    fresh.approve(PARSER);
    fresh.approve(EXPORT);
    await fresh.pass();
    expect(await fresh.batches.declarePassed(REPO, fresh.open().head)).toBe("not-held");
  });
});
