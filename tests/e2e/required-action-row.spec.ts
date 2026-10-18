import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import {
  expandDock,
  nowRow,
  nowRowGroup,
  openGroup,
  pressRow,
  recordCard,
  taskKeyLinks,
} from "./rails";
import { shownCard } from "./stack";

/**
 * A Waiting on you row for a required action the captain put off with Not
 * now (INF-358; the captain's "clicking on a task row in the 'waiting on
 * you' section of the tasks panel ... should directly open the decision card
 * that's waiting on the user, not the task card"): the row has no open card,
 * and its click shows the required action card again, as the record's Show
 * the card does, with the row's key in the card's head.
 */

const ACTION_TITLE = "Install the new version on the Mac mini";

function seed(userDataDir: string): { key: string; id: string } {
  const db = openDatabase(userDataDir);
  try {
    const tasks = new TaskService({ db, strict: true });
    const source = seedTask(tasks, {
      id: "row-source",
      title: "Add the device link to Settings",
      status: "completed",
    });
    tasks.declareRequiredActions(
      source.id,
      {
        cardId: "card-row-source-1",
        offerId: "offer-1",
        actions: [
          {
            id: "install-on-the-mini",
            target: "the Mac mini",
            title: ACTION_TITLE,
            consequence: "Until then the Mac mini keeps the old link.",
            instructions: ["Open Infinitary on the Mac mini.", "Choose Update now."],
            criterion: "The Mac mini reports the new version.",
            prerequisites: [],
            completion: { kind: "manual", label: "I installed it" },
          },
        ],
      },
      true,
    );
    const row = tasks.listOpen().find((record) => record.delivery?.captainAction);
    if (!row) throw new Error("The required action filed no row");
    // Presented once, as the card was, then Not now: the card is gone, the row stays.
    tasks.presentCaptainAction(row.id);
    tasks.deferCaptainAction(row.id);
    return { key: row.key, id: row.id };
  } finally {
    db.close();
  }
}

test("a Waiting on you row for a deferred required action shows its card again, not the record", async () => {
  const userDataDir = scratchDir("infinitary-required-action-row-");
  const row = seed(userDataDir);
  const launched = await launchApp({ userDataDir });
  try {
    const { app, page } = launched;
    await resizeWindow(app, page, { width: 1280, height: 820 });
    await expandDock(page, "now");
    await openGroup(page, "waiting");
    await expect(nowRow(page, row.key)).toBeVisible();
    expect(await nowRowGroup(page, row.key)).toBe("waiting");
    // No card is open for it: the row carries no shortcut to one.
    expect(
      await page.evaluate(
        async (id) =>
          (await window.infinitary.tasks.board()).tasks.find((task) => task.id === id)
            ?.waitingCardId,
        row.id,
      ),
    ).toBeNull();
    await pressRow(page, row.key);
    const card = shownCard(page, ACTION_TITLE);
    await expect(card).toBeVisible();
    await expect(recordCard(page)).toHaveCount(0);
    // The app's own card about the task names it in its head, as every card about a task does.
    await expect(taskKeyLinks(card.locator("[data-card-head] [data-card-key]"))).toHaveText([
      row.key,
    ]);
    await page.screenshot({ path: test.info().outputPath("required-action-row.png") });
  } finally {
    await launched.close();
  }
});
