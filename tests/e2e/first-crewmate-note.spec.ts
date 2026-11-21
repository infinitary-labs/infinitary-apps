import { expect, test } from "@playwright/test";
import { FIRST_CREWMATE_TITLE } from "@shared/firstCrewmateNote";
import { WELCOME_TITLE } from "@shared/welcome";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { gitIdentityHome } from "./homeFixtures";
import { type LaunchedApp, launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { writeMockClaudeClient } from "./mockClaudeClient";
import { mockProviderOverrideModelsJson } from "./mockModels";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { windowShot } from "./pictures";
import { promptInput } from "./prompt";
import { startedLine, taskKey } from "./rails";
import {
  FIRST_CREWMATE_ASK,
  FIRST_CREWMATE_CARD_TITLE,
  firstCrewmateCard,
} from "./scenarios/firstCrewmateCard";
import { expectNoCard, shownCard, stageAtRest } from "./stack";
import { pressWindowKey } from "./windowKeys";

/**
 * The first crewmate's note (INF-5532's approved plan; docs/first-launch.md
 * "The first crewmate's note"): when a new person's first crewmate starts,
 * the app shows one note that says the work goes on in the background and
 * that cards are the part that needs them, and puts away the welcome if it
 * is still up, so the crewmate's first card arrives on an open stage.
 *
 * Its data is a fresh profile and HOME, a git identity in that HOME, the
 * stand-in behind the key the gate signs in, and a crewmate whose first
 * card the journey holds until it has read the note and the open stage
 * (`tests/e2e/scenarios/firstCrewmateCard.ts`). It shares no sign-in,
 * keychain, account or folder with another journey and needs no Mac. Its
 * completion signal is a second crewmate started after a restart with no
 * second note, the record still naming the first note.
 */

const KEY_PROVIDER = "xai";

/** Where each section stood, kept with the run's results. */
const picture = (name: string) => test.info().outputPath(`${name}.png`);

const openTitles = async (page: LaunchedApp["page"]) =>
  (await page.evaluate(() => window.infinitary.cards.list())).map((card) => card.title);

const launch = (profile?: { userDataDir: string; homeDir: string }) =>
  launchApp({
    withMockProvider: true,
    // The base runtime serves no model, so the gate shows; the key the gate
    // signs in reads the same file and sends every turn to the stand-in.
    modelsJson: (port) => mockProviderOverrideModelsJson(port, KEY_PROVIDER),
    scenarios: [firstCrewmateCard],
    ...(profile ?? { prepareHome: gitIdentityHome("New Person", "new-person@localhost") }),
    env: { INFINITARY_CLAUDE_CLI: writeMockClaudeClient(scratchDir("infinitary-claude-stub-")) },
  });

test("a new person's first crewmate shows its note once, in place of the welcome", async () => {
  test.setTimeout(3 * 60_000);
  let launched = await launch();
  try {
    const { app, page, mockProvider } = launched;
    if (!mockProvider) throw new Error("The journey needs its stand-in provider.");
    await resizeWindow(app, page, { width: 1280, height: 900 });
    const input = promptInput(page);

    await test.step("a key signed in through the gate brings the welcome", async () => {
      const gate = page.locator("[data-first-run-gate]");
      await expect(gate).toHaveAttribute("data-first-run-gate", "open", { timeout: 20_000 });
      await gate.locator(`[data-connect-provider="${KEY_PROVIDER}"]`).click();
      await gate.locator("[data-connect-method]").getByRole("button", { name: "API key" }).click();
      const aside = gate.locator("[data-connect-aside]");
      await aside.locator("input[type='password']").fill("xai-first-crewmate");
      await aside.getByRole("button", { name: "Submit" }).click();
      await expect(input).toBeEnabled();
      await expect(shownCard(page, WELCOME_TITLE)).toBeVisible();
    });

    let noteId = "";
    await test.step("the first crewmate's start puts the welcome away and shows the note", async () => {
      // Typed under the welcome, which its own words tell a new person to do.
      await input.fill(`${SPAWN_PROMPT_MARKER} ${FIRST_CREWMATE_ASK}`);
      await input.press("Enter");
      await expect(startedLine(page, await taskKey(page, FIRST_CREWMATE_ASK))).toBeVisible({
        timeout: 30_000,
      });
      await expect(shownCard(page, FIRST_CREWMATE_TITLE)).toBeVisible();
      await expectNoCard(page, WELCOME_TITLE);
      expect(await openTitles(page)).toEqual([FIRST_CREWMATE_TITLE]);
      const cards = await page.evaluate(() => window.infinitary.cards.list());
      expect(cards[0]).toMatchObject({
        author: "firstmate",
        actions: [],
        replies: false,
        width: "regular",
      });
      noteId = cards[0]?.id ?? "";
      const record = await page.evaluate(() => window.infinitary.app.firstRun());
      expect(record.firstCrewmateNoteId).toBe(noteId);
      const body = cardBody(page, FIRST_CREWMATE_TITLE);
      await expect(body.locator('[data-part="now"]')).toBeVisible();
      await expect(body.locator('[data-part="later"]')).toBeVisible();
      await stageAtRest(page);
      await windowShot(page, picture("1-note"));
    });

    await test.step("Got it by its key opens the stage on the working crewmate", async () => {
      await pressWindowKey(app, "1", ["meta"]);
      await expectNoCard(page, FIRST_CREWMATE_TITLE);
      await expect(page.locator('[data-crew-state-word="working"][data-on="true"]')).toBeVisible({
        timeout: 20_000,
      });
      await windowShot(page, picture("2-after-got-it"));
    });

    await test.step("the crewmate's first card takes the open stage", async () => {
      await expect.poll(() => mockProvider.heldThreadAnswers(), { timeout: 30_000 }).toBe(1);
      mockProvider.releaseThreadAnswer();
      await expect(shownCard(page, FIRST_CREWMATE_CARD_TITLE)).toBeVisible({ timeout: 30_000 });
      await stageAtRest(page);
      await windowShot(page, picture("3-first-card"));
    });

    await test.step("after a restart, a second crewmate starts with no second note", async () => {
      const { userDataDir, homeDir } = launched;
      await launched.close();
      launched = await launch({ userDataDir, homeDir });
      const again = launched.page;
      await expect(shownCard(again, FIRST_CREWMATE_CARD_TITLE)).toBeVisible({ timeout: 20_000 });
      const second = `${FIRST_CREWMATE_ASK} again`;
      await promptInput(again).fill(`${SPAWN_PROMPT_MARKER} ${second}`);
      await promptInput(again).press("Enter");
      await expect(startedLine(again, await taskKey(again, second))).toBeVisible({
        timeout: 30_000,
      });
      // A note would commit in the same step that tells the window of the start.
      expect(await openTitles(again)).not.toContain(FIRST_CREWMATE_TITLE);
      const record = await again.evaluate(() => window.infinitary.app.firstRun());
      expect(record.firstCrewmateNoteId).toBe(noteId);
    });
  } finally {
    await launched.close();
  }
});
