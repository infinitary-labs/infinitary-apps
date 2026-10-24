import { writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { quoted } from "../../src/renderer/src/app/lastTurnWords";
import { askFirstmate, bubbleWords, mateBubble, yourBubble } from "./lastTurn";
import { type LaunchedApp, launchApp } from "./launch";
import { intersects, minimumWindowSize, resizeWindow, settled } from "./layout";
import {
  ANSWER_PROMPT_MARKER,
  MOCK_ANSWER_TITLE,
  MOCK_FM_DONE_TEXT,
  SPAWN_PROMPT_MARKER,
  TALL_ANSWER_PROMPT_MARKER,
} from "./mockProvider";
import { heroShot, regionShot } from "./pictures";
import { promptInput } from "./prompt";
import { FILE_TASK_PROMPT_MARKER, fileTask } from "./scenarios/fileTask";
import {
  lastTurnWords,
  SALUTE_PROMPT_MARKER,
  SLOW_CLOSE_PROMPT_MARKER,
  WORDLESS_CLOSE_PROMPT_MARKER,
} from "./scenarios/lastTurnWords";
import { REPLY_NOTE_MARKER, REPLY_NOTE_WORDS, replyNote } from "./scenarios/replyNote";
import { cardSurface, SHOWN_ENTRY } from "./stack";
import { pressKey, runFromSearch } from "./windowKeys";

/**
 * The last turn above the input (docs/composer.md "The last turn"): the
 * captain's message shows at once, the Firstmate's bubble says it is working
 * while its turn runs and turns into its reply as the turn ends - the turn's
 * closing words, or the app's typed line when it closed with none (INF-772) -
 * a new message replaces the pair, and the pair comes back after a relaunch.
 * Driven through the real Firstmate session and the mock provider.
 *
 * Every timing claim is an ORDER on the page's own log, never a window: the
 * page records the Firstmate's busy signal and reply line as the shell hears
 * them, and every state the Firstmate's bubble takes as the DOM shows it.
 */

declare global {
  interface Window {
    __fmTurnLog?: string[];
  }
}

let launched: LaunchedApp;

test.afterEach(async () => {
  await launched?.close();
});

/**
 * One entry per thing the page saw, in order: `busy:<true|false>` and
 * `reply` from the Firstmate's own events, `mate:<state>` each time the
 * Firstmate's bubble in the pair that stays appears or changes state, and
 * `state:<name>` when the character's canvas changes state.
 */
async function recordOnPage(page: Page): Promise<void> {
  await page.evaluate(() => {
    const log: string[] = [];
    window.__fmTurnLog = log;
    window.infinitary.events.on((event) => {
      if (event.type === "firstmate_state") log.push(`busy:${event.busy}`);
      if (event.type === "firstmate_reply") log.push("reply");
      if (event.type === "firstmate_emote" && !event.automatic) log.push("emote");
    });
    const isMate = (node: Element) =>
      node.getAttribute("data-last-turn-bubble") === "firstmate" &&
      node.closest("[data-leaving]") === null;
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") {
          if (record.target instanceof HTMLElement && isMate(record.target)) {
            log.push(`mate:${record.target.dataset.state}`);
          }
          if (record.attributeName === "aria-label" && record.target instanceof HTMLCanvasElement) {
            const name = record.target.getAttribute("aria-label") ?? "";
            if (name.startsWith("First mate - ")) {
              log.push(`state:${name.slice("First mate - ".length)}`);
            }
          }
          continue;
        }
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          const bubbles = [node, ...node.querySelectorAll("[data-last-turn-bubble]")];
          for (const bubble of bubbles) {
            if (bubble instanceof HTMLElement && isMate(bubble)) {
              log.push(`mate:${bubble.dataset.state}`);
            }
          }
        }
      }
    }).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-state", "aria-label"],
    });
  });
}

const log = (page: Page) => page.evaluate(() => [...(window.__fmTurnLog ?? [])]);

/** Wait until the log since `from` holds `entry`, and return the log since `from`. */
async function saw(page: Page, entry: string, from: number): Promise<string[]> {
  await expect
    .poll(
      async () => {
        const since = (await log(page)).slice(from);
        return since.includes(entry) ? "seen" : since.join(" > ");
      },
      { timeout: 30_000 },
    )
    .toBe("seen");
  return (await log(page)).slice(from);
}

async function say(page: Page, text: string): Promise<number> {
  const from = (await log(page)).length;
  const input = promptInput(page);
  await expect(input).toBeEnabled({ timeout: 30_000 });
  await input.click();
  await input.fill(text);
  await input.press("Enter");
  return from;
}

const box = async (target: ReturnType<typeof promptInput>) => {
  const measured = await target.boundingBox();
  if (!measured) throw new Error("not on screen");
  return measured;
};

test("a turn shows your message, the Firstmate working, then its reply, and comes back after a relaunch", async () => {
  launched = await launchApp({ withMockProvider: true, scenarios: [lastTurnWords, fileTask] });
  const { page } = launched;
  await recordOnPage(page);
  const input = promptInput(page);
  await expect(input).toBeEnabled({ timeout: 30_000 });
  const inputBefore = await box(input);

  await test.step("your message shows at once, and the Firstmate's bubble works, then replies in its closing words", async () => {
    const sent = `${SALUTE_PROMPT_MARKER}, ${SLOW_CLOSE_PROMPT_MARKER}`;
    const from = await say(page, sent);
    await expect(bubbleWords(yourBubble(page))).toHaveText(sent);
    const seen = await saw(page, "mate:reply", from);
    const said = seen.join(" > ");
    // Working while the turn runs; the reply line arrives before busy
    // falls, and the bubble turns into it after.
    const reply = seen.indexOf("reply");
    expect(reply, said).toBeGreaterThan(0);
    expect(seen.slice(0, reply), said).toContain("mate:working");
    const fall = seen.indexOf("busy:false", reply);
    expect(fall, said).toBeGreaterThan(reply);
    expect(seen.indexOf("mate:reply", fall), said).toBeGreaterThan(fall);
    await expect(bubbleWords(mateBubble(page))).toHaveText(MOCK_FM_DONE_TEXT);
  });

  await test.step("the pair sits above the input, and the input never moved", async () => {
    const inputAfter = await settled(page, () => box(input));
    expect(inputAfter).toEqual(inputBefore);
    for (const bubble of [yourBubble(page), mateBubble(page)]) {
      const at = await box(bubble);
      expect(at.y + at.height).toBeLessThanOrEqual(inputAfter.y);
    }
  });

  const wordless = `${ANSWER_PROMPT_MARKER} ${WORDLESS_CLOSE_PROMPT_MARKER}`;
  await test.step("a new message replaces the pair, and a turn that closed with no words replies with its card's title", async () => {
    const from = await say(page, wordless);
    await expect(bubbleWords(yourBubble(page))).toHaveText(wordless);
    await saw(page, "mate:reply", from);
    await expect(bubbleWords(mateBubble(page))).toHaveText(MOCK_ANSWER_TITLE);
    // The card on the stage keeps clear of the pair.
    const card = await settled(page, () => box(cardSurface(page)));
    for (const bubble of [yourBubble(page), mateBubble(page)]) {
      expect(intersects(card, await box(bubble))).toBe(false);
    }
  });

  await test.step("the last turn comes back after a relaunch", async () => {
    const { userDataDir, homeDir } = launched;
    await launched.close();
    launched = await launchApp({
      withMockProvider: true,
      scenarios: [lastTurnWords, fileTask],
      userDataDir,
      homeDir,
    });
    const again = launched.page;
    await expect(bubbleWords(yourBubble(again))).toHaveText(wordless);
    await expect(mateBubble(again)).toHaveAttribute("data-state", "reply");
    await expect(bubbleWords(mateBubble(again))).toHaveText(MOCK_ANSWER_TITLE);
  });
});

/** Native preference notification, then the still repaint it schedules: no sleep. */
async function settleReducedMotion(page: Page): Promise<void> {
  const from = (await log(page)).length;
  await page.evaluate(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const afterPaint = () => {
      // Two drawing frames put this witness after the motion loop's static
      // frame, whichever media listener ran first.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => window.__fmTurnLog?.push("motion:painted")),
      );
    };
    if (query.matches) afterPaint();
    else query.addEventListener("change", afterPaint, { once: true });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await saw(page, "motion:painted", from);
}

test("under reduced motion a turn still shows working, then the reply, while the character stands still", async () => {
  launched = await launchApp({ withMockProvider: true, scenarios: [lastTurnWords, fileTask] });
  const { page } = launched;
  await recordOnPage(page);
  await settleReducedMotion(page);
  const from = await say(page, `${SALUTE_PROMPT_MARKER}, ${SLOW_CLOSE_PROMPT_MARKER}`);
  const seen = await saw(page, "mate:reply", from);
  expect(seen, seen.join(" > ")).toContain("mate:working");
  await expect(bubbleWords(mateBubble(page))).toHaveText(MOCK_FM_DONE_TEXT);
  // The character never left its still frame: no state change from before
  // the captain typed until the reply was in place.
  expect(
    seen.filter((entry) => entry.startsWith("state:")),
    seen.join(" > "),
  ).toEqual([]);
});

test("a message sent mid-turn receives its own card answer, not the running turn's earlier emote", async () => {
  launched = await launchApp({ withMockProvider: true, scenarios: [lastTurnWords, fileTask] });
  const { page } = launched;
  await resizeWindow(launched.app, page, { width: 960, height: 640 });
  await recordOnPage(page);
  const from = await say(page, `${SALUTE_PROMPT_MARKER}, ${SLOW_CLOSE_PROMPT_MARKER}`);
  await saw(page, "emote", from);
  // The first reply happened, but its model request is still running. The
  // new message closes with no words, so its line is its own card's title.
  const later = `${ANSWER_PROMPT_MARKER} ${WORDLESS_CLOSE_PROMPT_MARKER}`;
  const sent = await say(page, later);
  await saw(page, "mate:reply", sent);
  await expect(bubbleWords(yourBubble(page))).toHaveText(later);
  await expect(bubbleWords(mateBubble(page))).toHaveText(MOCK_ANSWER_TITLE);
  const kept = await page.evaluate(() => window.infinitary.conversation.lastTurn());
  writeFileSync(test.info().outputPath("mid-turn-state.json"), JSON.stringify(kept, null, 2));
  expect(kept).toMatchObject({
    you: later,
    reply: { text: MOCK_ANSWER_TITLE },
  });
  await regionShot(page.locator("[data-last-turn]"), test.info().outputPath("mid-turn.png"));
  await page.screenshot({ path: test.info().outputPath("mid-turn-window.png") });
  if (process.env.FM_REPLY_HERO === "1") {
    await heroShot(launched.app, page, {
      region: page.locator("[data-last-turn]"),
      anchors: [promptInput(page)],
      name: "read-message-reply",
    });
  }
});

test("both lines remain in sight with a tallest card at the smallest window", async () => {
  launched = await launchApp({ withMockProvider: true, scenarios: [lastTurnWords, fileTask] });
  const { page } = launched;
  await resizeWindow(launched.app, page, await minimumWindowSize(launched.app));
  await recordOnPage(page);
  const from = await say(page, TALL_ANSWER_PROMPT_MARKER);
  await saw(page, "mate:reply", from);
  const card = await settled(page, () => box(cardSurface(page)));
  for (const bubble of [yourBubble(page), mateBubble(page)]) {
    const at = await box(bubble);
    expect(intersects(card, at)).toBe(false);
    expect(
      await bubble.evaluate((element) => {
        const at = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(at.x + at.width / 2, at.y + at.height / 2),
        );
      }),
    ).toBe(true);
  }
  await page.screenshot({ path: test.info().outputPath("tall-card-window.png") });
  await regionShot(
    page.locator("[data-last-turn]"),
    test.info().outputPath("tall-card-bubbles.png"),
  );
});

test("starting work with no closing words replies with what happened rather than echoing the task", async () => {
  launched = await launchApp({ withMockProvider: true, scenarios: [lastTurnWords, fileTask] });
  const { page } = launched;
  await resizeWindow(launched.app, page, { width: 1280, height: 800 });
  const title = "Promote alpha 0.1.31-alpha.46 to the stable release";
  await expect(promptInput(page)).toBeEnabled({ timeout: 30_000 });
  await askFirstmate(page, `${WORDLESS_CLOSE_PROMPT_MARKER}, ${SPAWN_PROMPT_MARKER} ${title}`);
  const turn = await page.evaluate(() => window.infinitary.conversation.lastTurn());
  await expect(bubbleWords(mateBubble(page))).toHaveText(turn?.reply?.text ?? "");
  await regionShot(page.locator("[data-last-turn]"), test.info().outputPath("started-reply.png"));
  writeFileSync(test.info().outputPath("started-reply.json"), JSON.stringify(turn, null, 2));
  const task = await page.evaluate(async (title) => {
    const board = await window.infinitary.tasks.board();
    return board.tasks.find((row) => row.title === title);
  }, title);
  expect(task?.title).toBe(title);
  // A title names work to do; the reply must say what happened to it.
  expect(turn?.reply?.text).not.toBe(title);
});

test("filing work with no closing words replies with the filed task instead of a generic acknowledgment", async () => {
  launched = await launchApp({ withMockProvider: true, scenarios: [lastTurnWords, fileTask] });
  const { page } = launched;
  await resizeWindow(launched.app, page, { width: 1280, height: 800 });
  const title = "Build personal panels in isolation, swap in when ready";
  await expect(promptInput(page)).toBeEnabled({ timeout: 30_000 });
  await askFirstmate(page, `${WORDLESS_CLOSE_PROMPT_MARKER}, ${FILE_TASK_PROMPT_MARKER} ${title}`);
  const turn = await page.evaluate(() => window.infinitary.conversation.lastTurn());
  const task = await page.evaluate(
    async (title) =>
      (await window.infinitary.tasks.board()).tasks.find((row) => row.title === title),
    title,
  );
  expect(task?.title).toBe(title);
  await expect(bubbleWords(mateBubble(page))).toHaveText(turn?.reply?.text ?? "");
  await regionShot(page.locator("[data-last-turn]"), test.info().outputPath("filed-reply.png"));
  writeFileSync(
    test.info().outputPath("filed-reply.json"),
    JSON.stringify({ turn, task }, null, 2),
  );
  // Filing should identify the task a captain can refer to next, not merely acknowledge the ask.
  expect(turn?.reply?.text).toContain(task?.key);
  if (process.env.FM_ACTION_REPLY_HERO === "1") {
    await heroShot(launched.app, page, {
      region: page.locator("[data-last-turn]"),
      anchors: [promptInput(page)],
      name: "action-reply-line",
    });
  }
});

// INF-1103, the captain's words on INF-1102: "we should allow the first mate
// response message here to be clickable, and clicking opens up a card that
// shows the message as a note", built as the plan's approved answers: a
// reading card the window holds, the words as the first mate wrote them,
// and the captain's message in quotation marks as its title.
test("the reply line opens the whole reply as a note, by click, Enter, Space and command search, and Esc closes it", async () => {
  launched = await launchApp({ withMockProvider: true, scenarios: [replyNote, fileTask] });
  const { page } = launched;
  await resizeWindow(launched.app, page, { width: 1280, height: 800 });
  await expect(promptInput(page)).toBeEnabled({ timeout: 30_000 });
  const sent = `Can the Mac mini run our Linux checks, ${REPLY_NOTE_MARKER}`;
  await askFirstmate(page, sent);
  const kept = await page.evaluate(() => window.infinitary.conversation.lastTurn());
  // The line is one line; the words as written are kept beside it.
  expect(kept?.reply?.words).toBe(REPLY_NOTE_WORDS);
  expect(kept?.reply?.text).not.toContain("\n");
  await expect(bubbleWords(mateBubble(page))).toHaveText(kept?.reply?.text ?? "");

  const note = page.locator(`${SHOWN_ENTRY} [data-reply-note]`);
  const title = page.locator(`${SHOWN_ENTRY} [data-card-title]`);
  const noteWords = () => note.evaluate((body) => body.textContent);
  const turnsSent = () =>
    page.evaluate(async () => (await window.infinitary.conversation.lastTurn())?.you);

  await test.step("a click opens the note at the front, with your message as its title and the words as written", async () => {
    await mateBubble(page).click();
    await expect(note).toBeVisible();
    await expect(title).toHaveText(quoted(sent));
    expect(await noteWords()).toBe(REPLY_NOTE_WORDS);
    await regionShot(cardSurface(page), test.info().outputPath("reply-note.png"));
    if (process.env.FM_REPLY_NOTE_HERO === "1") {
      await heroShot(launched.app, page, {
        region: cardSurface(page),
        anchors: [mateBubble(page)],
        name: "reply-note",
      });
    }
  });

  await test.step("Esc closes it, and nothing was sent", async () => {
    await page.keyboard.press("Escape");
    await expect(note).toHaveCount(0);
    expect(await turnsSent()).toBe(sent);
  });

  await test.step("Enter and Space on the focused line open it too", async () => {
    for (const key of ["Enter", " "]) {
      await pressKey(mateBubble(page), key);
      await expect(note).toBeVisible();
      expect(await noteWords()).toBe(REPLY_NOTE_WORDS);
      await page.keyboard.press("Escape");
      await expect(note).toHaveCount(0);
    }
  });

  await test.step("after a relaunch, command search opens the same words", async () => {
    const { userDataDir, homeDir } = launched;
    await launched.close();
    launched = await launchApp({
      scenarios: [fileTask],
      withMockProvider: true,
      userDataDir,
      homeDir,
    });
    const again = launched.page;
    await expect(mateBubble(again)).toHaveAttribute("data-state", "reply");
    await runFromSearch(launched.app, again, "firstmate.reply");
    const reopened = again.locator(`${SHOWN_ENTRY} [data-reply-note]`);
    await expect(reopened).toBeVisible();
    expect(await reopened.evaluate((body) => body.textContent)).toBe(REPLY_NOTE_WORDS);
    await expect(again.locator(`${SHOWN_ENTRY} [data-card-title]`)).toHaveText(quoted(sent));
  });
});
