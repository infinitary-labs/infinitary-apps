import { BATCH_STATUS_WORDS, type BatchChange } from "@shared/batches";
import { formatTime } from "@shared/i18n/format";
import { describe, expect, it } from "vitest";
import { failed, passed, REPO, running, setup } from "../../../tests/helpers/batchesHarness";
import { BATCH_WORDS } from "./batches";

// Intent: the captain's approved plan for a held batch's declared fix (docs/forge.md, "A held
// batch"): once the fix's story is confirmed on its own branch, the batch runs its own checks
// at the held version plus the fix; at the fix's approval, a passed run at that same version
// merges that exact commit, otherwise the batch combines with the line as before; and changes
// waiting in line then wait for the project's batch gap (the captain's answer). The project and
// its host are `batchesHarness.ts`.

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
/** The repair's own change, declared the held batch's fix and built on its held version. */
const FIX: BatchChange = {
  taskId: "t-fix",
  branch: "fm/task-fix",
  head: "3c2b1a0918f7e6d5c4b3a2918070f6e5d4c3b2a1",
  title: "fix(export): read dates through the parser's new form",
  body: "- The export reads dates as the parser now writes them.",
  at: 7_000,
};
const FIX_AGAIN: BatchChange = { ...FIX, head: "b8e1f04a7c2d9e5b3f6a0c8d1e4b7a2f5c9d0e3b" };
const HOURS_3 = 3 * 60 * 60 * 1000;

/**
 * Two approved changes held on a failed check, a third waiting in line, and a fix
 * declared and built on the held version, its story not confirmed yet.
 */
async function heldWithFix() {
  const home = setup();
  home.repos.configure(REPO, { batchGap: 180 });
  home.approve(PARSER);
  home.approve(EXPORT);
  await home.pass();
  home.host.report([passed("build"), failed("unit-tests")]);
  await home.pass();
  home.approve(LEGEND);
  await home.pass();
  const held = home.open();
  home.builtOn.set(FIX.head, held.head);
  home.builtOn.set(FIX_AGAIN.head, held.head);
  expect(await home.batches.declareFix(REPO, FIX.taskId, FIX.head)).toBeUndefined();
  await home.pass();
  return { home, held };
}

/** The fix's crewmate confirms its story at its version on its own branch. */
async function confirm(home: ReturnType<typeof setup>, change: BatchChange) {
  const { taskId, branch, head, title, body } = change;
  await home.batches.revise(REPO, { taskId, branch, head, title, body });
  await home.pass();
}

describe("a held batch's early run with its declared fix", () => {
  it("runs the batch's checks at the held version plus the fix once its story is confirmed, keeping the line out", async () => {
    const { home, held } = await heldWithFix();
    const pushes = home.heard.pushes.length;

    await confirm(home, FIX);

    const trial = home.open().trial;
    expect(trial).toMatchObject({ task: FIX.taskId, version: FIX.head, base: held.base });
    expect(trial?.members.map((member) => member.taskId)).toEqual([
      "t-parser",
      "t-export",
      "t-fix",
    ]);
    expect(trial?.members.at(-1)?.heldBase).toBe(held.head);
    // Pushed to the batch's own branch, where its pull request runs the checks.
    expect(home.heard.pushes.slice(pushes)).toEqual([
      { branch: held.branch, head: trial?.head, expected: held.head },
    ]);
    expect(home.host.pulls.get(31)?.head).toBe(trial?.head);
    expect([...home.host.pulls.keys()]).toEqual([31]);
    // The batch stays held at its version: nothing merged, the line still waits.
    expect(home.open()).toMatchObject({ head: held.head, hold: { head: held.head } });
    expect(home.members()).toEqual(["t-parser", "t-export"]);
    expect(home.record().line.map((change) => change.taskId)).toEqual(["t-legend"]);
    expect(home.host.merges).toEqual([]);
    expect(home.heard.notes).toContainEqual(BATCH_WORDS.trial("meter", "#31"));
    expect(home.heard.taskNotes).toContainEqual({
      taskId: FIX.taskId,
      text: BATCH_WORDS.trialTask("#31"),
    });

    // The same story confirmed again starts nothing new.
    await confirm(home, FIX);
    expect(home.heard.pushes).toHaveLength(pushes + 1);
  });

  it("merges the run's exact commit once the fix is approved at that version and the run passed, and the line waits for the gap", async () => {
    const { home, held } = await heldWithFix();
    await confirm(home, FIX);
    const trial = home.open().trial;
    home.host.report([passed("build"), passed("unit-tests")]);
    home.host.ready("clean");
    await home.pass();
    // Passed but not approved: it waits for the approval and merges nothing.
    expect(home.host.merges).toEqual([]);
    expect(home.batches.status(REPO, FIX.taskId, FIX.head)).not.toMatchObject({ kind: "failed" });

    await home.approve(FIX);
    await home.pass();

    expect(home.host.merges).toEqual([expect.objectContaining({ number: 31, head: trial?.head })]);
    for (const change of [PARSER, EXPORT, FIX])
      expect(home.place(change)).toMatchObject({ state: "merged" });
    expect(home.heard.settled.flat()).toEqual(
      expect.arrayContaining(["t-parser", "t-export", "t-fix"]),
    );
    expect(home.record().fixes ?? []).toEqual([]);
    // The line did not join, and waits for the project's batch gap from when the held batch formed.
    expect(home.record().open).toBeUndefined();
    expect(home.record().line.map((change) => change.taskId)).toEqual(["t-legend"]);
    expect(home.batches.status(REPO, LEGEND.taskId, LEGEND.head)).toEqual({
      kind: "waiting",
      words: BATCH_STATUS_WORDS.waitingUntil(
        formatTime((held.since as number) + HOURS_3, { hour: "numeric", minute: "2-digit" }),
      ),
    });
    home.advance(HOURS_3);
    await home.pass();
    expect(home.members()).toEqual(["t-legend"]);
  });

  it("combines with the line as before when the fix is approved while the run still runs", async () => {
    const { home, held } = await heldWithFix();
    await confirm(home, FIX);
    const trial = home.open().trial;
    home.host.report([passed("build"), running("unit-tests")]);

    await home.approve(FIX);
    await home.pass();

    expect(home.members()).toEqual(["t-parser", "t-export", "t-fix", "t-legend"]);
    expect(home.open().trial).toBeUndefined();
    expect(home.open().hold).toBeUndefined();
    expect([held.head, trial?.head]).not.toContain(home.open().head);
    expect(home.host.merges).toEqual([]);
  });

  it("combines with the line as before when the fix is approved at another version than the run's", async () => {
    const { home } = await heldWithFix();
    await confirm(home, FIX);
    home.host.report([passed("build"), passed("unit-tests")]);
    home.host.ready("clean");
    await home.pass();

    await home.approve(FIX_AGAIN);
    await home.pass();

    expect(home.host.merges).toEqual([]);
    expect(home.members()).toEqual(["t-parser", "t-export", "t-fix", "t-legend"]);
    expect(home.open().members.find((member) => member.taskId === "t-fix")?.head).toBe(
      FIX_AGAIN.head,
    );
    expect(home.open().trial).toBeUndefined();
  });

  it("keeps the hold when the run fails, tells the fix's crewmate once, and stays held when that version is approved anyway", async () => {
    const { home, held } = await heldWithFix();
    await confirm(home, FIX);
    home.host.report([passed("build"), failed("unit-tests")]);
    await home.pass();
    await home.pass();

    expect(home.heard.trialFailed).toEqual([{ task: FIX.taskId, failed: ["unit-tests"] }]);
    expect(home.heard.notes).toContainEqual(
      BATCH_WORDS.trialFailed("meter", "#31", ["unit-tests"]),
    );
    expect(home.open()).toMatchObject({ head: held.head, hold: { head: held.head } });
    expect(home.batches.status(REPO, FIX.taskId, FIX.head)).toMatchObject({ kind: "failed" });

    await home.approve(FIX);
    await home.pass();
    expect(home.host.merges).toEqual([]);
    expect(home.open()).toMatchObject({ head: held.head, hold: { head: held.head } });
    expect(home.members()).toEqual(["t-parser", "t-export"]);
    expect(home.heard.trialFailed).toHaveLength(1);
  });

  it("starts a new run for a new version of the fix in place of the earlier one", async () => {
    const { home, held } = await heldWithFix();
    await confirm(home, FIX);
    const first = home.open().trial?.head;
    home.host.report([passed("build"), failed("unit-tests")]);
    await home.pass();

    await confirm(home, FIX_AGAIN);

    const trial = home.open().trial;
    expect(trial).toMatchObject({ version: FIX_AGAIN.head });
    expect(trial?.head).not.toBe(first);
    expect(trial?.failed).toBeUndefined();
    expect(home.heard.pushes.at(-1)).toEqual({
      branch: held.branch,
      head: trial?.head,
      expected: first,
    });
    expect(home.open().hold).toMatchObject({ head: held.head });
  });

  it("leaves the batch held, merging nothing, once the fix's task closed", async () => {
    const { home, held } = await heldWithFix();
    await confirm(home, FIX);
    home.host.report([passed("build"), passed("unit-tests")]);
    home.host.ready("clean");
    home.closedTasks.add(FIX.taskId);
    await home.pass();
    await home.pass();

    expect(home.host.merges).toEqual([]);
    expect(home.open()).toMatchObject({ head: held.head, hold: { head: held.head } });
    expect(home.members()).toEqual(["t-parser", "t-export"]);
  });

  it("drops the run and combines as before when a held member's approval ends", async () => {
    const { home, held } = await heldWithFix();
    await confirm(home, FIX);
    home.host.report([passed("build"), passed("unit-tests")]);
    home.host.ready("clean");

    await home.batches.withdraw(REPO, EXPORT.taskId);
    await home.pass();

    expect(home.open().trial).toBeUndefined();
    expect(home.host.merges).toEqual([]);
    expect(home.members()).not.toContain("t-export");
    expect(home.open().head).not.toBe(held.head);
  });
});
