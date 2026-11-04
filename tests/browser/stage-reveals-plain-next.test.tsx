import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { seededHome, subscribed } from "./freshHome";
import { answerStack, inFrameTitled, shownEntry } from "./stack";
import { openSize, openWindow } from "./window";

// FI3-871, from the stage-reveals journey: the next card is prepared while
// the captain reads, and nothing of its own runs until it is shown. A plain
// body's animation holds at its start on the prepared page, then plays on
// the same page once the card is shown.

const READING_NOTE = "The harbour note you are reading";
const TIDE_TABLE = "The tide table";
const FADING =
  "<style>@keyframes harbour-in { from { opacity: 0 } to { opacity: 1 } } #fade { animation: harbour-in 1s linear forwards }</style>" +
  '<p id="fade">The tide table, fading in.</p>';

/** The paints the prepared page is given to start its fade, the journey's 300 ms hold at 60 a second. */
const HELD_PAINTS = 18;

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** The prepared entry's frame, the next card's page the stage draws while the captain reads. */
const warmFrame = () =>
  document.querySelector<HTMLIFrameElement>('[data-card-layer] [data-stage-entry="warm"] iframe');

/** The tide table's fade, read inside its page: its state and time, or null before it runs. */
const fade = () =>
  inFrameTitled(`${TIDE_TABLE} body`, () => {
    const animation = document.querySelector("#fade")?.getAnimations()[0];
    return animation ? { state: animation.playState, time: Number(animation.currentTime) } : null;
  });

test("a plain next card's animation waits until it is shown", async () => {
  const home = subscribed(
    await seededHome({
      notes: [
        { id: "reading", title: READING_NOTE, body: "<p>Close me.</p>" },
        { id: "tides", title: TIDE_TABLE, body: FADING },
      ],
    }),
  );
  const bridge = fakeBridge(home);
  answerStack(bridge, home);
  await openSize();
  await openWindow(bridge);
  await expect.element(page.getByRole("region", { name: READING_NOTE, exact: true })).toBeVisible();

  // Section: the tide table's page is prepared, and its fade holds at its start.
  await expect.poll(() => warmFrame()?.title).toBe(`${TIDE_TABLE} body`);
  await expect
    .poll(() => warmFrame()?.hasAttribute("data-frame-drawn"), {
      message: "the prepared page has drawn",
    })
    .toBe(true);
  for (let left = HELD_PAINTS; left > 0; left--) await nextFrame();
  expect(await fade()).toEqual({ state: "paused", time: 0 });

  // Section: closing the note shows the tide table, and its fade plays.
  await userEvent.click(
    page
      .elementLocator(shownEntry() as HTMLElement)
      .getByRole("button", { name: "Close", exact: true }),
  );
  await expect.element(page.getByRole("region", { name: TIDE_TABLE, exact: true })).toBeVisible();
  await expect.poll(async () => (await fade())?.state).not.toBe("paused");
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
