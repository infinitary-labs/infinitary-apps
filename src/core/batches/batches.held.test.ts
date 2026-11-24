import { BATCH_STATUS_WORDS, type BatchChange, type MergeWays } from "@shared/batches";
import { describe, expect, it, vi } from "vitest";
import {
  EVERY_WAY,
  failed,
  passed,
  REPO,
  running,
  type StandInPull,
  setup,
} from "../../../tests/helpers/batchesHarness";
import { BATCH_WORDS } from "./batches";
import { LEFT_OUT_WORDS } from "./combine";

// Intent: the captain's approved plan for batches of their own, piece 1. Its done-when list
// asks for the formation rule, a change left out, the merge-way choice from host facts,
// two changes sent back, a fix ending a hold, an approval withdrawn, restart reconcile and
// receipts; its rules say a batch of one reads and merges as that change's pull request
// does, a failed batch holds while later approvals wait, and the host's own reading
// decides what happens next. The project and its host are `batchesHarness.ts`.

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
const LEGEND: BatchChange = {
  taskId: "t-legend",
  branch: "fm/task-legend",
  head: "0f9e8d7c6b5a49382716f5e4d3c2b1a009182736",
  title: "fix(chart): keep the legend inside the chart",
  body: "- The legend no longer overlaps the bars.",
  at: 3_000,
};
const AXIS: BatchChange = {
  taskId: "t-axis",
  branch: "fm/task-axis",
  head: "7e6d5c4b3a2918070f6e5d4c3b2a190817263544",
  title: "fix(chart): label the time axis in local time",
  body: "- The time axis reads in the viewer's own time.",
  at: 4_000,
};

/** A repair's own change, declared the held batch's fix. */
const FIX: BatchChange = {
  taskId: "t-fix",
  branch: "fm/task-fix",
  head: "3c2b1a0918f7e6d5c4b3a2918070f6e5d4c3b2a1",
  title: "fix(export): read dates through the parser's new form",
  body: "- The export reads dates as the parser now writes them.",
  at: 7_000,
};

/** Two approved changes combined and opened as pull request #31. */
async function batchOfTwo(ways: MergeWays = EVERY_WAY) {
  const home = setup(ways);
  home.approve(PARSER);
  home.approve(EXPORT);
  await home.pass();
  return home;
}

// Intent: the captain's answer in the approved plan (`squash_only`): batched pull requests
// are not offered to a project that allows only squash merges, since a batch keeps one commit
// for each change. The choice in Settings and the first mate's project settings both pass here.
// Intent: the same approved plan as `batches.test.ts` (a failed batch holds while later approvals
// wait; two changes sent back; a fix ending a hold; the hold's repair and retries): the held batch
// scenarios, split out along their owner. The project and its host are `batchesHarness.ts`.

describe("a held batch", () => {
  async function heldBatch() {
    const home = await batchOfTwo();
    home.host.report([passed("build"), failed("unit-tests"), failed("lint")]);
    await home.pass();
    return home;
  }

  it("holds on failed checks, tells the first mate once, and keeps later approvals waiting in line", async () => {
    const home = await heldBatch();
    await home.pass();
    const held = home.open();
    expect(held.hold).toMatchObject({
      reason: "checks",
      head: held.head,
      checks: ["unit-tests", "lint"],
    });
    expect(home.heard.held).toHaveLength(1);
    expect(home.heard.held[0]).toMatchObject({
      repo: { id: REPO },
      batch: { number: 31, members: [{ taskId: "t-parser" }, { taskId: "t-export" }] },
    });
    expect(home.heard.notes.at(-1)).toEqual(
      BATCH_WORDS.held("meter", "#31", ["unit-tests", "lint"]),
    );
    // A member of a held batch of several is paused, and its own crewmate is not woken.
    expect(home.batches.status(REPO, PARSER.taskId, PARSER.head)).toMatchObject({ kind: "paused" });
    expect(home.heard.settled).toEqual([]);

    home.approve(LEGEND);
    await home.pass();
    expect(home.place(LEGEND)).toEqual({ state: "waiting", place: "line" });
    expect(home.members()).toEqual(["t-parser", "t-export"]);
    expect(home.open().head).toBe(held.head);
    expect(home.host.merges).toEqual([]);
    expect(home.heard.held).toHaveLength(1);
  });

  // INF-5097 piece 1's review: the checks that never ran are read from the host's own facts.
  // The readings are as GitLab and GitHub give them: a manual job nobody started and a job
  // allowed to fail that was cancelled never ran, one allowed to fail that failed did, and a
  // row that sums up a whole run - GitLab's pipeline beside its jobs, GitHub's unfinished
  // workflow run - names no check of its own: its jobs do.
  it("names the checks that never ran from the host's facts, and none where its reading was incomplete", async () => {
    const home = setup();
    home.approve(PARSER);
    home.approve(EXPORT);
    await home.pass();
    home.host.report([
      failed("unit-tests"),
      { name: "deploy-preview", state: "neutral", manual: true, status: "manual" },
      {
        name: "lint-docs",
        state: "neutral",
        failureAllowed: true,
        allowFailure: true,
        status: "canceled",
      },
      {
        name: "spellcheck",
        state: "neutral",
        failureAllowed: true,
        allowFailure: true,
        status: "failed",
      },
      {
        name: "pipeline #640 (branch)",
        state: "neutral",
        manual: true,
        summary: true,
        run: 640,
        event: "push",
        status: "manual",
      },
      {
        name: "ci (run 812)",
        state: "pending",
        summary: true,
        run: 812,
        workflow: 7,
        event: "push",
      },
      { name: "journeys", state: "pending", status: "in_progress", run: 812, workflow: 7 },
    ]);
    await home.pass();
    expect(home.open().hold).toMatchObject({
      checks: ["unit-tests"],
      notRun: ["deploy-preview", "lint-docs", "journeys"],
    });
    // A later reading the host could not finish: which checks never ran is not known.
    home.host.checksProblem = "GitHub could not provide all check runs: 502";
    await home.pass();
    expect(home.open().hold?.checks).toEqual(["unit-tests"]);
    expect(home.open().hold).not.toHaveProperty("notRun");
    await home.batches.answer(REPO, {
      action: "send-back",
      head: home.open().head,
      changes: [{ taskId: "t-parser", reason: "its date test fails" }],
    });
    expect(home.batches.sentBack(REPO, "t-parser")).toEqual([
      expect.not.objectContaining({ notRun: expect.anything() }),
    ]);
    expect(home.batches.sentBack(REPO, "t-parser")[0]?.failed).toEqual(["unit-tests"]);
  });

  it("sends two changes back, each with its reason, and combines the rest again with the line", async () => {
    const home = setup();
    home.approve(PARSER);
    home.approve(EXPORT);
    home.approve(LEGEND);
    await home.pass();
    // The batch stopped at its failed unit tests: its journeys were cancelled and its
    // browser tests never started, as a batch that stops early leaves them.
    home.host.report([
      failed("unit-tests"),
      running("lint"),
      { name: "journeys", state: "cancelled" },
      { name: "browser-tests", state: "skipped" },
    ]);
    await home.pass();
    expect(home.open().hold).toMatchObject({ notRun: ["lint", "journeys", "browser-tests"] });
    // Its lint finishes while it holds: the hold names its checks as they stand now.
    home.host.report([
      failed("unit-tests"),
      failed("lint"),
      { name: "journeys", state: "cancelled" },
      { name: "browser-tests", state: "skipped" },
    ]);
    await home.pass();
    expect(home.open().hold).toMatchObject({
      checks: ["unit-tests", "lint", "journeys"],
      notRun: ["journeys", "browser-tests"],
    });
    expect(home.heard.held).toHaveLength(1);
    home.approve(AXIS);
    await home.pass();
    const held = home.open();

    const refused = await home.batches.answer(REPO, {
      action: "send-back",
      head: held.head,
      changes: [
        { taskId: "t-parser", reason: "its date test fails on the batch's version" },
        { taskId: "t-export", reason: "its export reads the dates the parser change moved" },
      ],
    });

    expect(refused).toBeUndefined();
    expect(home.heard.sentBack).toEqual([
      { taskId: "t-parser", reason: "its date test fails on the batch's version" },
      { taskId: "t-export", reason: "its export reads the dates the parser change moved" },
    ]);
    expect(home.heard.taskNotes).toEqual([
      {
        taskId: "t-parser",
        text: BATCH_WORDS.sentBackTask("its date test fails on the batch's version"),
      },
      {
        taskId: "t-export",
        text: BATCH_WORDS.sentBackTask("its export reads the dates the parser change moved"),
      },
    ]);
    expect(home.heard.notes).toContainEqual(
      BATCH_WORDS.sentBack("meter", PARSER.title, "its date test fails on the batch's version"),
    );
    expect(home.members()).toEqual(["t-legend", "t-axis"]);
    expect(home.record().line).toEqual([]);
    expect(home.open().hold).toBeUndefined();
    expect(home.open().head).not.toBe(held.head);
    // Intent (INF-5097 piece 1, the captain's answer Keep): the version sent back stands
    // sent back with its reason, its approval kept to wait for a repair, and the record
    // keeps the send-back with its batch, its failed checks and the checks that never ran.
    expect(home.place(PARSER)).toEqual({
      state: "sent-back",
      reason: "its date test fails on the batch's version",
      number: 31,
      url: held.url,
    });
    expect(home.batches.status(REPO, PARSER.taskId, PARSER.head)).toMatchObject({
      kind: "failed",
      words: BATCH_STATUS_WORDS.sentBack("its date test fails on the batch's version"),
    });
    expect(home.batches.sentBack(REPO, "t-parser")).toEqual([
      {
        taskId: "t-parser",
        head: PARSER.head,
        reason: "its date test fails on the batch's version",
        at: expect.any(Number),
        number: 31,
        url: held.url,
        failed: ["unit-tests", "lint"],
        notRun: ["journeys", "browser-tests"],
      },
    ]);
    expect(home.heard.settled).toContainEqual(["t-parser", "t-export"]);
    const pull = home.host.pulls.get(31) as StandInPull;
    expect(pull.title).toBe("chore: merge 2 approved changes");
    expect(pull.body).toContain(`- ${LEGEND.title}\n- ${AXIS.title}`);
    expect(pull.body).not.toContain(PARSER.title);

    home.host.report([passed("unit-tests")]);
    home.host.ready("clean");
    await home.pass();
    expect(home.host.main.map((commit) => commit.title)).toEqual([LEGEND.title, AXIS.title]);
  });

  it("gives the pull request the batch's own words at what it just read, and sends a rewrite the host refused again", async () => {
    const home = setup();
    home.approve(PARSER);
    home.approve(EXPORT);
    home.approve(LEGEND);
    await home.pass();
    home.host.report([failed("unit-tests")]);
    await home.pass();
    const pull = home.host.pulls.get(31) as StandInPull;
    expect(pull.title).toBe("chore: merge 3 approved changes");
    // Opened with its words, the pull request needed no rewrite.
    expect(home.host.rewrites).toEqual([]);

    // Someone edits the description as the batch changes: the host refuses the stale rewrite.
    home.host.editBeforeRewrite = "Edited on the pull request's page.";
    await home.batches.answer(REPO, {
      action: "send-back",
      head: home.open().head,
      changes: [{ taskId: "t-legend", reason: "its legend test fails on the batch's version" }],
    });
    expect(home.members()).toEqual(["t-parser", "t-export"]);
    expect(home.host.rewrites).toEqual([]);
    expect(pull.title).toBe("chore: merge 3 approved changes");

    await home.pass();
    expect(home.host.rewrites).toEqual([{ number: 31, title: "chore: merge 2 approved changes" }]);
    expect(pull.body).toContain(`- ${PARSER.title}\n- ${EXPORT.title}`);
    expect(pull.body).not.toContain(LEGEND.title);
    await home.pass();
    expect(home.host.rewrites).toHaveLength(1);

    // One change left: the pull request reads as that change's own.
    home.host.report([failed("unit-tests")]);
    await home.pass();
    await home.batches.answer(REPO, {
      action: "send-back",
      head: home.open().head,
      changes: [{ taskId: "t-export", reason: "its export test fails too" }],
    });
    expect(home.members()).toEqual(["t-parser"]);
    expect(pull.title).toBe(PARSER.title);
  });

  it("refuses to send back a change the batch does not carry, and an answer to a hold that ended", async () => {
    const home = await heldBatch();
    const held = home.open();
    expect(
      await home.batches.answer(REPO, {
        action: "send-back",
        head: held.head,
        changes: [{ taskId: "t-legend", reason: "its legend test fails" }],
      }),
    ).toBe(BATCH_WORDS.notMember("t-legend"));
    // INF-5097 piece 1's review: one change named twice counts once or not at all, never twice.
    expect(
      await home.batches.answer(REPO, {
        action: "send-back",
        head: held.head,
        changes: [
          { taskId: "t-parser", reason: "its date test fails" },
          { taskId: "t-parser", reason: "its date test fails again" },
        ],
      }),
    ).toBe(BATCH_WORDS.namedTwice("t-parser"));
    expect(home.batches.sentBack(REPO, "t-parser")).toEqual([]);
    expect(home.members()).toContain("t-parser");
    expect(
      await home.batches.answer(REPO, {
        action: "try-again",
        head: "0000000000000000000000000000000000000000",
      }),
    ).toBe(BATCH_WORDS.ended);
    // Settings asks the same answer, and a refusal fails its request with the same words.
    await expect(
      home.batches.answerOrThrow(REPO, {
        action: "try-again",
        head: "0000000000000000000000000000000000000000",
      }),
    ).rejects.toThrow(BATCH_WORDS.ended);
    expect(home.heard.sentBack).toEqual([]);
    expect(home.open()).toEqual(held);
  });

  // Intent: the captain's direction that a held batch's fix goes through that batch's own
  // repair and "the next batch takes everything waiting plus the fix, without asking".
  it("lets a change declared the batch's fix join it once approved and end the hold, with the line behind it", async () => {
    const home = await heldBatch();
    home.approve(LEGEND);
    await home.pass();
    const held = home.open();

    expect(await home.batches.declareFix(REPO, FIX.taskId)).toBeUndefined();
    // Declared, not yet approved: the batch stays held as it was, its declarer recorded
    // as the hold's repair, which the Batches panel and Settings name.
    await home.pass();
    expect(home.open()).toEqual({ ...held, repair: FIX.taskId });

    home.approve(FIX);
    await home.pass();
    // The fix sits right behind the members, then the changes that waited in line.
    expect(home.members()).toEqual(["t-parser", "t-export", "t-fix", "t-legend"]);
    expect(home.open().hold).toBeUndefined();
    expect(home.open().head).not.toBe(held.head);
    expect(home.record().line).toEqual([]);
    // Joined, the fix stays declared until a batch merges with it.
    expect(home.record().fixes).toEqual([FIX.taskId]);
    expect([...home.host.pulls.keys()]).toEqual([31]);
    expect((home.host.pulls.get(31) as StandInPull).title).toBe("chore: merge 4 approved changes");
  });

  // Intent: the captain's approved plan to stop changes bouncing between batches, piece 3:
  // one repair declaration sends a change back and declares its own change the fix, and the
  // batch is combined once, with the fix, never with what was sent back.
  it("sends a change back beside a declared fix and stays held, combining nothing, until the fix joins", async () => {
    const home = await heldBatch();
    home.approve(LEGEND);
    await home.pass();
    const held = home.open();
    const combines = home.heard.combinedOn.length;

    const refused = await home.batches.answer(
      REPO,
      {
        action: "send-back",
        head: held.head,
        changes: [{ taskId: "t-export", reason: "its export test fails on the batch's version" }],
      },
      FIX.taskId,
    );

    expect(refused).toBeUndefined();
    expect(home.heard.sentBack).toEqual([
      { taskId: "t-export", reason: "its export test fails on the batch's version" },
    ]);
    // The change sent back keeps its approval (INF-5097, the captain's answer Keep), and
    // its version stands sent back, so it cannot join with the fix.
    expect(home.approvals.has("t-export")).toBe(true);
    expect(home.place(EXPORT)).toMatchObject({ state: "sent-back" });
    expect(home.record().fixes).toEqual([FIX.taskId]);
    // Held at the same version, combining nothing, even when its checks pass on a rerun.
    home.host.report([passed("build"), passed("unit-tests"), passed("lint")]);
    home.host.ready("clean");
    await home.pass();
    await home.pass();
    expect(home.open().hold?.head).toBe(held.head);
    expect(home.open().head).toBe(held.head);
    expect(home.heard.combinedOn).toHaveLength(combines);
    expect(home.host.merges).toEqual([]);

    // The fix approved: one combine without the change sent back, given the version that held.
    home.approve(FIX);
    await home.pass();
    expect(home.members()).toEqual(["t-parser", "t-fix", "t-legend"]);
    expect(home.open().hold).toBeUndefined();
    expect(home.heard.combinedOn.slice(combines)).toEqual([[held.head]]);
    expect(home.record().held).toEqual([held.head]);
  });

  // Intent: the same piece, the independent review's finding, a bug being fixed: a batch
  // whose every member was sent back beside a fix released the line before the fix came.
  it("keeps waiting for the declared fix when every member has left, and takes the fix with the line", async () => {
    const home = await heldBatch();
    home.approve(LEGEND);
    await home.pass();
    const held = home.open();

    await home.batches.answer(
      REPO,
      {
        action: "send-back",
        head: held.head,
        changes: [
          { taskId: "t-parser", reason: "its date test fails on the batch's version" },
          { taskId: "t-export", reason: "its export test fails on the batch's version" },
        ],
      },
      FIX.taskId,
    );
    await home.pass();
    expect(home.members()).toEqual([]);
    expect(home.open().head).toBe(held.head);
    expect(home.open().hold?.head).toBe(held.head);
    expect(home.place(LEGEND)).toEqual({ state: "waiting", place: "line" });

    home.approve(FIX);
    await home.pass();
    expect(home.members()).toEqual(["t-fix", "t-legend"]);
    expect(home.open().hold).toBeUndefined();
  });

  // Intent: the same piece, the independent review's finding, a bug being fixed: a batch
  // closed where the project lives forgot the versions that held, so a fix built on one
  // would be carried whole, with the work of the changes sent back.
  it("keeps the versions that held when the batch is closed and its changes go back in line", async () => {
    const home = await heldBatch();
    const held = home.open();
    await home.batches.answer(
      REPO,
      {
        action: "send-back",
        head: held.head,
        changes: [{ taskId: "t-export", reason: "its export test fails on the batch's version" }],
      },
      FIX.taskId,
    );
    (home.host.pulls.get(31) as StandInPull).state = "closed";
    await home.pass();
    expect(home.record().held).toEqual([held.head]);
    expect(home.record().fixes).toEqual([FIX.taskId]);

    // The rest formed a new batch; it merges without the fix, which stays declared.
    expect(home.members()).toEqual(["t-parser"]);
    home.approve(FIX);
    home.host.report([passed("build"), passed("unit-tests"), passed("lint")]);
    home.host.ready("clean");
    await home.pass();
    expect(home.host.main.map((commit) => commit.title)).toEqual([PARSER.title]);
    expect(home.record().fixes).toEqual([FIX.taskId]);
    expect(home.record().held).toEqual([held.head]);

    // The next batch is combined with the fix marked and the version that held.
    await home.pass();
    expect(home.heard.combinedOn.at(-1)).toEqual([held.head]);
  });

  // Intent: INF-4421's finding, a bug being fixed: a fix approved two hours before it was
  // declared never joined its held batch, the same approval again changed nothing, and the
  // batch and the fix waited on each other.
  it("lets a change approved before it was declared the fix join the held batch, and an approval repeated changes nothing", async () => {
    const home = await heldBatch();
    home.approve(FIX);
    home.approve(LEGEND);
    await home.pass();
    const held = home.open();
    expect(held.hold).toBeDefined();
    expect(home.place(FIX)).toEqual({ state: "waiting", place: "line" });

    expect(await home.batches.declareFix(REPO, FIX.taskId)).toBeUndefined();
    await home.pass();
    expect(home.members()).toEqual(["t-parser", "t-export", "t-fix", "t-legend"]);
    expect(home.open().hold).toBeUndefined();
    expect(home.open().head).not.toBe(held.head);
    expect(home.record().line).toEqual([]);

    // The kept approval runs again at the same version: it keeps its place in the batch.
    const joined = home.open();
    home.approve(FIX);
    await home.pass();
    expect(home.open()).toEqual(joined);
  });

  // Intent: issue #55, a bug being fixed: a repair declared its change the held batch's fix,
  // another task took that work over and was approved at the same commit, and the batch stayed
  // held because the fix mark followed the declaring task alone. Its review's findings: the
  // takeover carries the repair's one declaration, with the base that repair is measured from,
  // and the batch that merges with it answers that declaration.
  it("lets another task's change approved at the declared fix's exact commit join the held batch and end the hold", async () => {
    const home = await heldBatch();
    const held = home.open();
    home.builtOn.set(FIX.head, held.head);
    // The repair declares the commit it has committed and is never approved; the task that
    // takes its work over delivers that commit from a branch of its own.
    expect(await home.batches.declareFix(REPO, FIX.taskId, FIX.head)).toBeUndefined();
    const delivered = { ...FIX, taskId: "t-takeover", branch: "fm/task-takeover", at: 8_000 };

    home.approve(delivered);
    await home.pass();
    expect(home.members()).toEqual(["t-parser", "t-export", "t-takeover"]);
    expect(home.open().members.at(-1)).toMatchObject({ head: FIX.head, fix: true });
    expect(home.open().hold).toBeUndefined();
    expect(home.open().head).not.toBe(held.head);
    expect(home.record().line).toEqual([]);
    // Still the repair's one declaration, carried from the version it was verified on.
    expect(home.record().fixes).toEqual([FIX.taskId]);
    expect(home.record().fixBases).toEqual({ [FIX.taskId]: held.head });
    expect(home.heard.combinedOn.at(-1)).toEqual([held.head]);

    home.host.report([passed("build"), passed("unit-tests"), passed("lint")]);
    home.host.ready("clean");
    await home.pass();
    expect(home.place(delivered)).toMatchObject({ state: "merged" });
    expect(home.record().fixes).toBeUndefined();
    expect(home.record().fixHeads).toBeUndefined();
    expect(home.record().held).toBeUndefined();
  });

  // Intent: issue #55's control: only the exact commit a repair declared carries its
  // declaration, so an unrelated approval, or an earlier commit of that repair delivered by
  // another task, never releases the hold.
  it("keeps the batch held when changes at other commits are approved beside a declared fix", async () => {
    const home = await heldBatch();
    const held = home.open();
    // The repair declared an earlier commit of its fix, then the one it has now.
    const earlier = "4d3c2b1a0918f7e6d5c4b3a2918070f6e5d4c3b2";
    await home.batches.declareFix(REPO, FIX.taskId, earlier);
    expect(await home.batches.declareFix(REPO, FIX.taskId, FIX.head)).toBeUndefined();
    const older = { ...FIX, taskId: "t-older", branch: "fm/task-older", head: earlier, at: 8_000 };

    home.approve(LEGEND);
    home.approve(older);
    await home.pass();
    expect(home.open()).toEqual({ ...held, repair: FIX.taskId });
    expect(home.record().line).toEqual([LEGEND, older]);
    expect(home.record().fixes).toEqual([FIX.taskId]);
    expect(home.record().fixHeads).toEqual({ [FIX.taskId]: FIX.head });
    expect(home.heard.pushes.at(-1)?.head).toBe(held.head);
    expect(home.host.merges).toEqual([]);
  });

  // Intent: the same issue, its second review's finding, a bug being fixed: a repair that
  // declared again while no commit could be read from its working copy kept the commit it had
  // named before, so another task's change at that earlier commit still ended the hold.
  it("binds no commit once the fix is declared again with none read, so a change at the commit named before waits", async () => {
    const home = await heldBatch();
    const held = home.open();
    await home.batches.declareFix(REPO, FIX.taskId, FIX.head);
    expect(await home.batches.declareFix(REPO, FIX.taskId)).toBeUndefined();
    expect(home.record().fixes).toEqual([FIX.taskId]);
    expect(home.record().fixHeads).toBeUndefined();

    const delivered = { ...FIX, taskId: "t-takeover", branch: "fm/task-takeover", at: 8_000 };
    home.approve(delivered);
    await home.pass();
    expect(home.open()).toEqual({ ...held, repair: FIX.taskId });
    expect(home.record().line).toEqual([delivered]);
    expect(home.host.merges).toEqual([]);
  });

  // Intent: the same issue, its second review's finding, a bug being fixed: a fix declared
  // alone was saved on whatever version the batch held at by then, so a repair that read one
  // held version before Try again was recorded as the repair of the next one.
  it("refuses a fix declared for a version the batch no longer holds at, and takes it at the version it holds at now", async () => {
    const home = await heldBatch();
    const read = home.open().head;
    await home.batches.answer(REPO, { action: "try-again", head: read });
    home.host.report([failed("unit-tests")]);
    await home.pass();
    const now = home.open();
    expect(now.hold?.head).toBeDefined();
    expect(now.hold?.head).not.toBe(read);

    expect(await home.batches.declareFix(REPO, FIX.taskId, FIX.head, read)).toBe(BATCH_WORDS.ended);
    expect(home.record().fixes).toBeUndefined();
    expect(home.open()).toEqual(now);

    expect(
      await home.batches.declareFix(REPO, FIX.taskId, FIX.head, now.hold?.head),
    ).toBeUndefined();
    expect(home.record().fixHeads).toEqual({ [FIX.taskId]: FIX.head });
    expect(home.open().repair).toBe(FIX.taskId);
  });

  // Intent: the same issue, its second review's finding, a bug being fixed: the held version
  // an approval measured a delivered fix from stayed with the repair's declaration alone, so
  // once that repair's task closed the delivery was carried whole, with the batch's own work.
  it("still carries a delivered fix from the held version once its repair's task closed", async () => {
    const home = await heldBatch();
    const held = home.open();
    home.builtOn.set(FIX.head, held.head);
    await home.batches.declareFix(REPO, FIX.taskId, FIX.head);
    // Try again: the batch is checked again, so the fix approved meanwhile waits in line.
    await home.batches.answer(REPO, { action: "try-again", head: held.head });
    const delivered = { ...FIX, taskId: "t-takeover", branch: "fm/task-takeover", at: 8_000 };
    home.approve({ ...delivered, heldBase: held.head });
    home.closedTasks.add(FIX.taskId);
    await home.pass();
    expect(home.record().fixes).toBeUndefined();
    expect(home.record().fixBases).toBeUndefined();
    expect(home.record().line).toEqual([{ ...delivered, heldBase: held.head }]);

    // The checked batch merges, and the next one takes the delivery from that version.
    home.host.report([passed("build"), passed("unit-tests"), passed("lint")]);
    home.host.ready("clean");
    await home.pass();
    await home.pass();
    expect(home.open().members).toMatchObject([{ taskId: "t-takeover", heldBase: held.head }]);
    expect(home.record().leftOut).toEqual([]);
  });

  // Intent: the same issue, its review's finding: the task that delivers a declared commit
  // holds no declaration of its own, so a later version of its change is an ordinary change.
  it("leaves a later version of the takeover's change an ordinary change", async () => {
    const home = await heldBatch();
    await home.batches.declareFix(REPO, FIX.taskId, FIX.head);
    const delivered = { ...FIX, taskId: "t-takeover", branch: "fm/task-takeover", at: 8_000 };
    home.approve(delivered);
    await home.pass();
    expect(home.members()).toEqual(["t-parser", "t-export", "t-takeover"]);

    const moved = { ...delivered, head: "4d3c2b1a0918f7e6d5c4b3a2918070f6e5d4c3b2" };
    home.approve(moved);
    await home.pass();
    expect(home.members()).toEqual(["t-parser", "t-export"]);
    expect(home.record().line).toEqual([moved]);
    expect(home.record().fixes).toEqual([FIX.taskId]);
  });

  // Intent: the same issue, its review's finding, a bug being fixed: a batch that waited for
  // the fix its repair declared beside a send-back stayed held when another task delivered
  // that fix's exact commit, since the wait knew the declaring task alone. The existing rule
  // stands: no other change, another repair's declared fix included, ends that wait.
  it("ends the wait for a fix declared beside a send-back when another task delivers its exact commit", async () => {
    const home = await heldBatch();
    home.approve(LEGEND);
    await home.pass();
    const held = home.open();
    const combines = home.heard.combinedOn.length;
    await home.batches.answer(
      REPO,
      {
        action: "send-back",
        head: held.head,
        changes: [{ taskId: "t-export", reason: "its export test fails on the batch's version" }],
      },
      FIX.taskId,
      FIX.taskId,
      FIX.head,
    );
    await home.batches.declareFix(REPO, AXIS.taskId, AXIS.head);
    home.approve(AXIS);
    await home.pass();
    expect(home.open().hold?.head).toBe(held.head);
    expect(home.heard.combinedOn).toHaveLength(combines);

    home.approve({ ...FIX, taskId: "t-takeover", branch: "fm/task-takeover", at: 8_000 });
    await home.pass();
    expect(home.members()).toEqual(["t-parser", "t-axis", "t-takeover", "t-legend"]);
    expect(home.open().hold).toBeUndefined();
    expect(home.heard.combinedOn.slice(combines)).toEqual([[held.head]]);
  });

  // Intent: INF-4421's finding, a bug being fixed: Try again rebuilt the held batch from its
  // own changes and erased the fix declared for it, so the fix never joined.
  it("keeps a declared fix through Try again, and the fix joins when the batch holds again", async () => {
    const home = await heldBatch();
    const first = home.open();
    expect(await home.batches.declareFix(REPO, FIX.taskId)).toBeUndefined();
    expect(
      await home.batches.answer(REPO, { action: "try-again", head: first.head }),
    ).toBeUndefined();
    expect(home.members()).toEqual(["t-parser", "t-export"]);
    expect(home.record().fixes).toEqual([FIX.taskId]);

    // Approved while the batch is checked again: it waits, marked as the fix.
    home.approve(FIX);
    await home.pass();
    expect(home.place(FIX)).toEqual({ state: "waiting", place: "line" });
    expect(home.record().line).toMatchObject([{ taskId: FIX.taskId, fix: true }]);

    await home.restart();
    expect(home.record().fixes).toEqual([FIX.taskId]);
    expect(home.record().line).toMatchObject([{ taskId: FIX.taskId, fix: true }]);

    // The batch holds again, and the next look takes the fix into it.
    const second = home.open();
    home.host.report([failed("unit-tests")]);
    await home.pass();
    await home.pass();
    expect(home.members()).toEqual(["t-parser", "t-export", "t-fix"]);
    expect(home.open().head).not.toBe(second.head);
    expect(home.open().hold).toBeUndefined();
    expect(home.record().fixes).toEqual([FIX.taskId]);
  });

  // Intent: the same piece, the independent review's second finding, a bug being fixed: a
  // fix that joined lost its declaration and verified base, so a new version of it approved
  // in its place was carried whole, with the members' work it was built on.
  it("carries a new version of a joined fix from the same held version, and forgets the fix once a batch merges with it", async () => {
    const home = await heldBatch();
    const held = home.open();
    expect(await home.batches.declareFix(REPO, FIX.taskId)).toBeUndefined();
    home.approve(FIX);
    await home.pass();
    expect(home.members()).toEqual(["t-parser", "t-export", "t-fix"]);
    expect(home.record().fixes).toEqual([FIX.taskId]);
    expect(home.record().held).toEqual([held.head]);
    const combines = home.heard.combinedOn.length;

    // The repair pushes a new version of its fix and the captain approves it: the batch goes
    // on without the old version, still carried from the version that held, and the new one
    // waits in line, still the fix.
    const replaced = { ...FIX, head: "4d3c2b1a0918f7e6d5c4b3a2918070f6e5d4c3b2" };
    await home.approve(replaced);
    await home.pass();
    expect(home.members()).toEqual(["t-parser", "t-export"]);
    expect(home.record().line).toMatchObject([
      { taskId: FIX.taskId, head: replaced.head, fix: true },
    ]);
    expect(home.heard.combinedOn.slice(combines)).toEqual([[held.head]]);

    // That batch merges without it; the next carries the new version from the version that held.
    home.host.report([passed("build"), passed("unit-tests"), passed("lint")]);
    home.host.ready("clean");
    await home.pass();
    await home.pass();
    expect(home.members()).toEqual(["t-fix"]);
    expect(home.open().members[0]).toMatchObject({ head: replaced.head, fix: true });
    expect(home.heard.combinedOn.at(-1)).toEqual([held.head]);

    home.host.report([passed("build"), passed("unit-tests"), passed("lint")]);
    home.host.ready("clean");
    await home.pass();
    expect(home.place(replaced)).toMatchObject({ state: "merged" });
    expect(home.record().fixes).toBeUndefined();
    expect(home.record().held).toBeUndefined();
  });

  // Intent: the update onto main's project-move guard, its review's findings: a move during
  // the batch branch's read still pushed to the former address (a bug being fixed); and the
  // captain's ruling on that review that a move resets a declared repair, whose whole branch
  // goes as an ordinary change once approved again at the new address.
  it("pushes nothing to a former address when the project moves during a held repair's read, and resets the repair for fresh approval at the new one", async () => {
    const home = await heldBatch();
    const held = home.open();
    await home.batches.answer(
      REPO,
      {
        action: "send-back",
        head: held.head,
        changes: [{ taskId: "t-export", reason: "its export test fails on the batch's version" }],
      },
      FIX.taskId,
    );
    home.builtOn.set(FIX.head, held.head);
    const pushes = home.heard.pushes.length;
    const get = home.repos.get.bind(home.repos);
    let movedTo: string | undefined;
    vi.spyOn(home.repos, "get").mockImplementation((id) => {
      const repo = get(id);
      return repo && id === REPO && movedTo ? { ...repo, origin: movedTo } : repo;
    });
    home.host.duringBranchRead = () => {
      movedTo = "https://github.com/acme/new-meter.git";
    };
    await home.approve(FIX);
    await home.pass();
    expect(movedTo).toBeDefined();
    expect(home.heard.pushes).toHaveLength(pushes);
    expect(home.host.branches.get(held.branch)).toBe(held.head);

    // The next pass finds the batch at the former address: its changes go back for approval,
    // and the declared repair is reset with it.
    await home.pass();
    expect(home.record().open).toBeUndefined();
    expect(home.record().fixes).toBeUndefined();
    expect(home.record().held).toBeUndefined();

    // Approved again at the new address, the repair goes as an ordinary change, in a new batch.
    await home.approve(FIX);
    await home.pass();
    expect(home.members()).toEqual([FIX.taskId]);
    expect(home.open()).toMatchObject({ origin: "https://github.com/acme/new-meter.git" });
    expect(home.open().members[0]).not.toHaveProperty("heldBase");
    expect(home.open().members[0]).not.toHaveProperty("fix");
    expect(home.heard.pushes.slice(pushes).map((push) => push.branch)).not.toContain(held.branch);
  });

  // Intent: the same piece, the independent review's third finding, a bug being fixed: once
  // the awaited fix was approved, a combine whose push went through but whose record was not
  // saved left every later pass pushing against the version before it, refused each time.
  it("takes the awaited fix over a push whose record was lost, instead of failing on every pass", async () => {
    const home = await heldBatch();
    const held = home.open();
    await home.batches.answer(
      REPO,
      {
        action: "send-back",
        head: held.head,
        changes: [{ taskId: "t-export", reason: "its export test fails on the batch's version" }],
      },
      FIX.taskId,
    );
    home.approve(FIX);
    // The combine with the fix was pushed, and the app stopped before saving it.
    const lost = "c0ffee0123456789abcdef0123456789abcdef01";
    home.host.branches.set(held.branch, lost);
    home.host.carried.set(lost, []);
    await home.pass();
    expect(home.members()).toEqual(["t-parser", "t-fix"]);
    expect(home.open().hold).toBeUndefined();
    expect(home.heard.pushes.at(-1)).toMatchObject({ branch: held.branch, expected: lost });
  });

  // Intent: the same piece, the independent review's fourth finding, a bug being fixed: Try
  // again and a send-back pushed against the version before a push whose record was lost.
  it("lets Try again go over a push whose record was lost while the batch waits for its fix", async () => {
    const home = await heldBatch();
    const earlier = home.open().head;
    await home.batches.answer(REPO, { action: "try-again", head: earlier });
    home.host.report([failed("unit-tests")]);
    await home.pass();
    const held = home.open();
    expect(held.head).not.toBe(earlier);
    expect(held.hold?.head).toBe(held.head);
    await home.batches.answer(
      REPO,
      {
        action: "send-back",
        head: held.head,
        changes: [{ taskId: "t-export", reason: "its export test fails on the batch's version" }],
      },
      FIX.taskId,
    );
    const lost = "c0ffee0123456789abcdef0123456789abcdef01";
    home.host.branches.set(held.branch, lost);
    home.host.carried.set(lost, []);
    expect(
      await home.batches.answer(REPO, { action: "try-again", head: held.head }),
    ).toBeUndefined();
    expect(home.members()).toEqual(["t-parser"]);
    expect(new Set(home.heard.excludedHeads.at(-1))).toEqual(new Set([held.head, lost, earlier]));
    expect(home.heard.pushes.at(-1)).toMatchObject({ branch: held.branch, expected: lost });
  });

  // Intent: the same piece, the independent review's later finding, a bug being fixed: the
  // base a combine verified for the fix was saved only after its push came back, so a push
  // that never did lost it, and a rewritten fix sent after the app restarted was carried whole.
  it("keeps the fix's verified version through a push that never came back, and refuses a rewritten fix after a restart", async () => {
    const home = await heldBatch();
    const held = home.open();
    await home.batches.answer(
      REPO,
      {
        action: "send-back",
        head: held.head,
        changes: [{ taskId: "t-export", reason: "its export test fails on the batch's version" }],
      },
      FIX.taskId,
    );
    home.builtOn.set(FIX.head, held.head);
    home.stopPushes(true);
    home.approve(FIX);
    await home.pass();
    // The combine verified the fix on the version that held; its push never came back.
    expect(home.heard.combinedOn.at(-1)).toEqual([held.head]);
    expect(home.record().fixBases).toEqual({ [FIX.taskId]: held.head });
    expect(home.open().hold?.head).toBe(held.head);
    expect(home.open().head).toBe(held.head);
    expect(home.host.branches.get(held.branch)).toBe(held.head);

    await home.restart();
    expect(home.record().fixBases).toEqual({ [FIX.taskId]: held.head });
    home.stopPushes(false);
    // The fix rewritten onto the default branch: it carries the change sent back with it.
    const rewritten = { ...FIX, head: "4d3c2b1a0918f7e6d5c4b3a2918070f6e5d4c3b2" };
    home.approve(rewritten);
    await home.pass();
    expect(home.members()).toEqual(["t-parser"]);
    expect(home.record().leftOut).toEqual([
      expect.objectContaining({
        taskId: FIX.taskId,
        head: rewritten.head,
        reason: LEFT_OUT_WORDS.fixBaseLost(held.head),
      }),
    ]);
    expect(home.heard.pushes.at(-1)).toMatchObject({ branch: held.branch, expected: held.head });
  });

  // Intent: the same piece, the independent review's second finding, a bug being fixed: a
  // batch held for a repair that closed before its fix was approved waited for it forever.
  it("stays held and says so once when the awaited repair closes, until Try again", async () => {
    const home = await heldBatch();
    const held = home.open();
    await home.batches.answer(
      REPO,
      {
        action: "send-back",
        head: held.head,
        changes: [{ taskId: "t-export", reason: "its export test fails on the batch's version" }],
      },
      FIX.taskId,
    );
    await home.pass();
    const combines = home.heard.combinedOn.length;
    const notes = home.heard.notes.length;

    home.closedTasks.add(FIX.taskId);
    await home.pass();
    await home.pass();
    expect(home.open().hold?.head).toBe(held.head);
    expect(home.open().awaits).toBe("");
    expect(home.record().fixes).toBeUndefined();
    expect(home.heard.combinedOn).toHaveLength(combines);
    expect(home.heard.notes.slice(notes)).toEqual([BATCH_WORDS.fixClosed("meter", "#31")]);

    expect(
      await home.batches.answer(REPO, { action: "try-again", head: held.head }),
    ).toBeUndefined();
    expect(home.open().hold).toBeUndefined();
    expect(home.open().awaits).toBeUndefined();
    expect(home.members()).toEqual(["t-parser"]);
  });

  // Intent: the same piece, the independent review's finding, a bug being fixed: a fix
  // forgotten once a batch merged without it would be carried whole, with the work of the
  // changes it was built on, so it stays declared until a batch merges with it.
  it("keeps a declared fix that its batch merged without, so the next batch carries it as the fix", async () => {
    const home = await heldBatch();
    const first = home.open();
    expect(await home.batches.declareFix(REPO, FIX.taskId)).toBeUndefined();
    await home.batches.answer(REPO, { action: "try-again", head: first.head });
    home.approve(FIX);
    home.host.report([passed("build"), passed("unit-tests"), passed("lint")]);
    home.host.ready("clean");
    await home.pass();
    expect(home.place(PARSER)).toMatchObject({ state: "merged" });
    expect(home.record().held).toEqual([first.head]);
    // The fix forms the next batch on its own, still marked as the fix, with the version that held.
    expect(home.members()).toEqual(["t-fix"]);
    expect(home.open().members[0]?.fix).toBe(true);
    expect(home.heard.combinedOn.at(-1)).toEqual([first.head]);
  });

  it("refuses a fix declaration when no batch of the project is held", async () => {
    const home = await batchOfTwo();
    expect(await home.batches.declareFix(REPO, "t-fix")).toBe(
      "No batch of this project is held, so there is nothing to fix.",
    );
    expect(home.record().fixes).toBeUndefined();
  });

  it("ends the hold when the failed checks run again, merges when they pass, and holds anew when they fail again", async () => {
    const home = await heldBatch();
    const held = home.open();
    // The repair judged a flake and ran the failed checks again where the project lives.
    home.host.report([passed("build"), running("unit-tests"), running("lint")]);
    await home.pass();
    expect(home.open().hold).toBeUndefined();
    expect(home.open().head).toBe(held.head);
    expect(home.batches.status(REPO, PARSER.taskId, PARSER.head)).toMatchObject({
      kind: "in-batch",
    });

    home.host.report([passed("build"), failed("unit-tests"), passed("lint")]);
    await home.pass();
    expect(home.open().hold).toMatchObject({ reason: "checks", checks: ["unit-tests"] });
    expect(home.heard.held).toHaveLength(2);

    home.host.report([passed("build"), passed("unit-tests"), passed("lint")]);
    home.host.ready("clean");
    await home.pass();
    expect(home.host.merges.map((merge) => merge.head)).toEqual([held.head]);
    expect(home.heard.pushes).toHaveLength(1);
  });

  // Intent: the captain's direction that a held batch's repair takes everything waiting,
  // without asking.
  it("tries again by combining the batch at a new version with the changes waiting in line, so its checks run again", async () => {
    const home = await heldBatch();
    home.approve(LEGEND);
    await home.pass();
    const held = home.open();
    expect(
      await home.batches.answer(REPO, { action: "try-again", head: held.head }),
    ).toBeUndefined();
    expect(home.members()).toEqual(["t-parser", "t-export", "t-legend"]);
    expect(home.record().line).toEqual([]);
    expect(home.open().hold).toBeUndefined();
    expect(home.open().head).not.toBe(held.head);
    expect(home.heard.pushes.at(-1)).toMatchObject({ expected: held.head });
    expect(home.heard.notes.at(-1)).toEqual(BATCH_WORDS.retried("meter", "#31"));
  });
});
