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
 * focused control stops being usable - a stack arrow that turns disabled at
 * the end of the stack, a picture's remove button that goes with its picture
 * - focus returns to the main message, never to a remembered card or pager
 * control. One window with three notes stacked: the arrows first, then a
 * picture removed from the main message, then one removed from the shown
 * card's reply.
 */

const TITLES = ["Alpha", "Bravo", "Charlie"];
const PICTURE = "chart.png";

/** Whether the main message holds the window's focus. */
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

  // Section: a stack arrow that becomes disabled returns focus to the main input.
  {
    const next = page.getByRole("button", { name: "Next card", exact: true });
    await userEvent.click(next);
    await expect.poll(() => document.activeElement === next.element()).toBe(true);
    await userEvent.click(next);
    await expect.element(next).toBeDisabled();
    await expect.poll(mainMessageFocused).toBe(true);
    const previous = page.getByRole("button", { name: "Previous card", exact: true });
    await userEvent.click(previous);
    await expect.poll(() => document.activeElement === previous.element()).toBe(true);
    await userEvent.click(previous);
    await expect.element(previous).toBeDisabled();
    await expect.poll(mainMessageFocused).toBe(true);
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
