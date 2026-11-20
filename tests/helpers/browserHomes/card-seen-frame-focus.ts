import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CardService } from "../../../src/core/orchestrator/cardService";
import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import { seedTask } from "../../../src/core/tasks/seedTask";
import { TaskService } from "../../../src/core/tasks/taskService";
import type { HomeRead } from "../browserFreshHome";

const CARD_ID = "card-seen-frame-focus";
const TASK_ID = "seen-frame-focus";

/** The card's thread, which the window reads when the card shows. */
export const asked: HomeRead[] = [["inf:cards:thread", [CARD_ID]]];

/**
 * A crewmate's findings note on its idle task, put up through the card
 * service as the host puts a card up, so it has the offer and released
 * update a window reports seen. Its body holds a link the keyboard focus
 * can rest on.
 */
export default function seed(userDataDir: string, { title }: { title: string }): void {
  const db = openDatabase(userDataDir);
  try {
    const tasks = new TaskService({ db, strict: true });
    // A real idle task has a working copy; without one, boot starts it again
    // and a start that fails drops its cards' records.
    const worktreeDir = join(userDataDir, "crew", TASK_ID);
    mkdirSync(worktreeDir, { recursive: true });
    seedTask(tasks, {
      id: TASK_ID,
      title: "Check latency",
      status: "idle",
      worktreeDir,
      outcome: "The findings are on the card.",
    });
    const service = new CardService({
      now: () => Date.now(),
      tasks,
      cardStore: new CardStore(db),
      syncCaptainGate: () => {},
      closeAnsweredTask: () => false,
      settleFacts: () => undefined,
      followupNotice: () => undefined,
      broadcastCrewCounts: () => {},
      broadcastEvent: () => {},
      broadcastCards: () => {},
    });
    try {
      service.put({
        id: CARD_ID,
        taskId: TASK_ID,
        author: "crewmate",
        meta: "crewmate",
        priority: 30,
        title,
        body: '<p>The sampler reads every second.</p><p><a href="#findings">The findings</a></p>',
        status: "ready",
        createdAt: Date.now(),
        actions: [],
      });
    } finally {
      service.dispose();
    }
  } finally {
    db.close();
  }
}
