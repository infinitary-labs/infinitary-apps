import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BatchHostForge, commitId, standInGit } from "../../../tests/helpers/batchHost";
import { freshDatabase } from "../../../tests/helpers/database";
import { insertTask } from "../../../tests/helpers/prCiHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { standingApproval } from "../../../tests/helpers/settleHarness";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import type { MergeAuthorization } from "../storage/taskRecordTypes";
import { TaskService } from "../tasks/taskService";
import { RepoRegistry } from "../workspace/repoRegistry";
import { seedProject } from "../workspace/seedProject";
import { createOwnBatches } from "./ownBatches";
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

function home() {
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
  repos.recordQueue(REPO, { workflows: [] });
  const forge = new BatchHostForge();
  let clock = 10_000;
  const tick = () => {
    clock += 1;
    return clock;
  };
  const heard = {
    ran: [] as string[],
    ended: [] as unknown[][],
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
          approvals: {
            endAuthorization: (...said) => {
              heard.ended.push(said);
              return true;
            },
          },
        },
      }),
      firstmate: () => ({
        notifyOp: (wake, origin) => {
          heard.told.push({ wake, origin });
          return heard.told.length;
        },
      }),
      note: () => {},
      git: standInGit(forge),
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
    forge,
    heard,
    approve,
    pass: () => batches.pass(REPO),
    members: () => batches.record(REPO).open?.members.map((member) => member.taskId),
    record: () => batches.record(REPO),
    batches: () => batches,
    /** The app closed and opened again: a new wiring over what was saved. */
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
    // The captain withdrew the approval.
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

  it("wakes the one change's own task when a batch of one fails, and tells the first mate nothing", async () => {
    const at = home();
    at.approve(PARSER);
    await at.pass();
    at.forge.report([{ name: "unit-tests", state: "failure" }]);
    await at.pass();
    expect(at.heard.ran).toEqual([PARSER.id]);
    expect(at.heard.told).toEqual([]);
  });

  it("ends a sent-back change's approval and tells its crewmate the reason", async () => {
    const at = home();
    at.approve(PARSER);
    at.approve(EXPORT);
    await at.pass();
    at.forge.report([{ name: "unit-tests", state: "failure" }]);
    await at.pass();
    const reason = "its date test fails on the batch's version";
    expect(
      await at.batches().answer(REPO, {
        action: "send-back",
        head: at.forge.batchHead,
        changes: [{ taskId: PARSER.id, reason }],
      }),
    ).toBeUndefined();
    expect(at.heard.ended).toEqual([
      [
        PARSER.id,
        "invalidated",
        `its change was sent back from its batch: ${reason}`,
        { feed: true },
      ],
    ]);
    expect(at.heard.steered).toEqual([
      {
        taskId: PARSER.id,
        wake: { facts: { kind: "batch-sent-back", head: PARSER.head, reason } },
      },
    ]);
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
    expect(at.heard.ran).toEqual([PARSER.id, EXPORT.id]);
  });
});
