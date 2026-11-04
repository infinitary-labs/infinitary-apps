import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import Database from "better-sqlite3";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { scratchDir } from "../helpers/scratchDirs";
import { frameIn } from "./frames";
import {
  askAboutThis,
  browser,
  browserCard,
  browsersOnStage,
  compareRow,
  focusInBrowser,
  inspector,
  knowledgePanel,
  linkedReferences,
  pressIn,
  recordUse,
  reference,
  revisionRead,
  section,
} from "./knowledgeBrowser";
import { HARBOR, seedKnowledge } from "./knowledgeSeed";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { promptInput } from "./prompt";
import { openRecordMore, pressRow, recordCard, recordFrame } from "./rails";
import { clickInBody, SHOWN_ENTRY, showCard, shownCard, shownCardFrame } from "./stack";
import { focusOn, typeInto, untilFocused } from "./windowKeys";

/**
 * Knowledge where the captain already reads (docs/knowledge.md, "References
 * in an answer", "Knowledge used on a task" and "Ask about this"; the rest of
 * FI3-1110's approved design), in a development build over a collection two
 * crewmates recorded through the real owner: an answer's finding references
 * open the Knowledge browser's inspector on that finding, a task record's
 * Knowledge used row opens the exact revision its work used beside the
 * current one, and Ask about this starts the captain's next message - while
 * reading writes no knowledge, declares no use, files no task and sends
 * nothing. The stable side is tests/e2e/knowledge-gate.spec.ts.
 */

const ANSWER = "Retries keep the same message";

/** Every row the collection holds, by table: what a write would change. */
function knowledgeRows(userDataDir: string): Record<string, number> {
  const db = new Database(join(userDataDir, "knowledge", "knowledge.db"), { readonly: true });
  try {
    return Object.fromEntries(
      ["entries", "revisions", "sources", "assessments", "relations", "uses", "requests"].map(
        (table) => [
          table,
          (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
        ],
      ),
    );
  } finally {
    db.close();
  }
}

/** How many tasks the record holds: reading never files one. */
async function taskCount(page: Page): Promise<number> {
  return page.evaluate(async () => (await window.infinitary.tasks.board()).tasks.length);
}

/** Hides the browser with its own title row's Hide. */
async function hideBrowser(page: Page): Promise<void> {
  await page
    .locator(`${SHOWN_ENTRY} [data-panel-card-chrome]`)
    .getByRole("button", { name: "Hide", exact: true })
    .click();
  await expect(browsersOnStage(page)).toHaveCount(0);
}

test("an answer's finding opens the inspector, a task's Knowledge used opens the revision it used beside the current one, and Ask about this starts a message that nothing sends", async () => {
  const userDataDir = scratchDir("infinitary-knowledge-references-");
  const k = await seedKnowledge(userDataDir);
  // Firstmate's answer cites the two findings it relies on by their ids,
  // beside an id-shaped word that names no entry.
  const db = openDatabase(userDataDir);
  new CardStore(db).upsert({
    id: "card-fm-retries",
    author: "firstmate",
    priority: 30,
    title: ANSWER,
    meta: "firstmate",
    body:
      "<p>The retry path hands the original message back for another attempt, so it keeps its identity.</p>" +
      "<p>That does not make every failed request safe to send again.</p>" +
      "<h4>Based on these findings</h4>" +
      `<ul><li>A retry keeps the original message identity <span class="inf-mono">${k.keeps}</span></li>` +
      `<li>Every failed request is safe to send again <span class="inf-mono">${k.returns}</span></li></ul>` +
      '<p class="inf-muted">f-zzzzzz names nothing, so it stays text.</p>',
    actions: [],
    status: "ready",
    createdAt: Date.now(),
  });
  db.close();
  const rowsBefore = knowledgeRows(userDataDir);
  const { app, page, mockProvider } = await launchApp({ userDataDir, withMockProvider: true });
  try {
    await resizeWindow(app, page, { width: 1600, height: 1000 });
    await expect(knowledgePanel(page)).toBeAttached({ timeout: 30_000 });
    const tasksBefore = await taskCount(page);

    await test.step("the answer links only the findings it names, each marked as it stands", async () => {
      await showCard(page, ANSWER);
      const body = shownCardFrame(page);
      await expect(linkedReferences(body)).toHaveCount(2);
      await expect(linkedReferences(body)).toHaveText([k.keeps, k.returns]);
      // Checked with evidence, and contradicted by a check with evidence.
      await expect(reference(body, k.keeps)).toHaveAttribute("data-inf-standing", "ok");
      await expect(reference(body, k.returns)).toHaveAttribute("data-inf-standing", "warn");
      // A reference is read by what it says, not only by its id.
      await expect(reference(body, k.keeps)).toHaveAttribute(
        "aria-label",
        /A retry keeps the original message identity/,
      );
      await expect(reference(body, "f-zzzzzz")).toHaveCount(0);
    });

    await test.step("a reference brings the browser forward with its inspector on that finding, and Hide returns to the answer", async () => {
      await clickInBody(reference(shownCardFrame(page), k.keeps));
      await expect(browserCard(page)).toBeVisible();
      await expect(browser(page)).toHaveAttribute("data-knowledge-scope", "captain");
      await expect(inspector(page)).toHaveAttribute("data-knowledge-inspector", k.keeps);
      expect(await revisionRead(page)).toBe(1);
      await expect(browser(page).locator("[data-knowledge-earlier]")).toHaveCount(0);
      await expect.poll(() => focusInBrowser(page)).toBe("section:overview");
      await hideBrowser(page);
      await expect(shownCard(page, ANSWER)).toBeVisible();
    });

    await test.step("the task's record lists what its work declared it used, by the revision it used", async () => {
      await pressRow(page, k.taskKey);
      await expect(recordCard(page)).toBeVisible();
      const record = recordFrame(page);
      await expect(record.locator("[data-record]")).toHaveAttribute("data-knowledge", "on");
      // Knowledge used sits in the Info tab's More row (INF-2261).
      await openRecordMore(page);
      const knowledge = record.locator('[data-record-section="knowledge"]');
      await expect(knowledge).toBeVisible();
      // Pressed in the frame itself: Chromium drops native clicks into a
      // hidden window's sandboxed frames.
      await pressIn(knowledge.locator(":scope > summary"));
      await expect(knowledge).toHaveAttribute("open", "");
      await expect(record.locator("[data-record-knowledge-count]")).toHaveText("1");
      // The seed's crewmate used revision 1 of the finding, which was revised since.
      await expect(recordUse(record, k.retains, 1)).toBeVisible();
    });

    await test.step("its row opens that exact revision in the inspector, compared with the current one", async () => {
      await clickInBody(recordUse(recordFrame(page), k.retains, 1).locator("button"));
      await expect(browserCard(page)).toBeVisible();
      await expect(inspector(page)).toHaveAttribute("data-knowledge-inspector", k.retains);
      expect(await revisionRead(page)).toBe(1);
      await expect(browser(page).locator("[data-knowledge-earlier]")).toBeVisible();
      // Its statement was revised; where it holds was not.
      await expect(compareRow(page, "title")).toHaveAttribute("data-changed", "");
      await expect(compareRow(page, "conditions")).not.toHaveAttribute("data-changed");
      await expect.poll(() => focusInBrowser(page)).toBe("section:overview");

      // The current revision, then back to revision 1 from History.
      await pressIn(browser(page).locator("[data-knowledge-current]"));
      await expect.poll(() => revisionRead(page)).toBe(2);
      await expect(browser(page).locator("[data-knowledge-compare]")).toHaveCount(0);
      await pressIn(section(page, "history"));
      await pressIn(browser(page).locator('[data-knowledge-read-revision="1"]'));
      await expect.poll(() => revisionRead(page)).toBe(1);
      await expect(browser(page).locator("[data-knowledge-compare]")).toBeVisible();
    });

    await test.step("Ask about this starts the captain's message about exactly that revision, and sends nothing", async () => {
      // The browser's page was born while the keyboard was in the record's,
      // so Chromium has not told it where focus is: the next time the window
      // takes focus - on Linux a key's own press gives it - the window's page
      // holds it for a frame and the key reaches nothing (docs/keyboard.md,
      // "Cards and frames"). Focus comes into the browser from the window's
      // own page, as the shell moves it, and Chromium tells every page then.
      await focusOn(promptInput(page));
      await focusOn(frameIn(browserCard(page)));
      await focusOn(askAboutThis(page));
      await untilFocused(askAboutThis(page));
      await page.keyboard.press("Enter");
      await expect(promptInput(page)).toBeFocused();
      // The question names the entry by its id and the revision shown, so
      // the message is about exactly that record (its words: place.test.ts).
      const words = await promptInput(page).inputValue();
      expect(words).toMatch(new RegExp(`${k.retains}\\b[^)]*\\b1\\)`));
      // The captain can change it before he sends it; until then nothing leaves.
      await typeInto(promptInput(page), "Is it still true?");
      await expect(promptInput(page)).toHaveValue(`${words}Is it still true?`);
      // Held, not sent: no request ever carried the question, and it is still in the field.
      await page.waitForTimeout(500);
      const sent = (mockProvider?.requestBodies() ?? []).filter((body) =>
        body.includes("Is it still true?"),
      );
      expect(sent).toEqual([]);
      await expect(promptInput(page)).toHaveValue(`${words}Is it still true?`);
      await expect(browserCard(page)).toBeVisible();
    });

    await test.step("reading wrote no knowledge, declared no use and filed no task", async () => {
      expect(knowledgeRows(userDataDir)).toEqual(rowsBefore);
      expect(await taskCount(page)).toBe(tasksBefore);
    });
  } finally {
    await app.close();
  }
});
