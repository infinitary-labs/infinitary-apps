import { expect, type Page, test } from "@playwright/test";
import { CardDrafts } from "../../src/core/orchestrator/cardDrafts";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import {
  ANNOTATE,
  NOTE_COMMENT_LABEL,
  NOTE_REMOVE,
  POINT_AT,
  queuedNotesWords,
} from "../../src/shared/cardNotes";
import { COMPUTER } from "../../src/shared/deviceNames";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody, cardBodyElement } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import { startMockProvider } from "./mockProvider";
import { readSavedData } from "./savedData";
import { cardReply, clickInBody, showCard, shownCard } from "./stack";
import { focusOn, pressKey } from "./windowKeys";

/**
 * Unsent picks follow you (INF-5446; docs/card-authoring.md). The captain's
 * ask: "it would be cool if the answers you selected on cards showed up on
 * other devices too (like if you don't finish the card completely)". Two
 * apps on this Mac, each with its own data, as two of the captain's Macs: the
 * second controls the first mate on the first (docs/view.md). A pick, the
 * words in the card's field or a queued note on either shows on the other,
 * and a note removed on one leaves the other; picks and words come back
 * after either restarts; a press on the joined Mac sends every pick both
 * made; then the card and its draft are gone, and stay gone after a restart.
 *
 * Promised result: the other window shows each pick, the field's words and
 * the queued note, and none once it is removed; the press's answers hold
 * both windows' picks. Data: one first mate
 * card with a radio question and a checkbox. Completion signal: the other
 * window's control reads checked, its field reads the words, its queued-note
 * line reads one note and then is gone, and the card's
 * saved resolution holds the answers with no draft left. Platform
 * prerequisites: none beyond a desktop. Shared resources: none; each app has
 * its own data folder and the link is to 127.0.0.1.
 */

const CARD_ID = "survey-start";
const TITLE = "Choose where the survey starts";
const START = "Start the survey";
const WORDS = "After the morning tide";
const PRO_ENV = { INFINITARY_DEVICE_NAME: "MacBook Pro" };
const AIR_ENV = { INFINITARY_DEVICE_NAME: "MacBook Air" };

const shownIds = (page: Page) =>
  page.evaluate(async () => (await window.infinitary.cards.list()).map((card) => card.id));

function seedHome(dir: string) {
  const db = openDatabase(dir);
  try {
    new CardStore(db).upsert({
      id: CARD_ID,
      author: "firstmate",
      meta: "firstmate",
      title: TITLE,
      priority: 20,
      status: "ready",
      createdAt: Date.now(),
      body: '<fieldset><legend>Which harbour?</legend><label><input type="radio" name="harbour" value="north"> North Basin</label><label><input type="radio" name="harbour" value="south"> South Basin</label></fieldset><label><input type="checkbox" name="tide" value="yes"> Keep the tide table</label>',
      actions: [{ id: "go", label: START, default: true }],
    });
  } finally {
    db.close();
  }
}

const harbour = (page: Page, name: string) =>
  cardBody(page, TITLE).getByRole("radio", { name, exact: true });
const tide = (page: Page) =>
  cardBody(page, TITLE).getByRole("checkbox", { name: "Keep the tide table", exact: true });

/** The second app joins the first with the link its Devices tab makes. */
async function join(home: LaunchedApp): Promise<LaunchedApp> {
  const invite = await home.page.evaluate(() => window.infinitary.devices.invite({ kind: "mac" }));
  const view = await launchApp({ env: AIR_ENV });
  const { page } = view;
  await expect(page.locator('[data-first-run-gate="open"]')).toBeVisible();
  await page.locator("[data-join-chip]").click();
  await page.getByLabel(`The link from your other ${COMPUTER.one}`).fill(invite.link);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Control it from here" }).click();
  await expect(page.locator("[data-remote-control]")).toHaveAttribute("data-freshness", "live");
  return view;
}

test("a card's unsent picks and words follow the captain between windows and across restarts", async () => {
  // Five launches: the first mate's computer twice and the Mac that controls it three times.
  test.setTimeout(240_000);
  const homeDir = scratchDir("infinitary-card-drafts-");
  seedHome(homeDir);
  const provider = await startMockProvider();
  let pro = await launchApp({ userDataDir: homeDir, reuseMockProvider: provider, env: PRO_ENV });
  let air: LaunchedApp | undefined;
  try {
    air = await join(pro);
    const view = air.page;
    await showCard(view, TITLE);
    await showCard(pro.page, TITLE);

    await test.step("a pick on either shows on the other", async () => {
      await clickInBody(harbour(view, "South Basin"));
      await expect(harbour(pro.page, "South Basin")).toBeChecked();
      await clickInBody(tide(pro.page));
      await expect(tide(view)).toBeChecked();
      await expect(harbour(view, "South Basin")).toBeChecked();
    });

    await test.step("the words in the card's field show on the other once typing pauses", async () => {
      await cardReply(view).field.pressSequentially(WORDS);
      await expect(cardReply(pro.page).field).toHaveValue(WORDS);
    });

    await test.step("a note queued on either shows on the other, and a removed one leaves both", async () => {
      // Point at the question on the joined Mac and queue a note on it.
      await view.getByRole("button", { name: new RegExp(`^${POINT_AT}`) }).click();
      await focusOn(cardBodyElement(view, TITLE));
      await cardBody(view, TITLE).locator("legend").dispatchEvent("click");
      const comment = view
        .getByRole("dialog", { name: new RegExp(`^${ANNOTATE} `) })
        .getByRole("textbox", { name: NOTE_COMMENT_LABEL });
      await comment.fill("Ask the harbour master first");
      await pressKey(comment, "Enter");
      const queued = (page: Page) => page.getByText(queuedNotesWords(1), { exact: true });
      await expect(queued(view)).toBeVisible();
      await expect(queued(pro.page)).toBeVisible();
      // Removed on the first mate's computer, it leaves the joined Mac too.
      await pro.page.getByRole("button", { name: NOTE_REMOVE, exact: true }).click();
      await expect(queued(pro.page)).toHaveCount(0);
      await expect(queued(view)).toHaveCount(0);
    });

    await test.step("the joined Mac's window shows them again after its restart", async () => {
      const joined = air as LaunchedApp;
      await joined.close();
      air = await launchApp({
        userDataDir: joined.userDataDir,
        homeDir: joined.homeDir,
        env: AIR_ENV,
      });
      await expect(air.page.locator("[data-remote-control]")).toHaveAttribute(
        "data-freshness",
        "live",
      );
      await showCard(air.page, TITLE);
      await expect(harbour(air.page, "South Basin")).toBeChecked();
      await expect(tide(air.page)).toBeChecked();
      // The words were never kept on the joined Mac: they come back from the first mate's computer.
      await expect(cardReply(air.page).field).toHaveValue(WORDS);
    });

    await test.step("the first mate's computer keeps them across its own restart", async () => {
      const line = (air as LaunchedApp).page.locator("[data-remote-control]");
      await pro.close();
      // The joined Mac hears the first mate's computer go, so its later "live" is the link that came back.
      await expect(line).toHaveAttribute("data-freshness", "out-of-reach");
      pro = await launchApp({ userDataDir: homeDir, reuseMockProvider: provider, env: PRO_ENV });
      await expect(line).toHaveAttribute("data-freshness", "live", { timeout: 30_000 });
      await showCard(pro.page, TITLE);
      await expect(harbour(pro.page, "South Basin")).toBeChecked();
      await expect(tide(pro.page)).toBeChecked();
      await expect(cardReply(pro.page).field).toHaveValue(WORDS);
    });

    await test.step("a press on the joined Mac sends both windows' picks, and the card leaves both for good", async () => {
      const view = (air as LaunchedApp).page;
      await expect(view.locator("[data-remote-control]")).toHaveAttribute("data-freshness", "live");
      await showCard(view, TITLE);
      await shownCard(view, TITLE).getByRole("button", { name: START, exact: true }).click();
      await expect.poll(() => shownIds(pro.page)).not.toContain(CARD_ID);
      await expect.poll(() => shownIds(view)).not.toContain(CARD_ID);
      const joined = air as LaunchedApp;
      await joined.close();
      air = await launchApp({
        userDataDir: joined.userDataDir,
        homeDir: joined.homeDir,
        env: AIR_ENV,
      });
      await expect(air.page.locator("[data-remote-control]")).toHaveAttribute(
        "data-freshness",
        "live",
      );
      expect(await shownIds(air.page)).not.toContain(CARD_ID);
    });
  } finally {
    await air?.close();
    await pro.close();
    await provider.close();
  }

  // What the first mate's computer kept: the answers the press sent, and no draft.
  const kept = readSavedData(homeDir, (db) => ({
    answers: new CardStore(db).resolutionOf(CARD_ID)?.answers ?? [],
    drafts: new CardDrafts(db, () => {}).read(),
  }));
  expect(kept.answers.find((answer) => answer.name === "harbour")?.values).toEqual(["south"]);
  expect(kept.answers.find((answer) => answer.name === "tide")?.values).toEqual(["yes"]);
  expect(kept.drafts).toEqual([]);
});
