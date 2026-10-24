import { expect, type Locator, type Page, test } from "@playwright/test";
import { UI_SIZES } from "../../src/shared/preferences";
import { cardBodyElement } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { dockBody, expandDock, nowFrame } from "./rails";
import {
  INLINE_QUESTIONS_PROMPT_MARKER,
  INLINE_QUESTIONS_TITLE,
  inlineQuestions,
} from "./scenarios/inlineQuestions";
import {
  KEYBOARD_CARD_TITLES,
  KEYBOARD_CARDS_PROMPT_MARKER,
  keyboardCards,
} from "./scenarios/keyboardCards";
import {
  cardReply,
  closeQuestion,
  pager,
  showCard,
  shownCard,
  shownCardFrame,
  stagePrepared,
} from "./stack";
import { commandSearch, focusOn, pressWindowKey, typeInto } from "./windowKeys";

/**
 * The window's keys (docs/keyboard.md): Cmd+L goes back to the main message
 * from wherever focus is - a card's reply, a field inside a card drawn
 * inline or served at a host of its own, the Tasks panel, Settings - because
 * the main process hears the key before the page or any frame and tells the
 * shell which command it was. The words, and the caret, wait where they were.
 * The same route opens command search, goes to the shown card's reply, pages
 * the cards, opens the Tasks panel's search and opens Settings; command
 * search runs any of them by name and says why one cannot run now.
 */

const DRAFT = "ship the login fix today";
/** The caret after "ship". */
const CARET = 4;

/** Where the pager stands: the shown card's place and the stack's size. */
async function pagerPlace(page: Page): Promise<{ position: number; count: number }> {
  const pagination = page.locator("[data-card-pager]");
  return {
    position: Number(await pagination.getAttribute("data-pager-position")),
    count: Number(await pagination.getAttribute("data-pager-count")),
  };
}

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp({
    scenarios: [inlineQuestions, keyboardCards],
    withMockProvider: true,
  });
  const prompt = promptInput(launched.page);
  await prompt.click();
  await prompt.fill(`${SPAWN_PROMPT_MARKER} ${KEYBOARD_CARDS_PROMPT_MARKER}`);
  await prompt.press("Enter");
  await expect(pager(launched.page, 2)).toBeVisible({ timeout: 30_000 });
});

test.afterAll(async () => {
  await launched.close();
});

test("Cmd+L brings focus back to the main message from wherever it is, words and caret kept", async () => {
  const { app, page } = launched;
  const prompt = promptInput(page);
  await prompt.fill(DRAFT);
  await prompt.evaluate((field: HTMLTextAreaElement, at) => field.setSelectionRange(at, at), CARET);

  /** Types into `field`, presses Cmd+L, and finds the main message as it was left. */
  const backFrom = async (field: Locator, words: string) => {
    await field.fill(words);
    await pressWindowKey(app, "l", ["meta"]);
    await expect(prompt).toBeFocused();
    await expect(prompt).toHaveValue(DRAFT);
    expect(await prompt.evaluate((input: HTMLTextAreaElement) => input.selectionStart)).toBe(CARET);
    await expect(field).toHaveValue(words);
  };

  await test.step("from the Tasks panel's search", async () => {
    await expandDock(page, "now");
    const search = page
      .locator('[data-side-panel="now"] header')
      .getByRole("button", { name: "Search tasks" });
    await search.click();
    const query = nowFrame(page).locator("[data-now-query]");
    await expect(query).toBeFocused();
    await backFrom(query, "note");
    await query.fill("");
    await search.click();
  });

  await test.step("from a field inside a card drawn inline", async () => {
    await showCard(page, KEYBOARD_CARD_TITLES.inline);
    await backFrom(shownCardFrame(page).getByRole("textbox", { name: "Note" }), "inline");
  });

  await test.step("from a card's reply, whose page never sees the key", async () => {
    await page.evaluate(() => {
      const heard: string[] = [];
      (window as unknown as { heardKeys: string[] }).heardKeys = heard;
      window.addEventListener("keydown", (event) => heard.push(event.key), { capture: true });
    });
    await backFrom(cardReply(page).field, "a short answer");
    await cardReply(page).field.fill("");
    expect(
      await page.evaluate(() =>
        (window as unknown as { heardKeys: string[] }).heardKeys.filter(
          (key) => key.toLowerCase() === "l",
        ),
      ),
    ).toEqual([]);
  });

  await test.step("from a field inside a card served at a host of its own", async () => {
    await showCard(page, KEYBOARD_CARD_TITLES.served);
    const served = cardBodyElement(page, KEYBOARD_CARD_TITLES.served);
    await expect(served).toHaveAttribute("src", /^app-frame:\/\/card-[0-9a-f-]{36}\/$/);
    await backFrom(shownCardFrame(page).getByRole("textbox", { name: "Note" }), "served");
  });

  await test.step("from Settings, which it leaves for home", async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("tab", { name: "General", exact: true })).toBeVisible();
    await pressWindowKey(app, "l", ["meta"]);
    await expect(prompt).toBeFocused();
    await expect(prompt).toHaveValue(DRAFT);
  });
});

test("command search opens from inside a card, says why a command cannot run, and Escape gives focus back", async () => {
  const { app, page } = launched;
  const search = commandSearch(page);
  await showCard(page, KEYBOARD_CARD_TITLES.inline);
  const note = shownCardFrame(page).getByRole("textbox", { name: "Note" });
  await note.fill("half a thought");
  // The fill moves focus inside the card's own page, and the window hears
  // of it a moment later: a key that reaches the window first opens search
  // over the main message (INF-1132; docs/e2e-contracts.md, "Input waits
  // for focus").
  await focusOn(note);
  await pressWindowKey(app, "k", ["meta"]);
  await expect(search.dialog).toBeVisible();
  await expect(search.field).toBeFocused();

  await test.step("every window command is listed by name with its key, and the stack's end says why it cannot page", async () => {
    await expect(search.row("commands.search")).toHaveCount(0);
    for (const command of [
      "focus.main-message",
      "focus.card-reply",
      "panel:now/find",
      "settings.open",
    ])
      await expect(search.row(command).locator("kbd")).toHaveCount(1);
    // Close is chosen by name only: it has no key.
    await expect(search.row("cards.close").locator("kbd")).toHaveCount(0);
    const { position, count } = await pagerPlace(page);
    const edge = position === 1 ? "cards.previous" : position === count ? "cards.next" : null;
    expect(edge).not.toBeNull();
    await expect(search.row(edge ?? "")).toHaveAttribute("aria-disabled", "true");
    await expect(search.row(edge ?? "").locator("[data-command-refusal]")).not.toBeEmpty();
    await expect(search.row("focus.card-reply")).not.toHaveAttribute("aria-disabled", "true");
  });

  await test.step("typed words narrow the list", async () => {
    // Every command whose words hold both: the Tasks panel's Find a task and
    // Find on task board.
    await search.field.fill("task find");
    await expect(search.row("panel:now/find")).toBeVisible();
    await expect(search.row("panel:now/board-find")).toBeVisible();
    await search.field.fill("board find");
    await expect(search.rows).toHaveCount(1);
    await search.field.fill("nothing is called this");
    await expect(search.rows).toHaveCount(0);
  });

  // Focus goes back to the card it came from, as the picture viewer gives
  // it back: the card's frame, with the words in its field untouched.
  const cardFrame = `${KEYBOARD_CARD_TITLES.inline} body`;
  const focusedFrame = () =>
    page.evaluate(() => document.activeElement?.getAttribute("title") ?? null);

  await test.step("Escape closes search alone, and focus goes back to the card", async () => {
    await page.keyboard.press("Escape");
    await expect(search.dialog).toHaveCount(0);
    await expect.poll(focusedFrame).toBe(cardFrame);
    await expect(note).toHaveValue("half a thought");
    await expect(shownCard(page, KEYBOARD_CARD_TITLES.inline)).toBeVisible();
  });

  await test.step("its own key closes it the same way", async () => {
    await focusOn(note);
    await pressWindowKey(app, "k", ["meta"]);
    await expect(search.dialog).toBeVisible();
    await pressWindowKey(app, "k", ["meta"]);
    await expect(search.dialog).toHaveCount(0);
    await expect.poll(focusedFrame).toBe(cardFrame);
  });
  await note.fill("");
});

test("a command chosen in command search runs, and a refused one runs nothing", async () => {
  const { app, page } = launched;
  const search = commandSearch(page);
  const prompt = promptInput(page);
  await showCard(page, KEYBOARD_CARD_TITLES.inline);
  await prompt.fill(DRAFT);
  await focusOn(prompt);

  await test.step("Enter runs the chosen command: the shown card's reply takes focus", async () => {
    await pressWindowKey(app, "k", ["meta"]);
    await search.field.fill("reply");
    await expect(search.row("focus.card-reply")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(search.dialog).toHaveCount(0);
    await expect(cardReply(page).field).toBeFocused();
  });

  await test.step("arrows choose, and Enter on a command that cannot run leaves search open", async () => {
    const { position, count } = await pagerPlace(page);
    const edge = position === 1 ? "cards.previous" : "cards.next";
    expect(position === 1 || position === count).toBe(true);
    await pressWindowKey(app, "k", ["meta"]);
    await search.field.fill("card");
    while ((await search.row(edge).getAttribute("aria-selected")) !== "true")
      await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(search.dialog).toBeVisible();
    expect(await pagerPlace(page)).toEqual({ position, count });
    await page.keyboard.press("Escape");
    await expect(cardReply(page).field).toBeFocused();
  });

  await test.step("a size command runs in the main process, the same step its key takes", async () => {
    const saved = () =>
      page.evaluate(
        async () => (await window.infinitary.settings.getPreferences()).appearance.size,
      );
    await pressWindowKey(app, "k", ["meta"]);
    await search.field.fill("larger");
    await page.keyboard.press("Enter");
    await expect.poll(saved).toBe(UI_SIZES[1]);
    await pressWindowKey(app, "0", ["meta"]);
    await expect.poll(saved).toBe(UI_SIZES[0]);
  });
  await prompt.fill("");
});

test("the window's keys go to the reply, page the cards, find a task and open Settings from inside a card", async () => {
  const { app, page } = launched;
  const prompt = promptInput(page);
  await showCard(page, KEYBOARD_CARD_TITLES.inline);
  const note = () => shownCardFrame(page).getByRole("textbox", { name: "Note" });

  await test.step("Cmd+Shift+L goes to the shown card's reply, words and caret kept", async () => {
    const reply = cardReply(page).field;
    await reply.fill("a reply in progress");
    await reply.evaluate((field: HTMLTextAreaElement) => field.setSelectionRange(2, 2));
    await focusOn(note());
    await pressWindowKey(app, "l", ["meta", "shift"]);
    await expect(reply).toBeFocused();
    await expect(reply).toHaveValue("a reply in progress");
    expect(await reply.evaluate((field: HTMLTextAreaElement) => field.selectionStart)).toBe(2);
    await reply.fill("");
  });

  await test.step("Cmd+Shift+] and Cmd+Shift+[ page the stack the way its arrows do", async () => {
    const { position, count } = await pagerPlace(page);
    const [forward, back] = position < count ? ["]", "["] : ["[", "]"];
    await focusOn(note());
    await pressWindowKey(app, forward, ["meta", "shift"]);
    await expect
      .poll(async () => (await pagerPlace(page)).position)
      .toBe(position < count ? position + 1 : position - 1);
    await pressWindowKey(app, back, ["meta", "shift"]);
    await expect.poll(async () => (await pagerPlace(page)).position).toBe(position);
    await expect(shownCard(page, KEYBOARD_CARD_TITLES.inline)).toBeVisible();
    // The keys that follow wait until the stage has prepared the card
    // behind the shown one again (stagePrepared).
    await stagePrepared(page);
  });

  await test.step("Cmd+Shift+F opens the Tasks panel and its search, and what is typed next lands there", async () => {
    // The key opens a collapsed dock itself, so the frame is read without expanding it.
    const query = dockBody(page, "now").locator("[data-now-query]");
    const holdsCaret = () =>
      query.evaluate((field) => field.ownerDocument.activeElement === field).catch(() => false);
    await focusOn(note());
    await pressWindowKey(app, "f", ["meta", "shift"]);
    await expect.poll(holdsCaret).toBe(true);
    await typeInto(query, "SC");
    await expect(query).toHaveValue("SC");
    await expect(note()).toHaveValue("");
    // Pressed again from elsewhere, the search stays open and takes the keys back.
    await focusOn(note());
    await pressWindowKey(app, "f", ["meta", "shift"]);
    await expect.poll(holdsCaret).toBe(true);
    await typeInto(query, "R");
    await expect(query).toHaveValue("SCR");
    await query.fill("");
  });

  await test.step("Cmd+, opens Settings, and Cmd+L comes back home", async () => {
    await focusOn(note());
    await pressWindowKey(app, ",", ["meta"]);
    await expect(page.getByRole("tab", { name: "General", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Back", exact: true })).toBeFocused();
    await pressWindowKey(app, "l", ["meta"]);
    await expect(prompt).toBeFocused();
  });
});

test("closing the shown card from command search still asks first about unsent answers", async () => {
  const { app, page } = launched;
  const search = commandSearch(page);
  const prompt = promptInput(page);
  await prompt.fill(`${SPAWN_PROMPT_MARKER} ${INLINE_QUESTIONS_PROMPT_MARKER}`);
  await prompt.press("Enter");
  // The crewmate's card joins the stack once its turn is done.
  await expect(() => showCard(page, INLINE_QUESTIONS_TITLE)).toPass({ timeout: 60_000 });
  // Picked inside the frame, where the captain's click lands: Chromium drops
  // a native click into a hidden window's sandboxed frame.
  await shownCardFrame(page)
    .locator('input[name="writes"][value="any"]')
    .evaluate((control: HTMLInputElement) => control.click());

  await pressWindowKey(app, "k", ["meta"]);
  await search.field.fill("close");
  await page.keyboard.press("Enter");
  const confirm = closeQuestion(page);
  await expect(confirm).toBeVisible();
  // The question takes focus on the choice that loses nothing.
  await expect(confirm.getByRole("button", { name: "Keep answering", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(confirm).toHaveCount(0);
  await expect(shownCard(page, INLINE_QUESTIONS_TITLE)).toBeVisible();
});
