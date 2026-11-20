import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { EVENT_SCREEN_OFFER_TITLE } from "../../src/core/decisions/eventScreenOffer";
import { STAND_IN_EVENT } from "../../src/core/integrations";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import { heroShot, regionShot } from "./pictures";
import { settingsSection } from "./settings";
import { expectNoCard, shownCard, stageAtRest } from "./stack";
import { focusOn, pressKey, runFromSearch, typeInto, untilFocused } from "./windowKeys";

/**
 * INF-4667 finding 1: a watch with an Only if condition woke the first mate
 * for every email while Screen automation events was off, and nothing said
 * so. Saving such a watch now raises one card that explains the screen,
 * and its Turn on switches it on.
 *
 * - Promised result: a rule saved and turned on by keys from Settings →
 *   Automation with an Only if condition raises the offer card; Turn on,
 *   pressed by keys, leaves Screen automation events on in Settings →
 *   Intelligence → Decisions and takes the card down.
 * - Data: the stand-in integration over a scratch folder, its "An item
 *   arrives" event standing in for a mail account's, and an Only if
 *   condition a person would write about one sender.
 * - Completion signal: the shown card titled as the offer, then the
 *   decision use's switch read back through the window's own API.
 * - Platform prerequisites: none beyond the hermetic launcher and its
 *   stand-in model.
 * - Shared resources: none; its own userData, HOME and items folder.
 */

/** The Only if condition this journey types, as a person would about one sender. */
const ONLY_IF = "An email from Microsoft about my account";

let launched: LaunchedApp | undefined;
test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

test("a watch with an Only if offers the event screen, and Turn on switches it on", async () => {
  const testInfo = test.info();
  const userDataDir = scratchDir("infinitary-event-screen-offer-");
  const standIn = scratchDir("infinitary-stand-in-integration-");
  writeFileSync(join(standIn, "items.jsonl"), "");
  launched = await launchApp({
    userDataDir,
    withMockProvider: true,
    env: { INFINITARY_STAND_IN_INTEGRATION: standIn },
  });
  const { app, page } = launched;
  const screenOn = () =>
    page.evaluate(
      async () =>
        (await window.infinitary.models.decisions()).uses?.find((use) => use.id === "event-screen")
          ?.on,
    );
  expect(await screenOn()).toBe(false);

  await runFromSearch(app, page, "settings.automation");
  const tab = settingsSection(page, "automation");
  const create = tab.locator("[data-automation-new]");
  await untilFocused(create);
  await pressKey(create, "Enter");
  const sheet = tab.locator('[data-automation-sheet="new"]');
  const name = sheet.locator("#automation-name");
  await focusOn(name);
  await typeInto(name, "Microsoft account email");
  const when = sheet.locator("#automation-when");
  await pressKey(when, "w");
  await expect(sheet.locator("[data-automation-event]")).toHaveValue(
    `stand-in/${STAND_IN_EVENT.name}`,
  );
  const onlyIf = sheet.locator("#automation-waits-for");
  await focusOn(onlyIf);
  await typeInto(onlyIf, ONLY_IF);
  const prompt = sheet.locator("#automation-prompt");
  await focusOn(prompt);
  await typeInto(prompt, "Tell me what Microsoft wants: {{events}}");
  await pressKey(sheet.locator("[data-automation-enable]"), "Enter");
  const turnOnRule = sheet.locator("[data-automation-turn-on]");
  await untilFocused(turnOnRule);
  await pressKey(turnOnRule, "Enter");
  await expect
    .poll(async () =>
      (await page.evaluate(async () => (await window.infinitary.automation.list()).rules)).map(
        (rule) => rule.state,
      ),
    )
    .toEqual(["enabled"]);
  // Escape goes back to the list, then closes Settings, where the card waits.
  await expect(async () => {
    await page.keyboard.press("Escape");
    await expect(tab).toBeHidden({ timeout: 1_000 });
  }).toPass();

  const card = shownCard(page, EVENT_SCREEN_OFFER_TITLE);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(cardBody(page, EVENT_SCREEN_OFFER_TITLE).locator("body")).toContainText(ONLY_IF);
  const evidence =
    testInfo.repeatEachIndex === 0 ? process.env.INFINITARY_TASK_EVIDENCE_DIR : undefined;
  if (evidence) {
    await stageAtRest(page);
    await regionShot(card, join(evidence, "event-screen-offer-after.png"));
    await heroShot(app, page, { region: card, name: "event-screen-offer" });
  }

  const turnOn = card.getByRole("button", { name: "Turn on", exact: true });
  await focusOn(turnOn);
  await pressKey(turnOn, "Enter");
  await expect.poll(screenOn).toBe(true);
  await expectNoCard(page, EVENT_SCREEN_OFFER_TITLE);
});
