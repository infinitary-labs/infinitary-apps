import { expect, type Locator, test } from "@playwright/test";
import { READING_MS } from "../../src/renderer/src/app/lastTurnFade";
import { askFirstmate, bubbleWords, mateBubble, olderRound, yourBubble } from "./lastTurn";
import { launchApp } from "./launch";
import { atRest, minimumWindowSize, resizeWindow } from "./layout";
import { promptInput } from "./prompt";
import { lastTurnWords, SALUTE_PROMPT_MARKER } from "./scenarios/lastTurnWords";
import { QUIET_WORK_MARKER, quietMessages } from "./scenarios/quietMessages";
import { setThemeViaSettings } from "./theme";
import { focusOn, pressKey } from "./windowKeys";

/** Actual painted text, bubble and geometry, read through the last-turn owners. */
async function paint(bubble: Locator) {
  return bubble.evaluate((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      color: style.color,
      background: style.backgroundColor,
      font: style.font,
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  });
}

// Intent: the captain's C selection on INF-1968 and the newer upper-round
// hover bug report (INF-2217): hover and focus light only their own round.
// Fixture: two real turns through the isolated model stand-in. Failure:
// a sibling lighting up, unreadable hovered older type, moving geometry or lost reply
// reading. This renderer journey owns the painted reading states; the existing
// last-turn journey owns turn delivery. No native prerequisite or shared account.
for (const theme of ["dark", "light"] as const) {
  test(`quiet messages brighten to read without changing the cyan mark or layout in ${theme}`, async () => {
    const launched = await launchApp({ withMockProvider: true, scenarios: [lastTurnWords] });
    const { page } = launched;
    try {
      await setThemeViaSettings(page, theme);
      await askFirstmate(page, `${SALUTE_PROMPT_MARKER}, keep my earlier clue visible`);
      await askFirstmate(
        page,
        `${SALUTE_PROMPT_MARKER}, please keep the conversation easy to read`,
      );
      const lane = page.locator("[data-last-turn]");
      const reply = mateBubble(page);
      const you = yourBubble(page);
      const older = mateBubble(page, "older");
      // The core's reply event precedes MateLine replacing its working span.
      // Read the painted reply, not that outgoing working state.
      await expect(reply).toHaveAttribute("data-state", "reply");
      await Promise.all([atRest(you), atRest(reply), atRest(older)]);
      const mark = lane.locator(
        "[data-last-turn-pair]:not([data-older]) [data-last-turn-mark] > polygon:first-child",
      );
      const markColor = () => mark.evaluate((element) => getComputedStyle(element).stroke);
      await page.mouse.move(10, 10);
      await focusOn(promptInput(page));
      const resting = { you: await paint(you), reply: await paint(reply) };
      const olderRest = await paint(older);
      const cyan = await markColor();
      const primary = await lane.evaluate((element) => getComputedStyle(element).color);
      expect(resting.you.color).toBe(resting.reply.color);
      expect(resting.reply.color).not.toBe(primary);
      await expect(olderRound(page)).toHaveCSS("opacity", "0.5");

      await reply.hover();
      const reading = { you: await paint(you), reply: await paint(reply) };
      expect(reading.reply.color).toBe(primary);
      expect(reading.you.color).toBe(primary);
      expect(reading.you.background).not.toBe(resting.you.background);
      expect(reading.you.box).toEqual(resting.you.box);
      expect(reading.reply.box).toEqual(resting.reply.box);
      expect(reading.reply.font).toBe(resting.reply.font);
      expect(await paint(older)).toEqual(olderRest);
      expect(await markColor()).toBe(cyan);

      await you.hover();
      expect(await paint(reply)).toEqual(reading.reply);
      expect(await paint(older)).toEqual(olderRest);
      await expect(olderRound(page)).toHaveCSS("opacity", "0.5");

      await page.mouse.move(10, 10);
      await focusOn(reply);
      expect(await paint(reply)).toEqual(reading.reply);
      expect(await paint(older)).toEqual(olderRest);
      await expect(olderRound(page)).toHaveCSS("opacity", "0.5");
      expect(await markColor()).toBe(cyan);
      await focusOn(promptInput(page));
      expect(await paint(reply)).toEqual(resting.reply);
      expect(await paint(you)).toEqual(resting.you);

      // INF-2217's live reproduction hit the upper reply but lit the lower one.
      // Exercise both rows and keyboard focus, preserving each sibling's paint.
      for (const target of [older, yourBubble(page, "older")]) {
        await target.hover();
        expect(await paint(reply)).toEqual(resting.reply);
        expect(await paint(you)).toEqual(resting.you);
        await expect(olderRound(page)).toHaveCSS("opacity", "1");
        expect(await paint(older)).toEqual(olderRest);
        expect(await markColor()).toBe(cyan);
      }
      await page.mouse.move(10, 10);
      await focusOn(older);
      await expect(olderRound(page)).toHaveCSS("opacity", "1");
      expect(await paint(reply)).toEqual(resting.reply);
      expect(await paint(you)).toEqual(resting.you);
      await pressKey(older, "Tab");
      await expect(reply).toBeFocused();
      expect(await paint(reply)).toEqual(reading.reply);
      await expect(olderRound(page)).toHaveCSS("opacity", "0.5");
      await focusOn(promptInput(page));
      expect(await paint(reply)).toEqual(resting.reply);
      expect(await paint(you)).toEqual(resting.you);

      const kept = await page.evaluate(() => window.infinitary.conversation.lastTurn());
      await pressKey(reply, "Enter");
      const note = page.locator("[data-reply-note]");
      await expect(note).toHaveText(kept?.reply?.words ?? kept?.reply?.text ?? "");
      await page.keyboard.press("Escape");
      await expect(note).toHaveCount(0);
      await mateBubble(page, "older").click();
      await expect(note).toHaveText(
        kept?.previous?.reply?.words ?? kept?.previous?.reply?.text ?? "",
      );
      await page.keyboard.press("Escape");
      await expect(note).toHaveCount(0);
      await resizeWindow(launched.app, page, await minimumWindowSize(launched.app));
      await expect(you).toBeVisible();
      const overflow = await lane.evaluate((element) => element.scrollWidth > element.clientWidth);
      expect(overflow).toBe(false);
      await expect(bubbleWords(you)).toHaveText(kept?.you ?? "");
    } finally {
      await launched.close();
    }
  });
}

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
