import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SETTLE_FACTS_OPEN } from "@shared/cards";
import { CardService } from "../../../src/core/orchestrator/cardService";
import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import { seedTask } from "../../../src/core/tasks/seedTask";
import { TaskService } from "../../../src/core/tasks/taskService";
import type { HomeRead } from "../browserFreshHome";
import { completionCardBody } from "../completionCard";
import { seedDelivery } from "../taskDelivery";

const CARD_ID = "card-settle-facts-seen";
const TASK_ID = "settle-facts-seen";

/** The card's thread, which the window reads when the card shows. */
export const asked: HomeRead[] = [["inf:cards:thread", [CARD_ID]]];

/**
 * What the settle-facts-seen test's story reads back: the card's words, and
 * the lines its change adds and deletes once the host has read them.
 */
type Input = { title: string; merge: string; lines?: { added: number; deleted: number } };

/**
 * A crewmate's completion decision on its idle task, whose checks passed,
 * put up through the card service as the host puts a card up, so it has the
 * offer and released update a window reports seen. With `lines`, the host
 * has also read what the change adds and deletes, which its fact strip shows
 * as one more cell.
 */
export default function seed(userDataDir: string, { title, merge, lines }: Input): void {
  const db = openDatabase(userDataDir);
  try {
    const tasks = new TaskService({ db, strict: true });
    // A real idle task has a working copy; without one, boot starts it again
    // and a start that fails drops its cards' records.
    const worktreeDir = join(userDataDir, "crew", TASK_ID);
    mkdirSync(worktreeDir, { recursive: true });
    seedTask(tasks, {
      id: TASK_ID,
      title: "Read the meters at a glance",
      status: "idle",
      worktreeDir,
      outcome: "The change is ready to merge.",
    });
    seedDelivery(tasks, TASK_ID, {
      mode: "local-only",
      ci: "green",
      ciAt: Date.now(),
      ...(lines
        ? {
            changeLines: {
              base: "a".repeat(40),
              head: "b".repeat(40),
              ...lines,
              at: Date.now(),
            },
          }
        : {}),
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
        body: `${completionCardBody(
          "<p>The meter test sometimes read before the pending write finished.</p>",
          "<p>The meter waits for the write before it reads.</p>",
          "<p>The meter test failed now and then.</p>",
          "<p>The meter test passes every time.</p>",
        )}${SETTLE_FACTS_OPEN}</div>`,
        status: "ready",
        createdAt: Date.now(),
        actions: [
          { id: "merge", label: merge, default: true, effect: { kind: "merge", after: "close" } },
        ],
      });
    } finally {
      service.dispose();
    }
  } finally {
    db.close();
  }
}
