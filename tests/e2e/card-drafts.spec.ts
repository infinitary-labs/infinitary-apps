import { expect, type Page, test } from "@playwright/test";
import { CardDrafts } from "../../src/core/orchestrator/cardDrafts";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { COMPUTER } from "../../src/shared/deviceNames";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import { startMockProvider } from "./mockProvider";
import { cardReply, clickInBody, showCard, shownCard } from "./stack";

/**
 * Unsent picks follow you (INF-5446; docs/card-authoring.md). The captain's
 * ask: "it would be cool if the answers you selected on cards showed up on
 * other devices too (like if you don't finish the card completely)". Two
 * apps on this Mac, each with its own data, as two of the captain's Macs: the
 * second controls the first mate on the first (docs/view.md). A pick or the
 * words in the card's field on either shows on the other, the first mate's
 * computer keeps them across its restart, and the press on either sends
 * every pick both made; then the card and its draft are gone.
 *
 * Promised result: the other window shows each pick and the field's words,
 * and the press's answers hold both windows' picks. Data: one first mate
 * card with a radio question and a checkbox. Completion signal: the other
 * window's control reads checked, its field reads the words, and the card's
 * saved resolution holds the answers. Platform prerequisites: none beyond a
 * desktop. Shared resources: none; each app has its own data folder and the
 * link is to 127.0.0.1.
 */

const CARD_ID = "survey-start";
const TITLE = "Choose where the survey starts";
const START = "Start the survey";
const WORDS = "After the morning tide";

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
  const view = await launchApp({ env: { INFINITARY_DEVICE_NAME: "MacBook Air" } });
  const { page } = view;
  await expect(page.locator('[data-first-run-gate="open"]')).toBeVisible();
  await page.locator("[data-join-chip]").click();
  await page.getByLabel(`The link from your other ${COMPUTER.one}`).fill(invite.link);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Control it from here" }).click();
  await expect(page.locator("[data-remote-control]")).toHaveAttribute("data-freshness", "live");
  return view;
}

test("a card's unsent picks and words follow the captain between windows and across a restart", async () => {
  // Three launches: the first mate's computer twice and the one that controls it.
  test.setTimeout(180_000);
  const homeDir = scratchDir("infinitary-card-drafts-");
  seedHome(homeDir);
  const provider = await startMockProvider();
  const proEnv = { INFINITARY_DEVICE_NAME: "MacBook Pro" };
  let pro = await launchApp({ userDataDir: homeDir, reuseMockProvider: provider, env: proEnv });
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

    await test.step("the first mate's computer keeps them across its restart", async () => {
      await pro.close();
      pro = await launchApp({ userDataDir: homeDir, reuseMockProvider: provider, env: proEnv });
      await showCard(pro.page, TITLE);
      await expect(harbour(pro.page, "South Basin")).toBeChecked();
      await expect(tide(pro.page)).toBeChecked();
      await expect(cardReply(pro.page).field).toHaveValue(WORDS);
    });

    await test.step("the press sends both windows' picks, and the card leaves both", async () => {
      await shownCard(pro.page, TITLE).getByRole("button", { name: START, exact: true }).click();
      await expect(shownCard(pro.page, TITLE)).toHaveCount(0);
      await expect
        .poll(() =>
          view.evaluate(async () => (await window.infinitary.cards.list()).map((card) => card.id)),
        )
        .not.toContain(CARD_ID);
    });
  } finally {
    await air?.close();
    await pro.close();
    await provider.close();
  }

  // What the first mate's computer kept: the answers the press sent, and no draft.
  const db = openDatabase(homeDir);
  try {
    const answers = new CardStore(db).resolutionOf(CARD_ID)?.answers ?? [];
    expect(answers.find((answer) => answer.name === "harbour")?.values).toEqual(["south"]);
    expect(answers.find((answer) => answer.name === "tide")?.values).toEqual(["yes"]);
    expect(new CardDrafts(db, () => {}).read()).toEqual([]);
  } finally {
    db.close();
  }
});
