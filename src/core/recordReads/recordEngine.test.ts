import { afterEach, describe, expect, it, vi } from "vitest";
import { freshDatabase, rowsRead } from "../../../tests/helpers/database";
import { AT, FINISHED, GROK, row, snapshot } from "../../../tests/helpers/placedWorkRecord";
import { type PlacedWorkAnswer, PlacedWorkScores } from "../routing/placedWork";
import { DecisionStore } from "../storage/decisionStore";
import { SettingsStore } from "../storage/settingsStore";
import { selectTasks } from "../storage/taskSelection";
import { UsageStore } from "../storage/usageStore";
import { seedTask } from "../tasks/seedTask";
import { queryTasksAsync } from "../tasks/taskQuery";
import { TaskService } from "../tasks/taskService";
import type { RecordParent } from "./protocol";
import { RecordReadEngine } from "./recordEngine";

afterEach(() => vi.restoreAllMocks());

describe("finding A: one placement snapshot per batch, matching task rows only", () => {
  it("scores nine starts against one work read, preserves learned charges, and sees the next committed route", () => {
    const db = freshDatabase();
    try {
      const tasks = new TaskService({ db, now: () => AT });
      const decisions = new DecisionStore(db);
      const usage = new UsageStore(db);
      const route = (id: string) =>
        decisions.recordRouting({
          taskId: id,
          provider: GROK.provider,
          model: GROK.id,
          bucket: "medium",
          served: "medium",
          rule: "R4",
          reasons: [],
        });
      for (const [index, cost] of FINISHED.entries()) {
        const id = `finished-${index}`;
        seedTask(tasks, {
          id,
          title: "Completed audit work",
          status: "running",
          createdAt: AT - 86400000,
        });
        route(id);
        usage.record({
          taskId: id,
          accountId: "mini-grok",
          model: GROK,
          usage: { cost, costSource: "listed-prices" },
          at: AT - 3600000,
        });
        tasks.close(id, { status: "done", reason: "finished", actor: "host" });
      }
      // The existing recorded-reading fixture owns these values (INF-438).
      const reading = row();
      const settings = new SettingsStore(db);
      const local = new PlacedWorkScores(db, settings);
      local.observe("mini", snapshot(AT, [reading]));
      const priceKey = JSON.stringify([reading.provider, reading.windows[0]?.id]);
      settings.setAllowancePrices({ [priceKey]: 38 / 290.21 });
      const engine = new RecordReadEngine(db);
      const workRead = vi.spyOn(PlacedWorkScores.prototype, "data");
      const observed = vi.spyOn(PlacedWorkScores.prototype, "observe");
      const reads: Extract<RecordParent, { type: "batch" }>["reads"] = Array.from(
        { length: 9 },
        (_, id) => ({
          id,
          request: {
            kind: "placed",
            input: {
              rows: [reading],
              now: AT,
              observations: [{ source: "mini", snapshot: snapshot(AT, [reading]) }],
              prices: settings.getAllowancePrices(),
            },
          },
        }),
      );
      const answers = engine.batch(reads);
      expect(workRead).toHaveBeenCalledTimes(1);
      // One batch must not replay the same quota reading's usage queries per start.
      expect(observed).toHaveBeenCalledTimes(1);
      const first = answers[0];
      if (first?.type !== "answer") throw new Error("the placement batch did not answer");
      const data = (first.answer as PlacedWorkAnswer).data;
      expect(data.work).toEqual([]);
      expect(data.samples).toEqual([]);
      expect(
        answers.every(
          (answer) =>
            answer.type === "answer" &&
            JSON.stringify(answer.answer) === JSON.stringify(first.answer),
        ),
      ).toBe(true);
      expect(local.score(reading, AT, GROK.id, data)).toEqual(
        local.score(reading, AT, GROK.id, local.data(AT)),
      );
      seedTask(tasks, {
        id: "new-start",
        title: "Audit the next session",
        status: "running",
        deviceId: "mini",
        createdAt: AT,
      });
      route("new-start");
      workRead.mockClear();
      const next = engine.batch(reads.slice(0, 1))[0];
      if (next?.type !== "answer") throw new Error("the next placement did not answer");
      expect(workRead).toHaveBeenCalledTimes(1);
      expect(observed).toHaveBeenCalledTimes(1);
      expect(
        local.score(reading, AT, GROK.id, (next.answer as PlacedWorkAnswer).data).charge?.windows[0]
          ?.points,
      ).toBeGreaterThan(local.score(reading, AT, GROK.id, data).charge?.windows[0]?.points ?? 0);
    } finally {
      db.close();
    }
  });

  it("selects matching metadata in SQLite and loads only the requested page through the task owner", async () => {
    const db = freshDatabase();
    try {
      const tasks = new TaskService({ db, now: () => AT });
      tasks.create({
        id: "note",
        title: "What’s new in Infinitary",
        goal: "Review the “Later” group",
        prompt: "Read the release notes",
        repoId: null,
      });
      tasks.create({
        id: "other",
        title: "Review session frictions",
        goal: "Keep the window responsive",
        prompt: "Review yesterday",
        repoId: null,
      });
      const list = vi.spyOn(tasks, "list").mockImplementation(() => {
        throw new Error("search must not load the task list");
      });
      const getMany = vi.spyOn(tasks, "getMany");
      const reach = {
        select: async (input: Parameters<typeof selectTasks>[1]) => selectTasks(db, input),
      };
      const found = await queryTasksAsync(
        tasks,
        { text: '"later"', status: "live", limit: 1 },
        undefined,
        undefined,
        undefined,
        reach,
      );
      expect(found.rows.map((record) => record.task_id)).toEqual(["note"]);
      expect(found.total).toBe(1);
      expect(getMany).toHaveBeenCalledWith(["note"]);
      expect(list).not.toHaveBeenCalled();
      let selection: ReturnType<typeof selectTasks> | undefined;
      const read = rowsRead(db, () => {
        selection = selectTasks(db, { text: "what's new", limit: 1, skip: 0 });
      });
      expect(selection).toEqual({ ids: ["note"], total: 1 });
      expect(read).toBe(1);
      const page = await queryTasksAsync(
        tasks,
        { limit: 1, snapshot: true },
        undefined,
        undefined,
        undefined,
        reach,
      );
      expect(page.order).toHaveLength(2);
      const last = await queryTasksAsync(
        tasks,
        { limit: 1, skip: 1 },
        undefined,
        undefined,
        undefined,
        reach,
      );
      expect(last.total).toBe(page.total);
      expect(last.rows[0]?.task_id).not.toBe(page.rows[0]?.task_id);
      expect(
        (
          await queryTasksAsync(
            tasks,
            { parent: "missing" },
            undefined,
            undefined,
            undefined,
            reach,
          )
        ).total,
      ).toBe(0);
    } finally {
      db.close();
    }
  });
});
