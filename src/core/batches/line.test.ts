import {
  BATCH_STATUS_WORDS,
  type BatchChange,
  type BatchMember,
  type BatchRecord,
  EMPTY_BATCH_RECORD,
} from "@shared/batches";
import { describe, expect, it } from "vitest";
import { BATCH_WAITING_WORDS } from "../forge";
import type { Combined } from "./combine";
import {
  batchStatus,
  carried,
  combined,
  enqueue,
  fixWaits,
  forms,
  hold,
  merged,
  pruned,
  release,
  reopened,
  reworded,
  standing,
  withdraw,
} from "./line";

// Intent: the captain's approved plan for batches of their own, piece 1: a project's line
// of approved changes and its one open batch, as the rules its done-when list names - the
// formation rule, a change left out, two changes sent back, a fix ending a hold, an
// approval withdrawn and receipts.

const BASE = "9d1c7e2a4b6f8091a3c5e7d9f1b3a5c7e9d1f3b5";
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

const member = (change: BatchChange, commit: string): BatchMember => ({ ...change, commit });
const PARSER_COMMIT = "1111111111111111111111111111111111111111";
const EXPORT_COMMIT = "2222222222222222222222222222222222222222";
const LEGEND_COMMIT = "3333333333333333333333333333333333333333";

/** What a combine of `changes` onto the default branch answers, the last commit its version. */
function combineOf(members: BatchMember[], leftOut: Combined["leftOut"] = []): Combined {
  return { base: BASE, head: members.at(-1)?.commit ?? BASE, members, leftOut };
}

/** Two approved changes combined and opened as pull request #31. */
function openBatch(): BatchRecord {
  const line = enqueue(enqueue(EMPTY_BATCH_RECORD, PARSER), EXPORT);
  const pushed = combined(
    line,
    combineOf([member(PARSER, PARSER_COMMIT), member(EXPORT, EXPORT_COMMIT)]),
    { branch: "infinitary-batch/7c41", at: 5_000 },
  );
  return {
    ...pushed,
    open: {
      ...(pushed.open as NonNullable<BatchRecord["open"]>),
      number: 31,
      url: "https://github.com/acme/meter/pull/31",
    },
  };
}

describe("the formation rule", () => {
  it("forms a batch once one change is in line and none of this home's is open", () => {
    expect(forms(EMPTY_BATCH_RECORD)).toBe(false);
    expect(forms(enqueue(EMPTY_BATCH_RECORD, PARSER))).toBe(true);
  });

  it("keeps changes approved meanwhile in line while a batch is open", () => {
    const waiting = enqueue(openBatch(), LEGEND);
    expect(forms(waiting)).toBe(false);
    expect(waiting.line).toEqual([LEGEND]);
    expect(standing(waiting, LEGEND.taskId, LEGEND.head)).toEqual({
      state: "waiting",
      place: "line",
    });
  });

  it("takes the whole line, in approval order, whatever order the approvals were saved in", () => {
    const line = enqueue(enqueue(enqueue(EMPTY_BATCH_RECORD, LEGEND), PARSER), EXPORT);
    expect(carried(line).map((change) => change.taskId)).toEqual([
      "t-parser",
      "t-export",
      "t-legend",
    ]);
  });
});

// Intent: the captain's approved plan to run a batched project's batch check less often
// (piece 1, "Approve and build"): with a batch gap, changes approved after a batch formed
// wait and go up together once the gap from that batch's start has passed; a held batch's
// repair never waits; with no gap a batch forms at once, as before.
describe("the batch gap", () => {
  const HOURS_3 = 180;
  const GAP_MS = HOURS_3 * 60_000;

  /** The open batch #31, formed at 5_000, merged at 8_000, then two changes approved. */
  function afterMerge(): BatchRecord {
    const done = merged(openBatch(), new Map(), 8_000);
    return enqueue(enqueue(done, { ...LEGEND, at: 9_000 }), {
      ...PARSER,
      head: EXPORT_COMMIT,
      at: 10_000,
    });
  }

  it("keeps two approvals in line until the gap from the last batch's start has passed, then takes both", () => {
    const record = afterMerge();
    expect(record.formed).toBe(5_000);
    expect(forms(record, HOURS_3, 10_000)).toBe(false);
    expect(forms(record, HOURS_3, 5_000 + GAP_MS - 1)).toBe(false);
    expect(forms(record, HOURS_3, 5_000 + GAP_MS)).toBe(true);
    const next = combined(
      record,
      combineOf([
        member(LEGEND, LEGEND_COMMIT),
        member({ ...PARSER, head: EXPORT_COMMIT }, PARSER_COMMIT),
      ]),
      { branch: "infinitary-batch/9a02", at: 5_000 + GAP_MS },
    );
    expect(next.open?.members.map((entry) => entry.taskId)).toEqual(["t-legend", "t-parser"]);
    expect(next.formed).toBe(5_000 + GAP_MS);
  });

  it("forms at once with no gap, or when the project has had no batch yet", () => {
    expect(forms(afterMerge(), undefined, 10_000)).toBe(true);
    expect(forms(enqueue(EMPTY_BATCH_RECORD, PARSER), HOURS_3, 1_000)).toBe(true);
  });

  it("moves nothing when the open batch is combined again, as a held batch's repair does", () => {
    const held = hold(openBatch(), {
      at: 6_000,
      head: EXPORT_COMMIT,
      reason: "checks",
      checks: ["typecheck-lint-build"],
    }).record;
    const fixed = enqueue(held, { ...LEGEND, fix: true, at: 7_000 });
    // The repair answers the open batch, which the gap never holds: its fix joins at once.
    expect(fixWaits(fixed)).toBe(true);
    const again = combined(
      release(fixed),
      combineOf([
        member(PARSER, PARSER_COMMIT),
        member(EXPORT, EXPORT_COMMIT),
        member(LEGEND, LEGEND_COMMIT),
      ]),
      { branch: "infinitary-batch/7c41", at: 7_500 },
    );
    expect(again.open?.members).toHaveLength(3);
    expect(again.formed).toBe(5_000);
  });
});

describe("a combine's result on the record", () => {
  it("opens the batch with one commit per change and empties the line of what it carried", () => {
    const record = openBatch();
    expect(record.line).toEqual([]);
    expect(record.open).toMatchObject({
      branch: "infinitary-batch/7c41",
      head: EXPORT_COMMIT,
      base: BASE,
      members: [
        { taskId: "t-parser", commit: PARSER_COMMIT },
        { taskId: "t-export", commit: EXPORT_COMMIT },
      ],
      since: 5_000,
    });
  });

  it("leaves a change out with its reason while the rest go on", () => {
    const line = enqueue(enqueue(EMPTY_BATCH_RECORD, PARSER), EXPORT);
    const reason = "it no longer combines with the default branch";
    const record = combined(
      line,
      combineOf([member(PARSER, PARSER_COMMIT)], [{ change: EXPORT, reason }]),
      { branch: "infinitary-batch/7c41", at: 5_000 },
    );
    expect(record.open?.members.map((entry) => entry.taskId)).toEqual(["t-parser"]);
    expect(record.line).toEqual([]);
    expect(standing(record, EXPORT.taskId, EXPORT.head)).toEqual({ state: "left-out", reason });
    expect(batchStatus({ state: "left-out", reason })).toEqual({
      kind: "failed",
      words: BATCH_STATUS_WORDS.leftOut(reason),
    });
    // A new version of that change joins the line again and its note goes.
    const repaired = enqueue(record, { ...EXPORT, head: LEGEND.head, at: 6_000 });
    expect(repaired.leftOut).toEqual([]);
    expect(repaired.line.map((change) => change.head)).toEqual([LEGEND.head]);
  });

  it("opens no batch when nothing combined", () => {
    const line = enqueue(EMPTY_BATCH_RECORD, PARSER);
    const record = combined(
      line,
      combineOf([], [{ change: PARSER, reason: "it changes nothing" }]),
      {
        branch: "infinitary-batch/7c41",
        at: 5_000,
      },
    );
    expect(record.open).toBeUndefined();
    expect(forms(record)).toBe(false);
  });

  it("keeps the pull request and its start when the open batch is combined again", () => {
    const again = combined(
      openBatch(),
      combineOf([member(PARSER, LEGEND_COMMIT), member(EXPORT, PARSER_COMMIT)]),
      { branch: "infinitary-batch/7c41", at: 9_000 },
    );
    expect(again.open).toMatchObject({ number: 31, since: 5_000, head: PARSER_COMMIT });
    expect(again.open?.hold).toBeUndefined();
  });
});

describe("a held batch", () => {
  const failed = {
    at: 6_000,
    head: EXPORT_COMMIT,
    reason: "checks" as const,
    checks: ["unit-tests"],
  };

  it("is told to its owner once for each held version", () => {
    const first = hold(openBatch(), failed);
    expect(first.fresh).toBe(true);
    expect(hold(first.record, { ...failed, at: 7_000 }).fresh).toBe(false);
    expect(hold(first.record, { ...failed, head: LEGEND_COMMIT }).fresh).toBe(true);
  });

  it("reads as held for each change of several, and as failed for its only change", () => {
    const several = hold(openBatch(), failed).record;
    expect(standing(several, PARSER.taskId, PARSER.head)).toMatchObject({
      state: "waiting",
      place: "held",
      number: 31,
    });
    expect(batchStatus(standing(several, PARSER.taskId, PARSER.head) as never)).toEqual({
      kind: "paused",
      words: BATCH_STATUS_WORDS.held("checks"),
      link: "https://github.com/acme/meter/pull/31",
    });
    // A batch a rule of the default branch holds says that, never that its checks failed.
    const blocked = hold(openBatch(), { ...failed, reason: "rules", checks: [] }).record;
    expect(batchStatus(standing(blocked, PARSER.taskId, PARSER.head) as never)).toEqual({
      kind: "paused",
      words: BATCH_STATUS_WORDS.held("rules"),
      link: "https://github.com/acme/meter/pull/31",
    });
    const one = hold(withdraw(openBatch(), EXPORT.taskId), failed).record;
    expect(standing(one, PARSER.taskId, PARSER.head)).toMatchObject({
      state: "failed",
      checks: ["unit-tests"],
    });
  });

  it("sends two changes back: both leave, and the rest combine again with the line", () => {
    let record = hold(
      enqueue(enqueue(openBatch(), LEGEND), { ...LEGEND, taskId: "t-axis", at: 4_000 }),
      failed,
    ).record;
    record = withdraw(withdraw(record, PARSER.taskId), EXPORT.taskId);
    expect(record.open?.members).toEqual([]);
    expect(record.open?.stale).toBe(true);
    expect(carried(record, "line").map((change) => change.taskId)).toEqual(["t-legend", "t-axis"]);
    expect(standing(record, PARSER.taskId, PARSER.head)).toBeUndefined();
  });

  // Intent: the captain's direction that a held batch's repair takes "everything waiting
  // plus the fix, without asking".
  it("ends by a declared fix: the fix joins right behind the members, and the rest of the line behind it", () => {
    const held = hold(openBatch(), failed).record;
    const fix = {
      ...LEGEND,
      taskId: "t-fix",
      title: "fix(parser): keep the renamed column for the export",
      at: 4_000,
      fix: true as const,
    };
    const withLine = enqueue(enqueue(held, LEGEND), fix);
    expect(fixWaits(withLine)).toBe(true);
    expect(fixWaits(enqueue(held, LEGEND))).toBe(false);
    expect(carried(withLine, "line").map((change) => change.taskId)).toEqual([
      "t-parser",
      "t-export",
      "t-fix",
      "t-legend",
    ]);
    const fixed = combined(
      release(withLine),
      combineOf([
        member(PARSER, PARSER_COMMIT),
        member(EXPORT, EXPORT_COMMIT),
        member(fix, LEGEND_COMMIT),
        member(LEGEND, "4444444444444444444444444444444444444444"),
      ]),
      { branch: "infinitary-batch/7c41", at: 8_000 },
    );
    expect(fixed.open?.hold).toBeUndefined();
    expect(fixed.line).toEqual([]);
  });

  it("ends when its checks run again", () => {
    const held = hold(openBatch(), failed).record;
    expect(release(held).open?.hold).toBeUndefined();
    expect(release(openBatch())).toEqual(openBatch());
  });
});

describe("an approval withdrawn", () => {
  it("takes the change out of the line", () => {
    const line = enqueue(enqueue(EMPTY_BATCH_RECORD, PARSER), EXPORT);
    expect(withdraw(line, PARSER.taskId).line).toEqual([EXPORT]);
  });

  it("takes the change out of the open batch, which combines again without it", () => {
    const record = withdraw(openBatch(), PARSER.taskId);
    expect(record.open?.members.map((entry) => entry.taskId)).toEqual(["t-export"]);
    expect(record.open?.stale).toBe(true);
    expect(standing(record, PARSER.taskId, PARSER.head)).toBeUndefined();
  });

  it("carries only the newly approved version of a change approved again", () => {
    const next = { ...PARSER, head: LEGEND.head, at: 7_000 };
    const record = enqueue(openBatch(), next);
    expect(record.open?.members.map((entry) => entry.taskId)).toEqual(["t-export"]);
    expect(record.line).toEqual([next]);
    // The same approved version is put in line once.
    expect(enqueue(record, next)).toBe(record);
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

  it("keeps a waiting change's place in line and gives it the story's title and words", () => {
    const line = enqueue(enqueue(EMPTY_BATCH_RECORD, PARSER), EXPORT);
    const record = reworded(line, RETITLED);
    expect(record.line).toEqual([{ ...PARSER, ...RETITLED }, EXPORT]);
    expect(standing(record, PARSER.taskId, PARSER.head)).toEqual({
      state: "waiting",
      place: "line",
    });
  });

  it("keeps a batch's change in its place, and has the batch combined again so its commit says the new words", () => {
    const held = hold(openBatch(), {
      at: 6_000,
      head: EXPORT_COMMIT,
      reason: "checks",
      checks: ["unit-tests"],
    }).record;
    const record = reworded(held, RETITLED);
    expect(record.open?.members).toEqual([
      { ...member(PARSER, PARSER_COMMIT), ...RETITLED },
      member(EXPORT, EXPORT_COMMIT),
    ]);
    expect(record.open?.stale).toBe(true);
    // The next combine carries the same changes in the same order, under the new words.
    expect(carried(record).map((change) => change.title)).toEqual([RETITLED.title, EXPORT.title]);
    // No change was sent back: each still reads its place in the held batch.
    expect(standing(record, PARSER.taskId, PARSER.head)).toMatchObject({ place: "held" });
    expect(standing(record, EXPORT.taskId, EXPORT.head)).toMatchObject({ place: "held" });
  });

  it("leaves the batch at its version when the story's title and commit words read as they did", () => {
    const record = reworded(openBatch(), {
      taskId: PARSER.taskId,
      head: PARSER.head,
      title: PARSER.title,
      body: PARSER.body,
    });
    expect(record).toEqual(openBatch());
    expect(record.open?.stale).toBeUndefined();
  });

  it("carries no other version of the task: one confirmed at another version leaves, as a withdrawn one does", () => {
    const elsewhere = { ...RETITLED, head: LEGEND.head };
    expect(reworded(openBatch(), elsewhere)).toEqual(withdraw(openBatch(), PARSER.taskId));
    const line = enqueue(enqueue(EMPTY_BATCH_RECORD, PARSER), EXPORT);
    expect(reworded(line, elsewhere).line).toEqual([EXPORT]);
  });
});

describe("receipts", () => {
  it("gives each member its own commit on the default branch once the batch merged", () => {
    const landed = new Map([
      [PARSER.taskId, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      [EXPORT.taskId, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
    ]);
    const record = merged(enqueue(openBatch(), LEGEND), landed, 9_000);
    expect(record.open).toBeUndefined();
    expect(record.receipts).toEqual([
      {
        taskId: "t-parser",
        head: PARSER.head,
        sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        number: 31,
        url: "https://github.com/acme/meter/pull/31",
        at: 9_000,
      },
      {
        taskId: "t-export",
        head: EXPORT.head,
        sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        number: 31,
        url: "https://github.com/acme/meter/pull/31",
        at: 9_000,
      },
    ]);
    expect(standing(record, EXPORT.taskId, EXPORT.head)).toMatchObject({ state: "merged" });
    expect(batchStatus(standing(record, EXPORT.taskId, EXPORT.head) as never)).toEqual({
      kind: "passed",
      words: BATCH_STATUS_WORDS.merged,
      link: "https://github.com/acme/meter/pull/31",
    });
    // The next batch forms from what waited.
    expect(forms(record)).toBe(true);
  });

  it("names no commit it could not read, never a guessed one", () => {
    const record = merged(openBatch(), new Map([[PARSER.taskId, undefined]]), 9_000);
    expect(record.receipts.map((receipt) => "sha" in receipt)).toEqual([false, false]);
  });

  it("drops a closed task's receipt and left-out note once nothing reads them", () => {
    const record: BatchRecord = {
      ...merged(openBatch(), new Map(), 9_000),
      leftOut: [{ taskId: "t-legend", head: LEGEND.head, reason: "it changes nothing", at: 9_000 }],
    };
    const live = pruned(record, (taskId) => taskId === "t-export");
    expect(live.receipts.map((receipt) => receipt.taskId)).toEqual(["t-export"]);
    expect(live.leftOut).toEqual([]);
    expect(pruned(live, () => true)).toBe(live);
  });
});

describe("a batch's place on its changes", () => {
  it("says a change in line waits for the batch check, and one in the batch is being checked", () => {
    expect(batchStatus({ state: "waiting", place: "line" })).toEqual({
      kind: "waiting",
      words: BATCH_WAITING_WORDS,
    });
    expect(batchStatus(standing(openBatch(), PARSER.taskId, PARSER.head) as never)).toEqual({
      kind: "in-batch",
      words: BATCH_STATUS_WORDS.batch,
      link: "https://github.com/acme/meter/pull/31",
    });
  });

  it("puts the members back at the front of the line when the pull request was closed unmerged", () => {
    const record = reopened(enqueue(openBatch(), LEGEND));
    expect(record.open).toBeUndefined();
    expect(record.line.map((change) => change.taskId)).toEqual([
      "t-parser",
      "t-export",
      "t-legend",
    ]);
    expect(record.line[0]).not.toHaveProperty("commit");
  });
});
