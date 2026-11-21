import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import { seedTask } from "../../../src/core/tasks/seedTask";
import { TaskService } from "../../../src/core/tasks/taskService";
import type { HomeRead } from "../browserFreshHome";

const CARD_ID = "card-head-narrow-review-1";

/** The card's thread, which the window reads when the card shows. */
export const asked: HomeRead[] = [["inf:cards:thread", [CARD_ID]]];

/** What the card-head-narrow test's story reads back. */
type Words = { title: string; card: string; model: string };

/**
 * A reviewer's decision card about a change it reviewed, as a crewmate
 * writes one: its head carries the Decision and Review finding chips, its
 * task's key and title, and the model it ran on.
 */
export default function seed(userDataDir: string, { title, card, model }: Words): void {
  const db = openDatabase(userDataDir);
  try {
    const tasks = new TaskService({ db, strict: true });
    const reviewed = seedTask(tasks, {
      id: "head-narrow-reviewed",
      title: "Stop an older copy at an update",
      status: "queued",
      startPolicy: "on-request",
    });
    const review = seedTask(tasks, {
      id: "head-narrow-review",
      title,
      status: "queued",
      startPolicy: "on-request",
    });
    new CardStore(db).upsert({
      id: CARD_ID,
      taskId: review.id,
      author: "crewmate",
      priority: 15,
      title: card,
      meta: title,
      model,
      reviewTaskId: reviewed.id,
      body: "<p>The change stops an older copy when an update starts. Three ways remain to handle a copy that is still busy.</p>",
      status: "ready",
      createdAt: Date.now(),
      actions: [
        { id: "wait", label: "Wait for it", variant: "secondary" },
        { id: "stop", label: "Stop it", variant: "primary", default: true },
      ],
    });
  } finally {
    db.close();
  }
}
