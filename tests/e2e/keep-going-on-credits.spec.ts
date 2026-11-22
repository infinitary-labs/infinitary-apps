import { expect, type Page, test } from "@playwright/test";
import { creditsOfferCardId } from "../../src/core/orchestrator/hostCards";
import * as m from "../../src/shared/i18n/messages.generated";
import type { CatalogModelView } from "../../src/shared/quota";
import { CLAUDE_CREW_ACCOUNT, FIRSTMATE_MODEL_KEY, launchClaudeCrew } from "./claudeCrew";
import { leaveSettings } from "./handoverCards";
import type { LaunchedApp } from "./launch";
import { promptInput } from "./prompt";
import { HARD_TASK_PROMPT_MARKER, hardTask } from "./scenarios/hardTask";
import { claudeStarter } from "./starters";
import { focusOn, pressKey } from "./windowKeys";

/**
 * Keep going on credits (INF-4104 piece 2, docs/quota.md "Keep going on
 * credits"): the crew's Claude account has used up its session allowance,
 * and Claude says extra usage is on. With the account's switch off, a hard
 * task drops to the weaker level and the app offers, once, to keep going on
 * credits; the captain turns the switch on from the account's row menu by
 * keys, the offer goes, and the next hard task stays at the high level on
 * Claude.
 */

const OPUS = claudeStarter("high");
const SONNET = claudeStarter("medium");
const OPUS_KEY = `anthropic-claude/${OPUS.id}`;

const SPENT_CATALOG: CatalogModelView[] = [OPUS, SONNET].map((model) => ({
  provider: "claude",
  id: model.id,
  label: model.name,
  effectivePercentRemaining: 0,
  paceStatus: "behind",
}));

const FIRST_TITLE = "Audit the rivet ledger";
const SECOND_TITLE = "Audit the hull ledger";

async function modelOf(page: Page, title: string): Promise<string | null> {
  const board = await page.evaluate(() => window.infinitary.tasks.board());
  return board.tasks.find((task) => task.title === title)?.model ?? null;
}

async function startHardTask(page: Page, title: string): Promise<void> {
  const input = promptInput(page);
  await expect(input).toBeEnabled({ timeout: 30_000 });
  await focusOn(input);
  await input.fill(`${HARD_TASK_PROMPT_MARKER} ${title}`);
  await pressKey(input, "Enter");
}

/** Whether the crew's offer to keep going on credits is up: the list holds only the cards that are up. */
async function offerShown(page: Page): Promise<boolean> {
  const id = creditsOfferCardId(CLAUDE_CREW_ACCOUNT);
  const cards = await page.evaluate(() => window.infinitary.cards.list());
  return cards.some((card) => card.id === id);
}

test("a spent Claude allowance with extra usage keeps a hard task at its level once the switch is on", async () => {
  test.setTimeout(3 * 60_000);
  let launched: LaunchedApp | undefined;
  try {
    launched = await launchClaudeCrew({
      catalog: SPENT_CATALOG,
      allowance: { percentRemaining: 0, credits: { state: "available", usedPercent: 12 } },
      scenarios: [hardTask],
    });
    const { page } = launched;

    await startHardTask(page, FIRST_TITLE);
    await expect
      .poll(() => modelOf(page, FIRST_TITLE), { timeout: 60_000 })
      .toBe(FIRSTMATE_MODEL_KEY);
    await expect.poll(() => offerShown(page), { timeout: 30_000 }).toBe(true);

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Intelligence", exact: true }).click();
    const row = page.locator(`[data-account-row="${CLAUDE_CREW_ACCOUNT}"]`);
    const kebab = row.getByRole("button", { name: /actions$/ });
    await pressKey(kebab, "Enter");
    const item = page.locator('[data-menu-item="keep-going"]');
    await expect(item).toHaveText(new RegExp(m.settingsSubscriptionsMenuKeepGoing()));
    await page.keyboard.press("ArrowDown");
    await expect(item).toBeFocused();
    await page.keyboard.press("Enter");
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.infinitary.accounts.list())).find(
            (account) => account.id === CLAUDE_CREW_ACCOUNT,
          )?.keepGoingOnCredits,
      )
      .toBe(true);
    await expect(row).toContainText(m.settingsSubscriptionsCreditsKeepsGoing());
    await expect.poll(() => offerShown(page)).toBe(false);
    // The switch leaves its menu open, on, until Escape closes it; then Settings closes.
    await expect(item).toHaveAttribute("aria-checked", "true");
    await leaveSettings(page);

    await startHardTask(page, SECOND_TITLE);
    await expect.poll(() => modelOf(page, SECOND_TITLE), { timeout: 60_000 }).toBe(OPUS_KEY);
  } finally {
    await launched?.close();
  }
});
