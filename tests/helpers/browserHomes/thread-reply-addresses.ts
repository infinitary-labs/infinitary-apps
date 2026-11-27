import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import { SCRATCH_PROJECT_KEY } from "../../../src/core/storage/projectStore";
import { seedTask } from "../../../src/core/tasks/seedTask";
import { TaskService } from "../../../src/core/tasks/taskService";
import type { HomeRead } from "../browserFreshHome";

const CARD_ID = "thread-reply-addresses";

/** The one task's key: the first a fresh home numbers, in the project of tasks no project holds. */
const KEY = `${SCRATCH_PROJECT_KEY}-1`;

/** The card's thread, read when it shows, and the reply's task key, which the window looks up. */
export const asked: HomeRead[] = [
  ["inf:cards:thread", [CARD_ID]],
  ["inf:tasks:keys", [[KEY]]],
];

/**
 * What the thread-reply-addresses test's story reads back: the card's title
 * and its thread's two lines, the captain's with `{key}` where the task's key goes.
 */
type Input = { title: string; answer: string; reply: string };

/**
 * A Secrets ask the first mate raised, with the captain's question and the
 * first mate's answer under it: the answer names the key page as words, as
 * the ask's step did, and the captain's line names an older address and the
 * task the key is for.
 */
export default function seed(userDataDir: string, { title, answer, reply }: Input): void {
  const db = openDatabase(userDataDir);
  try {
    const task = seedTask(new TaskService({ db, strict: true }), {
      id: "rehearse-harness",
      title: "Rehearse harness chapters 6 to 12 with a real model",
      status: "queued",
      startPolicy: "on-request",
    });
    if (task.key !== KEY) throw new Error(`The seeded task took ${task.key}, not ${KEY}`);
    const cards = new CardStore(db);
    cards.upsert({
      id: CARD_ID,
      author: "firstmate",
      meta: "firstmate",
      priority: 30,
      title,
      body: "<p>The rehearsal runs through OpenRouter, and its meter stops at your cap.</p>",
      status: "ready",
      createdAt: Date.now(),
      actions: [
        { id: "later", label: "Not now", variant: "secondary" },
        { id: "add", label: "Add the key", variant: "primary", default: true },
      ],
    });
    cards.appendMessage({ cardId: CARD_ID, who: "captain", text: reply.replace("{key}", KEY) });
    cards.appendMessage({ cardId: CARD_ID, who: "firstmate", text: answer });
  } finally {
    db.close();
  }
}
