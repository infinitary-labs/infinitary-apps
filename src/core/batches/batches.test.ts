import { isDeepStrictEqual } from "node:util";
import {
  BATCH_STATUS_WORDS,
  type BatchChange,
  type MergeWays,
  SQUASH_ONLY_WORDS,
} from "@shared/batches";
import { formatTime } from "@shared/i18n/format";
import { describe, expect, it, vi } from "vitest";
import {
  EVERY_WAY,
  failed,
  MAIN_AT_START,
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
describe("choosing batched pull requests", () => {
  it("is refused with its reason for a project that allows only squash merges", async () => {
    const home = setup({ squash: true, rebase: false, merge: false });
    await expect(home.batches.refuseSquashOnly(REPO)).rejects.toThrow(SQUASH_ONLY_WORDS);
  });

  it("is taken for a project that can keep each change's commit, by a rebase merge or a merge commit", async () => {
    for (const ways of [
      { squash: true, rebase: true, merge: false },
      { squash: false, rebase: false, merge: true },
    ])
      await expect(setup(ways).batches.refuseSquashOnly(REPO)).resolves.toBeUndefined();
  });

  it("is not refused while the host cannot say which merges the project allows", async () => {
    const home = setup({ squash: true, rebase: false, merge: false });
    home.host.waysUnreadable = true;
    await expect(home.batches.refuseSquashOnly(REPO)).resolves.toBeUndefined();
  });
});

describe("forming a batch", () => {
  it("keeps an open batch from claiming or cleaning up a reused number after a project move", async () => {
    const home = await batchOfTwo();
    const open = home.open();
    const pull = home.host.pulls.get(31);
    if (!pull) throw new Error("The fixture needs the open batch request.");
    await home.approve(LEGEND);
    expect(home.record().line.map((member) => member.taskId)).toEqual([LEGEND.taskId]);
    const formerReceipts = home.batches.record(REPO).receipts;
    // Simulate an unrelated request already merged at the new address, even at the same head.
    Object.assign(pull, { state: "closed", merged: true });
    const get = home.repos.get.bind(home.repos);
    const moved = vi.spyOn(home.repos, "get").mockImplementation((id) => {
      const repo = get(id);
      return repo && id === REPO
        ? { ...repo, origin: "https://github.com/acme/new-meter.git" }
        : repo;
    });
    try {
      await home.pass();
      expect(home.record().open).toBeUndefined();
      expect(home.heard.addressMoved.map((entry) => entry.taskId)).toEqual([
        PARSER.taskId,
        EXPORT.taskId,
        LEGEND.taskId,
      ]);
      // Leaving for a former address is not a send-back: no history is kept for it.
      expect(home.heard.sentBack).toEqual([]);
      expect(home.record().sentBack).toBeUndefined();
      const fresh = { ...LEGEND, taskId: "fresh-task", branch: "fm/fresh-task" };
      await home.approve(fresh);
      await home.pass();
      expect(home.open()).toMatchObject({
        number: 32,
        origin: "https://github.com/acme/new-meter.git",
      });
      expect(home.open().members.map((member) => member.taskId)).toEqual([fresh.taskId]);
      expect(home.record().receipts).toEqual(formerReceipts);
      expect(home.heard.settled).toEqual([]);
      expect(home.host.pulls.get(31)).toBe(pull);
      expect(home.host.branches.get(open.branch)).toBe(open.head);
    } finally {
      moved.mockRestore();
    }
  });

  it("combines the whole line into one pull request, one commit for each change, in approval order", async () => {
    const home = await batchOfTwo();
    expect([...home.host.pulls.keys()]).toEqual([31]);
    const pull = home.host.pulls.get(31) as StandInPull;
    expect(pull.branch).toBe("infinitary-batch/3fa9c1d2");
    expect(pull.title).toBe("chore: merge 2 approved changes");
    expect(home.host.carried.get(pull.head)?.map((commit) => commit.title)).toEqual([
      PARSER.title,
      EXPORT.title,
    ]);
    // The description lists the changes, then carries each one's story.
    expect(pull.body).toContain(`- ${PARSER.title}\n- ${EXPORT.title}`);
    expect(pull.body).toContain("<!-- story of t-parser -->");
    expect(pull.body).toContain("<!-- story of t-export -->");
    expect(home.open()).toMatchObject({
      number: 31,
      url: "https://github.com/acme/meter/pull/31",
      base: MAIN_AT_START,
      head: pull.head,
    });
    expect(home.record().line).toEqual([]);
    expect(home.batches.status(REPO, PARSER.taskId, PARSER.head)).toMatchObject({
      kind: "in-batch",
      link: "https://github.com/acme/meter/pull/31",
    });
    expect(home.heard.notes).toEqual([BATCH_WORDS.formed("meter", "#31", 2)]);
  });

  // The plan's "A batch of several is titled in the app's words in the naming form", under
  // the captain's ruling that no naming form lives in the app: the active runbook gives it.
  it("titles a batch of several in the form the active naming runbook gives a name the app writes, and plainly with none on", async () => {
    const team = setup();
    // A team that names work by its area in capitals and brackets.
    team.nameBy({
      pattern: "^\\[[A-Z][A-Z0-9-]*\\] \\S.+$",
      message: 'Start with the area in capitals and brackets, such as "[DOCS] Explain the export".',
      compose: "[APP] {summary}",
    });
    team.approve(PARSER);
    team.approve(EXPORT);
    await team.pass();
    expect((team.host.pulls.get(31) as StandInPull).title).toBe("[APP] merge 2 approved changes");

    const unnamed = setup();
    unnamed.nameBy(null);
    unnamed.approve(PARSER);
    unnamed.approve(EXPORT);
    await unnamed.pass();
    expect((unnamed.host.pulls.get(31) as StandInPull).title).toBe("merge 2 approved changes");
  });

  it("starts as soon as one change is in line, and keeps one open batch: a later approval waits", async () => {
    const home = setup();
    home.approve(PARSER);
    await home.pass();
    expect(home.members()).toEqual(["t-parser"]);
    home.approve(EXPORT);
    await home.pass();
    expect([...home.host.pulls.keys()]).toEqual([31]);
    expect(home.members()).toEqual(["t-parser"]);
    expect(home.place(EXPORT)).toEqual({ state: "waiting", place: "line" });
  });

  // Found by rehearsing this piece's live proof: four changes were approved within half a
  // second, and the pass combining the first one saved the record it had read at its start,
  // so two approvals written beside it left the line until their own merges ran again.
  it("keeps the changes approved while the batch ahead of them is being combined: they wait in line and go up together next", async () => {
    const home = setup();
    home.whileCombining(() => {
      void home.approve(EXPORT);
      void home.approve(LEGEND);
    });
    void home.approve(PARSER);
    await home.pass();
    // One more pass, behind the two approvals that waited their turn.
    await home.pass();
    expect(home.members()).toEqual(["t-parser"]);
    expect(home.record().line.map((change) => change.taskId)).toEqual(["t-export", "t-legend"]);
    expect(home.place(EXPORT)).toEqual({ state: "waiting", place: "line" });
    expect(home.place(LEGEND)).toEqual({ state: "waiting", place: "line" });

    // The batch ahead merges, and the two that waited go up as one pull request.
    home.host.report([passed("build")]);
    home.host.ready("clean");
    await home.pass();
    expect(home.host.merges.map((merge) => merge.number)).toEqual([31]);
    expect([...home.host.pulls.keys()]).toEqual([31, 32]);
    expect(home.members()).toEqual(["t-export", "t-legend"]);
    expect(home.record().line).toEqual([]);
  });

  it("leaves out a change that no longer combines, tells its task why, and goes on with the rest", async () => {
    const home = setup();
    home.conflicting.add("t-export");
    home.approve(PARSER);
    home.approve(EXPORT);
    home.approve(LEGEND);
    await home.pass();
    expect(home.members()).toEqual(["t-parser", "t-legend"]);
    expect(home.place(EXPORT)).toEqual({ state: "left-out", reason: LEFT_OUT_WORDS.conflict });
    expect(home.heard.taskNotes).toEqual([
      { taskId: "t-export", text: BATCH_WORDS.leftOut(LEFT_OUT_WORDS.conflict) },
    ]);
    expect(home.heard.settled).toEqual([["t-export"]]);

    // Its crewmate brings the branch up to date; the new version, once approved, waits in line.
    home.conflicting.delete("t-export");
    const repaired = { ...EXPORT, head: "c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7", at: 6_000 };
    home.approve(repaired);
    await home.pass();
    expect(home.place(repaired)).toEqual({ state: "waiting", place: "line" });
    expect(home.record().leftOut).toEqual([]);
  });

  // Intent: INF-4517's plan, piece 2 (the captain's "Approve and build"): the left-out
  // notice says whether the change clashes with the default branch now or only with changes
  // ahead; in the second case nothing can be done yet, and the change's merge runs again
  // once when that batch merges or the clashing change leaves it.
  it("tells a change that clashes only with a change ahead that nothing can be done yet, and runs its merge again once that batch merges", async () => {
    const home = setup();
    home.clashing.set("t-export", "t-parser");
    home.approve(PARSER);
    home.approve(EXPORT);
    await home.pass();
    const reason = LEFT_OUT_WORDS.ahead(PARSER.title);
    expect(home.members()).toEqual(["t-parser"]);
    expect(home.place(EXPORT)).toEqual({ state: "left-out", reason, ahead: "t-parser" });
    expect(home.batches.status(REPO, EXPORT.taskId, EXPORT.head)?.kind).toBe("paused");
    expect(home.heard.taskNotes).toEqual([
      { taskId: "t-export", text: BATCH_WORDS.leftOutAhead(reason) },
    ]);
    expect(home.heard.settled).toEqual([["t-export"]]);

    // Passes while the batch ahead is checked say nothing more.
    await home.pass();
    expect(home.heard.settled).toEqual([["t-export"]]);

    // The batch ahead merges: the clash is now one with the default branch, said once.
    home.host.report([passed("build")]);
    home.host.ready("clean");
    await home.pass();
    expect(home.host.merges.map((merge) => merge.number)).toEqual([31]);
    expect(home.place(EXPORT)).toEqual({ state: "left-out", reason: LEFT_OUT_WORDS.conflict });
    expect(home.heard.taskNotes.slice(1)).toEqual([
      { taskId: "t-export", text: BATCH_WORDS.clashMerged },
    ]);
    expect(home.heard.settled).toEqual([["t-export"], ["t-parser"], ["t-export"]]);
    await home.pass();
    expect(home.heard.settled).toEqual([["t-export"], ["t-parser"], ["t-export"]]);
  });

  it("runs a left-out change's merge again once when the change ahead it clashed with leaves the batch, so the same version can go back in line", async () => {
    const home = setup();
    home.clashing.set("t-export", "t-parser");
    home.approve(PARSER);
    home.approve(EXPORT);
    home.approve(LEGEND);
    await home.pass();
    expect(home.members()).toEqual(["t-parser", "t-legend"]);

    // The parser change's approval ends, so it leaves the batch.
    home.approvals.delete("t-parser");
    await home.batches.withdraw(REPO, "t-parser");
    await home.pass();
    expect(home.members()).toEqual(["t-legend"]);
    expect(home.place(EXPORT)).toBeUndefined();
    expect(home.heard.taskNotes.slice(1)).toEqual([
      { taskId: "t-export", text: BATCH_WORDS.clashLeft },
    ]);
    expect(home.heard.settled).toEqual([["t-export"], ["t-export"]]);

    // Its kept merge reads no place now and puts the approved version in line again.
    await home.batches.enqueue(REPO, EXPORT);
    await home.pass();
    expect(home.place(EXPORT)).toEqual({ state: "waiting", place: "line" });
  });

  it("opens no pull request when nothing in line combines", async () => {
    const home = setup();
    home.conflicting.add("t-parser");
    home.approve(PARSER);
    await home.pass();
    expect(home.host.pulls.size).toBe(0);
    expect(home.heard.pushes).toEqual([]);
    expect(home.record().open).toBeUndefined();
    expect(home.place(PARSER)).toMatchObject({ state: "left-out" });
  });
});

// The independent review's finding on this change, a bug being fixed, with the captain's
// answer to it: a batch opens even when a change's story could not be written, Activity
// names the missing story once, and the description is written again until it is there.
describe("a story that could not be added", () => {
  it("opens the batch anyway, names the missing story once, and adds it as soon as it can be", async () => {
    const home = setup();
    home.unwritable.add(EXPORT.taskId);
    home.approve(PARSER);
    home.approve(EXPORT);
    await home.pass();
    const pull = home.host.pulls.get(31) as StandInPull;
    expect(pull.body).toContain(`- ${PARSER.title}\n- ${EXPORT.title}`);
    expect(pull.body).toContain("<!-- story of t-parser -->");
    expect(pull.body).not.toContain("<!-- story of t-export -->");
    expect(home.heard.notes).toEqual([
      BATCH_WORDS.formed("meter", "#31", 2),
      BATCH_WORDS.noStory("meter", "#31", [EXPORT.title]),
    ]);

    // Still missing on the passes after: nothing is rewritten, and it is not said again.
    await home.pass();
    await home.pass();
    expect(home.host.rewrites).toEqual([]);
    expect(home.heard.notes).toHaveLength(2);

    // The story can be written: the next pass adds it, and the passes after write nothing.
    home.unwritable.clear();
    await home.pass();
    expect(pull.body).toContain("<!-- story of t-export -->");
    expect(home.host.rewrites).toEqual([{ number: 31, title: "chore: merge 2 approved changes" }]);
    await home.pass();
    expect(home.host.rewrites).toHaveLength(1);
    expect(home.heard.notes).toHaveLength(2);
  });

  it("does the same for a batch of one, whose description is its change's own story", async () => {
    const home = setup();
    home.unwritable.add(PARSER.taskId);
    home.approve(PARSER);
    await home.pass();
    const pull = home.host.pulls.get(31) as StandInPull;
    expect(pull.title).toBe(PARSER.title);
    expect(pull.body).toBe("");
    expect(home.heard.notes).toEqual([
      BATCH_WORDS.formed("meter", "#31", 1),
      BATCH_WORDS.noStory("meter", "#31", [PARSER.title]),
    ]);

    home.unwritable.clear();
    await home.pass();
    expect(pull.body).toBe(
      `Part of the t-parser work.\n\n<!-- story of t-parser -->\n## Why\n${PARSER.title}`,
    );
    expect(home.heard.notes).toHaveLength(2);
  });

  it("says nothing again for a story still missing after the batch's members changed", async () => {
    const home = setup();
    home.unwritable.add(EXPORT.taskId);
    home.approve(PARSER);
    home.approve(EXPORT);
    home.approve(LEGEND);
    await home.pass();
    home.host.report([failed("unit-tests")]);
    await home.pass();
    const said = home.heard.notes.filter((note) => note.m === "feedBatchNoStory");
    expect(said).toEqual([BATCH_WORDS.noStory("meter", "#31", [EXPORT.title])]);

    // A change is sent back: the batch is at a new version, and the same story is still missing.
    await home.batches.answer(REPO, {
      action: "send-back",
      head: home.open().head,
      changes: [{ taskId: "t-legend", reason: "its legend test fails on the batch's version" }],
    });
    await home.pass();
    const pull = home.host.pulls.get(31) as StandInPull;
    expect(pull.title).toBe("chore: merge 2 approved changes");
    expect(pull.body).not.toContain("<!-- story of t-export -->");
    expect(home.heard.notes.filter((note) => note.m === "feedBatchNoStory")).toEqual(said);
  });
});

describe("a batch of one", () => {
  it("reads as that change's own pull request: its title, the words around its story, then the story", async () => {
    const home = setup();
    home.approve(PARSER);
    await home.pass();
    const pull = home.host.pulls.get(31) as StandInPull;
    expect(pull.title).toBe(PARSER.title);
    expect(pull.body).toBe(
      `Part of the t-parser work.\n\n<!-- story of t-parser -->\n## Why\n${PARSER.title}`,
    );
    expect(home.heard.notes).toEqual([BATCH_WORDS.formed("meter", "#31", 1)]);
  });

  it("merges as that pull request does: one squash commit with the change's title and words", async () => {
    const home = setup();
    home.approve(PARSER);
    await home.pass();
    home.host.report([passed("build")]);
    home.host.ready("clean");
    await home.pass();
    expect(home.host.merges).toEqual([
      {
        number: 31,
        head: home.heard.pushes[0]?.head,
        way: "squash",
        title: PARSER.title,
        body: PARSER.body,
      },
    ]);
    // The squash commit the host answered is the change's own commit on the default branch.
    expect(home.place(PARSER)).toMatchObject({
      state: "merged",
      receipt: { sha: home.host.main[0]?.sha, number: 31 },
    });
    expect(home.heard.landedReads).toBe(0);
    expect(home.heard.settled).toEqual([["t-parser"]]);
    expect(home.heard.notes.at(-1)).toEqual(BATCH_WORDS.merged("meter", "#31", 1));
  });

  it("wakes its own change when its checks fail, and never the first mate", async () => {
    const home = setup();
    home.approve(PARSER);
    await home.pass();
    home.host.report([passed("build"), failed("unit-tests")]);
    await home.pass();
    expect(home.place(PARSER)).toEqual({
      state: "failed",
      checks: ["unit-tests"],
      number: 31,
      url: "https://github.com/acme/meter/pull/31",
    });
    expect(home.heard.settled).toEqual([["t-parser"]]);
    expect(home.heard.held).toEqual([]);
  });
});

describe("merging a batch of several", () => {
  it("merges by rebase where the project allows it: a receipt for each change, the branch deleted, the tasks settled, the next batch formed", async () => {
    const home = await batchOfTwo();
    home.approve(LEGEND);
    home.host.report([passed("build"), passed("unit-tests")]);
    home.host.ready("clean");
    await home.pass();

    expect(home.host.merges).toEqual([
      {
        number: 31,
        head: home.heard.pushes[0]?.head,
        way: "rebase",
        title: "chore: merge 2 approved changes",
        body: `- ${PARSER.title}\n- ${EXPORT.title}`,
      },
    ]);
    // Each change is its own commit on the default branch, and its receipt names that commit.
    expect(home.host.main.map((commit) => commit.title)).toEqual([PARSER.title, EXPORT.title]);
    expect(home.place(PARSER)).toMatchObject({
      state: "merged",
      receipt: {
        sha: home.host.main[0]?.sha,
        number: 31,
        url: "https://github.com/acme/meter/pull/31",
      },
    });
    expect(home.place(EXPORT)).toMatchObject({
      state: "merged",
      receipt: { sha: home.host.main[1]?.sha, number: 31 },
    });
    expect(home.host.branches.has("infinitary-batch/3fa9c1d2")).toBe(false);
    expect(home.heard.settled).toEqual([["t-parser", "t-export"]]);
    expect(home.heard.notes).toContainEqual(BATCH_WORDS.merged("meter", "#31", 2));

    // The change approved meanwhile is the next batch, on a branch of its own.
    expect(home.open()).toMatchObject({ number: 32, branch: "infinitary-batch/8be04a67" });
    expect(home.members()).toEqual(["t-legend"]);
    expect(home.open().base).toBe(home.host.branches.get("main"));
  });

  it("keeps the batch's own commits with a merge commit where the project allows no rebase merge", async () => {
    const home = await batchOfTwo({ squash: true, rebase: false, merge: true });
    const written = home.open().members.map((member) => member.commit);
    home.host.report([passed("build")]);
    home.host.ready("clean");
    await home.pass();
    expect(home.host.merges.map((merge) => merge.way)).toEqual(["merge"]);
    expect(home.place(PARSER)).toMatchObject({ state: "merged", receipt: { sha: written[0] } });
    expect(home.place(EXPORT)).toMatchObject({ state: "merged", receipt: { sha: written[1] } });
  });

  it("holds where the project allows only squash merges, says so once, and merges once it allows another", async () => {
    const home = await batchOfTwo({ squash: true, rebase: false, merge: false });
    home.host.report([passed("build")]);
    home.host.ready("clean");
    await home.pass();
    await home.pass();
    expect(home.host.merges).toEqual([]);
    expect(home.open().hold).toMatchObject({ reason: "merge-way", checks: [] });
    expect(
      home.heard.notes.filter((note) => isDeepStrictEqual(note, BATCH_WORDS.noWay("meter", "#31"))),
    ).toHaveLength(1);
    // The allowed merges are kept as read, for the reason Settings shows.
    expect(home.record().ways).toEqual({ squash: true, rebase: false, merge: false });

    home.host.ways = { squash: true, rebase: true, merge: false };
    await home.pass();
    expect(home.host.merges.map((merge) => merge.way)).toEqual(["rebase"]);
    expect(home.record().ways).toEqual({ squash: true, rebase: true, merge: false });
  });

  it("waits while the batch's checks run or the host has not said it may merge", async () => {
    const home = await batchOfTwo();
    home.host.report([passed("build"), running("unit-tests")]);
    home.host.ready("clean");
    await home.pass();
    expect(home.host.merges).toEqual([]);
    home.host.report([passed("build"), passed("unit-tests")]);
    home.host.ready("computing");
    await home.pass();
    expect(home.host.merges).toEqual([]);
    expect(home.open().hold).toBeUndefined();
  });

  it("holds a batch the host reads as blocked by a rule, says so once and sends no merge, then merges by itself once the host lets it through", async () => {
    // The plan: the app "follows the host's reading and adds no rule". The live
    // proof on GitHub under a signed-commits rule: the batch's check passed, the
    // host read its pull request as blocked, and the batch waited without a word.
    const home = await batchOfTwo();
    home.host.report([passed("build")]);
    home.host.ready("blocked");
    await home.pass();
    await home.pass();
    expect(home.host.merges).toEqual([]);
    const held = home.open();
    expect(held.hold).toMatchObject({ reason: "rules", head: held.head, checks: [] });
    const said = BATCH_WORDS.blocked("meter", "#31", "GitHub");
    expect(home.heard.notes.filter((note) => isDeepStrictEqual(note, said))).toHaveLength(1);
    expect(home.place(PARSER)).toMatchObject({ state: "waiting", place: "held", hold: "rules" });
    // A rule is no failed check: no repair is started for it.
    expect(home.heard.held).toEqual([]);

    home.host.ready("clean");
    await home.pass();
    expect(home.host.merges).toHaveLength(1);
    expect(home.place(PARSER)).toMatchObject({ state: "merged" });
  });

  it("treats a version with no checks as pending until every change in it was declared to run none", async () => {
    const home = await batchOfTwo();
    home.host.ready("clean");
    await home.pass();
    home.declaredNoChecks.add("t-parser");
    await home.pass();
    expect(home.host.merges).toEqual([]);
    home.declaredNoChecks.add("t-export");
    await home.pass();
    expect(home.host.merges).toHaveLength(1);
  });

  it("waits for a pull request that has yet to follow its pushed branch, and combines again only for a branch that itself moved", async () => {
    const home = await batchOfTwo();
    home.host.report([failed("unit-tests")]);
    await home.pass();
    const held = home.open();
    const pushes = home.heard.pushes.length;

    // Try again pushes a new version; the host's pull request still shows the one before.
    home.host.trails = true;
    await home.batches.answer(REPO, { action: "try-again", head: held.head });
    const pushed = home.open().head;
    expect(pushed).not.toBe(held.head);
    await home.pass();
    await home.pass();
    expect(home.heard.pushes).toHaveLength(pushes + 1);
    expect(home.open().head).toBe(pushed);
    expect(home.host.merges).toEqual([]);

    // The pull request catches up: its checks are read at the pushed version and it merges.
    home.host.trails = false;
    home.host.report([passed("unit-tests")]);
    home.host.ready("clean");
    await home.pass();
    expect(home.host.merges).toEqual([expect.objectContaining({ number: 31, head: pushed })]);

    // A branch someone else moved is not the batch the app combined: it is combined again.
    const moved = setup();
    moved.approve(PARSER);
    await moved.pass();
    const before = moved.open().head;
    moved.host.branches.set(
      "infinitary-batch/3fa9c1d2",
      "c0ffee0123456789abcdef0123456789abcdef01",
    );
    moved.host.carried.set("c0ffee0123456789abcdef0123456789abcdef01", []);
    await moved.pass();
    expect(moved.open().head).not.toBe(before);
    expect(moved.heard.pushes.at(-1)).toMatchObject({
      branch: "infinitary-batch/3fa9c1d2",
      head: moved.open().head,
    });
  });

  it("combines again onto the moved default branch when the host reads the batch behind", async () => {
    const home = await batchOfTwo();
    const first = home.open().head;
    home.host.report([passed("build")]);
    home.host.branches.set("main", "2b4d6f8a0c1e3a5c7e9b1d3f5a7c9e1b3d5f7a9c");
    home.host.ready("behind");
    await home.pass();
    expect(home.host.merges).toEqual([]);
    expect(home.open().base).toBe("2b4d6f8a0c1e3a5c7e9b1d3f5a7c9e1b3d5f7a9c");
    expect(home.open().head).not.toBe(first);
    // The batch branch the app owns moves from the version it last pushed, to the same pull request.
    expect(home.heard.pushes.at(-1)).toEqual({
      branch: "infinitary-batch/3fa9c1d2",
      head: home.open().head,
      expected: first,
    });
    expect([...home.host.pulls.keys()]).toEqual([31]);
  });

  it("closes a change's own pull request with a link once its batch merged", async () => {
    const home = setup();
    home.approve({ ...PARSER, number: 27 });
    home.approve(EXPORT);
    await home.pass();
    home.host.report([passed("build")]);
    home.host.ready("clean");
    await home.pass();
    expect(home.host.notes).toEqual([
      {
        number: 27,
        note: BATCH_WORDS.superseded("#31", "https://github.com/acme/meter/pull/31"),
      },
    ]);
  });

  it("holds a merge the host refused with the host's own words, and never sends it again at that version", async () => {
    const home = await batchOfTwo();
    home.host.report([passed("build")]);
    home.host.ready("clean");
    home.host.refusal = "Commits must have verified signatures.";
    await home.pass();
    await home.pass();
    expect(home.host.merges).toHaveLength(1);
    const held = home.open();
    expect(held.hold).toMatchObject({
      reason: "merge-way",
      head: held.head,
      detail: "Commits must have verified signatures.",
    });
    expect(home.heard.notes.at(-1)).toEqual(
      BATCH_WORDS.refused("meter", "#31", "Commits must have verified signatures."),
    );

    // The host reading it as blocked and then as mergeable again leaves the refusal standing.
    home.host.ready("blocked");
    await home.pass();
    home.host.ready("clean");
    await home.pass();
    expect(home.host.merges).toHaveLength(1);
    expect(home.open().hold).toMatchObject({ reason: "merge-way", head: held.head });

    // Try again makes a new version; the rule was lifted meanwhile, so that one merges.
    home.host.refusal = undefined;
    expect(
      await home.batches.answer(REPO, { action: "try-again", head: held.head }),
    ).toBeUndefined();
    home.host.report([passed("build")]);
    await home.pass();
    expect(home.host.merges.map((merge) => merge.head)).toEqual([
      held.head,
      home.heard.pushes.at(-1)?.head,
    ]);
    expect(home.place(PARSER)).toMatchObject({ state: "merged" });
  });
});

// Intent: the approved plan's piece 5, for batches: a branch with a merge
// queue of GitHub's own takes the batch's pull request, and the batch waits
// "until the host merges or removes it".
// Intent: the captain's approved plan to run a batched project's batch check less often
// (piece 1, "Approve and build"): at most every 3 hours, set in Settings → Projects or by the
// first mate. Its done-when list: with a 3-hour gap, two approvals after a batch formed join
// one batch formed 3 hours after the previous one, and a held batch's fix reruns at once.
// With no gap a batch forms as today, which the tests above keep.
describe("the batch gap", () => {
  const HOURS_3 = 3 * 60 * 60 * 1000;

  it("keeps two approvals after a batch formed in line, saying when the next batch starts, then forms one batch with both 3 hours after the previous one", async () => {
    const home = setup();
    home.repos.configure(REPO, { batchGap: 180 });
    home.approve(PARSER);
    await home.pass();
    const formed = home.record().formed as number;
    expect(home.open()).toMatchObject({ number: 31, since: formed });
    home.host.report([passed("build")]);
    home.host.ready("clean");
    await home.pass();
    expect(home.place(PARSER)).toMatchObject({ state: "merged" });

    home.approve(LEGEND);
    await home.pass();
    home.advance(60 * 60 * 1000);
    home.approve(FIX);
    await home.pass();
    expect(home.record().open).toBeUndefined();
    expect(home.record().line.map((change) => change.taskId)).toEqual(["t-legend", "t-fix"]);
    expect([...home.host.pulls.keys()]).toEqual([31]);
    expect(home.batches.status(REPO, FIX.taskId, FIX.head)).toEqual({
      kind: "waiting",
      words: BATCH_STATUS_WORDS.waitingUntil(
        formatTime(formed + HOURS_3, { hour: "numeric", minute: "2-digit" }),
      ),
    });

    // The first pass once 3 hours have passed since the previous batch started.
    home.advance(2 * 60 * 60 * 1000);
    await home.pass();
    expect(home.open()).toMatchObject({ number: 32 });
    expect(home.members()).toEqual(["t-legend", "t-fix"]);
    expect(home.record().formed).toBeGreaterThanOrEqual(formed + HOURS_3);
  });

  it("lets a held batch's declared fix join it at once while the gap runs", async () => {
    const home = await batchOfTwo();
    home.repos.configure(REPO, { batchGap: 180 });
    home.host.report([passed("build"), failed("unit-tests")]);
    await home.pass();
    const held = home.open();
    expect(held.hold).toMatchObject({ reason: "checks" });

    expect(await home.batches.declareFix(REPO, FIX.taskId)).toBeUndefined();
    home.approve(FIX);
    await home.pass();
    expect(home.members()).toEqual(["t-parser", "t-export", "t-fix"]);
    expect(home.open().hold).toBeUndefined();
    expect(home.open().head).not.toBe(held.head);
    // The repair answers the open batch; the gap still counts from when it formed.
    expect(home.record().formed).toBe(held.since);
  });
});

describe("a batch on a branch with GitHub's merge queue", () => {
  async function queuedBatch() {
    const home = await batchOfTwo();
    home.host.mergeQueue = true;
    home.host.report([passed("build")]);
    home.host.ready("clean");
    await home.pass();
    return home;
  }

  it("hands the batch to the queue, waits there without sending again, and settles its tasks once GitHub merges it", async () => {
    const home = await queuedBatch();
    const head = home.open().head;
    expect(home.host.merges).toEqual([expect.objectContaining({ number: 31, head })]);
    expect(home.open()).toMatchObject({ queued: head });
    expect(home.open().hold).toBeUndefined();
    expect(home.heard.notes.at(-1)).toEqual(BATCH_WORDS.queued("meter", "#31", "GitHub"));
    // Queued is not merged: no receipt, no task settled.
    expect(home.place(PARSER)).not.toMatchObject({ state: "merged" });
    expect(home.heard.settled).toEqual([]);

    // Later passes, and the app starting again, read the queue and send nothing.
    const reads = home.host.queueReads;
    await home.pass();
    await home.restart();
    expect(home.host.queueReads).toBe(reads + 2);
    expect(home.host.merges).toHaveLength(1);
    expect(home.open()).toMatchObject({ queued: head });

    // GitHub's queue merges it, each change its own commit.
    home.host.queued.delete(31);
    home.host.land(31, "rebase");
    await home.pass();
    expect(home.record().open).toBeUndefined();
    expect(home.place(PARSER)).toMatchObject({
      state: "merged",
      receipt: { sha: home.host.main[0]?.sha, number: 31 },
    });
    expect(home.place(EXPORT)).toMatchObject({
      state: "merged",
      receipt: { sha: home.host.main[1]?.sha, number: 31 },
    });
    expect(home.heard.settled).toEqual([["t-parser", "t-export"]]);
    expect(home.host.merges).toHaveLength(1);
  });

  it("holds a batch GitHub removed from its queue, never sends that version again, and sends the new version Try again makes", async () => {
    const home = await queuedBatch();
    const head = home.open().head;
    // GitHub removes it: the pull request is open and out of the queue.
    home.host.queued.delete(31);
    await home.pass();
    expect(home.open().queued).toBeUndefined();
    expect(home.open().hold).toMatchObject({
      reason: "merge-way",
      head,
      detail: BATCH_WORDS.removed("GitHub"),
    });
    expect(home.heard.notes.at(-1)).toEqual(BATCH_WORDS.removedHeld("meter", "#31", "GitHub"));
    const told = home.heard.notes.length;
    await home.pass();
    await home.pass();
    expect(home.host.merges).toHaveLength(1);
    expect(home.heard.notes).toHaveLength(told);

    // Try again makes a new version, which goes to the queue once its checks pass.
    expect(await home.batches.answer(REPO, { action: "try-again", head })).toBeUndefined();
    home.host.report([passed("build")]);
    await home.pass();
    const again = home.heard.pushes.at(-1)?.head;
    expect(again).not.toBe(head);
    expect(home.host.merges.map((merge) => merge.head)).toEqual([head, again]);
    expect(home.open()).toMatchObject({ queued: again });
  });
});

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
    // The rest of the batch and the change that waited go on as one batch, on the same pull request.
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

    // The next pass reads the pull request again and rewrites it once.
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
    // Declared, not yet approved: the batch stays held as it was.
    await home.pass();
    expect(home.open()).toEqual(held);

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

    // The app closes and opens again: the declaration and the mark are on the saved record.
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

    // The batch merges with the fix: the declaration and the versions that held are forgotten.
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
    const lost = "c0ffee0123456789abcdef0123456789abcdef01";
    home.host.branches.set(held.branch, lost);
    home.host.carried.set(lost, []);
    expect(
      await home.batches.answer(REPO, { action: "try-again", head: held.head }),
    ).toBeUndefined();
    expect(home.members()).toEqual(["t-parser"]);
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

describe("an approval withdrawn", () => {
  it("takes the change out of the open batch, which combines again without it", async () => {
    const home = await batchOfTwo();
    const first = home.open().head;
    await home.batches.withdraw(REPO, "t-export");
    await home.pass();
    expect(home.members()).toEqual(["t-parser"]);
    expect(home.open().head).not.toBe(first);
    expect(home.open().stale).toBeUndefined();
    // The pull request now carries one change, so it reads as that change's own.
    expect((home.host.pulls.get(31) as StandInPull).title).toBe(PARSER.title);
    expect(home.place(EXPORT)).toBeUndefined();
  });

  it("carries no further a change whose approval ended since it joined", async () => {
    const home = await batchOfTwo();
    home.approvals.delete("t-parser");
    await home.pass();
    expect(home.members()).toEqual(["t-export"]);
  });

  it("closes the pull request and drops the branch once every change was withdrawn", async () => {
    const home = await batchOfTwo();
    await home.batches.withdraw(REPO, "t-parser");
    await home.batches.withdraw(REPO, "t-export");
    await home.pass();
    expect(home.record().open).toBeUndefined();
    expect((home.host.pulls.get(31) as StandInPull).state).toBe("closed");
    expect(home.host.branches.has("infinitary-batch/3fa9c1d2")).toBe(false);
    expect(home.host.merges).toEqual([]);
  });

  it("takes a waiting change out of the line", async () => {
    const home = await batchOfTwo();
    home.approve(LEGEND);
    await home.batches.withdraw(REPO, "t-legend");
    await home.pass();
    expect(home.record().line).toEqual([]);
    expect(home.members()).toEqual(["t-parser", "t-export"]);
  });

  it("merges only approved work: an approval that ends as the batch turns green leaves before the merge", async () => {
    const home = await batchOfTwo();
    home.host.report([passed("build")]);
    home.host.ready("clean");
    // The captain's reply ends the approval after this pass's first look.
    home.host.beforeChecks = () => {
      home.approvals.delete("t-export");
      home.host.beforeChecks = undefined;
    };
    await home.pass();
    expect(home.host.merges).toEqual([]);
    expect(home.members()).toEqual(["t-parser"]);
    expect(home.host.main).toEqual([]);
  });
});

// The independent review's finding on this change, a bug being fixed, with the captain's
// answer to it: a change whose story is revised at its approved version stays in its batch,
// which only takes the story's title and words.
describe("a story revised at the approved version", () => {
  const RETITLED = {
    taskId: PARSER.taskId,
    head: PARSER.head,
    title: "fix(parser): read a date's time zone as written",
    body: "- A date keeps the time zone it was written with.",
  };
  const asItWas = (change: BatchChange) => ({
    taskId: change.taskId,
    head: change.head,
    title: change.title,
    body: change.body,
  });

  it("rewrites only the description when the commit words read as they did: no new version, no checks run again", async () => {
    const home = await batchOfTwo();
    const pull = home.host.pulls.get(31) as StandInPull;
    const version = pull.head;
    home.retold.set(EXPORT.taskId, "A report could not leave the app.");
    await home.batches.revise(REPO, asItWas(EXPORT));
    await home.pass();
    expect(pull.body).toContain("A report could not leave the app.");
    expect(home.host.rewrites).toEqual([{ number: 31, title: "chore: merge 2 approved changes" }]);
    expect(pull.head).toBe(version);
    expect(home.heard.pushes).toHaveLength(1);
    expect(home.members()).toEqual(["t-parser", "t-export"]);
    await home.pass();
    expect(home.host.rewrites).toHaveLength(1);
  });

  it("combines the batch again in place when the commit words changed: the same pull request, the same order, the commit under its new title", async () => {
    const home = await batchOfTwo();
    const pull = home.host.pulls.get(31) as StandInPull;
    const version = pull.head;
    await home.batches.revise(REPO, RETITLED);
    await home.pass();
    expect([...home.host.pulls.keys()]).toEqual([31]);
    expect(pull.state).toBe("open");
    expect(home.members()).toEqual(["t-parser", "t-export"]);
    expect(home.host.carried.get(pull.head)?.map((commit) => commit.title)).toEqual([
      RETITLED.title,
      EXPORT.title,
    ]);
    // The new version went over the one the app pushed, to the same branch.
    expect(home.heard.pushes.at(-1)).toMatchObject({
      branch: "infinitary-batch/3fa9c1d2",
      expected: version,
    });
    expect(pull.body).toContain(`- ${RETITLED.title}\n- ${EXPORT.title}`);
    expect(home.place(PARSER)).toMatchObject({ state: "waiting", place: "batch", number: 31 });
  });

  it("keeps a batch of one's pull request open under the story's new title, never closing and opening another", async () => {
    const home = setup();
    home.approve(PARSER);
    await home.pass();
    await home.batches.revise(REPO, RETITLED);
    await home.pass();
    expect([...home.host.pulls.keys()]).toEqual([31]);
    const pull = home.host.pulls.get(31) as StandInPull;
    expect(pull).toMatchObject({ state: "open", title: RETITLED.title });
    expect(home.host.branches.get("infinitary-batch/3fa9c1d2")).toBe(pull.head);
    // It merges as that change's own pull request would, under the revised words.
    home.host.report([passed("unit-tests")]);
    home.host.ready("clean");
    await home.pass();
    expect(home.host.merges).toMatchObject([
      { number: 31, way: "squash", title: RETITLED.title, body: RETITLED.body },
    ]);
  });

  it("sends no change back from a held batch: the hold stays for a story whose commit words read as they did", async () => {
    const home = await batchOfTwo();
    home.host.report([failed("unit-tests")]);
    await home.pass();
    const held = home.open().hold;
    expect(held).toMatchObject({ reason: "checks" });
    home.retold.set(EXPORT.taskId, "A report could not leave the app.");
    await home.batches.revise(REPO, asItWas(EXPORT));
    await home.pass();
    expect(home.open().hold).toEqual(held);
    expect(home.members()).toEqual(["t-parser", "t-export"]);
    expect(home.heard.sentBack).toEqual([]);
    expect((home.host.pulls.get(31) as StandInPull).body).toContain(
      "A report could not leave the app.",
    );

    // New commit words make a new version of the same changes, whose checks run again.
    await home.batches.revise(REPO, RETITLED);
    await home.pass();
    expect(home.members()).toEqual(["t-parser", "t-export"]);
    expect(home.heard.sentBack).toEqual([]);
    expect(home.open().hold).toBeUndefined();
    expect(home.heard.pushes).toHaveLength(2);
  });

  it("keeps a waiting change's place in line under the story's new words", async () => {
    const home = await batchOfTwo();
    home.approve(LEGEND);
    await home.approve(AXIS);
    await home.batches.revise(REPO, {
      ...asItWas(LEGEND),
      title: "fix(chart): keep the legend clear of the bars",
    });
    await home.pass();
    expect(home.record().line.map((change) => change.title)).toEqual([
      "fix(chart): keep the legend clear of the bars",
      AXIS.title,
    ]);
    expect(home.heard.pushes).toHaveLength(1);
  });

  it("takes the batch's version of a change out when its story is confirmed at another version", async () => {
    const home = await batchOfTwo();
    await home.batches.revise(REPO, { ...RETITLED, head: LEGEND.head });
    await home.pass();
    expect(home.members()).toEqual(["t-export"]);
    expect(home.place(PARSER)).toBeUndefined();
  });
});

describe("after a restart", () => {
  it("adopts the pull request the host already holds when its confirmation was lost, and opens no second one", async () => {
    const home = setup();
    home.host.loseNextOpen = true;
    home.approve(PARSER);
    home.approve(EXPORT);
    await home.pass();
    expect(home.open().number).toBeUndefined();
    expect(home.host.pulls.size).toBe(1);
    home.host.offline = false;

    await home.restart();
    expect([...home.host.pulls.keys()]).toEqual([31]);
    expect(home.open()).toMatchObject({ number: 31, url: "https://github.com/acme/meter/pull/31" });
    expect(home.heard.notes).toEqual([BATCH_WORDS.formed("meter", "#31", 2)]);
  });

  it("reads the open pull request once and rewrites nothing that already carries the batch's words", async () => {
    const home = await batchOfTwo();
    await home.restart();
    await home.pass();
    expect(home.host.rewrites).toEqual([]);

    // A rewrite that never reached the host before the app closed is sent after it opens again.
    const pull = home.host.pulls.get(31) as StandInPull;
    pull.title = "chore: merge 3 approved changes";
    await home.restart();
    expect(home.host.rewrites).toEqual([{ number: 31, title: "chore: merge 2 approved changes" }]);
  });

  it("reads a batch that merged while the app was closed: receipts, the branch dropped, the tasks settled", async () => {
    const home = await batchOfTwo();
    home.host.land(31, "rebase");
    await home.restart();
    expect(home.record().open).toBeUndefined();
    expect(home.place(PARSER)).toMatchObject({
      state: "merged",
      receipt: { sha: home.host.main[0]?.sha, number: 31 },
    });
    expect(home.place(EXPORT)).toMatchObject({
      state: "merged",
      receipt: { sha: home.host.main[1]?.sha },
    });
    expect(home.host.branches.has("infinitary-batch/3fa9c1d2")).toBe(false);
    expect(home.heard.settled).toEqual([["t-parser", "t-export"]]);
    // The app sent no merge of its own.
    expect(home.host.merges).toEqual([]);
  });

  it("puts the changes back at the front of the line when the pull request was closed unmerged, and forms the next batch", async () => {
    const home = await batchOfTwo();
    home.approve(LEGEND);
    await home.pass();
    (home.host.pulls.get(31) as StandInPull).state = "closed";
    await home.restart();
    expect(home.host.branches.has("infinitary-batch/3fa9c1d2")).toBe(false);
    expect(home.open()).toMatchObject({ number: 32, branch: "infinitary-batch/8be04a67" });
    expect(home.members()).toEqual(["t-parser", "t-export", "t-legend"]);
  });

  it("keeps a held batch held without telling the first mate again", async () => {
    const home = await batchOfTwo();
    home.host.report([failed("unit-tests")]);
    await home.pass();
    await home.restart();
    expect(home.open().hold).toMatchObject({ reason: "checks", checks: ["unit-tests"] });
    expect(home.heard.held).toHaveLength(1);
  });

  it("drops a merged change's receipt once its task closed", async () => {
    const home = await batchOfTwo();
    home.host.report([passed("build")]);
    home.host.ready("clean");
    await home.pass();
    expect(home.record().receipts.map((receipt) => receipt.taskId)).toEqual([
      "t-parser",
      "t-export",
    ]);
    home.closedTasks.add("t-parser");
    home.closedTasks.add("t-export");
    await home.restart();
    expect(home.repos.get(REPO)?.batch?.receipts ?? []).toEqual([]);
  });
});

// Intent: INF-4517 piece 3 with the captain's choice on the review's question ("Follow the next
// part's commits; tell its crewmate to rebuild without it"): a later part approved into line
// behind an earlier part waits there, and once that earlier part closes without merging, it gets
// its turn: left out in words while its branch carries that work, carried once rebuilt without it.
describe("a later part whose earlier part closes without merging", () => {
  const APPROVED_EXPORT = "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00";
  const PANEL: BatchChange = {
    taskId: "t-panel",
    branch: "fm/task-panel",
    head: "6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b",
    title: "feat(export): show the CSV export in the report panel",
    body: "- The report panel offers the CSV export.",
    at: 5_000,
    base: EXPORT.branch,
    after: EXPORT.taskId,
  };

  it("leaves it out with words to rebuild while it carries that work, and carries it rebuilt", async () => {
    const home = setup();
    home.carryingBase.add(PANEL.head);
    await home.approve(PANEL);
    await home.pass();
    // Its earlier part is live and not in a batch: it waits in line, with no note.
    expect(home.record().line.map((change) => change.taskId)).toEqual([PANEL.taskId]);
    expect(home.heard.taskNotes).toEqual([]);

    // The earlier part is dropped: it was never merged.
    home.closedTasks.add(EXPORT.taskId);
    home.unmergedBases.set(PANEL.taskId, APPROVED_EXPORT);
    await home.pass();
    const reason = LEFT_OUT_WORDS.baseClosed(APPROVED_EXPORT);
    expect(home.record().line).toEqual([]);
    expect(home.record().leftOut.map((entry) => entry.taskId)).toEqual([PANEL.taskId]);
    expect(home.heard.taskNotes).toEqual([
      { taskId: PANEL.taskId, text: BATCH_WORDS.leftOut(reason) },
    ]);
    expect(home.members()).toEqual([]);

    // Its crewmate rebuilds without that work, and the captain approves the new version.
    const rebuilt = { ...PANEL, head: "1b2c3d4e5f60718293a4b5c6d7e8f90123456789", at: 6_000 };
    await home.approve(rebuilt);
    await home.pass();
    expect(home.members()).toEqual([PANEL.taskId]);
    expect(home.open().members[0]?.head).toBe(rebuilt.head);
  });
});
