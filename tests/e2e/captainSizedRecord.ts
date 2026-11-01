import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";

/**
 * A saved record the size of the captain's own, for the freeze journey
 * (main-thread-freeze.spec.ts; INF-2061's plan, "seeds a record of your
 * size"). Each count is a reading of the captain's record, never a guess:
 *
 * - 160,094 task events (INF-2059's reading, the history the open messages
 *   walked);
 * - about 3,400 tasks (INF-940's reading, the task list sorted through a
 *   disk file);
 * - 33 open messages in 13 chains (INF-2061's reading).
 *
 * Every row goes through the one writer (`seedTask`, `TaskService`), so the
 * record holds what the app itself writes: the events are a crewmate's
 * progress lines, the most common event the app records.
 */
export const CAPTAIN_RECORD = {
  taskEvents: 160_094,
  tasks: 3_400,
  openMessages: 33,
  chains: 13,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Writes the record into `userDataDir` and answers the ids of the tasks the
 * open messages are about. Older work is closed, as most of a long record
 * is; the open messages' work waits in the backlog, so no crewmate starts.
 */
export function seedCaptainSizedRecord(
  userDataDir: string,
  now = Date.now(),
): { chainTasks: string[] } {
  const db = openDatabase(userDataDir);
  try {
    const tasks = new TaskService({ db, strict: true });
    const chainTasks: string[] = [];
    db.transaction(() => {
      const closed = CAPTAIN_RECORD.tasks - CAPTAIN_RECORD.chains;
      const ids: string[] = [];
      for (let index = 0; index < CAPTAIN_RECORD.tasks; index += 1) {
        const id = `history-${index}`;
        const isChain = index >= closed;
        seedTask(tasks, {
          id,
          title: `Earlier work ${index}`,
          prompt: `Finish piece ${index} of the earlier work.`,
          status: isChain ? "queued" : index % 7 === 0 ? "cancelled" : "completed",
          ...(isChain ? { startPolicy: "on-request" as const } : {}),
          createdAt: now - (CAPTAIN_RECORD.tasks - index) * (DAY_MS / 40),
        });
        if (!isChain && index % 7 !== 0)
          tasks.close(id, { status: "done", reason: "finished", actor: "host" });
        if (isChain) chainTasks.push(id);
        ids.push(id);
      }
      // Each open message is about one chain's task: the first one starts the
      // chain, and every later one about the same work joins it.
      for (let index = 0; index < CAPTAIN_RECORD.openMessages; index += 1) {
        const askId = `open-message-${index}`;
        const taskId = chainTasks[index % CAPTAIN_RECORD.chains] as string;
        tasks.openAsk({
          id: askId,
          text: `How is piece ${index} going?`,
          at: now - (CAPTAIN_RECORD.openMessages - index) * 60_000,
        });
        tasks.attachAsk(askId, taskId, "tool:spawn_task");
        tasks.closeAsk(askId, "closed");
        tasks.setAskDelivery(askId, "covered");
      }
      // The rest of the history: progress lines spread over every task.
      const counted = db.prepare("SELECT COUNT(*) AS n FROM task_events").get() as { n: number };
      for (let index = counted.n; index < CAPTAIN_RECORD.taskEvents; index += 1) {
        tasks.noteProgress(
          ids[index % ids.length] as string,
          `Checked part ${index} of the change.`,
        );
      }
    })();
    return { chainTasks };
  } finally {
    db.close();
  }
}
