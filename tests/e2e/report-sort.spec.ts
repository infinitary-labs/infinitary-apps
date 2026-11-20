import { expect, test } from "@playwright/test";
import { waitForFirstmateIdle } from "./crew";
import { type LaunchedApp, launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { activityFrame, reportLine, startedLine, taskKey } from "./rails";

/**
 * S7c acceptance (captain call C7 A, heuristics only): a crewmate's report
 * is sorted by the whose-turn rule in the host, not by a second model.
 *
 * What that must look like from the captain's chair: the report is ONE
 * quiet feed line - the retired triage session used to paraphrase every
 * report a few seconds later, which is two lines about one event - no card
 * is raised for it, and none of the machinery names itself anywhere. The
 * mock crewmate stops with nothing running, so the rule's answer is
 * "nobody's turn": the Firstmate hears the report's own words, acts if it
 * must, and the app returns to idle.
 */

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp({ withMockProvider: true });
});

test.afterAll(async () => {
  await launched.close();
});

test("a report is one quiet feed line, sorted in code, with no card and no second voice", async () => {
  const { page } = launched;
  const input = promptInput(page);
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} write a short status note`);
  await input.press("Enter");
  const key = await taskKey(page, "write a short status note");
  await expect(startedLine(page, key)).toBeVisible({ timeout: 30_000 });
  await expect(reportLine(page, key)).toBeVisible({ timeout: 30_000 });
  await waitForFirstmateIdle(page, 20_000);

  // Exactly one line about that report: no paraphrase of it follows.
  const lines = await page.evaluate(() => window.infinitary.feed.recent());
  expect(lines.filter((line) => line.taskKey === key && line.event === "report")).toHaveLength(1);

  // The report earned no card, and the task is still the crewmate's to
  // resume - a report is not a close (WI-11).
  const cards = await page.evaluate(() => window.infinitary.cards.list());
  expect(cards).toEqual([]);
  const board = await page.evaluate(() => window.infinitary.tasks.board());
  expect(board.tasks.some((task) => task.status === "active")).toBe(true);

  // None of the machinery names itself: the word reaches no surface.
  // biome-ignore lint/plugin/e2e-text-lookup: a retired machinery word must reach no surface; the word is the subject.
  await expect(page.getByText(/supervision/i)).toHaveCount(0);
  await expect(activityFrame(page).getByText(/supervision/i)).toHaveCount(0);
});
