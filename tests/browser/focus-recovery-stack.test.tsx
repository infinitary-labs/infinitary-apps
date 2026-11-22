import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { seededHome, subscribed } from "./freshHome";
import { messageBox, pastePictures, picturePng } from "./prompt";
import { answerStack, inShown, shownEntry } from "./stack";
import { openSize, openWindow } from "./window";

/**
 * One fallback for the whole shell (`guardLostFocus`,
 * src/renderer/src/app/focusRecovery.ts; docs/keyboard.md): when the
 * focused control stops being usable - a stack arrow that goes with the pager
 * when the stack falls to one card, a picture's remove button that goes with its picture
 * - focus returns to the main message, never to a remembered card or pager
 * control. One window with three notes stacked: the arrows first, then a
 * picture removed from the main message, then one removed from the shown
 * card's reply.
 */

const TITLES = ["Alpha", "Bravo", "Charlie"];
const PICTURE = "chart.png";

const mainMessageFocused = () =>
  document.activeElement !== null && document.activeElement === messageBox();

test("a control that becomes unavailable returns focus to the main message", async () => {
  const home = subscribed(await seededHome({ titles: TITLES }));
  const bridge = fakeBridge(home);
  answerStack(bridge, home);
  await openSize();
  await openWindow(bridge);
  await expect.element(page.getByRole("region", { name: TITLES[0], exact: true })).toBeVisible();
  await expect.poll(() => messageBox()?.disabled).toBe(false);
  const png = await picturePng();

  // Section: a stack arrow that goes away returns focus to the main input. The
  // arrows go round past either end (INF-4541), so an arrow goes only with the
  // pager, when the stack falls to one card.
  {
    const listed = home["inf:cards:list"];
    if (!Array.isArray(listed)) throw new Error("The seeded home read no cards");
    for (const name of ["Next card", "Previous card"]) {
      bridge.push("inf:cards", listed);
      const arrow = page.getByRole("button", { name, exact: true });
      await userEvent.click(arrow);
      await expect.poll(() => document.activeElement === arrow.element()).toBe(true);
      bridge.push("inf:cards", listed.slice(0, 1));
      await expect.element(arrow).not.toBeInTheDocument();
      await expect.poll(mainMessageFocused).toBe(true);
    }
    bridge.push("inf:cards", listed);
  }

  // Section: removing a picture from the main input returns focus to the main input.
  {
    const field = messageBox();
    if (!field) throw new Error("The window drew no message box");
    pastePictures(field, png, [{ name: PICTURE }]);
    const remove = page.getByRole("button", { name: `Remove ${PICTURE}`, exact: true });
    await userEvent.click(remove);
    await expect.element(remove).not.toBeInTheDocument();
    await expect.poll(mainMessageFocused).toBe(true);
  }

  // Section: removing a picture from the reply input returns focus to the main input.
  {
    await expect.element(page.getByRole("region", { name: TITLES[0], exact: true })).toBeVisible();
    pastePictures(inShown("[data-card-reply] textarea"), png, [{ name: PICTURE }]);
    const remove = page.getByRole("button", { name: `Remove ${PICTURE}`, exact: true });
    await expect.element(remove).toBeVisible();
    expect(shownEntry()?.contains(remove.element()), "the picture is the reply's").toBe(true);
    await userEvent.click(remove);
    await expect.element(remove).not.toBeInTheDocument();
    await expect.poll(mainMessageFocused).toBe(true);
  }
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
