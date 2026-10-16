import { expect, type FrameLocator, type Page, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import type { Card, CardObservation } from "../../src/shared/cards";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody, frameGesturesDecided } from "./frames";
import { launchApp } from "./launch";
import { pressPointer, resizeWindow } from "./layout";
import { INLINE_PNG } from "./mockProvider";
import { promptInput } from "./prompt";
import { keySummary, linkedTaskKeys, recordCard } from "./rails";
import { expectNoCard, SHOWN_ENTRY, showCard, shownCard, shownEntry } from "./stack";
import {
  commandSearch,
  focusedRegion,
  focusOn,
  pressKey,
  pressWindowKey,
  regionAfter,
  runFromSearch,
  typeInto,
} from "./windowKeys";

/**
 * A card from the keyboard alone (docs/keyboard.md, "Cards and frames";
 * FI3-800 piece 6): F6 lands on the card and the reading keys scroll its
 * body; Go to the card's body and Go to the card's buttons go to its own
 * places; a choice pressed with Enter goes through the click's own checks,
 * and a held Enter sends nothing more; focus that leaves a field or a
 * picture inside the card's frame for command search or the picture viewer
 * comes back to it, caret and all; a task key the keyboard rests on opens
 * its summary; Escape leaves the body for the card; and a card's script
 * cannot use any of it to open things or move focus.
 *
 * A key typed inside a card's frame goes through Playwright's keyboard: the
 * window's own input path (`pressWindowKey`) reaches the main process,
 * which hears the window's commands, but not a hidden window's frames.
 */

const TITLE = "Pick the launch window";
const HOSTILE = "A card that forges its own gestures";
const PICTURES = ["The launch board before", "The launch board after"];
const DRAFT = "ship the login fix today";
/** The caret after "ship". */
const CARET = 4;

function decisionCard(key: string): Card {
  return {
    id: "card-fm-launch",
    author: "firstmate",
    meta: "firstmate",
    priority: 20,
    title: TITLE,
    body:
      `<p>The checklist in ${key} is ready. Pick when the launch goes out.</p>` +
      `<fieldset><legend>When should it launch?</legend>` +
      `<label><input type="radio" name="window" value="morning" required> Tomorrow morning</label>` +
      `<label><input type="radio" name="window" value="evening"> Tomorrow evening</label></fieldset>` +
      `<p><label>Note <textarea name="note"></textarea></label></p>` +
      `<figure class="inf-pictures">` +
      PICTURES.map((alt) => `<img src="${INLINE_PNG}" alt="${alt}" width="160" height="90">`).join(
        "",
      ) +
      `<figcaption>The launch board, before and after</figcaption></figure>` +
      "<p>The rest of the plan follows, one step a line.</p>".repeat(16),
    status: "ready",
    createdAt: Date.now(),
    actions: [
      { id: "hold", label: "Hold", variant: "secondary" },
      { id: "launch", label: "Launch it", variant: "primary", default: true },
    ],
  };
}

/**
 * A body whose script, ten times over two seconds, makes the bridge send
 * every gesture that opens or moves something - a click on its picture and
 * on its task key, an Escape - and sends a picture of its own besides,
 * while it keeps every key the captain types inside it for itself.
 */
function hostileCard(key: string): Card {
  const forged = JSON.stringify({
    fm: 2,
    type: "image",
    index: 0,
    pictures: [{ src: INLINE_PNG, alt: "forged", width: 2, height: 2 }],
  });
  return {
    id: "card-fm-hostile",
    author: "firstmate",
    meta: "firstmate",
    priority: 30,
    title: HOSTILE,
    body:
      `<p>The report in ${key} is ready.</p>` +
      `<p><label>Scratch <input name="scratch"></label></p>` +
      `<img src="${INLINE_PNG}" alt="A picture the script clicks" width="80" height="40">` +
      `<p role="status">0</p>` +
      "<script>(function () {" +
      'document.addEventListener("keydown", function (event) {' +
      "  if (event.isTrusted) { event.preventDefault(); event.stopImmediatePropagation(); }" +
      "}, true);" +
      "var sent = 0;" +
      "var forge = setInterval(function () {" +
      '  var click = function (node) { if (node) node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); };' +
      '  click(document.querySelector("img"));' +
      '  click(document.querySelector("a[data-inf-task]"));' +
      '  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));' +
      `  parent.postMessage(${forged}, "*");` +
      "  sent += 1;" +
      '  document.querySelector("[role=status]").textContent = String(sent);' +
      "  if (sent >= 10) clearInterval(forge);" +
      "}, 200);" +
      "})();</script>",
    status: "ready",
    createdAt: Date.now(),
    actions: [],
  };
}

/** A recorded task for the bodies to name, and the cards. */
function seed(userDataDir: string, cards: (key: string) => Card[]): void {
  const db = openDatabase(userDataDir);
  try {
    const task = seedTask(new TaskService({ db, strict: true }), {
      id: "keyboard-launch",
      title: "Prepare the launch checklist",
      status: "queued",
      startPolicy: "on-request",
    });
    const store = new CardStore(db);
    for (const card of cards(task.key)) store.upsert(card);
  } finally {
    db.close();
  }
}

function observationsOf(userDataDir: string, cardId: string): CardObservation[] {
  const db = openDatabase(userDataDir);
  try {
    return new CardStore(db).observations(cardId);
  } finally {
    db.close();
  }
}

const body = (page: Page, title: string): FrameLocator => cardBody(page, title);

/** What holds focus inside a card's frame: its tag and its name. */
function focusedInFrame(frame: FrameLocator): Promise<{ tag: string; name: string } | null> {
  return frame
    .locator("body")
    .evaluate(() => {
      const active = document.activeElement;
      if (!active || active === document.body) return null;
      return {
        tag: active.tagName,
        name: active.getAttribute("alt") ?? active.getAttribute("name") ?? "",
      };
    })
    .catch(() => null);
}

/** How far the shown card's body, the one place it scrolls, is scrolled. */
const cardScroll = (page: Page) =>
  shownEntry(page)
    .locator("[data-card-body]")
    .evaluate((scroller) => scroller.scrollTop);

/** How much of the shown card's body lies past its edge, once its frame has laid out. */
const cardOverflow = (page: Page) =>
  shownEntry(page)
    .locator("[data-card-body]")
    .evaluate((scroller) => scroller.scrollHeight - scroller.clientHeight);

/** The picture viewer and the place it says it is at. */
const viewer = (page: Page) => page.getByRole("dialog", { name: /^Pictures from / });

async function typeDraft(page: Page): Promise<void> {
  const prompt = promptInput(page);
  await prompt.fill(DRAFT);
  await prompt.evaluate((field: HTMLTextAreaElement, at) => field.setSelectionRange(at, at), CARET);
  await expect(prompt).toBeFocused();
}

async function expectDraftKept(page: Page): Promise<void> {
  const prompt = promptInput(page);
  await expect(prompt).toBeFocused();
  await expect(prompt).toHaveValue(DRAFT);
  expect(await prompt.evaluate((field: HTMLTextAreaElement) => field.selectionStart)).toBe(CARET);
}

test("a card is read, answered and chosen from the keyboard, through the click's own checks", async () => {
  test.setTimeout(120_000);
  const userDataDir = scratchDir("infinitary-card-keyboard-");
  seed(userDataDir, (key) => [decisionCard(key)]);
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  let offerId = "";
  try {
    const { app, page } = launched;
    await resizeWindow(app, page, { width: 1280, height: 820 });
    await showCard(page, TITLE);
    await typeDraft(page);
    offerId = await page.evaluate(
      async (title) =>
        (await window.infinitary.cards.list()).find((card) => card.title === title)?.offerId ?? "",
      TITLE,
    );
    expect(offerId).not.toBe("");

    await test.step("F6 lands on the card, and the reading keys scroll its body", async () => {
      await expect.poll(() => cardOverflow(page)).toBeGreaterThan(0);
      let at = await focusedRegion(page);
      while (at !== "card") at = await regionAfter(app, page, at, "F6");
      expect(await cardScroll(page)).toBe(0);
      await page.keyboard.press("PageDown");
      await expect.poll(() => cardScroll(page)).toBeGreaterThan(0);
      await page.keyboard.press("End");
      const end = await cardScroll(page);
      await page.keyboard.press("ArrowUp");
      await expect.poll(() => cardScroll(page)).toBeLessThan(end);
      await page.keyboard.press("Home");
      await expect.poll(() => cardScroll(page)).toBe(0);
    });

    await test.step("Go to the card's body puts focus in the body, and Tab goes on to its first control", async () => {
      await runFromSearch(app, page, "focus.card-body");
      await expect(shownEntry(page).locator("[data-card-body]")).toBeFocused();
      await page.keyboard.press("PageDown");
      await expect.poll(() => cardScroll(page)).toBeGreaterThan(0);
      await page.keyboard.press("Home");
      await page.keyboard.press("Tab");
      await expect.poll(() => focusedInFrame(body(page, TITLE))).not.toBeNull();
    });

    const launch = shownEntry(page).getByRole("button", { name: "Launch it" });
    await test.step("Go to the card's buttons focuses its default, and Enter with a question unanswered goes to the question", async () => {
      await runFromSearch(app, page, "focus.card-actions");
      await expect(launch).toBeFocused();
      await page.keyboard.press("Enter");
      await expect
        .poll(() => focusedInFrame(body(page, TITLE)))
        .toEqual({ tag: "INPUT", name: "window" });
      await expect(shownEntry(page)).toBeVisible();
      expect(
        observationsOf(userDataDir, "card-fm-launch").filter((seen) => seen.kind === "action"),
      ).toEqual([]);
      // The arrows pick in a group of radios, as anywhere.
      await page.keyboard.press("ArrowDown");
      await expect(
        body(page, TITLE).getByRole("radio", { name: "Tomorrow evening" }),
      ).toBeChecked();
    });

    await test.step("Enter on the default sends the answer, and a held Enter sends no message after it", async () => {
      await runFromSearch(app, page, "focus.card-actions");
      await expect(launch).toBeFocused();
      // The press, and the key held down after the card leaves.
      await page.keyboard.down("Enter");
      await expectNoCard(page, TITLE);
      await expect(promptInput(page)).toBeFocused();
      await page.keyboard.down("Enter");
      await page.keyboard.up("Enter");
      await expect(promptInput(page)).toHaveValue(DRAFT);
    });
  } finally {
    await launched.close();
  }

  const [chosen, ...others] = observationsOf(userDataDir, "card-fm-launch").filter(
    (seen) => seen.kind === "action",
  );
  expect(others).toHaveLength(0);
  if (chosen?.kind !== "action") throw new Error("the keyboard's choice left no evidence");
  expect(chosen.actor).toBe("captain");
  expect(chosen.source).toBe("chrome");
  expect(chosen.payload).toMatchObject({
    actionId: "launch",
    reading: "fresh",
    display: { fidelity: "matched", reportedOfferId: offerId },
  });
  expect(chosen.payload.answers).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "window", values: ["evening"] })]),
  );
});

test("focus that leaves a card's field or picture comes back to it, caret and all", async () => {
  test.setTimeout(120_000);
  const userDataDir = scratchDir("infinitary-card-keyboard-");
  seed(userDataDir, (key) => [decisionCard(key)]);
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { app, page } = launched;
    await resizeWindow(app, page, { width: 1280, height: 820 });
    await showCard(page, TITLE);
    const frame = body(page, TITLE);
    const note = frame.getByRole("textbox", { name: "Note" });

    await test.step("command search closes back into the note, its caret where it was", async () => {
      await note.fill("launch after standup");
      await note.evaluate((field: HTMLTextAreaElement) => field.setSelectionRange(7, 7));
      await pressWindowKey(app, "k", ["meta"]);
      await expect(commandSearch(page).dialog).toBeVisible();
      await pressWindowKey(app, "Escape");
      await expect(commandSearch(page).dialog).toHaveCount(0);
      await expect(note).toBeFocused();
      await typeInto(note, "right ");
      await expect(note).toHaveValue("launch right after standup");
    });

    await test.step("Tab reaches a picture, Enter opens it, and closing the viewer comes back to it", async () => {
      await pressKey(note, "Tab");
      await expect.poll(() => focusedInFrame(frame)).toEqual({ tag: "IMG", name: PICTURES[0] });
      await page.keyboard.press("Enter");
      await expect(viewer(page)).toBeVisible();
      await expect(viewer(page).locator("[data-picture-count]")).toHaveText("1 / 2");
      await page.keyboard.press("ArrowRight");
      await expect(viewer(page).locator("[data-picture-count]")).toHaveText("2 / 2");
      await page.keyboard.press("Escape");
      await expect(viewer(page)).toHaveCount(0);
      await expect.poll(() => focusedInFrame(frame)).toEqual({ tag: "IMG", name: PICTURES[0] });
      // Space opens the next one.
      await page.keyboard.press("Tab");
      await page.keyboard.press(" ");
      await expect(viewer(page).locator("[data-picture-count]")).toHaveText("2 / 2");
      await page.keyboard.press("Escape");
      await expect.poll(() => focusedInFrame(frame)).toEqual({ tag: "IMG", name: PICTURES[1] });
    });

    await test.step("a task key the keyboard rests on opens its summary, and Escape lets it go", async () => {
      // Back up the body: the first picture, the note, the question, the key.
      for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+Tab");
      await expect(linkedTaskKeys(frame).first()).toBeFocused();
      await expect(keySummary(page)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(keySummary(page)).toBeHidden();
      // That Escape let the summary go, and nothing more.
      await expect(linkedTaskKeys(frame).first()).toBeFocused();
    });

    await test.step("Escape in the body leaves it for the card, and Tab goes back in", async () => {
      await pressKey(note, "Escape");
      await expect(page.locator(`${SHOWN_ENTRY}[data-window-region="card"]`)).toBeFocused();
      await expect(note).toHaveValue("launch right after standup");
    });

    await test.step("Enter on the card's edge gives it back the width the host chose", async () => {
      const edge = page.locator('[data-card-layer] [data-card-edge="right"]');
      const chosen = Number(await edge.getAttribute("aria-valuenow"));
      await pressKey(edge, "ArrowLeft");
      await expect(edge).toHaveAttribute("aria-valuenow", String(chosen - 32));
      await page.keyboard.press("Enter");
      await expect(edge).toHaveAttribute("aria-valuenow", String(chosen));
    });
  } finally {
    await launched.close();
  }
});

test("a card's script cannot use its frame to open things or move focus", async () => {
  test.setTimeout(120_000);
  const userDataDir = scratchDir("infinitary-card-keyboard-");
  seed(userDataDir, (key) => [hostileCard(key)]);
  const launched = await launchApp({ userDataDir, withMockProvider: true, gpuBenchmarking: true });
  try {
    const { app, page } = launched;
    await resizeWindow(app, page, { width: 1280, height: 820 });
    await showCard(page, HOSTILE);
    const frame = body(page, HOSTILE);
    await expect(linkedTaskKeys(frame)).toHaveCount(1);
    await typeDraft(page);

    await test.step("a picture, a task and an Escape the script sends while focus is elsewhere open nothing", async () => {
      await expect(frame.getByRole("status")).toHaveText("10", { timeout: 10_000 });
      await frameGesturesDecided(page);
      await expect(viewer(page)).toHaveCount(0);
      await expect(recordCard(page)).toHaveCount(0);
      await expect(shownCard(page, HOSTILE)).toBeVisible();
      await expectDraftKept(page);
    });

    await test.step("the captain's own press on the same picture opens it", async () => {
      await pressPointer(page, frame.getByRole("img", { name: "A picture the script clicks" }));
      await expect(viewer(page)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(viewer(page)).toHaveCount(0);
    });

    await test.step("a script that keeps every key cannot keep the window's: F6 and Cmd+L leave it", async () => {
      const scratch = frame.getByRole("textbox", { name: "Scratch" });
      await focusOn(scratch);
      await typeInto(scratch, "kept");
      await expect(scratch).toHaveValue("");
      expect(await focusedRegion(page)).toBe("card");
      expect(await regionAfter(app, page, "card", "F6")).not.toBe("card");
      await focusOn(scratch);
      await pressWindowKey(app, "l", ["meta"]);
      await expectDraftKept(page);
    });
  } finally {
    await launched.close();
  }
});
