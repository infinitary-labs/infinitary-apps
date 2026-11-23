import { expect, test } from "vitest";
import { page } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { seededHome, subscribed } from "./freshHome";
import { APP_WINDOW, openSize, openWindow } from "./window";

/**
 * Intent: the captain's report that the last turn's lines "can get cut off
 * mid word", and their ask: "i think we should preserve full words"
 * (docs/composer.md "The last turn"). Fixture: the conversation in the
 * captain's picture, its message and reply too long for one line. Failure: a
 * line whose ellipsis follows part of a word, a bubble wider than the words
 * it shows, or a cut that stays put as the width changes.
 */

const ROUND = {
  ask: `i'm thinking of renaming the label "Care" to "Rigor" or "Quality" because Care reads soft`,
  reply:
    "I asked a crewmate to recommend a new name for “Care”. It will compare both and come back with one.",
};

const BREAKING_SPACE = /[^\S   ]/;

function words(who: "you" | "firstmate"): HTMLElement {
  const found = document.querySelector<HTMLElement>(
    `[data-last-turn] [data-last-turn-bubble="${who}"] [data-last-turn-words]`,
  );
  if (!found) throw new Error(`The window drew no ${who} words`);
  return found;
}

function ellipsisWidth(node: HTMLElement): number {
  const probe = document.createElement("span");
  probe.textContent = "…";
  const style = getComputedStyle(node);
  probe.style.font = style.font;
  probe.style.letterSpacing = style.letterSpacing;
  probe.style.position = "fixed";
  probe.style.whiteSpace = "pre";
  document.body.append(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  return width;
}

/**
 * What a line draws, read off the page's layout: the box the line holds,
 * and the characters drawn whole before the ellipsis, which the browser
 * hides once one no longer fits beside it (`text-overflow: ellipsis`).
 */
function drawn(node: HTMLElement) {
  const text = node.firstChild;
  if (!(text instanceof Text)) throw new Error("The words are not one text");
  const box = node.getBoundingClientRect().width;
  const range = document.createRange();
  const widthTo = (end: number) => {
    range.setStart(text, 0);
    range.setEnd(text, end);
    return range.getBoundingClientRect().width;
  };
  const whole = widthTo(text.length);
  if (whole <= box + 0.5) return { cut: false as const, whole: text.data };
  const ellipsis = ellipsisWidth(node);
  let shown = 0;
  while (shown < text.length && widthTo(shown + 1) + ellipsis <= box + 0.01) shown++;
  return {
    cut: true as const,
    whole: text.data,
    shown: text.data.slice(0, shown),
    hidden: text.data.charAt(shown),
    spare: box - widthTo(shown) - ellipsis,
    hiddenWidth: widthTo(shown + 1) - widthTo(shown),
  };
}

test("each cut line ends on a whole word at every width, and its bubble holds only what it shows", async () => {
  const home = await seededHome({ theme: "dark", rounds: [ROUND] });
  const bridge = fakeBridge(subscribed(home));
  await openSize();
  await openWindow(bridge);
  await expect
    .poll(() => document.querySelector("[data-last-turn-bubble='firstmate']"))
    .not.toBeNull();

  // The page from the app's window down to a third of it, as rails beside
  // the input and a larger Size narrow it; each width without a new draw.
  let cuts = 0;
  for (let width = APP_WINDOW.width; width >= APP_WINDOW.width / 3; width -= 20) {
    await page.viewport(width, APP_WINDOW.height);
    await expect.poll(() => window.innerWidth).toBe(width);
    for (const who of ["you", "firstmate"] as const) {
      const node = words(who);
      const said = who === "you" ? ROUND.ask : ROUND.reply;
      await expect
        .poll(
          () => {
            const line = drawn(node);
            if (!line.cut) return "whole";
            return BREAKING_SPACE.test(line.hidden) &&
              !/\s$/.test(line.shown) &&
              line.spare < line.hiddenWidth
              ? "whole words"
              : `cut at ${JSON.stringify(line.shown)}|${JSON.stringify(line.hidden)} with ${line.spare.toFixed(1)}px spare`;
          },
          { message: `${who} at a ${width}px page` },
        )
        .toMatch(/^whole/);
      const line = drawn(node);
      if (line.cut) cuts++;
      expect(line.whole, "the line keeps all its words").toBe(said);
    }
  }
  expect(cuts, "some widths cut each line").toBeGreaterThan(2);
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
