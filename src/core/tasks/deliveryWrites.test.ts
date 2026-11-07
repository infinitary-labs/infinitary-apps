import { describe, expect, it } from "vitest";
import { rowWrites } from "../../../tests/helpers/rowWrites";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { openInMemoryDatabase } from "../storage/db";
import type { CardRefusal, CiWatch } from "../storage/taskStore";
import { seedTask } from "./seedTask";
import { TaskService } from "./taskService";

// INF-2220: a delivery write saved the task's change evidence, every
// permission column, the history its column keeps and the turn's
// declarations whatever it changed, and a write that changed nothing still
// moved the task's updated time and the board. Each family is now written
// only when its saved value moves, and an exact no-op writes nothing.

const HEAD = "c4d0a220c089e1d83092fead988848b4fed1e80a";

function setup() {
  let now = 50_000;
  const db = openInMemoryDatabase();
  const tasks = new TaskService({ db, strict: true, now: () => (now += 1_000) });
  seedTask(tasks, { id: "t1", title: "Fix the phone check", status: "running" });
  const watch: CiWatch = { head: HEAD, since: 40_000, tries: 2, nextAt: 60_000 };
  const refusal: CardRefusal = {
    at: 45_000,
    title: "Phone check fixed",
    reason: "checks",
    why: "The checks had not finished.",
  };
  const checkBack = { at: 45_000, until: 90_000, waitingFor: "journeys" };
  seedDelivery(tasks, "t1", { headSha: HEAD, ciWatch: watch, checkBack });
  tasks.delivery.recordPermissionRecords("t1", { cardRefusal: refusal });
  const changes: number[] = [];
  tasks.onChange((change) => changes.push(change.seq));
  return { db, tasks, watch, refusal, checkBack, changes, writes: rowWrites(db) };
}

describe("a task's delivery write (INF-2220)", () => {
  it("writes nothing for an evidence update that changes no saved fact", () => {
    const { tasks, watch, refusal, checkBack, changes, writes } = setup();
    const before = tasks.get("t1");
    const seq = tasks.boardSeq();

    tasks.delivery.recordChangeEvidence("t1", { headSha: HEAD, ciWatch: { ...watch } });
    tasks.delivery.recordPermissionRecords("t1", { cardRefusal: { ...refusal } });

    expect(writes.take()).toEqual([]);
    expect(changes).toEqual([]);
    expect(tasks.boardSeq()).toBe(seq);
    expect(tasks.get("t1")).toEqual(before);
    expect(tasks.get("t1")?.delivery).toMatchObject({
      ciWatch: watch,
      cardRefusal: refusal,
      checkBack,
    });
  });

  it("saves a moved watch as evidence alone, keeping permissions and declarations", () => {
    const { tasks, watch, refusal, checkBack, changes, writes } = setup();
    const before = tasks.get("t1")?.updatedAt ?? 0;

    tasks.delivery.recordChangeEvidence("t1", { ciWatch: { ...watch, tries: 3, nextAt: 70_000 } });

    expect(writes.take()).toEqual([
      "task_delivery_evidence UPDATE",
      "tasks UPDATE",
      "task_board UPDATE",
    ]);
    expect(changes).toHaveLength(1);
    const after = tasks.get("t1");
    expect(after?.updatedAt).toBeGreaterThan(before);
    expect(after?.delivery).toMatchObject({
      headSha: HEAD,
      ciWatch: { ...watch, tries: 3, nextAt: 70_000 },
      cardRefusal: refusal,
      checkBack,
    });
  });

  it("saves a changed permission in its own column, leaving evidence and the other columns", () => {
    const { tasks, watch, refusal, writes } = setup();
    tasks.delivery.recordPermissionRecords("t1", {
      override: { words: "Merge anyway", holds: [], until: "task", at: 52_000 },
    });
    writes.take();

    const refused: CardRefusal = { ...refusal, at: 58_000, why: "The checks failed." };
    tasks.delivery.recordPermissionRecords("t1", { cardRefusal: refused });

    expect(writes.take()).toEqual(["task_permissions UPDATE", "tasks UPDATE", "task_board UPDATE"]);
    expect(tasks.get("t1")?.delivery).toMatchObject({
      headSha: HEAD,
      ciWatch: watch,
      cardRefusal: refused,
      override: { words: "Merge anyway", holds: [], until: "task", at: 52_000 },
    });

    tasks.delivery.recordPermissionRecords("t1", { cardRefusal: undefined, override: undefined });
    // The cleared columns are written, then the row holding none goes.
    expect(writes.take()).toEqual([
      "task_permissions UPDATE",
      "task_permissions DELETE",
      "tasks UPDATE",
      "task_board UPDATE",
    ]);
    const cleared = tasks.get("t1")?.delivery;
    expect(cleared?.cardRefusal).toBeUndefined();
    expect(cleared?.override).toBeUndefined();
    expect(cleared?.ciWatch).toEqual(watch);
  });

  it("keeps an observation's timeline line when its facts are unchanged", () => {
    const { tasks, watch, changes, writes } = setup();

    tasks.delivery.recordChangeEvidence(
      "t1",
      { ciWatch: { ...watch } },
      { kind: "ci", text: "Checks still running" },
    );

    expect(writes.take()).toEqual([
      "tasks UPDATE",
      "task_events INSERT",
      "task_events UPDATE",
      "task_board UPDATE",
    ]);
    expect(changes).toHaveLength(1);
    expect(tasks.timeline("t1").at(-1)).toMatchObject({ kind: "ci", text: "Checks still running" });
  });
});

// INF-2993: Allow for the rest of this task is kept on the task and ends
// with it; choosing it again for the same place replaces the older one.
describe("a task's Allow for the rest of this task (INF-2993)", () => {
  const allowance = {
    connection: "c-github",
    action: "write",
    signature: '["POST, PATCH, PUT or DELETE one path","changes"]',
    scope: "POST /repos/octo/queue-proof-4ca5",
    words: "POST requests to octo/queue-proof-4ca5",
    mark: "",
    at: 46_000,
    card: "integration-ask-pulls",
  };

  it("keeps one per place while the task is open, and none once it closes", () => {
    const { tasks } = setup();
    tasks.delivery.allowIntegration("t1", allowance);
    tasks.delivery.allowIntegration("t1", { ...allowance, mark: "renewed", at: 47_000 });
    tasks.delivery.allowIntegration("t1", { ...allowance, scope: "POST /repos/octo/meter" });
    expect(tasks.delivery.integrationAllowances("t1").map((kept) => kept.mark)).toEqual([
      "renewed",
      "",
    ]);

    tasks.close("t1", { status: "done", reason: "settled", actor: "host" });

    expect(tasks.delivery.integrationAllowances("t1")).toEqual([]);
    expect(tasks.get("t1")?.delivery?.integrationAllowances).toBeUndefined();
    expect(() => tasks.delivery.allowIntegration("t1", allowance)).toThrow("is closed");
  });
});
