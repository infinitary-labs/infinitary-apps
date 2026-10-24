import { expect, type Locator, type Page, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask, type TaskSeed } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { within } from "./layout";
import {
  KEYBOARD_CARD_TITLES,
  KEYBOARD_CARDS_PROMPT_MARKER,
  SPAWN_PROMPT_MARKER,
} from "./mockProvider";
import { promptInput } from "./prompt";
import { expandDock, nowFrame, openRowSummary, POINT_SUMMARY, rowSummary } from "./rails";
import { pager, showCard, shownCardFrame } from "./stack";
import {
  commandSearch,
  endRecording,
  focusedRegion,
  keyboardSettings,
  pressWindowKey,
  regionAfter,
  startRecording,
} from "./windowKeys";

/**
 * Lists, Settings and the window's parts from the keyboard
 * (docs/keyboard.md, "Parts of the window" and "Lists and Settings"): F6 and
 * ⇧F6 move between the window's parts from wherever focus is, a card's
 * frame included, and the main message keeps its words and caret; in the
 * Tasks list the arrows move between rows, the keyboard's rest opens a
 * row's summary as the pointer's does, Enter opens the task, and focus,
 * the Tab stop and the summary stay with a row whose task moves to another
 * group; Settings' tabs follow the arrows; and the parts' keys can be
 * changed like any other.
 *
 * A key typed into a panel's frame goes through Playwright's keyboard: the
 * window's own input path (`pressWindowKey`) reaches the main process, which
 * hears F6, but not a hidden window's frames.
 */

const DRAFT = "ship the login fix today";
/** The caret after "ship". */
const CARET = 4;

/** The Tasks row that holds the keyboard's focus, by its task's key. */
function focusedRowKey(page: Page): Promise<string | null> {
  // A missing focused row is a reading, not a five-second wait that fails.
  return nowFrame(page)
    .locator("[data-now-row]:focus")
    .evaluateAll((rows) => rows[0]?.getAttribute("data-now-key") ?? null);
}

/**
 * Whether the open summary sits beside `row` where it is now: its hairline
 * leaves the panel's edge at the row's middle (`placeRowSummary`), so a
 * summary still placed for where the row was is not level with it.
 */
async function summaryLevelWith(page: Page, row: Locator): Promise<boolean> {
  const tie = openRowSummary(page).locator("[data-point-summary-tie]");
  const [line, box] = await Promise.all([
    tie.boundingBox({ timeout: 1_000 }).catch(() => null),
    row.boundingBox({ timeout: 1_000 }).catch(() => null),
  ]);
  if (!line || !box) return false;
  // The row's middle, drawn across the hairline, lies within it.
  const middle = { x: line.x, y: box.y + box.height / 2, width: line.width, height: 0 };
  return within(middle, line).length === 0;
}

test("F6 and Shift+F6 go round the window's parts, and the arrows move through the Tasks list", async () => {
  test.setTimeout(120_000);
  const launched = await launchApp({ withMockProvider: true });
  try {
    const { app, page } = launched;
    const prompt = promptInput(page);
    await prompt.click();
    await prompt.fill(`${SPAWN_PROMPT_MARKER} ${KEYBOARD_CARDS_PROMPT_MARKER}`);
    await prompt.press("Enter");
    await expect(pager(page, 2)).toBeVisible({ timeout: 30_000 });
    await prompt.fill(`${SPAWN_PROMPT_MARKER} tidy the release notes`);
    await prompt.press("Enter");
    await expandDock(page, "now");
    await expandDock(page, "activity");
    await expect(nowFrame(page).locator("[data-now-row]")).toHaveCount(2, { timeout: 30_000 });

    const round: string[] = [];
    await test.step("F6 from the main message reaches every part and comes back, words and caret kept", async () => {
      await prompt.fill(DRAFT);
      await prompt.evaluate(
        (field: HTMLTextAreaElement, at) => field.setSelectionRange(at, at),
        CARET,
      );
      let at = await focusedRegion(page);
      expect(at).toBe("main-message");
      do {
        at = await regionAfter(app, page, at, "F6");
        if (at !== null) round.push(at);
      } while (at !== "main-message" && round.length < 10);
      expect(round).toEqual(expect.arrayContaining(["card", "panel:now", "panel:activity"]));
      expect(round.at(-1)).toBe("main-message");
      await expect(prompt).toBeFocused();
      await expect(prompt).toHaveValue(DRAFT);
      expect(await prompt.evaluate((field: HTMLTextAreaElement) => field.selectionStart)).toBe(
        CARET,
      );
    });

    await test.step("Shift+F6 goes back the same way", async () => {
      const back: string[] = [];
      let at: string | null = "main-message";
      for (let i = 0; i < round.length; i++) {
        at = await regionAfter(app, page, at, "F6", ["shift"]);
        if (at !== null) back.push(at);
      }
      expect(back).toEqual([...round].reverse().slice(1).concat("main-message"));
    });

    await test.step("from a field inside a card's frame, F6 moves on to the next part", async () => {
      await showCard(page, KEYBOARD_CARD_TITLES.inline);
      const note = shownCardFrame(page).getByRole("textbox", { name: "Note" });
      await note.fill("half a thought");
      expect(await focusedRegion(page)).toBe("card");
      const next = round[round.indexOf("card") + 1] ?? null;
      expect(await regionAfter(app, page, "card", "F6")).toBe(next);
      await expect(note).toHaveValue("half a thought");
    });

    await test.step("in the Tasks list, the arrows move between rows, the keyboard's rest opens a summary, and Enter opens the task", async () => {
      // The second task may still be starting: its row moves from queued to
      // working when its crewmate begins, and a row that changes group is
      // drawn anew, so the focus resting on it would go. The arrows start
      // once both rows sit in working.
      await expect(nowFrame(page).locator('[data-now-group="working"] [data-now-row]')).toHaveCount(
        2,
        { timeout: 30_000 },
      );
      let at = await focusedRegion(page);
      while (at !== "panel:now") at = await regionAfter(app, page, at, "F6");
      await expect.poll(() => focusedRowKey(page)).not.toBeNull();
      const first = await focusedRowKey(page);
      await expect(rowSummary(page)).toBeVisible();
      await page.keyboard.press("ArrowDown");
      await expect.poll(() => focusedRowKey(page)).not.toBe(first);
      const second = await focusedRowKey(page);
      await expect(rowSummary(page)).toBeVisible();
      await page.keyboard.press("Home");
      await expect.poll(() => focusedRowKey(page)).toBe(first);
      await page.keyboard.press("Escape");
      await expect(rowSummary(page)).toBeHidden();

      // One Tab stop: F6 away and back lands on the row focus was last on.
      await page.keyboard.press("End");
      await expect.poll(() => focusedRowKey(page)).toBe(second);
      at = await regionAfter(app, page, "panel:now", "F6");
      while (at !== "panel:now") at = await regionAfter(app, page, at, "F6");
      await expect.poll(() => focusedRowKey(page)).toBe(second);

      await page.keyboard.press("Enter");
      await expect(
        nowFrame(page).locator(`[data-now-row][data-now-key="${second}"]`),
      ).toHaveAttribute("data-now-selected", "");
    });
  } finally {
    await launched.close();
  }
});

/**
 * INF-902: a task moves to another group under the keyboard's rest - it
 * starts, finishes, gets a card, or another surface moves it - and the
 * panel draws its row anew there. Focus, the list's one Tab stop and the
 * open summary go with it; a task that moves into a closed group leaves
 * them on that group's header, never on the frame's body. Here another
 * surface moves it: the task board's Back to backlog, through the record's
 * own path (`task.run`), while the keyboard stays in the Tasks list.
 */
test("a task the keyboard rests on keeps focus, the Tab stop and its summary as it moves to another group", async () => {
  const userDataDir = scratchDir("infinitary-keyboard-moves-");
  const db = openDatabase(userDataDir);
  try {
    const now = Date.now();
    let clock = now - 60 * 60_000;
    const tasks = new TaskService({ db, strict: true, now: () => clock });
    // Held until next month, so the queued tasks wait without starting.
    const held = { kind: "at-time" as const, until: now + 30 * 24 * 60 * 60_000 };
    const seed = (value: TaskSeed) => {
      clock += 60_000;
      seedTask(tasks, value);
    };
    seed({ id: "launch", title: "Plan the spring launch email", status: "queued", gate: held });
    seed({ id: "venue", title: "Book the venue for the offsite", status: "queued", gate: held });
    seed({ id: "notes", title: "Sort the release notes by area", status: "queued", gate: held });
    seed({
      id: "icons",
      title: "Retire the old app icons",
      status: "queued",
      startPolicy: "on-request",
    });
  } finally {
    db.close();
  }
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { app, page } = launched;
    const list = nowFrame(page);
    const row = (id: string) => list.locator(`[data-now-row="${id}"]`);
    const backlog = list.locator('[data-now-group-header="backlog"]');
    const focused = (target: string) => list.locator(`${target}:focus`);
    const toBacklog = (id: string) =>
      page.evaluate((taskId) => window.infinitary.task.run(taskId, "unqueue-task"), id);
    const f6AwayAndBack = async () => {
      let at = await regionAfter(app, page, "panel:now", "F6");
      while (at !== "panel:now") at = await regionAfter(app, page, at, "F6");
    };
    await expandDock(page, "now");
    await expect(list.locator("[data-now-row]")).toHaveCount(3);
    await promptInput(page).click();
    let at = await focusedRegion(page);
    while (at !== "panel:now") at = await regionAfter(app, page, at, "F6");
    await expect.poll(() => focusedRowKey(page)).not.toBeNull();

    await test.step("a row that moves to an open group keeps focus, the Tab stop and its summary there", async () => {
      // End reaches the backlog's header, → opens it, ↑ rests on the last queued row.
      await page.keyboard.press("End");
      await expect(focused('[data-now-group-header="backlog"]')).toHaveCount(1);
      await page.keyboard.press("ArrowRight");
      await expect(row("icons")).toBeVisible();
      await page.keyboard.press("ArrowUp");
      await expect(focused('[data-now-group="queued"] [data-now-row="notes"]')).toHaveCount(1);
      await expect(openRowSummary(page)).toHaveAttribute(POINT_SUMMARY, "notes");
      await expect.poll(() => summaryLevelWith(page, row("notes"))).toBe(true);

      await toBacklog("notes");
      await expect(focused('[data-now-group="backlog"] [data-now-row="notes"]')).toHaveCount(1);
      await expect(openRowSummary(page)).toHaveAttribute(POINT_SUMMARY, "notes");
      await expect.poll(() => summaryLevelWith(page, row("notes"))).toBe(true);
      // The keys go on from the row where it is now.
      await page.keyboard.press("ArrowDown");
      await expect(focused('[data-now-row="icons"]')).toHaveCount(1);
      await page.keyboard.press("ArrowUp");
      await expect(focused('[data-now-row="notes"]')).toHaveCount(1);
      // One Tab stop: F6 away and back lands on the row in its new group.
      const notes = await row("notes").getAttribute("data-now-key");
      await f6AwayAndBack();
      await expect.poll(() => focusedRowKey(page)).toBe(notes);
    });

    await test.step("a row that moves into a closed group leaves focus and the Tab stop on that group's header", async () => {
      // ← goes up to the backlog's header and ← closes it; ↑ rests on the last queued row.
      await page.keyboard.press("ArrowLeft");
      await expect(focused('[data-now-group-header="backlog"]')).toHaveCount(1);
      await page.keyboard.press("ArrowLeft");
      await expect(backlog).toHaveAttribute("aria-expanded", "false");
      await page.keyboard.press("ArrowUp");
      await expect(focused('[data-now-row="venue"]')).toHaveCount(1);

      await toBacklog("venue");
      await expect(row("venue")).toHaveCount(0);
      await expect(focused('[data-now-group-header="backlog"]')).toHaveCount(1);
      await f6AwayAndBack();
      await expect(focused('[data-now-group-header="backlog"]')).toHaveCount(1);
    });
  } finally {
    await launched.close();
  }
});

test("Settings' tabs follow the arrow keys, and F6 moves between the tabs and the open section", async () => {
  const launched = await launchApp();
  try {
    const { app, page } = launched;
    await expect(promptInput(page)).toBeVisible();
    await pressWindowKey(app, ",", ["meta"]);
    const selected = page.getByRole("tab", { selected: true });
    await expect(selected).toBeVisible();

    expect(await regionAfter(app, page, await focusedRegion(page), "F6")).toBe("settings-tabs");
    await expect(selected).toBeFocused();
    const first = await selected.textContent();

    await page.keyboard.press("ArrowRight");
    await expect(selected).not.toHaveText(first ?? "");
    await expect(selected).toBeFocused();
    // The open section is the chosen tab's.
    const tabId = await selected.getAttribute("id");
    await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", tabId ?? "");

    await page.keyboard.press("End");
    await expect(selected).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(selected).toHaveText(first ?? "");
    await expect(selected).toBeFocused();

    // The tabs are one Tab stop: Tab goes on into the section.
    await page.keyboard.press("Tab");
    expect(await focusedRegion(page)).toBe("settings-section");
    expect(await regionAfter(app, page, "settings-section", "F6", ["shift"])).toBe("settings-tabs");
    expect(await regionAfter(app, page, "settings-tabs", "F6")).toBe("settings-section");
  } finally {
    await launched.close();
  }
});

test("a person gives Go to the next part of the window a key of their own", async () => {
  const launched = await launchApp();
  try {
    const { app, page } = launched;
    const keyboard = keyboardSettings(page);
    await pressWindowKey(app, "k", ["meta"]);
    const search = commandSearch(page);
    await expect(search.row("regions.next").locator("kbd")).toHaveText("F6");
    await search.field.fill("keyboard");
    await pressWindowKey(app, "Enter");
    await expect(keyboard.search).toBeFocused();

    await startRecording(page, "regions.next");
    await pressWindowKey(app, "F7");
    await expect(keyboard.verdict("regions.next")).toHaveAttribute("data-keyboard-verdict", "free");
    await endRecording(app, page, "Enter");
    await expect(keyboard.keys("regions.next").locator("kbd")).toHaveText(["F7"]);

    // F7 now moves between the parts; F6 no longer does. Each part focus
    // goes into is written down as it goes.
    await page.evaluate(() => {
      const moves: (string | null)[] = [];
      (window as unknown as { moves: typeof moves }).moves = moves;
      document.addEventListener("focusin", () =>
        moves.push(
          document.activeElement
            ?.closest("[data-window-region]")
            ?.getAttribute("data-window-region") ?? null,
        ),
      );
    });
    const movesSoFar = () =>
      page.evaluate(() => {
        const log = (window as unknown as { moves: (string | null)[] }).moves;
        return log.splice(0).filter((move) => move !== null);
      });
    const from = await regionAfter(app, page, await focusedRegion(page), "F7");
    const to = await regionAfter(app, page, from, "F7");
    expect(new Set([from, to])).toEqual(new Set(["settings-tabs", "settings-section"]));
    expect(await movesSoFar()).toEqual([from, to]);
    await pressWindowKey(app, "F6");
    // A later window key: once it has opened search, F6 has been heard too.
    await pressWindowKey(app, "k", ["meta"]);
    await expect(search.dialog).toBeVisible();
    expect(await movesSoFar()).toEqual([]);
    await pressWindowKey(app, "Escape");
    await expect(search.dialog).toBeHidden();

    await keyboard.resetAll.click();
    await keyboard.resetAll.click();
    await expect(keyboard.keys("regions.next").locator("kbd")).toHaveText(["F6"]);
  } finally {
    await launched.close();
  }
});
