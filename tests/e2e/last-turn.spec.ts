import { writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { TaskService } from "../../src/core/tasks/taskService";
import { CONVERSATION_HEADING, PICTURE_ONLY_WORDS } from "../../src/renderer/src/app/lastTurnWords";
import { NOTE_GOT_IT_LABEL } from "../../src/shared/cardLeave";
import * as m from "../../src/shared/i18n/messages.generated";
import { seedReplyReading } from "../helpers/replyReading";
import { scratchDir } from "../helpers/scratchDirs";
import {
  askFirstmate,
  bubbleWords,
  cardRound,
  conversation,
  conversationReplies,
  conversationTile,
  conversationView,
  conversationYou,
  mateBubble,
  olderRound,
  selectFirstLine,
  yourBubble,
} from "./lastTurn";
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
import {
  BACKLOG_ASK,
  BACKLOG_CARD_TITLE,
  BACKLOG_REPLY,
  conversationRounds,
  REMINDER_ASK,
  REMINDER_REPLY,
} from "./scenarios/conversationRounds";
import { FILE_TASK_PROMPT_MARKER, fileTask } from "./scenarios/fileTask";
import {
  lastTurnWords,
  SALUTE_PROMPT_MARKER,
  SLOW_CLOSE_PROMPT_MARKER,
  WORDLESS_CLOSE_PROMPT_MARKER,
} from "./scenarios/lastTurnWords";
import { REPLY_NOTE_MARKER, REPLY_NOTE_WORDS, replyNote } from "./scenarios/replyNote";
import { cardSurface, noteDone, shownCard } from "./stack";
import { setThemeViaSettings } from "./theme";
import { pressKey, runFromSearch } from "./windowKeys";

/**
 * The last turn above the input (docs/composer.md "The last turn"): the
 * captain's message shows at once, the Firstmate's bubble says it is working
 * while its turn runs and turns into its reply as the turn ends - the turn's
 * closing words, or the app's typed line when it closed with none (INF-772) -
 * a new message makes the newest round the older one above it (INF-1771:
 * "allow last two rounds of messages instead of one round, with the older
 * one fading a bit"), a card leaves only the newest round, and both rounds
 * come back after a relaunch. Driven through the real Firstmate session and
 * the mock provider.
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
    // Working while the turn runs with no reply yet; the reply line arrives
    // before busy falls, and the bubble turns into it as it arrives: working
    // never holds a reply back (INF-1771).
    const reply = seen.indexOf("reply");
    expect(reply, said).toBeGreaterThan(0);
    expect(seen.slice(0, reply), said).toContain("mate:working");
    expect(seen.indexOf("busy:false", reply), said).toBeGreaterThan(reply);
    await expect(bubbleWords(mateBubble(page))).toHaveText(MOCK_FM_DONE_TEXT);
    // Once the turn is over, the mark stops spinning (INF-2483).
    await expect(mateBubble(page)).not.toHaveAttribute("data-working");
    await expect(page.locator("[data-last-turn] [data-last-turn-mark][data-working]")).toHaveCount(
      0,
    );
  });

  const second = "How is the alpha coming along?";
  await test.step("a new message makes the round before it the older round, drawn fainter above it", async () => {
    const from = await say(page, second);
    await expect(bubbleWords(yourBubble(page))).toHaveText(second);
    await expect(bubbleWords(yourBubble(page, "older"))).toHaveText(
      `${SALUTE_PROMPT_MARKER}, ${SLOW_CLOSE_PROMPT_MARKER}`,
    );
    await expect(bubbleWords(mateBubble(page, "older"))).toHaveText(MOCK_FM_DONE_TEXT);
    await saw(page, "mate:reply", from);
    await expect(bubbleWords(mateBubble(page))).toHaveText(MOCK_FM_DONE_TEXT);
    // The older round at the strength the captain chose, above the newest.
    await expect(olderRound(page)).toHaveCSS("opacity", "0.5");
    const older = await box(yourBubble(page, "older"));
    expect(older.y + older.height).toBeLessThanOrEqual((await box(yourBubble(page))).y);
  });

  await test.step("both rounds sit above the input, and the input never moved", async () => {
    const inputAfter = await settled(page, () => box(input));
    expect(inputAfter).toEqual(inputBefore);
    for (const bubble of [
      yourBubble(page, "older"),
      mateBubble(page, "older"),
      yourBubble(page),
      mateBubble(page),
    ]) {
      const at = await box(bubble);
      expect(at.y + at.height).toBeLessThanOrEqual(inputAfter.y);
    }
  });

  const wordless = `${ANSWER_PROMPT_MARKER} ${WORDLESS_CLOSE_PROMPT_MARKER}`;
  await test.step("a turn that closed with no words replies with its card's title, and with the card up only the newest round shows", async () => {
    const from = await say(page, wordless);
    await expect(bubbleWords(yourBubble(page))).toHaveText(wordless);
    await saw(page, "mate:reply", from);
    await expect(bubbleWords(mateBubble(page))).toHaveText(MOCK_ANSWER_TITLE);
    await expect(olderRound(page)).toHaveCount(0);
    const card = await settled(page, () => box(cardSurface(page)));
    for (const bubble of [yourBubble(page), mateBubble(page)]) {
      expect(intersects(card, await box(bubble))).toBe(false);
    }
  });

  await test.step("the last two rounds come back after a relaunch", async () => {
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
    const kept = await again.evaluate(() => window.infinitary.conversation.lastTurn());
    expect(kept?.previous).toMatchObject({ you: second, reply: { text: MOCK_FM_DONE_TEXT } });
    // The card is still up, so only the newest round shows; putting it
    // aside brings the older round back. Aside is not a round, where Got it
    // on the card would be (docs/composer.md "Card rounds").
    await expect(olderRound(again)).toHaveCount(0);
    await again.evaluate(async () => {
      for (const card of await window.infinitary.cards.list())
        await window.infinitary.cards.minimize(card.id, true);
    });
    await expect(bubbleWords(yourBubble(again, "older"))).toHaveText(second);
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
// response message here to be clickable", which opened the reply as a note.
// INF-6337's plan, the captain's Approve and build, opens the conversation
// instead: "clicking would open up a full card with something more like a
// chat UX", with the reply as the first mate wrote it beside the captain's
// own words, and the strip hidden while it is shown. Opening it sends nothing.
test("the reply line opens the conversation with the whole reply, by click, Enter, Space and command search, and Esc closes it", async () => {
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

  const shown = conversation(page);
  const newestReply = conversationReplies(page).last();
  const newestYou = conversationYou(page).last();
  const turnsSent = () =>
    page.evaluate(async () => (await window.infinitary.conversation.lastTurn())?.you);

  await test.step("a click opens the conversation at the front, with your words and the reply as written", async () => {
    await mateBubble(page).click();
    await expect(shown).toBeVisible();
    await expect(newestYou).toHaveText(sent);
    await expect(
      page.getByRole("heading", { name: CONVERSATION_HEADING, exact: true }),
    ).toBeVisible();
    await expect(page.locator("[data-last-turn]")).toHaveCount(0);
    expect(await selectFirstLine(newestYou)).not.toBe("");
    expect(await newestReply.textContent()).toBe(REPLY_NOTE_WORDS);
    await expect(newestReply).toBeInViewport();
    await regionShot(cardSurface(page), test.info().outputPath("conversation.png"));
  });

  await test.step("Esc closes it, the strip is back, and nothing was sent", async () => {
    await page.keyboard.press("Escape");
    await expect(shown).toHaveCount(0);
    await expect(mateBubble(page)).toBeVisible();
    expect(await turnsSent()).toBe(sent);
  });

  await test.step("Enter and Space on the focused line open it too", async () => {
    for (const key of ["Enter", " "]) {
      await pressKey(mateBubble(page), key);
      await expect(shown).toBeVisible();
      expect(await newestReply.textContent()).toBe(REPLY_NOTE_WORDS);
      await page.keyboard.press("Escape");
      await expect(shown).toHaveCount(0);
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
    const reopened = conversationReplies(again).last();
    await expect(reopened).toBeVisible();
    expect(await reopened.textContent()).toBe(REPLY_NOTE_WORDS);
    await expect(conversationYou(again).last()).toHaveText(sent);
  });
});

// INF-6337, the captain's words: "a thread that has everything the user
// directly interacted with - their own prompts, first mate's response, cards
// they interacted etc", which "should become a place for people to find
// their recent cards"; the approved plan: "A press opens the card in front,
// and Hide returns to the conversation".
test("the conversation holds a card the captain answered, lists it under Cards, and its tile opens it and returns", async () => {
  launched = await launchApp({ withMockProvider: true, scenarios: [conversationRounds] });
  const { page } = launched;
  await resizeWindow(launched.app, page, { width: 1280, height: 800 });
  await expect(promptInput(page)).toBeEnabled({ timeout: 30_000 });
  await askFirstmate(page, BACKLOG_ASK);
  await expect(shownCard(page, BACKLOG_CARD_TITLE)).toBeVisible({ timeout: 30_000 });
  // A first mate's note offers Got it; its words are the press the conversation keeps.
  const pressed = NOTE_GOT_IT_LABEL;
  await noteDone(page).click();
  await expect(shownCard(page, BACKLOG_CARD_TITLE)).toHaveCount(0);
  await askFirstmate(page, REMINDER_ASK);
  const chose = m.shellConversationChose({ label: pressed });

  await test.step("Everything holds both messages, their replies, and the card with the press", async () => {
    await mateBubble(page).click();
    await expect(conversation(page)).toBeVisible();
    await expect(page.locator("[data-last-turn]")).toHaveCount(0);
    await expect(conversationYou(page)).toHaveText([BACKLOG_ASK, chose, REMINDER_ASK]);
    await expect(conversationReplies(page)).toHaveText([BACKLOG_REPLY, REMINDER_REPLY]);
    await expect(conversationTile(page)).toHaveText([new RegExp(BACKLOG_CARD_TITLE)]);
    await regionShot(cardSurface(page), test.info().outputPath("everything.png"));
    if (process.env.FM_CONVERSATION_HERO === "1") {
      await heroShot(launched.app, page, {
        region: cardSurface(page),
        anchors: [promptInput(page)],
        name: "conversation",
      });
    }
  });

  await test.step("Cards lists it as answered, and its tile opens it and returns to Cards", async () => {
    await conversationView(page, m.shellConversationCards()).click();
    const answered = conversation(page).locator('[data-conversation-section="answered"]');
    await expect(answered.locator("[data-conversation-card]")).toHaveText([
      new RegExp(BACKLOG_CARD_TITLE),
    ]);
    await expect(answered).toContainText(m.shellConversationYouChose({ label: pressed }));
    await regionShot(cardSurface(page), test.info().outputPath("cards.png"));
    await answered.locator("[data-conversation-card]").click();
    await expect(shownCard(page, BACKLOG_CARD_TITLE)).toBeVisible();
    await expect(conversation(page)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(conversation(page)).toHaveAttribute("data-conversation", "cards");
  });
});

// Intent: INF-6337's plan, the captain's Approve and build, part 2: a press of
// a card's button shows above the message box as one row with the card's
// name; the name opens the card, and the rest of the row opens the
// conversation at that round. Fixture: the conversation scenario's note,
// answered with Got it. Failure: no row, a reply line under it, the name not opening
// the past card, or the conversation opening somewhere else.
test("a press of a card's button shows on the strip with the card's name, which opens it by click and Enter, and the row opens the conversation there", async () => {
  launched = await launchApp({ withMockProvider: true, scenarios: [conversationRounds] });
  const { page } = launched;
  await resizeWindow(launched.app, page, { width: 1280, height: 800 });
  await expect(promptInput(page)).toBeEnabled({ timeout: 30_000 });
  await askFirstmate(page, BACKLOG_ASK);
  await expect(shownCard(page, BACKLOG_CARD_TITLE)).toBeVisible({ timeout: 30_000 });
  await noteDone(page).click();
  await expect(shownCard(page, BACKLOG_CARD_TITLE)).toHaveCount(0);

  const row = cardRound(page);
  await test.step("the press is the newest round: the card's name, then Got it outlined, with no reply line", async () => {
    await expect(row).toHaveAttribute("data-card-round", "choice");
    await expect(row.locator("[data-last-turn-card]")).toHaveText(BACKLOG_CARD_TITLE);
    await expect(yourBubble(page)).toHaveText(NOTE_GOT_IT_LABEL);
    await expect(yourBubble(page)).toHaveAttribute("data-choice", "");
    await expect(mateBubble(page)).toHaveCount(0);
    // The message it answered is the older round above it, at half strength.
    await expect(bubbleWords(yourBubble(page, "older"))).toHaveText(BACKLOG_ASK);
  });

  await test.step("the card's name opens the card it answered, as a past card", async () => {
    await row.locator("[data-last-turn-card]").click();
    await expect(shownCard(page, BACKLOG_CARD_TITLE)).toBeVisible();
    await expect(conversation(page)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(shownCard(page, BACKLOG_CARD_TITLE)).toHaveCount(0);
  });

  await test.step("Enter on the focused card name opens it too", async () => {
    await pressKey(row.locator("[data-last-turn-card]"), "Enter");
    await expect(shownCard(page, BACKLOG_CARD_TITLE)).toBeVisible();
    await expect(conversation(page)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(shownCard(page, BACKLOG_CARD_TITLE)).toHaveCount(0);
  });

  await test.step("the rest of the row opens the conversation at that round", async () => {
    await yourBubble(page).click();
    await expect(conversation(page)).toBeVisible();
    const landed = conversation(page).locator("[data-conversation-round][data-landed]");
    await expect(landed).toHaveAttribute("data-kind", "choice");
    await expect(landed.locator("[data-conversation-card]")).toHaveText(
      new RegExp(BACKLOG_CARD_TITLE),
    );
    await expect(landed).toBeInViewport();
  });
});

// Intent: INF-2218's accepted plan keeps saved words and picture-only and
// problem replies; INF-6337's plan, the captain's Approve and build, draws
// the captain's words whole in the conversation, so a long question no
// longer folds, and the older round's line opens the conversation there.
// Fixture: the captain's actual long request and existing screenshot reply,
// saved by TaskService beside a picture-only failed round. Completion is the
// drawn words, selected literal reply text and unchanged saved rounds.
// Hidden desktop and private data only; no account or device prerequisite.
for (const theme of ["dark", "light"] as const) {
  test(`the conversation keeps picture problems and shows a long question whole in ${theme}`, async () => {
    const userDataDir = scratchDir("infinitary-reply-reading-");
    const db = openDatabase(userDataDir);
    const fixture = seedReplyReading(new TaskService({ db, strict: true }));
    db.close();
    launched = await launchApp({ userDataDir, withMockProvider: true });
    const { page } = launched;
    await setThemeViaSettings(page, theme);
    await resizeWindow(launched.app, page, await minimumWindowSize(launched.app));
    const saved = await page.evaluate(() => window.infinitary.conversation.lastTurn());
    expect(saved?.reply?.text).toBe(fixture.problemWords);
    await mateBubble(page).click();
    const yours = conversationYou(page);
    const replies = conversationReplies(page);
    await expect(yours).toHaveCount(2);
    await expect(yours.last()).toHaveText(PICTURE_ONLY_WORDS);
    await expect(replies.last()).toHaveText(saved?.reply?.text ?? "");
    const colors = await replies.last().evaluate((element) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--danger)";
      element.append(probe);
      const result = {
        actual: getComputedStyle(element).color,
        expected: getComputedStyle(probe).color,
      };
      probe.remove();
      return result;
    });
    expect(colors.actual).toBe(colors.expected);
    await page.keyboard.press("Escape");
    await expect(conversation(page)).toHaveCount(0);
    await mateBubble(page, "older").click();
    await expect(yours.first()).toBeInViewport();
    await expect(yours.first()).toHaveText(saved?.previous?.you ?? "");
    expect(await replies.first().textContent()).toBe(saved?.previous?.reply?.words);
    await expect(replies.first().locator("li")).toHaveCount(0);
    expect(await selectFirstLine(replies.first())).not.toBe("");
    expect(await selectFirstLine(yours.first())).not.toBe("");
    await page.keyboard.press("Escape");
    await expect(conversation(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.infinitary.conversation.lastTurn())).toEqual(saved);
  });
}
