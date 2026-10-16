import { expect, type Locator, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { intersects, minimumWindowSize, resizeWindow } from "./layout";
import { SHOWN_ENTRY, showCard } from "./stack";

/**
 * A card from a task that runs on another computer names where it runs in
 * its head, whatever the length of its task's title (FI3-1019; docs/helper.md,
 * "A card from there"): the title gives way, the place reads whole.
 */

// Longer than a card head has room for at any window size, so the title must give way.
const TITLE =
  "Hello-World answer only - read the README, report its first line, and say whether anything else in the project changed since yesterday";
const PLACE = "on Mac mini";
const CARD = "The README's first line is Hello World";

/** Every character shows: nothing inside it is cut or scrolled out of view. */
const readsWhole = (target: Locator) =>
  target.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);

test("a card from a task on another Mac names where it runs whole, however long its task's title", async () => {
  const userDataDir = scratchDir("infinitary-card-place-");
  const db = openDatabase(userDataDir);
  try {
    const task = seedTask(new TaskService({ db, strict: true }), {
      id: "place-readme",
      title: TITLE,
      status: "queued",
      startPolicy: "on-request",
      deviceId: "mini",
    });
    new CardStore(db).upsert({
      id: "card-place-readme-1",
      taskId: task.id,
      author: "crewmate",
      priority: 15,
      title: CARD,
      meta: TITLE,
      model: "Mock Model",
      place: PLACE,
      body: "<p>The first line is Hello World. I changed nothing.</p>",
      status: "ready",
      createdAt: Date.now(),
      actions: [],
    });
  } finally {
    db.close();
  }
  const { app, page, close } = await launchApp({ userDataDir });
  try {
    for (const size of [await minimumWindowSize(app), { width: 1200, height: 800 }]) {
      await resizeWindow(app, page, size);
      await showCard(page, CARD);
      const head = page.locator(`${SHOWN_ENTRY} [data-card-head]`);
      const place = head.locator("[data-card-place]");
      await expect(place).toContainText(PLACE);
      await expect(place).toBeInViewport({ ratio: 1 });
      expect(await readsWhole(place)).toBe(true);
      // The title is what gives way, and the place stays clear of the model and close.
      const meta = head.locator("[data-card-meta]");
      await expect(meta).toHaveText(TITLE);
      expect(await readsWhole(meta)).toBe(false);
      const box = await place.boundingBox();
      const chip = await head.locator("[data-model-chip]").boundingBox();
      const closeBox = await head.getByRole("button", { name: "Close" }).boundingBox();
      if (!box || !chip || !closeBox) throw new Error("The card head did not lay out");
      expect(intersects(box, chip)).toBe(false);
      expect(intersects(box, closeBox)).toBe(false);
    }
  } finally {
    await close();
  }
});
