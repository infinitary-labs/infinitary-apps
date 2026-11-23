import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import * as m from "../../src/shared/i18n/messages.generated";
import type { AnyCommandId, KeyChord } from "../../src/shared/keyboard";
import { presetKeys } from "../../src/shared/keyPresets";
import { SMALLEST_WINDOW } from "../../src/shared/smallestWindow";
import { scratchDir } from "../helpers/scratchDirs";
import { THIS_DESKTOP } from "./desktop";
import { cardBody, cardBodyAsHeld, cardBodyElement, readFrameOnce } from "./frames";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { heroShot, regionShot } from "./pictures";
import { promptInput } from "./prompt";
import { pressRow, recordCard, recordFrame, recordTab, showRecordTab } from "./rails";
import {
  FIND_RECORD_UPDATE_MARKER,
  FIND_RECORD_VERDICT,
  findRecordUpdate,
} from "./scenarios/findRecordUpdate";
import { cardReply, cardScroller, factsStrip, pushCards, showCard, shownEntry } from "./stack";
import { focusOn, pressKey, pressWindowKey, typeInto } from "./windowKeys";

/**
 * Find in this card (docs/keyboard.md, "Finding in the shown card"; the
 * captain's ask: "cmd + f search functionality within cards"): ⌘F opens a
 * find field in the shown card's head that counts the card's matches in
 * reading order - title, body, folded sections, thread - and brings the
 * current one into sight, opening the folded section that holds it. One Esc
 * closes it and gives focus back; the magnifying glass opens it too. It
 * finds in the shown card alone: paging with it open keeps the words and
 * counts the next card's matches, its facts strip included, and none of the
 * last card's stay lit. A fold inside a fold counts and both open for it,
 * while words hidden on their own never count. A revision the host writes
 * into a shown card is found again; an Esc in a card's body closes Find
 * first; and in the smallest window the current match ends in sight through
 * every scroller holding it. Under the Emacs preset its own keys open and
 * step Find: Alt+S, F3 and Shift+F3 on Linux, where Ctrl+F and Ctrl+G move
 * and cancel.
 */

const TITLE = "Add a keyboard command to the catalog";
// A card long enough that its body scrolls, its last match in a folded section.
const BODY =
  "<p>Every feature works from the keyboard. A new command joins the catalog with one key.</p>" +
  Array.from(
    { length: 14 },
    (_, i) => `<p>Step ${i + 1}: the catalog row names its label, its scope and who runs it.</p>`,
  ).join("") +
  "<details><summary>Evidence</summary><p>The Keyboard journey presses it by keys.</p></details>";

// The card beside it, with matches of its own in its title, body, a fold
// inside a fold and its facts strip, and two it hides on their own.
const NEIGHBOR = "Discard the keyboard sketch";
const NEIGHBOR_FACTS = "Branch: keyboard sketch";
const NEIGHBOR_BODY =
  "<p>The sketch of the keyboard map is not needed.</p>" +
  '<p style="visibility: hidden">A keyboard note no one sees.</p>' +
  "<details><summary>Notes</summary>" +
  "<details><summary>More</summary><p>A nested keyboard note.</p></details>" +
  "<p hidden>A hidden keyboard note.</p>" +
  "</details>" +
  `<div class="inf-facts" data-facts><span>${NEIGHBOR_FACTS}</span></div>`;

// A task whose record holds the words in its title and Activity, until the host adds another.
const RECORD_TITLE = "Map the keyboard";
const RECORD_GOAL = "Map every key on the keyboard.";
const RECORD_NOTE = "The keyboard rows are listed.";

const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
const cardSurface = (page: Page) => shownEntry(page).locator("[data-card-surface]");
const findField = (page: Page) => shownEntry(page).locator("[data-card-find-field]");
const findCount = (page: Page) => shownEntry(page).locator("[data-card-find-count]");
const findButton = (page: Page) =>
  shownEntry(page).getByRole("button", { name: m.uiCardFind(), exact: true });
const findClose = (page: Page) =>
  shownEntry(page).getByRole("button", { name: m.uiCardFindClose(), exact: true });

/**
 * The matches lit, and the current one, in the document holding `element`:
 * the window or a card's page. `outside` counts the lit ones outside it.
 */
const litMatches = (element: Element) => {
  const named = (name: string) =>
    [...(CSS.highlights.get(name) ?? [])].filter(
      (range) => range instanceof Range && range.startContainer.isConnected,
    ) as Range[];
  const outside = (ranges: Range[]) =>
    ranges.filter((range) => !element.contains(range.startContainer)).length;
  const every = named("inf-find");
  const current = named("inf-find-current");
  return { every: every.length, current: current.length, outside: outside(every) };
};

/** A page that lights nothing: one not drawn, or torn down while it was read. */
const NOTHING_LIT = { every: 0, current: 0, outside: 0 };

const litIn = (body: Locator) => body.evaluate(litMatches);

/** What the window lights, read against the shown entry: a match outside it would be another card's. */
const windowLit = (page: Page) => litIn(shownEntry(page));

/**
 * What the page of the card titled `title` lights, wherever the stage keeps
 * it; none when it is not drawn, or is torn down while it is read.
 */
async function pageLit(page: Page, title: string): Promise<number> {
  return (await readFrameOnce(cardBodyAsHeld(page, title), litMatches, NOTHING_LIT)).every;
}

/**
 * What the facts strip of the card titled `title` lights; none when its
 * page is not drawn, or is torn down while it is read.
 */
async function factsLit(page: Page, title: string): Promise<{ every: number; current: number }> {
  const facts = factsStrip(cardBody(page, title)).page;
  const { every, current } = await readFrameOnce(facts, litMatches, NOTHING_LIT);
  return { every, current };
}

/**
 * A read that marks the page it runs in (`HELD_READ`) and never answers on
 * its own: only its page's teardown ends it.
 */
const holdRead = (body: HTMLElement) => {
  body.setAttribute("data-held-read", "");
  return new Promise<string>(() => {});
};
const HELD_READ = "body[data-held-read]";

/**
 * Whether the current match in the card titled `title` lies in sight
 * through every box that scrolls or cuts what holds its page, and the window.
 */
async function currentInSight(page: Page, title: string): Promise<boolean> {
  const box = await cardBody(page, title)
    .locator("body")
    .evaluate(() => {
      const [range] = [...(CSS.highlights.get("inf-find-current") ?? [])] as Range[];
      return range ? range.getBoundingClientRect().toJSON() : null;
    });
  if (!box) return false;
  return cardBodyElement(page, title).evaluate((frame, words) => {
    const top = frame.getBoundingClientRect().top + words.top;
    const bottom = top + words.height;
    if (top < 0 || bottom > window.innerHeight) return false;
    for (let at = frame.parentElement; at; at = at.parentElement) {
      if (getComputedStyle(at).overflowY === "visible") continue;
      const port = at.getBoundingClientRect().top + at.clientTop;
      if (top < port || bottom > port + at.clientHeight) return false;
    }
    return true;
  }, box);
}

async function foldedWordsInSight(page: Page): Promise<boolean> {
  const words = await cardBody(page, TITLE)
    .locator("details p")
    .evaluate((p) => p.getBoundingClientRect().toJSON());
  const frame = await cardBodyElement(page, TITLE).boundingBox();
  const sight = await cardScroller(page).boundingBox();
  if (!frame || !sight) return false;
  const top = frame.y + words.top;
  return top >= sight.y && top + words.height <= sight.y + sight.height;
}

test("⌘F finds words across a card's title, body, folded section and thread", async () => {
  const userDataDir = scratchDir("infinitary-card-find-");
  const db = openDatabase(userDataDir);
  try {
    const store = new CardStore(db);
    store.upsert({
      id: "card-find",
      author: "firstmate",
      meta: "first mate",
      priority: 30,
      title: TITLE,
      body: BODY,
      status: "ready",
      createdAt: Date.now(),
      actions: [
        { id: "later", label: "Save for later", variant: "secondary" },
        { id: "go", label: "Approve", variant: "primary", default: true },
      ],
    });
    store.appendMessage({
      cardId: "card-find",
      who: "captain",
      text: "Does the keyboard map change?",
    });
    store.appendMessage({ cardId: "card-find", who: "firstmate", text: "Only one new row." });
    store.upsert({
      id: "card-find-neighbor",
      author: "crewmate",
      meta: "crewmate",
      priority: 20,
      title: NEIGHBOR,
      body: NEIGHBOR_BODY,
      status: "ready",
      createdAt: Date.now() - 1_000,
      actions: [
        {
          id: "discard",
          label: "Discard",
          variant: "primary",
          default: true,
          effect: { kind: "settle", mode: "discard" },
        },
      ],
    });
  } finally {
    db.close();
  }
  const { app, page, close } = await launchApp({ userDataDir, withMockProvider: true });
  try {
    await resizeWindow(app, page, { width: 1280, height: 640 });
    await showCard(page, TITLE);
    await expect(cardBody(page, TITLE).locator("details")).not.toHaveAttribute("open", /.*/);
    const reply = cardReply(page).field;

    await test.step("⌘F counts every match in reading order, the folded one included", async () => {
      await focusOn(reply);
      await pressWindowKey(app, "f", ["meta"]);
      await expect(findField(page)).toBeFocused();
      await typeInto(findField(page), "keyboard");
      // Title, body, the folded section, then the thread's message.
      await expect(findCount(page)).toHaveText(m.uiCardFindCount({ current: "1", total: "4" }));
      // The change's pictures: the release note's pair, and the merge card's After.
      if (evidence) {
        await regionShot(cardSurface(page), join(evidence, "card-find-after.png"));
        await heroShot(app, page, { region: cardSurface(page), name: "find-in-card" });
      }
    });

    await test.step("the next match opens its folded section and is brought into sight", async () => {
      await page.keyboard.press("Enter");
      await expect(findCount(page)).toHaveText(m.uiCardFindCount({ current: "2", total: "4" }));
      await pressWindowKey(app, "g", ["meta"]);
      await expect(findCount(page)).toHaveText(m.uiCardFindCount({ current: "3", total: "4" }));
      await expect(cardBody(page, TITLE).locator("details")).toHaveAttribute("open", "");
      await expect.poll(() => foldedWordsInSight(page)).toBe(true);
      if (evidence) await regionShot(cardSurface(page), join(evidence, "card-find-folded.png"));
      // Next goes on to the thread and round past the end; Previous comes back.
      await pressWindowKey(app, "g", ["meta"]);
      await pressWindowKey(app, "g", ["meta"]);
      await expect(findCount(page)).toHaveText(m.uiCardFindCount({ current: "1", total: "4" }));
      await page.keyboard.press("Shift+Enter");
      await expect(findCount(page)).toHaveText(m.uiCardFindCount({ current: "4", total: "4" }));
      await pressWindowKey(app, "g", ["meta", "shift"]);
      await expect(findCount(page)).toHaveText(m.uiCardFindCount({ current: "3", total: "4" }));
      await typeInto(findField(page), "s that match nothing");
      await expect(findCount(page)).toHaveText(m.uiCardFindNone());
    });

    await test.step("one Esc closes the field and gives focus back", async () => {
      await page.keyboard.press("Escape");
      await expect(findField(page)).toHaveCount(0);
      await expect(reply).toBeFocused();
      await expect(findButton(page)).toBeVisible();
      await expect.poll(() => windowLit(page)).toEqual({ every: 0, current: 0, outside: 0 });
      // The card stays shown at its size: Esc did nothing else.
      await expect(shownEntry(page).locator("[data-card-title]")).toHaveText(TITLE);
    });

    await test.step("the magnifying glass opens it once, and Esc goes back to the glass", async () => {
      await pressKey(findButton(page), "Enter");
      await expect(findField(page)).toBeFocused();
      await expect(findButton(page)).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(findButton(page)).toBeFocused();
      if (evidence) await regionShot(cardSurface(page), join(evidence, "card-find-button.png"));
      await findButton(page).click();
      await expect(findField(page)).toBeFocused();
      await typeInto(findField(page), "keyboard");
      await expect(findCount(page)).toHaveText(m.uiCardFindCount({ current: "1", total: "4" }));
      await findClose(page).click();
      await expect(findField(page)).toHaveCount(0);
      await expect(findButton(page)).toBeFocused();
      await expect.poll(() => windowLit(page)).toEqual({ every: 0, current: 0, outside: 0 });
      await expect.poll(() => pageLit(page, TITLE)).toBe(0);
    });

    await test.step("paging with it open finds in the next card alone, its facts strip included", async () => {
      await pressWindowKey(app, "f", ["meta"]);
      await expect(findField(page)).toBeFocused();
      await typeInto(findField(page), "keyboard");
      await expect(findCount(page)).toHaveText(m.uiCardFindCount({ current: "1", total: "4" }));
      await page.keyboard.press("Enter");
      await expect(findCount(page)).toHaveText(m.uiCardFindCount({ current: "2", total: "4" }));
      // The title's and thread's matches lit in the window, all in this card.
      await expect.poll(() => windowLit(page)).toEqual({ every: 2, current: 0, outside: 0 });
      await expect.poll(() => pageLit(page, TITLE)).toBe(2);

      await pressWindowKey(app, "]", ["meta", "shift"]);
      await expect(shownEntry(page).locator("[data-card-title]")).toHaveText(NEIGHBOR);
      // The words stay; the count is the shown card's own, from its first
      // match: its title, body, nested fold and facts strip, and neither
      // note hidden on its own.
      await expect(findField(page)).toHaveValue("keyboard");
      await expect(findCount(page)).toHaveText(m.uiCardFindCount({ current: "1", total: "4" }));
      await expect.poll(() => windowLit(page)).toEqual({ every: 1, current: 1, outside: 0 });
      await expect.poll(() => pageLit(page, TITLE)).toBe(0);
      await expect.poll(() => pageLit(page, NEIGHBOR)).toBe(2);
      // The third match is in the fold inside a fold: both open for it.
      await pressWindowKey(app, "g", ["meta"]);
      await pressWindowKey(app, "g", ["meta"]);
      await expect(findCount(page)).toHaveText(m.uiCardFindCount({ current: "3", total: "4" }));
      await expect(cardBody(page, NEIGHBOR).locator("details[open]")).toHaveCount(2);
      // The fourth is the facts strip's, lit in its own page.
      await expect(factsStrip(cardBody(page, NEIGHBOR)).strip).toContainText("keyboard");
      await expect.poll(() => factsLit(page, NEIGHBOR)).toEqual({ every: 1, current: 0 });
      await pressWindowKey(app, "g", ["meta"]);
      await expect(findCount(page)).toHaveText(m.uiCardFindCount({ current: "4", total: "4" }));
      await expect.poll(() => factsLit(page, NEIGHBOR)).toEqual({ every: 1, current: 1 });

      // A revision the host writes into the shown card is found again: the
      // strip, updated in place, now holds two matches, and the current one
      // keeps its place.
      const cards = await page.evaluate(() => window.infinitary.cards.list());
      const revised = cards.map((card) =>
        card.id === "card-find-neighbor"
          ? { ...card, body: card.body.replace(NEIGHBOR_FACTS, `${NEIGHBOR_FACTS}, keyboard map`) }
          : card,
      );
      expect(revised).not.toEqual(cards);
      await pushCards(app, revised);
      await expect(factsStrip(cardBody(page, NEIGHBOR)).strip).toContainText("keyboard map");
      await expect(findCount(page)).toHaveText(m.uiCardFindCount({ current: "4", total: "5" }));
      await expect.poll(() => factsLit(page, NEIGHBOR)).toEqual({ every: 2, current: 1 });

      // Paging on takes this card's pages away once it has left. A read still
      // running in one then answers as not drawn, so a poll looks again
      // instead of failing with the frame detached: one read held in the
      // body's page and one in the facts strip's, each in place before the page turns.
      const held = [cardBodyAsHeld(page, NEIGHBOR), factsStrip(cardBody(page, NEIGHBOR)).page].map(
        (frame) => ({ frame, answer: readFrameOnce(frame, holdRead, "not drawn") }),
      );
      for (const { frame } of held) await expect(frame.locator(HELD_READ)).toHaveCount(1);

      await pressWindowKey(app, "]", ["meta", "shift"]);
      await expect(shownEntry(page).locator("[data-card-title]")).toHaveText(TITLE);
      expect(await Promise.all(held.map(({ answer }) => answer))).toEqual([
        "not drawn",
        "not drawn",
      ]);
      await expect(findCount(page)).toHaveText(m.uiCardFindCount({ current: "1", total: "4" }));
      await expect.poll(() => pageLit(page, NEIGHBOR)).toBe(0);
      await expect.poll(() => factsLit(page, NEIGHBOR)).toEqual({ every: 0, current: 0 });
    });

    await test.step("an Esc in the card's body closes Find before anything else", async () => {
      const summary = cardBody(page, TITLE).locator("summary");
      await focusOn(summary);
      await page.keyboard.press("Escape");
      await expect(findField(page)).toHaveCount(0);
      // Its matches go, and focus goes back to the glass that had it before ⌘F.
      await expect(findButton(page)).toBeFocused();
      await expect.poll(() => windowLit(page)).toEqual({ every: 0, current: 0, outside: 0 });
      await expect.poll(() => pageLit(page, TITLE)).toBe(0);
      await expect(shownEntry(page).locator("[data-card-title]")).toHaveText(TITLE);
    });

    await test.step("in the smallest window the current match ends in sight through every scroller", async () => {
      await resizeWindow(app, page, SMALLEST_WINDOW);
      await pressWindowKey(app, "f", ["meta"]);
      await expect(findField(page)).toBeFocused();
      await typeInto(findField(page), "Step 13:");
      await expect(findCount(page)).toHaveText(m.uiCardFindCount({ current: "1", total: "1" }));
      await expect.poll(() => currentInSight(page, TITLE)).toBe(true);
    });
  } finally {
    await close();
  }
});

async function findTotal(page: Page): Promise<number> {
  const words = (await findCount(page).textContent()) ?? "";
  return Number(/(\d+)\D*$/.exec(words)?.[1] ?? Number.NaN);
}

test("a task record the host updates while Find is open is found again", async () => {
  const userDataDir = scratchDir("infinitary-card-find-record-");
  const db = openDatabase(userDataDir);
  let key = "";
  try {
    const tasks = new TaskService({ db, strict: true });
    const task = seedTask(tasks, {
      id: "find-record",
      title: RECORD_TITLE,
      intent: { goal: RECORD_GOAL, userWords: RECORD_GOAL },
      status: "completed",
    });
    tasks.note(task.id, RECORD_NOTE, { news: true });
    key = task.key;
  } finally {
    db.close();
  }
  const { app, page, close } = await launchApp({
    userDataDir,
    withMockProvider: true,
    scenarios: [findRecordUpdate],
  });
  try {
    await resizeWindow(app, page, { width: 1280, height: 640 });
    await pressRow(page, key);
    await expect(recordCard(page)).toHaveAttribute("data-task-record", "find-record");
    await showRecordTab(page, "activity");
    await expect(recordFrame(page).getByText(RECORD_NOTE).first()).toBeVisible();

    const activity = recordTab(page, "activity");
    await focusOn(activity);
    await pressWindowKey(app, "f", ["meta"]);
    await expect(findField(page)).toBeFocused();
    await typeInto(findField(page), "keyboard");
    await expect.poll(() => findTotal(page)).toBeGreaterThan(0);
    const before = await findTotal(page);
    const lit = await litIn(recordFrame(page).locator("body"));
    expect(lit.every).toBeGreaterThan(0);

    // The first mate records a verdict on the task: the shown Activity tab
    // gains a row the host writes in place, and Find counts it without
    // being opened again.
    await focusOn(promptInput(page));
    await typeInto(promptInput(page), `${FIND_RECORD_UPDATE_MARKER} ${key}`);
    await page.keyboard.press("Enter");
    await expect(recordFrame(page).getByText(FIND_RECORD_VERDICT).first()).toBeVisible();
    await expect(findField(page)).toHaveValue("keyboard");
    await expect.poll(() => findTotal(page)).toBeGreaterThan(before);
    await expect
      .poll(async () => (await litIn(recordFrame(page).locator("body"))).every)
      .toBeGreaterThan(lit.every);

    // An Esc in the record's page, which the page does not use, closes Find
    // and leaves the record shown.
    await focusOn(recordFrame(page).locator("summary:visible").first());
    await page.keyboard.press("Escape");
    await expect(findField(page)).toHaveCount(0);
    // Its matches go, and focus goes back to the tab that had it before ⌘F.
    await expect(activity).toBeFocused();
    await expect.poll(async () => (await litIn(recordFrame(page).locator("body"))).every).toBe(0);
    await expect(recordCard(page)).toHaveAttribute("data-task-record", "find-record");
  } finally {
    await close();
  }
});

/**
 * The Emacs preset's first key for a command on this computer, pressed
 * through the window: ⌘F and ⌘G on a Mac, Alt+S and F3 on Linux, where
 * Emacs's Ctrl+F moves and Ctrl+G cancels.
 */
async function pressEmacsKey(app: Parameters<typeof pressWindowKey>[0], id: AnyCommandId) {
  const [binding] = presetKeys("emacs", id, THIS_DESKTOP.keys);
  const chord = binding as KeyChord;
  await pressWindowKey(app, chord.key, [
    ...(chord.meta ? (["meta"] as const) : []),
    ...(chord.ctrl ? (["control"] as const) : []),
    ...(chord.alt ? (["alt"] as const) : []),
    ...(chord.shift ? (["shift"] as const) : []),
  ]);
}

test("the Emacs preset's own keys open Find and step through the matches", async () => {
  const userDataDir = scratchDir("infinitary-card-find-emacs-");
  const db = openDatabase(userDataDir);
  try {
    const store = new CardStore(db);
    store.upsert({
      id: "card-find",
      author: "firstmate",
      meta: "first mate",
      priority: 30,
      title: TITLE,
      body: BODY,
      status: "ready",
      createdAt: Date.now(),
      actions: [{ id: "go", label: "Approve", variant: "primary", default: true }],
    });
    store.appendMessage({
      cardId: "card-find",
      who: "captain",
      text: "Does the keyboard map change?",
    });
  } finally {
    db.close();
  }
  const { app, page, close } = await launchApp({
    userDataDir,
    withMockProvider: true,
    keys: "emacs",
  });
  try {
    await showCard(page, TITLE);
    const reply = cardReply(page).field;
    await focusOn(reply);
    await pressEmacsKey(app, "cards.find");
    await expect(findField(page)).toBeFocused();
    await typeInto(findField(page), "keyboard");
    await expect(findCount(page)).toHaveText(m.uiCardFindCount({ current: "1", total: "4" }));
    await pressEmacsKey(app, "cards.find-next");
    await expect(findCount(page)).toHaveText(m.uiCardFindCount({ current: "2", total: "4" }));
    await pressEmacsKey(app, "cards.find-next");
    await expect(findCount(page)).toHaveText(m.uiCardFindCount({ current: "3", total: "4" }));
    await pressEmacsKey(app, "cards.find-previous");
    await expect(findCount(page)).toHaveText(m.uiCardFindCount({ current: "2", total: "4" }));
    // The field kept the words: no key typed into it on the way.
    await expect(findField(page)).toHaveValue("keyboard");
  } finally {
    await close();
  }
});
