import { expect, type Locator, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { type Card, SETTLE_FACTS_OPEN } from "../../src/shared/cards";
import { RISK_DIMENSIONS, RISK_WORDS, type RiskAssessment } from "../../src/shared/risk";
import { completionCardBody } from "../helpers/completionCard";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody, cardBodyElement } from "./frames";
import { launchApp } from "./launch";
import { atRest, intersects, type Rect, resizeWindow, settled } from "./layout";
import { MOCK_MODEL_ID, MOCK_PROVIDER_ID } from "./mockProvider";
import { encodePng } from "./pictureFixtures";
import { heroShot } from "./pictures";
import { cardScroller, riskChart, SHOWN_ENTRY, showCard, shownCard } from "./stack";
import { focusOn, pressKey } from "./windowKeys";

/**
 * A merge card shows its crewmate's risk as a radar at its top right
 * (FI3-1127's plan, built in FI3-1128; docs/card-authoring.md "The risk
 * chart"). The captain reads each dimension by resting on its dot, or by
 * reaching it with Tab, and lets the note go by leaving it or with Esc,
 * which closes nothing else. The chart never covers the headline, the
 * first lines or Before's picture.
 *
 * The card is seeded as the host stores it, its assessment already
 * declared; the declaration's own refusals and persistence are the card
 * tool's and the supervisor's tests.
 */

const TITLE = "Cards open wide by default and saved widths move over";
const TASK = "task-wide-cards";

const RISK: RiskAssessment = {
  declared: {
    blast: { level: "high", why: "The stage, the store and every test that reads widths" },
    behavior: { level: "high", why: "Every card opens wider than before" },
    undo: { level: "medium", why: "Saved widths are rewritten by a migration" },
    evidence: { level: "medium", why: "Tests pass; the narrow window was not photographed" },
    sensitivity: { level: "medium", why: "Rewrites saved card widths" },
    novelty: { level: "medium", why: "A new width rule beside the old" },
    deps: { level: "low", why: "Nothing added" },
  },
};

/** A screenshot-sized view as a data picture, so the body needs no file. */
function view(shade: number, alt: string): string {
  const png = encodePng(1200, 360, () => [shade, shade, shade + 8]);
  return `<img src="data:image/png;base64,${png.toString("base64")}" alt="${alt}">`;
}

function mergeCard(): Card {
  return {
    id: "card-wide-cards",
    taskId: TASK,
    author: "crewmate",
    meta: "crewmate",
    priority: 30,
    title: TITLE,
    body: `${completionCardBody(
      "<p>You asked for cards to open wider.</p>",
      "<p>Every card opens at 800 px, and saved widths move over.</p>",
      `<p>Cards opened at 560 px.</p>${view(24, "A card at 560 px")}`,
      `<p>Cards open at 800 px.</p>${view(30, "A card at 800 px")}`,
    )}${SETTLE_FACTS_OPEN}</div>`,
    status: "ready",
    createdAt: Date.now(),
    width: "wide",
    risk: RISK,
    actions: [
      {
        id: "discard",
        label: "Discard",
        danger: true,
        effect: { kind: "settle", mode: "discard" },
      },
      { id: "merge", label: "Merge", default: true, effect: { kind: "settle", mode: "merge" } },
    ],
  };
}

/**
 * The box of an element's own words in the window, not of its block, which
 * reaches under a float beside it: read where its document draws them, then
 * moved by where the element sits in the window.
 */
async function wordsBox(target: Locator): Promise<Rect> {
  const read = await target.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element.firstChild ?? element);
    const words = range.getBoundingClientRect();
    const block = element.getBoundingClientRect();
    return {
      dx: words.x - block.x,
      dy: words.y - block.y,
      width: words.width,
      height: words.height,
    };
  });
  const block = (await target.boundingBox()) as Rect;
  return { x: block.x + read.dx, y: block.y + read.dy, width: read.width, height: read.height };
}

test("a merge card's risk chart sits at its top right, and each dot opens its own note by pointer and by keys", async () => {
  const userDataDir = scratchDir("infinitary-risk-chart-");
  const db = openDatabase(userDataDir);
  try {
    const tasks = new TaskService({ db });
    seedTask(tasks, {
      id: TASK,
      title: "Open cards wide",
      status: "completed",
      model: { provider: MOCK_PROVIDER_ID, id: MOCK_MODEL_ID },
    });
    tasks.recordDelivery(TASK, { mode: "local-only", ci: "green", ciAt: Date.now(), risk: RISK });
    new CardStore(db).upsert(mergeCard());
  } finally {
    db.close();
  }
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { app, page } = launched;
    await resizeWindow(app, page, { width: 1280, height: 900 });
    await showCard(page, TITLE);
    const risk = riskChart(page);
    await atRest(risk.chart);

    // Seven dots, each at the level the crewmate declared; no note at rest.
    for (const dimension of RISK_DIMENSIONS) {
      await expect(risk.dot(dimension)).toHaveAttribute(
        "data-risk-level",
        RISK.declared[dimension].level,
      );
    }
    await expect(risk.notes).toHaveCount(0);

    // Section: nothing the captain reads runs under the chart. The headline
    // and the first heading keep clear of it, and so does Before's picture.
    // A card with nothing on screen to hold appears before its body draws
    // (docs/renderer.md), then grows to the body and centres again, moving
    // the chart with it: the boxes are compared once the body has drawn and
    // they hold still.
    const frame = cardBody(page, TITLE);
    await expect(cardBodyElement(page, TITLE)).toHaveAttribute("data-frame-drawn", "");
    const headline = page.locator(`${SHOWN_ENTRY} [data-card-title]`);
    const why = frame.getByRole("heading", { name: "Why" });
    const picture = frame.getByRole("img", { name: "A card at 560 px" });
    const boxes = await settled(page, async () => ({
      chart: (await risk.chart.boundingBox()) as Rect,
      headline: await wordsBox(headline),
      why: await wordsBox(why),
      before: (await picture.boundingBox()) as Rect,
    }));
    expect(intersects(boxes.headline, boxes.chart)).toBe(false);
    expect(intersects(boxes.why, boxes.chart)).toBe(false);
    expect(intersects(boxes.before, boxes.chart)).toBe(false);

    // Section: resting on a dot opens its note, with the crewmate's line;
    // leaving lets it go.
    await risk.dot("blast").hover();
    await expect(risk.note("blast")).toContainText(RISK.declared.blast.why);
    if (process.env.INFINITARY_RISK_PICTURES) {
      await page.screenshot({ path: `${process.env.INFINITARY_RISK_PICTURES}/after.png` });
      await heroShot(page, {
        region: risk.chart,
        anchors: [risk.note("blast")],
        name: "self-reported-risk",
        ready: async () => {
          await risk.dot("blast").hover();
        },
      });
    }
    await risk.dot("deps").hover();
    await expect(risk.note("deps")).toContainText(RISK.declared.deps.why);
    await expect(risk.notes).toHaveCount(1);
    await page.mouse.move(2, 2);
    await expect(risk.notes).toHaveCount(0);

    // Section: the keys. Tab from the card's close reaches the dots in the
    // radar's order, each opening its note; Esc lets the note go and the
    // card stays.
    await pressKey(
      shownCard(page, TITLE).getByRole("button", { name: "Close", exact: true }),
      "Tab",
    );
    await expect(risk.dot("blast")).toBeFocused();
    await expect(risk.note("blast")).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(risk.dot("behavior")).toBeFocused();
    await expect(risk.note("behavior")).toContainText(RISK.declared.behavior.why);
    await page.keyboard.press("Escape");
    await expect(risk.notes).toHaveCount(0);
    await expect(risk.dot("behavior")).toBeFocused();
    await expect(shownCard(page, TITLE)).toBeVisible();

    // Read every crewmate-supplied reason with the keyboard.
    for (const dimension of RISK_DIMENSIONS) {
      await focusOn(risk.dot(dimension));
      const rating = RISK.declared[dimension];
      await expect(risk.note(dimension)).toHaveText(
        `${RISK_WORDS[dimension].label} · ${RISK_WORDS[dimension].levels[rating.level]}${rating.why}`,
      );
    }
    await page.keyboard.press("Escape");

    // Section: reading down to After, the chart leaves with the top of the
    // body; a dot the keyboard reaches brings it back, its note open.
    await cardScroller(page).evaluate((scroller) => {
      scroller.scrollTop = scroller.scrollHeight;
    });
    await expect(frame.getByRole("img", { name: "A card at 800 px" })).toBeInViewport();
    await expect(risk.dot("blast")).not.toBeInViewport();
    await pressKey(
      shownCard(page, TITLE).getByRole("button", { name: "Close", exact: true }),
      "Tab",
    );
    await expect(risk.dot("blast")).toBeFocused();
    await expect(risk.dot("blast")).toBeInViewport();
    await expect(risk.note("blast")).toContainText(RISK.declared.blast.why);
  } finally {
    await launched.close();
  }
});
