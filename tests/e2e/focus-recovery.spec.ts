import { expect, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { promptInput } from "./prompt";
import { expandDock, nowFrame, pressRow, recordCard } from "./rails";
import { cardReply } from "./stack";
import { typeInto } from "./windowKeys";

async function launchStack() {
  const userDataDir = scratchDir("infinitary-focus-recovery-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db, strict: true });
  const task = seedTask(tasks, {
    id: "harbour",
    title: "harbour",
    status: "queued",
    startPolicy: "on-request",
  });
  const cards = new CardStore(db);
  for (const [index, title] of ["Alpha", "Bravo", "Charlie"].entries()) {
    cards.upsert({
      id: title,
      author: "firstmate",
      priority: 25,
      title,
      meta: "firstmate",
      body: `<p>${title} body.</p>`,
      actions: [],
      status: "ready",
      createdAt: 1000 + index,
    });
  }
  db.close();
  return { app: await launchApp({ userDataDir, withMockProvider: true }), key: task.key };
}

test("Escape from a record does not restore a stale card control", async () => {
  const { app, key } = await launchStack();
  try {
    const { page } = app;
    await cardReply(page).field.click();
    await expandDock(page, "now");
    await nowFrame(page)
      .locator('[data-now-group-header="backlog"]')
      .evaluate((el) => (el as HTMLElement).click());
    await pressRow(page, key);
    await expect(recordCard(page)).toHaveAttribute("data-task-record", "harbour");
    await page.mouse.click(5, 120);
    await page.keyboard.press("Escape");
    await expect(recordCard(page)).toHaveCount(0);
    await expect(promptInput(page)).toBeFocused();
    await typeInto(promptInput(page), "Next task");
    await expect(promptInput(page)).toHaveValue("Next task");
  } finally {
    await app.close();
  }
});
