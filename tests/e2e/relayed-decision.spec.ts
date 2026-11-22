import { writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { FIRSTMATE_PERSONA } from "../../src/core/pi/piResources";
import { DECLINE_LABEL } from "../../src/shared/cardLeave";
import { launchClaudeCrew } from "./claudeCrew";
import { CLAUDE_CREW_PROMPT_MARKER } from "./crewScripts";
import type { LaunchedApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import {
  CLAUDE_RELAY_APPROVAL,
  CLAUDE_RELAY_MARKER,
  claudeRelay,
  MOCK_CLAUDE_PLAN_ACTIONS,
  MOCK_CLAUDE_PLAN_CARD_TITLE,
  MOCK_CLAUDE_RELAY_ANSWER,
  MOCK_CLAUDE_RELAY_ASK,
} from "./scenarios/claudeRelay";
import { cardReply, showCard } from "./stack";

/**
 * A decision the captain gives by reply reaches the Firstmate (FI3-710,
 * grounded on FI3-703). A Claude crewmate's plan card is up; the captain
 * approves it by replying under it. The crewmate answers in the thread with
 * one line, leaves the card as it is, and reports his words with
 * needs_firstmate - and the Firstmate is woken with that request, though
 * the card is still up and the host cannot watch a Claude crewmate's
 * background work. Before, that report sorted like any other and woke
 * nobody until the captain asked again (FI3-696).
 *
 * The mock provider supplies the two models' words; the reply, the thread,
 * the report's sort and the wake are the app's own.
 */

const TITLE = `plan the rivet threshold ${CLAUDE_CREW_PROMPT_MARKER} ${CLAUDE_RELAY_MARKER}`;

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchClaudeCrew({ scenarios: [claudeRelay] });
});

test.afterAll(async () => {
  await launched.close();
});

/** The plan card's buttons: its crewmate's choices and the app's Decline (INF-3108). */
const PLAN_BUTTONS = [...MOCK_CLAUDE_PLAN_ACTIONS, DECLINE_LABEL].sort();

function actionLabels(card: { actions: { label: string }[] } | undefined): string[] {
  return (card?.actions ?? []).map((action) => action.label).sort();
}

/** Every string in a request body that carries `needle`: the served text, unescaped. */
function servedTexts(body: string, needle: string): string[] {
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.includes(needle)) found.push(value);
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(JSON.parse(body));
  return found;
}

function thread(page: Page) {
  return page.locator("[data-card-thread]");
}

test("an approval given by reply under a crewmate's plan card wakes the Firstmate, the card still up", async () => {
  const { page, mockProvider } = launched;
  const firstmateHeard = (text: string) =>
    (mockProvider?.requestBodies() ?? []).some(
      (body) => body.includes(FIRSTMATE_PERSONA) && body.includes(text),
    );
  const input = page.getByRole("textbox", { name: "Task prompt" });
  await expect(input).toBeEnabled({ timeout: 30_000 });
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} ${TITLE}`);
  await input.press("Enter");

  // The plan card is on the stage once its crewmate reported.
  const planCard = () =>
    page.evaluate(
      async (title) => (await window.infinitary.cards.list()).find((card) => card.title === title),
      MOCK_CLAUDE_PLAN_CARD_TITLE,
    );
  await expect
    .poll(
      async () => {
        const card = await planCard();
        return card && !card.awaiting ? actionLabels(card) : null;
      },
      { timeout: 45_000 },
    )
    .toEqual(PLAN_BUTTONS);
  await showCard(page, MOCK_CLAUDE_PLAN_CARD_TITLE);

  const reply = cardReply(page).field;
  await reply.click();
  await reply.fill(CLAUDE_RELAY_APPROVAL);
  await cardReply(page).send.click();

  await showCard(page, MOCK_CLAUDE_PLAN_CARD_TITLE);
  await expect(
    thread(page)
      .locator('[data-thread-message="crewmate"]')
      .filter({ hasText: MOCK_CLAUDE_RELAY_ANSWER }),
  ).toBeVisible({ timeout: 45_000 });

  await expect
    .poll(() => firstmateHeard(`It asks the first mate to act: ${MOCK_CLAUDE_RELAY_ASK}.`), {
      timeout: 45_000,
    })
    .toBe(true);
  expect(firstmateHeard(CLAUDE_RELAY_APPROVAL)).toBe(true);
  const served = (mockProvider?.requestBodies() ?? [])
    .filter((body) => body.includes(FIRSTMATE_PERSONA))
    .flatMap((body) => servedTexts(body, "It asks the first mate to act"));
  writeFileSync(test.info().outputPath("firstmate-wake.txt"), `${served.at(-1) ?? ""}\n`);

  expect(actionLabels(await planCard())).toEqual(PLAN_BUTTONS);
  await page.locator("[data-card-layer]").screenshot({
    path: test.info().outputPath("relayed-decision-thread.png"),
  });
});
