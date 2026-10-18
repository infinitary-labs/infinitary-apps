import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { renderWake } from "../../src/core/orchestrator/wakes";
import { launchClaudeCrew } from "./claudeCrew";
import type { LaunchedApp } from "./launch";
import { CLAUDE_CREWMATE_MARKER, FM_SYSTEM_MARKER, MOCK_COMPLETION_TEXT } from "./mockProvider";
import { reportLine, taskKey } from "./rails";

/**
 * A crewmate the host cannot watch that stops with no card up reaches the
 * Firstmate at once (INF-11, from the captain's words "make this missed
 * escalation structurally impossible", 2026-10-18). A Claude crewmate runs
 * its own background work, so the app cannot prove it stopped; its report
 * used to be left to the idle clock, which first woke the Firstmate twenty
 * minutes later. Whatever the report says - a blocker only the captain can
 * clear, in DOP-18's and INF-410's cases - the app never reads its words, so
 * every report nothing holds now wakes the Firstmate with them.
 *
 * The mock provider supplies the models' words; the report, its sort and the
 * wake are the app's own.
 */

const TITLE = `write a short status note ${CLAUDE_CREWMATE_MARKER}`;

let launched: LaunchedApp;

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

test.beforeAll(async () => {
  launched = await launchClaudeCrew();
});

test.afterAll(async () => {
  await launched.close();
});

test("a Claude crewmate that stops with no card up wakes the Firstmate with its report", async () => {
  const { page, mockProvider } = launched;
  const input = page.getByRole("textbox", { name: "Task prompt" });
  await expect(input).toBeEnabled({ timeout: 30_000 });
  await input.click();
  await input.fill(`commission a crewmate: ${TITLE}`);
  await input.press("Enter");
  const key = await taskKey(page, TITLE);
  await expect(reportLine(page, key)).toBeVisible({ timeout: 45_000 });
  const task = await page.evaluate(
    async (title) =>
      (await window.infinitary.tasks.board()).tasks.find((row) => row.title === title) ?? null,
    TITLE,
  );

  // The Firstmate is served the report's own words, though no card is up.
  const wake = renderWake({
    facts: {
      kind: "report",
      task: { id: task?.id ?? "", title: TITLE },
      crewmate: task?.assignee ?? "",
      excerpt: MOCK_COMPLETION_TEXT,
      filed: [],
      cards: [],
    },
  });
  const served = () =>
    (mockProvider?.requestBodies() ?? [])
      .filter((body) => body.includes(FM_SYSTEM_MARKER))
      .flatMap((body) => servedTexts(body, wake));
  await expect.poll(() => served().length, { timeout: 45_000 }).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.infinitary.cards.list())).toEqual([]);
  writeFileSync(test.info().outputPath("firstmate-wake.txt"), `${served()[0] ?? ""}\n`);
});
