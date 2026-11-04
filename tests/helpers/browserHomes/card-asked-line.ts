import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import { seedTask } from "../../../src/core/tasks/seedTask";
import { TaskService } from "../../../src/core/tasks/taskService";
import type { HomeRead } from "../browserFreshHome";

/** One of the captain's messages and the title of the first mate's note answering it. */
type Answered = { ask: string; title: string };

/**
 * What the card-asked-line test's story reads back: a short message, then a
 * long one, then work an automation filed, work filed from a click, and work
 * that came from a task nobody asked for in words (INF-2326).
 */
type Input = {
  short: Answered;
  long: Answered;
  automation: { name: string; title: string };
  click: { card: string; choice: string; written: string; title: string };
  from: { parent: string; title: string };
};

/** Each note's thread, read when it shows or is prepared. */
export const asked: HomeRead[] = [
  ["inf:cards:thread", ["asked-short"]],
  ["inf:cards:thread", ["asked-long"]],
  ["inf:cards:thread", ["asked-automation"]],
  ["inf:cards:thread", ["asked-click"]],
  ["inf:cards:thread", ["asked-from"]],
];

/**
 * Two messages of the captain's, each answered on the first mate's own note
 * through the task it attached to (INF-1610), the short one on top.
 */
export default function seed(
  userDataDir: string,
  { short, long, automation, click, from }: Input,
): void {
  const db = openDatabase(userDataDir);
  try {
    const tasks = new TaskService({ db, strict: true });
    const cards = new CardStore(db);
    for (const [name, answered, priority] of [
      ["short", short, 60],
      ["long", long, 50],
    ] as const) {
      const task = seedTask(tasks, {
        id: `asked-${name}-task`,
        title: answered.title,
        status: "completed",
      });
      tasks.openAsk({ id: `ask-${name}`, text: answered.ask });
      tasks.attachAsk(`ask-${name}`, task.id, "tool:emit_card", true);
      tasks.closeAsk(`ask-${name}`, "closed");
      cards.upsert({
        id: `asked-${name}`,
        taskId: task.id,
        author: "firstmate",
        meta: "firstmate",
        priority,
        title: answered.title,
        body: "<p>The stack now keeps a card you replied under in its place while its author answers.</p>",
        status: "ready",
        createdAt: Date.now(),
        actions: [],
      });
    }
    seedTask(tasks, { id: "asked-automation-task", title: automation.title, status: "completed" });
    tasks.saveOrigin("asked-automation-task", {
      kind: "automation",
      ruleId: "rule-nightly",
      name: automation.name,
    });
    seedTask(tasks, { id: "asked-click-task", title: click.title, status: "completed" });
    tasks.saveOrigin("asked-click-task", {
      kind: "chose",
      cardId: "card-plan",
      card: click.card,
      choice: click.choice,
      written: click.written,
    });
    seedTask(tasks, { id: "asked-from-parent", title: from.parent, status: "completed" });
    seedTask(tasks, {
      id: "asked-from-task",
      title: from.title,
      status: "completed",
      parentId: "asked-from-parent",
    });
    for (const [name, title, priority] of [
      ["automation", automation.title, 40],
      ["click", click.title, 30],
      ["from", from.title, 20],
    ] as const) {
      cards.upsert({
        id: `asked-${name}`,
        taskId: `asked-${name}-task`,
        author: "firstmate",
        meta: "firstmate",
        priority,
        title,
        body: "<p>I checked it and nothing else needs your attention.</p>",
        status: "ready",
        createdAt: Date.now(),
        actions: [],
      });
    }
  } finally {
    db.close();
  }
}
