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
  pressDrawnRow,
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
    // INF-2537 / run 41733606005: keep the focus assertion above intact;
    // find and click the current row in one read, without refocusing it.
    expect(await pressDrawnRow(page, idle), `the Tasks row ${idle} is drawn to press`).toBe(true);
    await expect(recordCard(page)).toHaveAttribute("data-task-record", "press-idle");
  } finally {
    await launched.close();
  }
});

/**
 * INF-1146 (row-press-card-appears.spec.ts:127 in run 40092988228: focus
 * landed on the card instead of the Tasks panel): the panel says a press
 * began after it has asked for the task, and its process can send that late,
 * once the window has read the task and shown its card. The window here
 * holds every message the panel sends after it points, in their order,
 * until the card has appeared, so the order the failing run met by chance
 * is the order of every run. The data: the same two tasks and note. The
 * completion signal: the panel has answered a message the window sent it
 * after letting the held ones go, so the window has heard all it said
 * before. Platform and shared resources: none beyond the hermetic launch.
 */
test("a press the window hears of only after the card appeared keeps the Tasks panel's focus", async () => {
  test.setTimeout(90_000);
  const launched = await launchApp({ userDataDir: seeded(), withMockProvider: true });
  try {
    const { page } = launched;
    // The hold listens before the window's own code does, so the window
    // hears a held message only when it is let go.
    await page.addInitScript(() => {
      const held: MessageEvent[] = [];
      const state = {
        panel: null as Window | null,
        holding: false,
        released: false,
        answered: false,
        held,
      };
      Object.assign(window, { heldPanel: state });
      window.addEventListener(
        "message",
        (event) => {
          if (!state.panel || event.source !== state.panel) return;
          if (event.data?.marker === "answer") {
            event.stopImmediatePropagation();
            state.answered = true;
          } else if (state.holding) {
            event.stopImmediatePropagation();
            held.push(event);
          } else if (!state.released && event.data?.action === "point.openTask") {
            state.holding = true;
          }
        },
        true,
      );
    });
    await page.reload();
    const board: TaskBoard = await page.evaluate(() => window.infinitary.tasks.board());
    const keyOf = (id: string) => board.tasks.find((task) => task.id === id)?.key as string;
    const waiting = keyOf("press-waiting");
    const idle = keyOf("press-idle");

    await showCard(page, NOTE);
    await expandDock(page, "now");
    await expect(nowRow(page, waiting)).toBeVisible();
    await expect(nowRow(page, idle)).toBeVisible();
    await focusOn(dockFrameElement(page, "now"));
    // The panel answers the window's marker after everything the window sent it before.
    await nowFrame(page)
      .locator("body")
      .evaluate(() => {
        window.addEventListener("message", (event) => {
          if (event.source === parent && event.data?.marker === "ask")
            parent.postMessage({ marker: "answer" }, "*");
        });
      });
    type Held = {
      panel: Window | null;
      holding: boolean;
      released: boolean;
      answered: boolean;
      held: MessageEvent[];
    };
    // Every message the panel sends after it points waits, in order, as
    // messages its process sent late would, until the decision has appeared:
    // its entry is shown and no longer kept out of sight.
    await dockFrameElement(page, "now").evaluate((element, decision) => {
      const state = (window as unknown as { heldPanel: Held }).heldPanel;
      state.panel = (element as HTMLIFrameElement).contentWindow;
      const appeared = new MutationObserver(() => {
        const entry = document.querySelector<HTMLElement>(
          `[data-stage-entry="shown"][data-stage-entry-id="${decision}"]`,
        );
        if (!state.holding || !entry || entry.style.opacity === "0") return;
        appeared.disconnect();
        state.holding = false;
        state.released = true;
        for (const event of state.held.splice(0))
          window.dispatchEvent(
            new MessageEvent("message", {
              data: event.data,
              origin: event.origin,
              source: event.source,
            }),
          );
        state.panel?.postMessage({ marker: "ask" }, "*");
      });
      appeared.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["style", "data-stage-entry", "data-stage-entry-id"],
      });
    }, "card-press-decision");
    const held = () =>
      page.evaluate(() => {
        const { holding, released, answered, held } = (window as unknown as { heldPanel: Held })
          .heldPanel;
        return { holding, released, answered, held: held.length };
      });

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
    // The press's notice and all the panel said after it arrived once the card had appeared.
    await expect.poll(async () => (await held()).answered).toBe(true);
    expect((await held()).released).toBe(true);
    await expect(shownCard(page, DECISION)).toBeVisible();
    expect(await focusedRegion(page)).toBe("panel:now");

    // The press ends in its click, which opens the idle task's record.
    // INF-2537 / run 41733606005: keep the focus assertion above intact;
    // find and click the current row in one read, without refocusing it.
    expect(await pressDrawnRow(page, idle), `the Tasks row ${idle} is drawn to press`).toBe(true);
    await expect(recordCard(page)).toHaveAttribute("data-task-record", "press-idle");
  } finally {
    await launched.close();
  }
});
