import { cpSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { panelConsentTitle } from "../../src/core/plugins/consentWords";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import type { Card } from "../../src/shared/cards";
import { scratchDir } from "../helpers/scratchDirs";
import { drawnFrameIn, panelBody } from "./frames";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { ADD_PANEL_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { pager, showCard, shownCardFrame, shownEntry, stageAtRest } from "./stack";
import { focusedRegion, pressWindowKey, regionAfter, typeInto } from "./windowKeys";

/**
 * A frame's own script cannot take focus (docs/ui-plugins.md, "Focus and
 * the frames"): a card body's or an added panel's script that calls
 * `focus()` while the captain types in the main message leaves focus, the
 * caret and the next keys there. Only the captain's own key or click moves
 * focus into the frame.
 *
 * The script starts trying when the theme changes, so its tries come after
 * the captain is typing, or as soon as focus leaves its frame, so they come
 * right after the captain's own click or key in it, and each try makes its
 * frame taller, so the window counts them without reading inside the
 * frame. A script that tries each time focus leaves its frame stops when
 * focus comes back, whoever brought it, and its frame returns to its
 * resting height, so the count is always of the tries since focus last
 * left. Nothing here reads inside a frame while its script still tries:
 * Playwright's reads run there as a user gesture, and would let it move
 * focus as the captain's own click or key in it would.
 */

const DRAFT = "ship the fix";
/** The caret after "ship the". */
const CARET = 8;
const TYPED = " login";
const TRIES = 30;
const STEP_PX = 4;

const GRABBER = "A card that tries to take the caret";

/**
 * A body whose script, once the theme changes, focuses its field, selects
 * it and focuses its own window every 100 ms, TRIES times, growing by
 * STEP_PX with each try.
 */
function grabbingCard(): Card {
  return {
    id: "card-fm-grabber",
    author: "firstmate",
    meta: "firstmate",
    priority: 20,
    title: GRABBER,
    body:
      "<p>The weekly report is ready to read.</p>" +
      `<p><label>Scratch <input name="scratch"></label></p>` +
      `<div data-focus-tries style="height:0"></div>` +
      "<script>(function () {" +
      'var field = document.querySelector("input[name=scratch]");' +
      'var grow = document.querySelector("[data-focus-tries]");' +
      "var start = inf.theme;" +
      "var timer = null;" +
      "inf.onTheme(function (theme) {" +
      "  if (timer !== null || theme === start) return;" +
      "  var count = 0;" +
      "  timer = setInterval(function () {" +
      "    field.focus(); field.select(); window.focus();" +
      "    count += 1;" +
      `    grow.style.height = count * ${STEP_PX} + "px";` +
      `    if (count >= ${TRIES}) clearInterval(timer);` +
      "  }, 100);" +
      "});" +
      "})();</script>",
    status: "ready",
    createdAt: Date.now(),
    actions: [],
  };
}

/** The added panel's name and title (tests/fixtures/frame-realm/focus-taker). */
const FOCUS_TAKER = "Focus taker";

const RETAKER = "A card that tries to take the caret back";

/**
 * A body whose script, each time focus leaves its frame, focuses its field,
 * selects it and focuses its own window at once and then every 100 ms,
 * TRIES times, growing by STEP_PX with each try. When focus comes back to
 * its frame it stops and returns to its resting height. With `soon`, its
 * first try is the task right after the frame's blur rather than the blur
 * itself.
 */
function retakingCard({ soon = false }: { soon?: boolean } = {}): Card {
  return {
    id: "card-fm-retaker",
    author: "firstmate",
    meta: "firstmate",
    priority: 20,
    title: RETAKER,
    body:
      "<p>The weekly report is ready to read.</p>" +
      `<p><label>Scratch <input name="scratch"></label></p>` +
      `<div data-focus-tries style="height:0"></div>` +
      "<script>(function () {" +
      'var field = document.querySelector("input[name=scratch]");' +
      'var grow = document.querySelector("[data-focus-tries]");' +
      // Each loss of focus starts a round of tries; focus coming back ends it.
      "var round = 0;" +
      "function rest() {" +
      "  round += 1;" +
      '  grow.style.height = "0px";' +
      "}" +
      "function retake(mine, count) {" +
      "  if (mine !== round) return;" +
      "  field.focus(); field.select(); window.focus();" +
      "  if (mine !== round) return;" +
      `  grow.style.height = count * ${STEP_PX} + "px";` +
      `  if (count < ${TRIES}) setTimeout(function () { retake(mine, count + 1); }, 100);` +
      "}" +
      'window.addEventListener("blur", function () {' +
      "  rest();" +
      "  var mine = round;" +
      (soon ? "  setTimeout(function () { retake(mine, 1); }, 0);" : "  retake(mine, 1);") +
      "});" +
      'window.addEventListener("focus", rest);' +
      "})();</script>",
    status: "ready",
    createdAt: Date.now(),
    actions: [],
  };
}

const ASKING = "A card that asks which day";

/** A card whose default choice waits for its one required question. */
function askingCard(): Card {
  return {
    id: "card-fm-asking",
    author: "firstmate",
    meta: "firstmate",
    priority: 20,
    title: ASKING,
    body:
      "<p>The release can go out on either day.</p>" +
      "<fieldset><legend>Which day should it go out?</legend>" +
      `<label><input type="radio" name="day" value="friday" required> Friday</label>` +
      `<label><input type="radio" name="day" value="monday"> Monday</label></fieldset>`,
    status: "ready",
    createdAt: Date.now(),
    actions: [{ id: "ship", label: "Ship it", variant: "primary", default: true }],
  };
}

function seed(userDataDir: string, card: Card): void {
  const db = openDatabase(userDataDir);
  try {
    new CardStore(db).upsert(card);
  } finally {
    db.close();
  }
}

/** A frame's height in the window, which its script grows with each try. */
const heightOf = (frame: Locator) =>
  frame.evaluate((element) => Math.round(element.getBoundingClientRect().height));

/**
 * Returns once the card's frame holds focus and its script is not trying:
 * the frame is back at its `resting` height. Focus can leave a frame the
 * captain just clicked into and come back without him, when the window's
 * own page takes it and the shell gives it back (`guardFrameFocus`): the
 * round of tries that starts then ends when focus is back, so the tries a
 * journey counts next are the ones after the captain's next move.
 */
const untilResting = (frame: Locator, resting: number) =>
  expect
    .poll(() => heightOf(frame), { message: "the card's script has stopped trying" })
    .toBe(resting);

/** Changes the theme to the other one, which starts the script's tries. */
async function changeTheme(page: Page): Promise<void> {
  await page.evaluate(() =>
    window.infinitary.settings.setAppearance({
      theme: document.body.dataset.theme === "light" ? "dark" : "light",
    }),
  );
}

/** The main message's words and where its caret is. */
type Draft = { words: string; caret: number };

/** The draft the captain starts from: the caret after "ship the". */
const STARTING: Draft = { words: DRAFT, caret: CARET };

/** Puts the main message's caret where `draft` has it. */
const placeCaret = (prompt: Locator, { caret }: Draft) =>
  prompt.evaluate((field: HTMLTextAreaElement, at) => field.setSelectionRange(at, at), caret);

/**
 * The captain types in the main message, which holds `from`, while the
 * frame's script tries to take focus, from a frame `before` pixels tall:
 * the words, the caret and the keys typed between its tries stay in the
 * main message. Returns the draft the keys leave.
 */
async function typeThroughTries(
  page: Page,
  frame: Locator,
  before: number,
  from: Draft,
): Promise<Draft> {
  const prompt = promptInput(page);
  await expect.poll(() => heightOf(frame)).toBeGreaterThanOrEqual(before + 3 * STEP_PX);
  await expect(prompt).toBeFocused();
  // Paced so the keys fall between the script's tries.
  await typeInto(prompt, TYPED, { delay: 120 });
  await expect.poll(() => heightOf(frame)).toBeGreaterThanOrEqual(before + TRIES * STEP_PX);
  await expect(prompt).toBeFocused();
  const typed = {
    words: `${from.words.slice(0, from.caret)}${TYPED}${from.words.slice(from.caret)}`,
    caret: from.caret + TYPED.length,
  };
  await expect(prompt).toHaveValue(typed.words);
  expect(await prompt.evaluate((field: HTMLTextAreaElement) => field.selectionStart)).toBe(
    typed.caret,
  );
  return typed;
}

/**
 * The captain types in the main message, the caret after "ship the", while
 * the frame's script tries to take focus once the theme changes.
 */
async function typeThroughThemeTries(page: Page, frame: Locator): Promise<void> {
  const prompt = promptInput(page);
  await prompt.click();
  await prompt.fill(DRAFT);
  await placeCaret(prompt, STARTING);
  const before = await heightOf(frame);
  await changeTheme(page);
  await typeThroughTries(page, frame, before, STARTING);
}

test("a card's script that calls focus() leaves the caret and the next keys in the main message", async () => {
  test.setTimeout(120_000);
  const userDataDir = scratchDir("infinitary-frame-focus-");
  seed(userDataDir, grabbingCard());
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { app, page } = launched;
    await resizeWindow(app, page, { width: 1280, height: 820 });
    await showCard(page, GRABBER);
    const frame = drawnFrameIn(shownEntry(page));
    await expect(frame).toBeVisible();
    const scratch = shownCardFrame(page).getByRole("textbox", { name: "Scratch" });

    await test.step("thirty tries while the captain types take nothing from the main message", async () => {
      await typeThroughThemeTries(page, frame);
      await expect(scratch).toHaveValue("");
      await expect(scratch).not.toBeFocused();
    });

    await test.step("the captain's own key takes focus into the card", async () => {
      let at = await focusedRegion(page);
      for (let presses = 0; at !== "card" && presses < 10; presses++) {
        at = await regionAfter(app, page, at, "F6");
      }
      expect(at).toBe("card");
      for (let presses = 0; presses < 10; presses++) {
        if (await scratch.evaluate((field) => field === document.activeElement)) break;
        await page.keyboard.press("Tab");
      }
      await expect(scratch).toBeFocused();
      await typeInto(scratch, "by key");
      await expect(scratch).toHaveValue("by key");
    });

    await test.step("and so does the captain's own click", async () => {
      const prompt = promptInput(page);
      await prompt.click();
      await expect(prompt).toBeFocused();
      // e2e-frame-actions: native -- The real click must transfer focus; clickInBody would focus it itself.
      await scratch.click();
      await expect(scratch).toBeFocused();
      await page.keyboard.press("End");
      await typeInto(scratch, " and click");
      await expect(scratch).toHaveValue("by key and click");
      await expect(prompt).toHaveValue(`${DRAFT.slice(0, CARET)}${TYPED}${DRAFT.slice(CARET)}`);
    });
  } finally {
    await launched.close();
  }
});

test("an added panel's script that calls focus() leaves the caret and the next keys in the main message", async () => {
  test.setTimeout(120_000);
  const source = join(scratchDir("infinitary-frame-focus-panel-"), "focus-taker");
  cpSync(join(process.cwd(), "tests/fixtures/frame-realm/focus-taker"), source, {
    recursive: true,
  });
  const launched = await launchApp({ withMockProvider: true });
  try {
    const { page } = launched;
    const prompt = promptInput(page);
    await prompt.fill(`${ADD_PANEL_PROMPT_MARKER}${source}`);
    await prompt.press("Enter");
    await page.getByRole("button", { name: "Add it", exact: true }).click({ timeout: 30_000 });
    const frame = drawnFrameIn(page.locator('[data-side-panel="focus-taker"]'));
    await expect(frame).toBeVisible({ timeout: 30_000 });

    await typeThroughThemeTries(page, frame);
    const scratch = panelBody(page, "focus-taker").getByRole("textbox", { name: "Scratch" });
    await expect(scratch).toHaveValue("");
    await expect(scratch).not.toBeFocused();
  } finally {
    await launched.close();
  }
});

test("a card's script cannot take focus back from the main message right after the captain's own click or key in it", async () => {
  test.setTimeout(120_000);
  const userDataDir = scratchDir("infinitary-frame-focus-retake-");
  seed(userDataDir, retakingCard());
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { app, page } = launched;
    await resizeWindow(app, page, { width: 1280, height: 820 });
    await showCard(page, RETAKER);
    const frame = drawnFrameIn(shownEntry(page));
    await expect(frame).toBeVisible();
    const prompt = promptInput(page);
    await prompt.fill(DRAFT);
    const scratch = shownCardFrame(page).getByRole("textbox", { name: "Scratch" });
    // Focus has not been in the card yet, so its script has not tried.
    const resting = await heightOf(frame);

    let draft = STARTING;

    await test.step("a click in the card, then a click on the main message", async () => {
      // e2e-frame-actions: native -- The captain's own click in the frame is what lets its script take focus.
      await scratch.click();
      await expect(scratch).toBeFocused();
      await untilResting(frame, resting);
      await prompt.click();
      // The click put the caret where it landed.
      await placeCaret(prompt, draft);
      draft = await typeThroughTries(page, frame, resting, draft);
    });

    await test.step("a key in the card, then Go to the main message", async () => {
      // e2e-frame-actions: native -- The captain's own click and key in the frame are what let its script take focus.
      await scratch.click();
      await typeInto(scratch, "x");
      await untilResting(frame, resting);
      // The main message keeps its caret where the captain left it.
      await pressWindowKey(app, "l", ["meta"]);
      draft = await typeThroughTries(page, frame, resting, draft);
    });

    await expect(scratch).toHaveValue("x");
  } finally {
    await launched.close();
  }
});

test("a card's script cannot take focus back from a panel's field right after the captain's own click in the card", async () => {
  test.setTimeout(120_000);
  const userDataDir = scratchDir("infinitary-frame-focus-frames-");
  seed(userDataDir, retakingCard({ soon: true }));
  const source = join(scratchDir("infinitary-frame-focus-frames-panel-"), "focus-taker");
  cpSync(join(process.cwd(), "tests/fixtures/frame-realm/focus-taker"), source, {
    recursive: true,
  });
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { app, page } = launched;
    await resizeWindow(app, page, { width: 1280, height: 820 });
    const prompt = promptInput(page);
    await prompt.fill(`${ADD_PANEL_PROMPT_MARKER}${source}`);
    await prompt.press("Enter");
    await expect(pager(page, 2)).toBeVisible({ timeout: 30_000 });
    await showCard(page, panelConsentTitle(FOCUS_TAKER, FOCUS_TAKER));
    await page.getByRole("button", { name: "Add it", exact: true }).click();
    await expect(drawnFrameIn(page.locator('[data-side-panel="focus-taker"]'))).toBeVisible({
      timeout: 30_000,
    });
    await showCard(page, RETAKER);
    const frame = drawnFrameIn(shownEntry(page));
    await expect(frame).toBeVisible();
    const scratch = shownCardFrame(page).getByRole("textbox", { name: "Scratch" });
    const field = panelBody(page, "focus-taker").getByRole("textbox", { name: "Scratch" });

    const target = await field.boundingBox();
    if (target === null) throw new Error("the panel's field has no box");
    // Focus has not been in the card yet, so its script has not tried.
    const resting = await heightOf(frame);
    // The consent card has just dropped away: the captain clicks once the stage is at rest.
    await stageAtRest(page);
    // e2e-frame-actions: native -- The captain's own click in the card is what lets its script take focus.
    await scratch.click();
    await expect(scratch).toBeFocused();
    await untilResting(frame, resting);
    // The captain's pointer crosses the window on its way to the panel.
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 20 });
    // e2e-frame-actions: native -- The captain's own click moves focus from the card's frame straight to the panel's.
    await field.click();
    await expect.poll(() => heightOf(frame)).toBeGreaterThanOrEqual(resting + 3 * STEP_PX);
    expect(await focusedRegion(page)).toBe("panel:focus-taker");
    // Paced so the keys fall between the script's tries.
    await typeInto(field, TYPED, { delay: 120 });
    await expect.poll(() => heightOf(frame)).toBeGreaterThanOrEqual(resting + TRIES * STEP_PX);
    expect(await focusedRegion(page)).toBe("panel:focus-taker");
    await expect(field).toHaveValue(TYPED);
  } finally {
    await launched.close();
  }
});

test("the waiting default choice still takes the captain to the card's unanswered question", async () => {
  const userDataDir = scratchDir("infinitary-frame-focus-asking-");
  seed(userDataDir, askingCard());
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { page } = launched;
    await showCard(page, ASKING);
    await expect(drawnFrameIn(shownEntry(page))).toBeVisible();
    // Read from the window alone until the press: the frame has had no
    // gesture of the captain's, so only the shell can give it focus.
    const ship = page.getByRole("button", { name: "Ship it", exact: true });
    await expect(ship).toHaveAttribute("aria-disabled", "true");
    // Playwright waits for an aria-disabled button to enable; the captain's click does not.
    await ship.click({ force: true });
    await expect(
      shownCardFrame(page).getByRole("radio", { name: "Friday", exact: true }),
    ).toBeFocused();
    await expect(shownCardFrame(page).getByRole("radio", { checked: true })).toHaveCount(0);
  } finally {
    await launched.close();
  }
});
