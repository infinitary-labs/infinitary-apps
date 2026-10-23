import { expect, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import type { TaskBoard } from "../../src/shared/tasks";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import {
  dockFrameElement,
  expandDock,
  nowFrame,
  nowRow,
  nowRowSelector,
  recordCard,
} from "./rails";
import { showCard, shownCard, shownEntry } from "./stack";
import { focusedRegion, focusOn } from "./windowKeys";

/**
 * INF-551: a click on a Tasks row opens its task even when the card the
 * captain pointed at a moment before appears while that click is under
 * way. Pointing at a card brings it forward, and it takes the window's
 * focus once its body has drawn (`focusCard`); a press the captain began
 * since then decides where focus is, so the card appears without taking
 * the Tasks panel's focus and the click on the next row still counts.
 *
 * The data: two seeded tasks, one waiting on a decision card and one idle,
 * and a note in front, so the decision draws before it appears. The
 * completion signal: the idle task's record opens. Platform: none beyond
 * the hermetic launch; the presses are dispatched in the Tasks panel's
 * frame, as Chromium drops native clicks into a hidden window's frames.
 * Shared resources: none; the test launches its own app on its own data.
 */

const DECISION = "Choose the harbour route";
const NOTE = "The tide tables are current";

function seeded(): string {
  const userDataDir = scratchDir("infinitary-row-press-");
  const db = openDatabase(userDataDir);
  try {
    const tasks = new TaskService({ db, strict: true });
    seedTask(tasks, {
      id: "press-waiting",
      title: "Plan the harbour crossing",
      status: "idle",
      outcome: "Both channels are charted; the route is yours to choose.",
    });
    seedTask(tasks, {
      id: "press-idle",
      title: "Mend the sails",
      status: "idle",
      outcome: "I mended the torn seam on the mainsail.",
    });
    const cards = new CardStore(db);
    const createdAt = Date.now();
    cards.upsert({
      id: "card-press-decision",
      taskId: "press-waiting",
      author: "crewmate",
      meta: "",
      title: DECISION,
      priority: 30,
      status: "ready",
      createdAt,
      body: "<p>The east channel is shorter; the west channel is deeper at low tide.</p>",
      actions: [
        { id: "east", label: "East channel", variant: "secondary" },
        { id: "west", label: "West channel", variant: "primary", default: true },
      ],
    });
    cards.upsert({
      id: "card-press-note",
      author: "firstmate",
      meta: "firstmate",
      title: NOTE,
      priority: 30,
      status: "ready",
      createdAt: createdAt + 1,
      body: "<p>I checked the tide tables against this morning's readings.</p>",
      actions: [],
    });
  } finally {
    db.close();
  }
  return userDataDir;
}

test("a click on a Tasks row opens its task while the card pointed at just before appears", async () => {
  test.setTimeout(90_000);
  const launched = await launchApp({ userDataDir: seeded(), withMockProvider: true });
  try {
    const { page } = launched;
    const board: TaskBoard = await page.evaluate(() => window.infinitary.tasks.board());
    const keyOf = (id: string) => board.tasks.find((task) => task.id === id)?.key as string;
    const waiting = keyOf("press-waiting");
    const idle = keyOf("press-idle");

    await showCard(page, NOTE);
    await expandDock(page, "now");
    await expect(nowRow(page, waiting)).toBeVisible();
    await expect(nowRow(page, idle)).toBeVisible();
    await focusOn(dockFrameElement(page, "now"));
    // The click on the waiting row points at its decision, and the press on
    // the idle row begins right after, before the decision has appeared:
    // both in one task of the panel's page, so the order is the same on
    // every run.
    await nowFrame(page)
      .locator("body")
      .evaluate(
        (body, rows) => {
          body.querySelector<HTMLElement>(rows.waiting)?.click();
          body.querySelector(rows.idle)?.dispatchEvent(
            new PointerEvent("pointerdown", {
              bubbles: true,
              isPrimary: true,
              pointerType: "mouse",
            }),
          );
        },
        { waiting: nowRowSelector(waiting), idle: nowRowSelector(idle) },
      );
    await expect(shownCard(page, DECISION)).toBeVisible();
    await expect(shownEntry(page)).toHaveCSS("opacity", "1");
    // It appeared without taking the focus the press holds in the Tasks panel.
    expect(await focusedRegion(page)).toBe("panel:now");

    // The press ends in its click, which opens the idle task's record.
    await nowRow(page, idle).evaluate((row) => (row as HTMLElement).click());
    await expect(recordCard(page)).toHaveAttribute("data-task-record", "press-idle");
  } finally {
    await launched.close();
  }
});
