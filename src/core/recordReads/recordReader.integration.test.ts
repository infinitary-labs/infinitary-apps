import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AT, FINISHED, GROK, row, snapshot } from "../../../tests/helpers/placedWorkRecord";
import { bundleRecordProcess } from "../../../tests/helpers/recordProcessBundle";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { outsideCensus } from "../../../tests/helpers/statementCheck";
import { PlacedWorkScores } from "../routing/placedWork";
import { forkChildProcess } from "../sql/forkChildProcess";
import { openDatabase } from "../storage/db";
import { DecisionStore } from "../storage/decisionStore";
import { SettingsStore } from "../storage/settingsStore";
import { UsageStore } from "../storage/usageStore";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { RecordReader } from "./recordReader";

let entry: string;
beforeAll(async () => {
  entry = await bundleRecordProcess();
}, 60_000);

// Finding A's audit counted 6,630 tasks and nine concurrent starts.
const AUDIT_RECORD_TASKS = 6_630;
const AUDIT_STARTS = 9;
// The long-record check measured 7.4 s: five times that, rounded up to 5 s.
vi.setConfig({ testTimeout: 40_000 });

describe("finding A: the actual background record reader", () => {
  it("answers placement and the agents' and window's searches on a long record while the parent's event loop continues", async () => {
    const dir = scratchDir("infinitary-record-reader-");
    const db = openDatabase(dir);
    const reader = new RecordReader(forkChildProcess(entry), join(dir, "firstmate.db"));
    let progress: ReturnType<typeof setImmediate> | undefined;
    try {
      const tasks = new TaskService({ db, now: () => AT });
      const decisions = new DecisionStore(db);
      const usage = new UsageStore(db);
      // Real writer transitions and the existing recorded task-cost distribution;
      // historical titles are ordinary session-audit work, not copied personal records.
      outsideCensus(() =>
        db.transaction(() => {
          for (let index = 0; index < AUDIT_RECORD_TASKS; index++) {
            const id = `history-${index}`;
            seedTask(tasks, {
              id,
              title: `Review session report ${index}`,
              prompt: "Review the session's product frictions",
              status: "running",
              createdAt: AT - 86400000,
            });
            decisions.recordRouting({
              taskId: id,
              provider: GROK.provider,
              model: GROK.id,
              bucket: "medium",
              served: "medium",
              rule: "R4",
              reasons: [],
            });
            usage.record({
              taskId: id,
              accountId: "mini-grok",
              model: GROK,
              usage: { cost: FINISHED[index % FINISHED.length], costSource: "listed-prices" },
              at: AT - 3600000,
            });
            tasks.close(id, { status: "done", reason: "finished", actor: "host" });
          }
        })(),
      );
      // Warm the process before counting progress, so startup alone cannot prove it.
      await reader.tasks({ text: "not present", limit: 1, skip: 0 });
      const scores = new PlacedWorkScores(db, new SettingsStore(db), (input) =>
        reader.placed(input),
      );
      const mainData = vi.spyOn(PlacedWorkScores.prototype, "data").mockImplementation(() => {
        throw new Error("main must never read placement history");
      });
      let parentTurns = 0;
      const tick = () => {
        parentTurns++;
        progress = setImmediate(tick);
      };
      progress = setImmediate(tick);
      const reading = row();
      scores.observe("mini", snapshot(AT, [reading]));
      const placements = Array.from({ length: AUDIT_STARTS }, () => scores.prepare([reading], AT));
      const search = reader.tasks({
        text: `session report ${AUDIT_RECORD_TASKS - 1}`,
        status: "closed",
        limit: 1,
        skip: 0,
      });
      // The window's search of earlier work (`TaskProtocol.search`): every row closed before the board's window.
      const earlierInput = { text: "session report 662", recentFrom: AT + 1, limit: 50 };
      const earlier = reader.closed(earlierInput);
      const [answers, found, earlierFound] = await Promise.all([
        Promise.all(placements),
        search,
        earlier,
      ]);
      expect(reader.pid).toBeDefined();
      expect(reader.pid).not.toBe(process.pid);
      expect(parentTurns).toBeGreaterThan(0);
      expect(answers).toHaveLength(AUDIT_STARTS);
      expect(
        answers.every(
          (answer) =>
            answer.work.length === 0 &&
            answer.samples.length === 0 &&
            Object.keys(answer.charges ?? {}).length === 1,
        ),
      ).toBe(true);
      for (const data of answers)
        expect(scores.score(reading, AT, GROK.id, data).charge?.accountId).toBe(reading.accountId);
      expect(mainData).not.toHaveBeenCalled();
      mainData.mockRestore();
      expect(found).toEqual({ ids: [`history-${AUDIT_RECORD_TASKS - 1}`], total: 1 });
      // The same matches, in the same order, as the selection read in this process.
      expect(earlierFound.ids).toHaveLength(11);
      expect(earlierFound).toEqual(tasks.searchClosed(earlierInput));
      console.log(
        JSON.stringify({
          scenario: "concurrent placement and search",
          tasks: AUDIT_RECORD_TASKS,
          starts: AUDIT_STARTS,
          parentTurns,
          separateProcess: reader.pid !== process.pid,
          returnedTaskIds: found.ids,
          earlierWorkIds: earlierFound.ids.length,
          returnedHistoryRows: answers[0]?.work.length,
        }),
      );
    } finally {
      vi.restoreAllMocks();
      if (progress) clearImmediate(progress);
      const pid = reader.pid;
      reader.dispose();
      if (pid)
        await expect
          .poll(() => {
            try {
              process.kill(pid, 0);
              return true;
            } catch {
              return false;
            }
          })
          .toBe(false);
      db.close();
    }
  });

  it("rejects pending reads on shutdown instead of running them on the parent's thread", async () => {
    const dir = scratchDir("infinitary-record-shutdown-");
    const db = openDatabase(dir);
    const reader = new RecordReader(forkChildProcess(entry), join(dir, "firstmate.db"));
    const read = reader.tasks({ limit: 1, skip: 0 });
    const pid = reader.pid;
    reader.dispose();
    await expect(read).rejects.toThrow("shut down");
    await expect(reader.tasks({ limit: 1, skip: 0 })).rejects.toThrow("unavailable");
    if (pid)
      await expect
        .poll(() => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(false);
    db.close();
  });
});
