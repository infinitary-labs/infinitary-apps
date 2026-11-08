import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { clock, revisedLine as revisedWords } from "../../src/renderer/src/cards/revisedLine";
import { cardBody, cardBodyElement } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import { pseudoBox } from "./layout";
import { promptInput } from "./prompt";
import { readSavedData } from "./savedData";
import {
  CHANGE_MARKS_PROMPT_MARKER,
  CHANGE_MARKS_TITLE,
  changeMarkVersions,
} from "./scenarios/changeMarkVersions";
import { changeMarks, revisedLine } from "./stack";
import { focusOn } from "./windowKeys";

/** The offers the window reported seen, oldest first, read from the record itself. */
function seenOffers(userDataDir: string): string[] {
  return readSavedData(userDataDir, (db) =>
    (
      db
        .prepare("SELECT offer_id FROM card_observations WHERE kind = 'seen' ORDER BY seq")
        .all() as { offer_id: string }[]
    ).map((row) => row.offer_id),
  );
}

/** A time of day as the revised line writes it today, and anything after it. */
const CLOCK = /\d{1,2}:\d{2}.*/.source;

/**
 * The revised line the product writes for these counts, its time of day
 * matched by `time`.
 */
function revisedPattern(
  counts: { added: number; removed: number; rewritten?: boolean },
  time = ".*",
): RegExp {
  const at = Date.now();
  const line = revisedWords({ at, rewritten: false, marks: [], ...counts }, at);
  const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escapeRegExp(line).replace(escapeRegExp(clock(at, at)), () => time)}$`);
}

/** The version of the card the stage shows now. */
async function shownOffer(page: Page): Promise<string | undefined> {
  return page.evaluate(async (title) => {
    const cards = await window.infinitary.cards.list();
    return cards.find((card) => card.title === title)?.offerId;
  }, CHANGE_MARKS_TITLE);
}

/** Wait until the mock's request log stops growing so the next turn is a fresh prompt. */
async function providerQuiet(page: Page, mock: LaunchedApp["mockProvider"]): Promise<void> {
  let last = mock?.requestBodies().length ?? 0;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(150);
    const next = mock?.requestBodies().length ?? 0;
    if (next === last) return;
    last = next;
  }
}

// The whole journey is one test: each revision is compared with what the
// window last showed, so the sections depend on one another by design.
test("a revised card says what is new since the captain last saw it, and marks it", async () => {
  const launched = await launchApp({ withMockProvider: true, scenarios: [changeMarkVersions] });
  const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
  const shot = async (name: string) => {
    if (evidence) await launched.page.screenshot({ path: join(evidence, `${name}.png`) });
  };
  const transcript: string[] = [];
  try {
    const { page, userDataDir, mockProvider } = launched;
    const frame = cardBody(page, CHANGE_MARKS_TITLE);
    const marks = changeMarks(frame);
    const show = async (version: number, text: string) => {
      const input = promptInput(page);
      await input.fill(`${CHANGE_MARKS_PROMPT_MARKER}${version}`);
      await input.press("Enter");
      await expect(frame.getByText(text).or(frame.getByRole("img", { name: text }))).toBeVisible({
        timeout: 30_000,
      });
      await providerQuiet(page, mockProvider);
    };
    // The window reports the version in front of the captain; wait for the record to hold it.
    const recordedSeen = async () => {
      const offer = await shownOffer(page);
      await expect.poll(() => seenOffers(userDataDir).at(-1)).toBe(offer);
    };
    // The window goes behind another one, and comes back.
    const away = () =>
      page.evaluate(() => {
        Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
        window.dispatchEvent(new Event("blur"));
      });
    const back = () =>
      page.evaluate(() => {
        Reflect.deleteProperty(document, "hasFocus");
        window.dispatchEvent(new Event("focus"));
      });

    // Section 1: the first version goes up and is seen. Nothing is revised yet.
    await show(1, "Rewrite the uploader: 200 lines");
    await recordedSeen();
    await expect(revisedLine(page)).toHaveCount(0);
    await expect(marks.bars).toHaveCount(0);
    await shot("change-marks-1-first");

    // Section 2: a small revision. The line counts it, and a bar stands
    // beside each new part - a paragraph, a list item, a table row.
    await show(2, "Await the queue: 40 lines, touches the uploader");
    await expect(revisedLine(page)).toHaveText(revisedPattern({ added: 3, removed: 1 }, CLOCK));
    await expect(marks.parts).toHaveCount(3);
    await expect(marks.bars).toHaveCount(await marks.parts.count());
    transcript.push(`v2: ${await revisedLine(page).textContent()}`);
    await shot("change-marks-2-revised");
    await recordedSeen();

    // The marks stay through a reload: the record, not the window, holds them.
    await page.reload();
    await expect(revisedLine(page)).toHaveText(revisedPattern({ added: 3, removed: 1 }), {
      timeout: 30_000,
    });
    await expect(marks.bars).toHaveCount(3);

    // Section 3: two revisions land while the window is away - a question,
    // then a new drawing. Coming back, both are marked from the version seen.
    await away();
    await show(3, "Which route?");
    await show(4, "Ten runs after the fix, all passed");
    expect(seenOffers(userDataDir).at(-1)).not.toBe(await shownOffer(page));
    await back();
    await recordedSeen();
    await expect(revisedLine(page)).toHaveText(revisedPattern({ added: 2, removed: 1 }));
    await expect(marks.parts).toHaveCount(2);
    for (const part of await marks.parts.all()) {
      expect(await pseudoBox(part, "::before")).toBeNull();
    }
    transcript.push(`v3+v4 while away: ${await revisedLine(page).textContent()}`);
    if (evidence) await marks.parts.last().scrollIntoViewIfNeeded();
    await shot("change-marks-3-accumulated");

    // Section 4: more than half new is a rewrite - the line says so, and
    // nothing is marked.
    await show(5, "Ten runs passed on the Mac and in CI.");
    await expect(revisedLine(page)).toHaveText(
      revisedPattern({ added: 0, removed: 0, rewritten: true }, CLOCK),
    );
    await expect(marks.bars).toHaveCount(0);
    transcript.push(`v5: ${await revisedLine(page).textContent()}`);
    await shot("change-marks-4-rewritten");
    await recordedSeen();

    // Section 5: a playable preview gets the line and no bars: its own
    // script draws it.
    await show(6, "Drag to replay the ten runs.");
    await expect(revisedLine(page)).toHaveText(revisedPattern({ added: 2, removed: 0 }));
    await expect(marks.parts).toHaveCount(0);
    await expect(marks.bars).toHaveCount(0);
    transcript.push(`v6 preview: ${await revisedLine(page).textContent()}`);
    await shot("change-marks-5-preview");
    await recordedSeen();

    // Section 6: a figure that moves. Its script sits inside the figure, so
    // the card is still prose: the new paragraph and the figure are marked
    // like any other parts, and the figure still answers a press.
    await show(7, "Press Next run to replay the ten runs one at a time.");
    await expect(revisedLine(page)).toHaveText(revisedPattern({ added: 2, removed: 2 }));
    const runs = frame.getByRole("figure", {
      name: "Ten runs after the fix, one more on each press",
    });
    if (evidence) await runs.scrollIntoViewIfNeeded();
    await shot("change-marks-6-moving-figure");
    // The scripted frame draws the bars as the srcdoc one does.
    await expect(marks.bars).toHaveCount(await marks.parts.count());
    await expect(runs.getByText("10 of 10 passed")).toBeVisible();
    await runs.getByRole("button", { name: "Next run" }).dispatchEvent("click");
    await expect(runs.getByText("1 of 10 passed")).toBeVisible();
    await expect(marks.bars).toHaveCount(2);
    transcript.push(`v7 moving figure: ${await revisedLine(page).textContent()}`);
    await shot("change-marks-7-moving-figure-pressed");

    if (evidence) {
      await writeFile(
        join(evidence, "change-marks-journey.txt"),
        `${transcript.join("\n")}\nseen offers recorded: ${seenOffers(userDataDir).length}\n`,
      );
    }
  } finally {
    await launched.close();
  }
});

// Revision navigation is separate from the last-seen bars above: every
// row carries the list for its own write, and navigates only the current card.
test("each revision keeps its own links and reveals folded current content without changing a draft", async () => {
  const { seedRevisionCard, revisionRows, revisionLinks, revisionFrame, cardScroller } =
    await import("./revisions");
  const fixture = seedRevisionCard();
  const app = await launchApp({
    withMockProvider: true,
    scenarios: [changeMarkVersions],
    userDataDir: fixture.userDataDir,
  });
  try {
    const { page } = app;
    const links = revisionLinks(page),
      frame = revisionFrame(page);
    await expect(revisionRows(page)).toHaveCount(2);
    await expect(links).toHaveCount(2);
    const draft = frame.getByRole("textbox", { name: "Review note" });
    await draft.fill("My unsent review");
    await cardScroller(page).evaluate((el) => (el.scrollTop = 0));
    const thread = page.locator("[data-thread-messages]");
    const threadTop = await thread.evaluate((el) => el.scrollTop);
    const messages = await page.evaluate((id) => window.infinitary.cards.thread(id), fixture.id);
    await links.first().click();
    await expect(frame.getByText("Use your connected account.", { exact: true })).toBeInViewport();
    await expect(draft).toHaveValue("My unsent review");
    await focusOn(links.last());
    await links.last().press("Enter");
    await expect(frame.locator("[data-check-result]")).toBeInViewport();
    await expect(frame.locator("[data-checks]")).toHaveAttribute("open", "");
    await expect(frame.locator("[data-unrelated]")).not.toHaveAttribute("open", "");
    await frame.locator("[data-check-result]").press("Escape");
    await expect(links.last()).toBeFocused();
    expect(await thread.evaluate((el) => el.scrollTop)).toBe(threadTop);
    await expect(draft).toHaveValue("My unsent review");
    expect(
      (await page.evaluate((id) => window.infinitary.cards.thread(id), fixture.id)).messages,
    ).toHaveLength(messages.messages.length);
    await page.reload();
    await (await import("./windowKeys")).untilWindowCommands(page);
    await expect(cardBodyElement(page, "Review the project checks")).toHaveAttribute(
      "data-frame-drawn",
      "",
    );
    await expect(revisionRows(page)).toHaveCount(2);
    await links.last().click();
    await expect(frame.locator("[data-check-result]")).toBeInViewport();
    // A newer navigation supersedes the earlier one, not its area's availability.
    await links.evaluateAll((nodes) => {
      (nodes[0] as HTMLElement).click();
      (nodes[1] as HTMLElement).click();
    });
    await expect(frame.locator("[data-check-result]")).toBeInViewport();
    await expect(revisionRows(page).getByRole("status")).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await cardScroller(page).evaluate((el) => {
      el.scrollTop = 0;
    });
    expect(
      await cardScroller(page).evaluate((el) =>
        Number.parseFloat(getComputedStyle(el).getPropertyValue("--dur-med")),
      ),
    ).toBe(0);
    await focusOn(links.last());
    await links.last().press("Enter");
    await expect(frame.locator("[data-check-result]")).toBeFocused();
    await expect(frame.locator("[data-check-result]")).toBeInViewport();
    await frame.locator("[data-check-result]").press("Escape");
    await expect(links.last()).toBeFocused();
  } finally {
    await app.close();
  }
});

test("a preview revision returns to its current beginning without running a choice", async () => {
  const { seedRevisionCard, revisionRows, cardScroller, revisionFrame } = await import(
    "./revisions"
  );
  const { untilWindowCommands } = await import("./windowKeys");
  const fixture = seedRevisionCard({ preview: true, simple: true });
  const { app, page } = await launchApp({ userDataDir: fixture.userDataDir });
  try {
    await untilWindowCommands(page);
    await expect(revisionFrame(page).locator("body")).toHaveAttribute("data-preview-ready", "yes");
    await cardScroller(page).evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const link = revisionRows(page).last().locator("[data-revision-link]");
    await focusOn(link);
    await link.press("Enter");
    await expect.poll(() => cardScroller(page).evaluate((el) => el.scrollTop)).toBe(0);
    await cardScroller(page).press("Escape");
    await expect(link).toBeFocused();
    expect(
      (await page.evaluate(() => window.infinitary.cards.list())).some((c) => c.id === fixture.id),
    ).toBe(true);
  } finally {
    await app.close();
  }
});
