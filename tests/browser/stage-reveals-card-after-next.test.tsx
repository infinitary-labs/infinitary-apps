import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { seededHome, subscribed } from "./freshHome";
import { answerStack, cardLeave, shownEntry } from "./stack";
import { openSize, openWindow } from "./window";

// INF-624, from the stage-reveals journey: the card after the next one is
// prepared once the next card's height easing has finished
// (docs/renderer.md). On a MacBook the easing's animation clock started
// 1.85 ms ahead of the page clock its deadline was read on, so it finished
// 1.2 ms before that deadline, the card never settled and nothing was
// prepared. Here the easing starts 100 ms ahead, so its finish comes before
// the deadline whatever the display's frame rate.
const EASING_LEAD_MS = 100;
const SHORT_NOTE = "A short harbour note";
const TALL_NOTE = "A tall harbour note";
const LATER_NOTE = "A later harbour note";

/** The prepared entry's frame, the next card's page the stage draws while the captain reads. */
const warmFrame = () =>
  document.querySelector<HTMLIFrameElement>('[data-card-layer] [data-stage-entry="warm"] iframe');

const stagePrepared = () =>
  document.querySelector('[data-card-layer] [data-stage-entry="outgoing"]') === null &&
  document.querySelectorAll(
    '[data-card-layer] [data-stage-entry="warm"] iframe:is([data-frame-drawn], [data-frame-held])',
  ).length === 1;

const shownCard = (title: string) => page.getByRole("region", { name: title, exact: true });

test("the card after next is prepared when the height easing finishes ahead of the page clock", async () => {
  const berths = Array.from(
    { length: 8 },
    (_, index) => `<p>Berth ${index + 1} is free at high tide.</p>`,
  ).join("");
  const home = subscribed(
    await seededHome({
      notes: [
        { id: "short", title: SHORT_NOTE, body: "<p>Close me.</p>" },
        { id: "tall", title: TALL_NOTE, body: berths },
        { id: "later", title: LATER_NOTE, body: "<p>Waiting its turn.</p>" },
      ],
    }),
  );
  const bridge = fakeBridge(home);
  answerStack(bridge, home);
  await openSize();
  await openWindow(bridge);
  await expect.element(shownCard(SHORT_NOTE)).toBeVisible();
  await expect.poll(() => warmFrame()?.title).toBe(`${TALL_NOTE} body`);
  await expect.poll(stagePrepared).toBe(true);

  // Every easing of the card's height starts its clock ahead of the page's.
  const easings: string[] = [];
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (keyframes, options) {
    const animation = animate.call(this, keyframes, options);
    if (this.hasAttribute("data-card-presentation")) {
      animation.startTime = Number(document.timeline.currentTime) - EASING_LEAD_MS;
      easings.push("started");
      animation.addEventListener("finish", () => easings.push("finished"));
    }
    return animation;
  };
  try {
    await userEvent.click(cardLeave());
    await expect.element(shownCard(TALL_NOTE)).toBeVisible();
    await expect.poll(() => easings).toContain("finished");
    await expect
      .poll(() =>
        document
          .querySelector("[data-card-layer] [data-card-presentation]")
          ?.getAttribute("data-card-geometry"),
      )
      .not.toBe("animating");
    await expect.poll(() => warmFrame()?.title).toBe(`${LATER_NOTE} body`);
    await expect.poll(stagePrepared).toBe(true);
  } finally {
    Element.prototype.animate = animate;
  }
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
