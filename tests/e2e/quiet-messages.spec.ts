import { expect, test } from "@playwright/test";
import { READING_MS } from "../../src/renderer/src/app/lastTurnFade";
import { askFirstmate, mateBubble, olderRound } from "./lastTurn";
import { launchApp } from "./launch";
import { promptInput } from "./prompt";
import { lastTurnWords, SALUTE_PROMPT_MARKER } from "./scenarios/lastTurnWords";
import { QUIET_WORK_MARKER, quietMessages } from "./scenarios/quietMessages";
import { focusOn } from "./windowKeys";

// The painted reading states in each look, hover and focus, are the browser
// twins' (tests/browser/quiet-messages-dark.test.tsx, quiet-messages-light.test.tsx).
//
// Intent: the captain's added INF-1969 request, fifteen seconds after becoming
// second-to-last, even while the newest turn works. The page's virtual clock
// exercises that order deterministically; the task's real-speed demo proves it
// on the actual clock too. No account, native device or shared fixture is used.
test("the second-to-last round fades during newer work, but not while its reply has keyboard focus", async () => {
  const launched = await launchApp({
    withMockProvider: true,
    scenarios: [quietMessages, lastTurnWords],
  });
  const { page } = launched;
  try {
    await askFirstmate(page, `${SALUTE_PROMPT_MARKER}, keep my earlier clue visible`);
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 100));
    const input = promptInput(page);
    await input.fill(QUIET_WORK_MARKER);
    await input.press("Enter");
    await expect(olderRound(page)).toBeVisible();
    await expect(mateBubble(page)).toHaveAttribute("data-state", "working");
    await page.mouse.move(10, 10);
    await page.clock.runFor(READING_MS / 2);
    await focusOn(mateBubble(page, "older"));
    await page.clock.runFor(READING_MS);
    await expect(olderRound(page)).toBeVisible();
    await focusOn(input);
    const before = await input.boundingBox();
    await page.clock.runFor(READING_MS / 2);
    await expect(page.locator("[data-last-turn]")).toHaveAttribute("data-last-turn-fade", "fading");
    const dissolve = await page.evaluate(() =>
      Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--dur-slow")),
    );
    await page.clock.runFor(dissolve);
    await expect(olderRound(page)).toHaveCount(0);
    await expect(mateBubble(page)).toHaveAttribute("data-state", "working");
    expect(await input.boundingBox()).toEqual(before);
  } finally {
    await launched.close();
  }
});
