import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BatchHostForge, commitId, standInGit } from "../../../tests/helpers/batchHost";
import { freshDatabase } from "../../../tests/helpers/database";
import { insertTask } from "../../../tests/helpers/prCiHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { standingApproval } from "../../../tests/helpers/settleHarness";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import type { Batches } from "../batches/batches";
import type { CombineInput } from "../batches/combine";
import type { MergeAuthorization } from "../storage/taskRecordTypes";
import { TaskService } from "../tasks/taskService";
import { RepoRegistry } from "../workspace/repoRegistry";
import { seedProject } from "../workspace/seedProject";
import { KeptApproval } from "./keptApproval";
import { coveredNextStep } from "./mergeAuthorization";
import { createOwnBatches, runBatchFacts, settleBatchMembers } from "./ownBatches";
import type { SettleServiceHost } from "./settleHost";
import { SettleLocks } from "./settleLocks";
import { TICK_PERIOD_MS } from "./ticker";
import type { TypedWake } from "./wakes";

// Intent: the captain's approved plan for batches of their own, piece 1: "The merge
// click, or autonomy, keeps the approval at that version and puts the change in line";
// a change sent back goes back "with a reason" to its own crewmate; "A batch of one
// wakes its own crewmate. For a batch of several the first mate is told once"; and "A
// restart reconciles open batches from the host."
//
// The wiring runs over a fresh task record and project list; the stand-ins are the host
// (its pull request and checks), git, and the owners the wiring only calls.

const REPO = "repo-meter";
const PARSER = {
  id: "parser01",
  title: "fix(parser): read dates with a time zone",
  head: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
};
const EXPORT = {
  id: "export02",
  title: "feat(export): add a CSV export",
  head: "0f9e8d7c6b5a49382716f5e4d3c2b1a009182736",
};
const LEGEND = {
  id: "legend03",
  title: "fix(chart): keep the legend inside the chart",
  head: "7e6d5c4b3a2918070f6e5d4c3b2a190817263544",
};
type Change = typeof PARSER;
const branchOf = (change: Change) => `fm/task-${change.id}`;

/** The captain's click on a change's merge card: no pull request of its own, at this version. */
function approvalOf(change: Change, patch: Partial<MergeAuthorization> = {}): MergeAuthorization {
  return standingApproval({
    id: `approval-${change.id}`,
    target: {
      repoId: REPO,
      host: "github.com",
      owner: "acme",
      name: "meter",
      branch: branchOf(change),
      delivery: "direct-pr",
      method: "squash",
    },
    approvedHead: change.head,
    ...patch,
  });
}

function home(git: ReturnType<typeof standInGit> | undefined = undefined) {
  const db = freshDatabase();
  const tasks = new TaskService({ db, strict: true });
  const repos = new RepoRegistry(db, join(scratchDir("infinitary-own-batches-"), "fleet"));
  seedProject(db, {
    id: REPO,
    name: "meter",
    path: "/code/meter",
    origin: "https://github.com/acme/meter.git",
    delivery: "queue-pr",
  });
  const forge = new BatchHostForge();
  let clock = 10_000;
  const tick = () => {
    clock += 1;
    return clock;
  };
  // The real kept approval's end: only a former address's change has its approval ended.
  const approvals = new KeptApproval(
    { tasks, now: () => clock } as unknown as SettleServiceHost,
    new SettleLocks({} as never),
  );
  const heard = {
    ran: [] as string[],
    steered: [] as { taskId: string; wake: TypedWake }[],
    told: [] as { wake: TypedWake; origin: string }[],
    regions: [] as string[],
    ticks: [] as { name: string; period: number; run: (now: number) => void }[],
  };
  /** One run of the app: the wiring as the app builds it when it starts. */
  const start = () =>
    createOwnBatches({
      repos,
      forgeFor: () => forge,
      ticker: {
        now: tick,
        register: (name, period, run) => {
          heard.ticks.push({ name, period, run });
          return () => {};
        },
      },
      tasks,
      presentations: {
        batchRegion: async (taskId, branch) => {
          heard.regions.push(`${taskId} ${branch}`);
          return {
            story: { projectText: "" } as never,
            region: `<!-- the story of ${taskId} -->`,
          };
        },
      },
      inbox: {
        enqueue: (taskId, wake) => {
          heard.steered.push({ taskId, wake: wake as TypedWake });
          return heard.steered.length;
        },
      },
      late: () => ({
        checks: { declaredAbsent: () => false },
        settling: {
          kept: {
            runMergeAuthorization: async (taskId) => {
              heard.ran.push(taskId);
            },
          },
          // The app's own ending of a kept approval, over the task record.
          approvals,
        },
      }),
      firstmate: () => ({
        notifyOp: (wake, origin) => {
          heard.told.push({ wake, origin });
          return heard.told.length;
        },
      }),
      note: () => {},
      git: git ?? standInGit(forge),
    });
  let batches = start();
  /** A change whose merge card the captain approved, put in line as the merge does. */
  const approve = (change: Change, approval: MergeAuthorization = approvalOf(change)) => {
    insertTask(tasks, { id: change.id, repoId: REPO, branch: branchOf(change) });
    seedDelivery(tasks, change.id, { mergeAuthorization: approval });
    batches.enqueue(REPO, {
      taskId: change.id,
      branch: branchOf(change),
      head: change.head,
      title: change.title,
      body: "",
      at: tick(),
    });
  };
  return {
    tasks,
    repos,
    forge,
    heard,
    approve,
    enqueue: (change: Parameters<Batches["enqueue"]>[1]) => batches.enqueue(REPO, change),
    pass: () => batches.pass(REPO),
    members: () => batches.record(REPO).open?.members.map((member) => member.taskId),
    record: () => batches.record(REPO),
    batches: () => batches,
    restart() {
      heard.ticks.length = 0;
      batches = start();
    },
  };
}

describe("the batches of a person's own, wired to the task record", () => {
  it("carries a change only while a standing approval of the task's own branch covers that version", async () => {
    const at = home();
    at.approve(PARSER);
    // Approved at an earlier version than the one in line.
    at.approve(
      EXPORT,
      approvalOf(EXPORT, { approvedHead: "c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7" }),
    );
    at.approve(LEGEND, approvalOf(LEGEND, { status: "revoked", reason: "withdrawn" }));
    await at.pass();
    expect(at.members()).toEqual([PARSER.id]);
    expect(at.record().line).toEqual([]);
  });

  it("carries an approval that waits behind another of the same task, and none of a closed task", async () => {
    const at = home();
    // The approval in front is of a pull request the task reviewed; the task's own change waits behind it.
    at.approve(
      PARSER,
      approvalOf(PARSER, {
        id: "approval-review",
        review: { id: "review-1" } as MergeAuthorization["review"],
        queued: [approvalOf(PARSER)],
      }),
    );
    at.approve(EXPORT);
    at.tasks.close(EXPORT.id, { status: "dropped", reason: "cancelled", actor: "captain" });
    await at.pass();
    expect(at.members()).toEqual([PARSER.id]);
  });

  it("publishes each change's own story on a batch of several", async () => {
    const at = home();
    at.approve(PARSER);
    at.approve(EXPORT);
    await at.pass();
    expect(at.heard.regions).toEqual([
      `${PARSER.id} ${branchOf(PARSER)}`,
      `${EXPORT.id} ${branchOf(EXPORT)}`,
    ]);
    expect(at.forge.batch?.body).toContain(`<!-- the story of ${PARSER.id} -->`);
    expect(at.forge.batch?.body).toContain(`<!-- the story of ${EXPORT.id} -->`);
  });

  it("tells the first mate once about a held batch of several, naming each change by its task's key", async () => {
    const at = home();
    at.approve(PARSER);
    at.approve(EXPORT);
    await at.pass();
    at.forge.report([
      { name: "build", state: "success" },
      { name: "unit-tests", state: "failure" },
    ]);
    await at.pass();
    await at.pass();
    expect(at.heard.told).toEqual([
      {
        origin: "agent",
        wake: {
          facts: {
            kind: "batch-held",
            project: { id: REPO, name: "meter" },
            change: "#31",
            url: "https://github.com/acme/meter/pull/31",
            head: at.forge.batchHead,
            checks: ["unit-tests"],
            members: [
              { task: at.tasks.get(PARSER.id)?.key, title: PARSER.title },
              { task: at.tasks.get(EXPORT.id)?.key, title: EXPORT.title },
            ],
          },
        },
      },
    ]);
    // Its members' own crewmates are not woken: the first mate starts one repair.
    expect(at.heard.ran).toEqual([]);
    expect(at.heard.steered).toEqual([]);
  });

  // Intent: the captain's ask that a held batch show who repairs it: once a repair is
  // recorded, a later hold of the same batch names that repair by its task's key, so the
  // first mate steers it rather than starting another.
  it("names the recorded repair by its task's key when the same batch holds again", async () => {
    const at = home();
    at.approve(PARSER);
    at.approve(EXPORT);
    await at.pass();
    at.forge.report([{ name: "unit-tests", state: "failure" }]);
    await at.pass();
    // The repair is an open task of the project's: here the export change's own task.
    expect(await at.batches().markRepair(REPO, EXPORT.id)).toBeUndefined();
    const head = at.record().open?.head as string;
    expect(await at.batches().answer(REPO, { action: "try-again", head })).toBeUndefined();
    await at.pass();
    at.forge.report([{ name: "unit-tests", state: "failure" }]);
    await at.pass();
    expect(at.heard.told).toHaveLength(2);
    expect(at.heard.told.at(-1)?.wake.facts).toMatchObject({
      kind: "batch-held",
      repair: at.tasks.get(EXPORT.id)?.key,
    });
    expect(at.tasks.get(EXPORT.id)?.key).toMatch(/^[A-Z]+-\d+$/);
  });

  it("wakes the one change's own task when a batch of one fails, and tells the first mate nothing", async () => {
    const at = home();
    at.approve(PARSER);
    await at.pass();
    at.forge.report([{ name: "unit-tests", state: "failure" }]);
    await at.pass();
    expect(at.heard.ran).toEqual([PARSER.id]);
    expect(at.heard.told).toEqual([]);
  });

  // Intent: INF-5097 piece 1 with the captain's answer Keep: "a sent-back change's approval
  // is kept, as for a batch of one", and its crewmate and the batch's repair "see how many
  // times a change was sent back, why, and which checks never ran on it".
  it("keeps a sent-back change's approval and tells its crewmate why, how often it went back and what never ran, and the next held batch's repair hears it", async () => {
    const at = home();
    at.approve(PARSER);
    at.approve(EXPORT);
    await at.pass();
    at.forge.report([
      { name: "unit-tests", state: "failure" },
      { name: "journeys", state: "cancelled" },
    ]);
    await at.pass();
    const first = "its date test fails on the batch's version";
    expect(
      await at.batches().answer(REPO, {
        action: "send-back",
        head: at.forge.batchHead,
        changes: [{ taskId: PARSER.id, reason: first }],
      }),
    ).toBeUndefined();
    expect(at.tasks.get(PARSER.id)?.delivery?.mergeAuthorization?.status).toBe("standing");
    const approvalWords = (head: string) =>
      `The captain's merge approval is kept and covers ${head}. ${coveredNextStep(approvalOf(PARSER), "batch")}`;
    expect(at.heard.steered).toEqual([
      {
        taskId: PARSER.id,
        wake: {
          facts: {
            kind: "batch-sent-back",
            head: PARSER.head,
            reason: first,
            change: "#31",
            failed: ["unit-tests"],
            notRun: ["journeys"],
            earlier: [],
            approval: approvalWords(PARSER.head),
          },
        },
      },
    ]);
    // Its kept merge runs again to read the version sent back.
    await vi.waitFor(() => expect(at.heard.ran).toContain(PARSER.id));

    // The export merges alone; the parser's repair, approved under the kept approval, waits
    // in line with the legend, and their batch fails too.
    at.forge.report([{ name: "unit-tests", state: "success" }], "clean");
    await at.pass();
    const repaired = { ...PARSER, head: commitId("the parser's repair") };
    seedDelivery(at.tasks, PARSER.id, { mergeAuthorization: approvalOf(repaired) });
    at.enqueue({
      taskId: PARSER.id,
      branch: branchOf(PARSER),
      head: repaired.head,
      title: PARSER.title,
      body: "",
      at: 20_000,
    });
    at.approve(LEGEND);
    await at.pass();
    expect([...(at.members() ?? [])].sort()).toEqual([LEGEND.id, PARSER.id]);
    at.forge.report([{ name: "unit-tests", state: "failure" }]);
    await at.pass();
    // The first mate's held-batch wake carries the parser's earlier send-back for the repair's brief.
    expect(at.heard.told.at(-1)?.wake.facts).toMatchObject({
      kind: "batch-held",
      members: expect.arrayContaining([
        expect.objectContaining({
          task: at.tasks.get(PARSER.id)?.key,
          sentBack: [
            {
              head: PARSER.head,
              reason: first,
              change: "#31",
              failed: ["unit-tests"],
              notRun: ["journeys"],
            },
          ],
        }),
      ]),
    });
    const held = at.heard.told.at(-1)?.wake.facts as { members: { task?: string }[] } | undefined;
    const legend = held?.members.find((member) => member.task === at.tasks.get(LEGEND.id)?.key);
    expect(legend).toBeDefined();
    expect(legend).not.toHaveProperty("sentBack");

    const second = "its repair still fails the date test";
    await at.batches().answer(REPO, {
      action: "send-back",
      head: at.forge.batchHead,
      changes: [{ taskId: PARSER.id, reason: second }],
    });
    expect(at.heard.steered.at(-1)).toEqual({
      taskId: PARSER.id,
      wake: {
        facts: {
          kind: "batch-sent-back",
          head: repaired.head,
          reason: second,
          change: "#31",
          failed: ["unit-tests"],
          notRun: [],
          earlier: [
            {
              head: PARSER.head,
              reason: first,
              change: "#31",
              failed: ["unit-tests"],
              notRun: ["journeys"],
            },
          ],
          approval: approvalWords(repaired.head),
        },
      },
    });
    expect(at.tasks.get(PARSER.id)?.delivery?.mergeAuthorization?.status).toBe("standing");
  });

  it("ends a former address's approvals with no send-back history, and a change sent back there comes back in a new version approved at the new address", async () => {
    const at = home();
    at.approve(PARSER);
    at.approve(EXPORT);
    await at.pass();
    at.forge.report([{ name: "unit-tests", state: "failure" }]);
    await at.pass();
    const reason = "its date test fails on the batch's version";
    await at.batches().answer(REPO, {
      action: "send-back",
      head: at.forge.batchHead,
      changes: [{ taskId: PARSER.id, reason }],
    });
    await at.pass();
    expect(at.members()).toEqual([EXPORT.id]);
    at.approve(LEGEND);
    await at.pass();
    expect(at.record().line.map((entry) => entry.taskId)).toEqual([LEGEND.id]);

    at.repos.configure(REPO, { origin: "https://github.com/acme/new-meter.git" });
    await at.pass();
    expect(at.record().open).toBeUndefined();
    expect(at.record().line).toEqual([]);
    for (const change of [EXPORT, LEGEND])
      expect(at.tasks.get(change.id)?.delivery?.mergeAuthorization?.status).toBe("invalidated");
    expect(at.batches().sentBack(REPO, EXPORT.id)).toEqual([]);
    expect(at.batches().sentBack(REPO, LEGEND.id)).toEqual([]);
    // The captain's answer: the parser's send-back still stands at its version, which its
    // merge reads and does not put in line, even approved again at the new address.
    const moved = (change: Change): MergeAuthorization => {
      const fresh = approvalOf(change, { id: `approval-${change.id}-moved` });
      return { ...fresh, target: { ...fresh.target, name: "new-meter" } };
    };
    seedDelivery(at.tasks, PARSER.id, { mergeAuthorization: moved(PARSER) });
    expect(
      at
        .batches()
        .sentBack(REPO, PARSER.id)
        .map((entry) => entry.reason),
    ).toEqual([reason]);
    expect(at.batches().standing(REPO, PARSER.id, PARSER.head)).toMatchObject({
      state: "sent-back",
      reason,
    });
    const repaired = { ...PARSER, head: commitId("the parser's repair at the new address") };
    seedDelivery(at.tasks, PARSER.id, { mergeAuthorization: moved(repaired) });
    at.enqueue({
      taskId: PARSER.id,
      branch: branchOf(PARSER),
      head: repaired.head,
      title: PARSER.title,
      body: "",
      at: 31_000,
    });
    await at.pass();
    expect(at.members()).toEqual([PARSER.id]);
    expect(at.record().open?.origin).toBe("https://github.com/acme/new-meter.git");
    expect(at.batches().sentBack(REPO, PARSER.id)).toHaveLength(1);
  });

  it("reads its open batch from the host on the first pass after a start", async () => {
    const at = home();
    at.approve(PARSER);
    at.approve(EXPORT);
    await at.pass();
    const head = at.forge.batchHead;
    // The batch merged where the project lives while the app was closed.
    Object.assign(at.forge.batch as object, {
      state: "closed",
      merged: true,
      mergedSha: commitId(`merge of ${head}`),
    });
    at.restart();
    expect(at.heard.ticks.map(({ name, period }) => ({ name, period }))).toEqual([
      { name: "batches", period: TICK_PERIOD_MS },
    ]);
    at.heard.ticks[0]?.run(0);
    await expect.poll(() => at.record().open).toBeUndefined();
    expect(at.record().receipts.map((receipt) => receipt.taskId)).toEqual([PARSER.id, EXPORT.id]);
    // Each member's kept merge runs again, to read its receipt and close its task.
    await expect.poll(() => at.heard.ran).toEqual([PARSER.id, EXPORT.id]);
  });

  it("lets other events run between batch member closes, even if one settlement fails", async () => {
    const order: string[] = [];
    const failure = new Error("task could not settle");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await settleBatchMembers([PARSER.id, EXPORT.id, LEGEND.id], async (id) => {
        order.push(`start ${id}`);
        if (id === PARSER.id) {
          await Promise.resolve();
          setImmediate(() => order.push("other event"));
          throw failure;
        }
        order.push(`close ${id}`);
      });
      expect(order).toEqual([
        `start ${PARSER.id}`,
        "other event",
        `start ${EXPORT.id}`,
        `close ${EXPORT.id}`,
        `start ${LEGEND.id}`,
        `close ${LEGEND.id}`,
      ]);
      expect(warn).toHaveBeenCalledWith("[batches] settling a batch member:", failure);
    } finally {
      warn.mockRestore();
    }
  });

  // Intent: INF-4574's change 3 - a crewmate whose run watch reads a batch run it is not a
  // member of learns that the batch's repair owns its failure, and a replaced run says so.
  it("tells a run's watcher which batch it checks, unless the watcher's change is in it", async () => {
    const at = home();
    at.approve(PARSER);
    at.approve(EXPORT);
    await at.pass();
    insertTask(at.tasks, { id: "watcher9", repoId: REPO, branch: "fm/task-watcher9" });
    const open = at.record().open;
    if (!open) throw new Error("no open batch");
    const owners = {
      tasks: at.tasks,
      repos: at.repos,
      batches: at.batches(),
      forgeFor: () => at.forge,
    };
    const run = { branch: open.branch, headSha: open.head };
    expect(runBatchFacts(owners, "watcher9", run)).toEqual({
      change: "#31",
      url: "https://github.com/acme/meter/pull/31",
      head: open.head,
      members: [
        { task: at.tasks.get(PARSER.id)?.key, title: PARSER.title },
        { task: at.tasks.get(EXPORT.id)?.key, title: EXPORT.title },
      ],
      current: true,
    });
    expect(
      runBatchFacts(owners, "watcher9", { ...run, headSha: commitId("an earlier batch version") })
        ?.current,
    ).toBe(false);
    // A member's own crewmate hears of its batch through the batch, not its run watch.
    expect(runBatchFacts(owners, PARSER.id, run)).toBeUndefined();
    expect(
      runBatchFacts(owners, "watcher9", { branch: "fm/task-watcher9", headSha: open.head }),
    ).toBeUndefined();
  });
});

// Intent: INF-4517 piece 3 with the captain's choice on the review's question ("Follow the next
// part's commits; tell its crewmate to rebuild without it"): the wiring answers the batch, from
// the task record, which earlier part merged and which closed without merging.
describe("a later part built on an earlier part's approved version, wired to the task record", () => {
  it("names the version an earlier part merged at, and the version a later part was built on once its earlier part closed unmerged", async () => {
    const seen: { merged?: string; unmergedBase?: readonly string[] }[] = [];
    const forge = new BatchHostForge();
    const git = standInGit(forge);
    const at = home({
      ...git,
      combine: async (input: CombineInput) => {
        for (const change of input.changes)
          if (change.after)
            seen.push({
              ...(input.merged?.(change.after) ? { merged: input.merged(change.after) } : {}),
              ...(input.unmergedBase?.(change) ? { unmergedBase: input.unmergedBase(change) } : {}),
            });
        return git.combine({ ...input, changes: input.changes.filter((change) => !change.after) });
      },
    });
    const later = (id: string, base: Change) => {
      insertTask(at.tasks, {
        id,
        repoId: REPO,
        branch: `fm/task-${id}`,
        shape: {
          kind: "implement",
          built_on: { task: base.id, branch: branchOf(base), head: base.head },
        },
      });
      const change = { id, title: `feat(panel): ${id}`, head: commitId(id) };
      seedDelivery(at.tasks, id, { mergeAuthorization: approvalOf(change) });
      return at.enqueue({
        taskId: id,
        branch: `fm/task-${id}`,
        head: commitId(id),
        title: `feat(panel): ${id}`,
        body: "",
        at: 1,
        base: branchOf(base),
        after: base.id,
      });
    };
    // The export was approved, repaired under its kept approval, then dropped: its approval
    // ended unspent, and a later part may have been brought onto the repaired version.
    const repaired = commitId("export-repaired");
    insertTask(at.tasks, { id: EXPORT.id, repoId: REPO, branch: branchOf(EXPORT) });
    seedDelivery(at.tasks, EXPORT.id, {
      mergeAuthorization: approvalOf(EXPORT, {
        status: "revoked",
        reason: "the task closed",
        lineage: [
          {
            fromHead: EXPORT.head,
            toHead: repaired,
            newBase: commitId("main-newer"),
            impact: "none",
            changedPaths: [],
            evidence: "brought up to date with the default branch",
            validation: "the unit tests",
            generation: 1,
            at: 2,
          },
        ],
      }),
    });
    at.tasks.close(EXPORT.id, { status: "dropped", reason: "cancelled", actor: "captain" });
    insertTask(at.tasks, { id: PARSER.id, repoId: REPO, branch: branchOf(PARSER) });
    seedDelivery(at.tasks, PARSER.id, {
      mergeAuthorization: approvalOf(PARSER, { status: "consumed" }),
    });
    at.tasks.close(PARSER.id, { status: "done", reason: "merged", actor: "host" });
    await later("panel04", EXPORT);
    await later("zones05", PARSER);
    await at.pass();
    // Each combine of the line reads the same answers.
    expect(new Set(seen.map((answer) => JSON.stringify(answer)))).toEqual(
      new Set([
        JSON.stringify({ unmergedBase: [EXPORT.head, repaired] }),
        JSON.stringify({ merged: PARSER.head }),
      ]),
    );
  });
});
