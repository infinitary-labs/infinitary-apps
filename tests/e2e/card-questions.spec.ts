import { readFileSync } from "node:fs";
import { expect, type FrameLocator, type Page, test } from "@playwright/test";
import { CAPTAIN_WORDS } from "../../src/core/orchestrator/captainWakes";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { answersLine as answersWords } from "../../src/renderer/src/cards/answersLine";
import { cardAnswerLines, REPLY_SETTINGS_HEAD } from "../../src/shared/cardAnswerLines";
import { ANSWER_DONE_LABEL, NOTE_GOT_IT_LABEL } from "../../src/shared/cardLeave";
import {
  ANYTHING_ELSE_ANSWER,
  CARD_CHAT_LABEL,
  CARD_FILES_FIRST,
  CARD_REPLY_HINT,
  type Card,
  type CardAnswer,
  PAST_CARD_WORDS_LEAD,
} from "../../src/shared/cards";
import * as m from "../../src/shared/i18n/messages.generated";
import { AS_BUILT_WORDS, DEFAULT_WORDS } from "../../src/shared/plugins/bridge";
import { scratchDir } from "../helpers/scratchDirs";
import { bodyIn, cardBody, cardBodyElement } from "./frames";
import { seedRepo } from "./githubStub";
import { launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { pastePictures } from "./prompt";
import {
  cardQuestions,
  UNPICKED_DEFAULT_LABEL,
  UNPICKED_PROMPT_MARKER,
  UNPICKED_REFUSAL,
  UNPICKED_TITLE,
  WRITE_IN_DEFAULT_LABEL,
  WRITE_IN_PROMPT_MARKER,
  WRITE_IN_REFUSAL,
  WRITE_IN_TITLE,
  writeInQuestionsBody,
} from "./scenarios/cardQuestions";
import {
  EMIT_CARDS_PROMPT_MARKER,
  everyCardKind,
  MOCK_QUOTA_NOTE_TITLE,
} from "./scenarios/everyCardKind";
import {
  INLINE_QUESTIONS_LOCK_LABEL,
  INLINE_QUESTIONS_PROMPT_MARKER,
  INLINE_QUESTIONS_REVISE_REPLY,
  INLINE_QUESTIONS_REVISED_TITLE,
  INLINE_QUESTIONS_TITLE,
  inlineQuestions,
} from "./scenarios/inlineQuestions";
import {
  cardAnswersLine as answersLine,
  cardLeave,
  cardReply,
  closeQuestion,
  expectNoCard,
  noteDone,
  putAwayAndRestore,
  showCard,
  shownCard,
  shownEntry,
} from "./stack";
import {
  focusOn,
  pressKey,
  pressWindowKey,
  runFromSearch,
  typeInto,
  untilFocused,
} from "./windowKeys";

/**
 * Inline decisions (contract 4.22; the captain's Q1 B to Q4 A of
 * 2026-09-28, `fm3000-card-decisions-width-s1`). A card asks several
 * questions in its body with ordinary named form controls; a pick inside the
 * card sends nothing, the footer counts the picks, and the footer button the
 * captain clicks is the one send, carrying every named field to the author
 * in words.
 *
 * Through the real path: a real crewmate session on the mock provider, the
 * real bridge in the card's frame, the real chrome and the real core. Picks
 * are made inside the frame by dispatching the click there, since Chromium
 * drops native clicks into a hidden window's sandboxed frames.
 */

/** Clicks a control inside the card's frame, where the captain would. */
async function pick(frame: FrameLocator, selector: string) {
  await frame.locator(selector).evaluate((control: HTMLInputElement) => control.click());
}

/** Types into a field inside the card's frame, as an input event. */
async function type(frame: FrameLocator, selector: string, text: string) {
  await frame.locator(selector).evaluate((field: HTMLTextAreaElement, value) => {
    field.value = value;
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }, text);
}

/**
 * The footer's answers line for these counts: picks on a card, answers on a
 * preview. A card names the required questions still to answer, and the
 * skippable questions left untouched whose Default a click sends (INF-4425).
 */
const pickedLine = (
  answered: number,
  of: number,
  changed = 0,
  left: { unanswered?: number; defaults?: number } = {},
) => answersWords({ answered, of, changed, ...left }, false);
const answeredLine = (answered: number, of: number, changed = 0) =>
  answersWords({ answered, of, changed }, true);

/** A footer choice on a crewmate's card, as its author reads it (`CAPTAIN_WORDS`). */
const choiceWords = (
  title: string,
  choice: { id: string; label: string },
  answers?: CardAnswer[],
): string =>
  CAPTAIN_WORDS["card-choice"](
    {
      kind: "card-choice",
      to: "crewmate",
      card: { title },
      source: "chrome",
      choice: { ...choice, ...(answers ? { answers } : {}) },
    },
    {},
  );

/** The answers a footer click carried, as the card's author reads them under its choice. */
function answersWordsBlock(answers: CardAnswer[]): string {
  const wake = choiceWords("", { id: "", label: "" }, answers);
  const at = wake.indexOf("\n");
  if (at < 0) throw new Error("A choice's wake no longer carries its answers on their own lines");
  return wake.slice(at + 1);
}

/** How an answer line says the captain kept what the card proposed (`cardAnswerLines`). */
function asProposedWords(): string {
  const words = cardAnswerLines([{ name: "kept", values: [], changed: false }])[0]
    ?.split(", ")
    .at(-1);
  if (!words) throw new Error("An answer line no longer says whether it was proposed");
  return words;
}

/**
 * A skipped question's answer as the bridge sends it (INF-4425): the Default
 * it sent, as the card proposed it, marked skipped.
 */
const skippedAnswer = (name: string, value: string, label: string): CardAnswer => ({
  name,
  values: [value],
  labels: [label],
  changed: false,
  skipped: true,
});

/** The write-in card's skippable account question, skipped: Work account its Default. */
const ACCOUNT_SKIPPED = skippedAnswer("account", "work", "Work account");

/** How the author reads a question skipped: the Default it sent. */
function skippedLine(answer: CardAnswer): string {
  const line = cardAnswerLines([answer])[0];
  if (!line) throw new Error("A skipped question no longer reads as a line");
  return line;
}

/** The question the mock's write-in card opts out of Something else, as its legend reads. */
const OPTIONS_ONLY_QUESTION = (() => {
  const legend = /<fieldset data-inf-options-only><legend>([^<]+)<\/legend>/.exec(
    writeInQuestionsBody(true),
  )?.[1];
  if (!legend) throw new Error("The mock's write-in card has no options-only question");
  return legend;
})();

test("picks inside a card queue until a footer button sends them, and survive a revision by name", async () => {
  const launched = await launchApp({
    withMockProvider: true,
    scenarios: [cardQuestions, inlineQuestions],
  });
  const { page } = launched;
  try {
    const prompt = page.getByRole("textbox", { name: "Task prompt" });
    await prompt.fill(`${SPAWN_PROMPT_MARKER} ${INLINE_QUESTIONS_PROMPT_MARKER}`);
    await prompt.press("Enter");
    await expect(shownCard(page, INLINE_QUESTIONS_TITLE)).toBeVisible({ timeout: 30_000 });
    const card = await page.evaluate(
      async (title) =>
        (await window.infinitary.cards.list()).find((entry) => entry.title === title),
      INLINE_QUESTIONS_TITLE,
    );
    const taskId = card?.taskId as string;
    const steers = async () =>
      (await page.evaluate((id) => window.infinitary.tasks.detail(id), taskId)).events.filter(
        (event) => event.kind === "steered",
      );
    const steersBefore = (await steers()).length;

    // The proposals are picked; the required question has none, so the
    // default closing choice waits and the other one does not.
    const lock = page.getByRole("button", { name: INLINE_QUESTIONS_LOCK_LABEL, exact: true });
    await expect(answersLine(page)).toHaveText(pickedLine(1, 3, 0, { unanswered: 1 }));
    await expect(lock).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("button", { name: "Not now", exact: true })).toBeEnabled();

    const frame = cardBody(page, INLINE_QUESTIONS_TITLE);
    await pick(frame, 'input[name="read-scope"][value="all-visible"]');
    await type(frame, 'textarea[name="notes"]', "Keep it short");
    await expect(answersLine(page)).toHaveText(pickedLine(2, 3, 2, { unanswered: 1 }));
    await page.screenshot({ path: test.info().outputPath("card-questions-queued.png") });

    // A reply asks for the revision (contract 4.65: no button keeps a card
    // open). It carries what is picked and names what is not; the card
    // revises under its id.
    const reply = cardReply(page).field;
    await reply.click();
    await reply.fill(INLINE_QUESTIONS_REVISE_REPLY);
    await cardReply(page).send.click();
    await expect(shownCard(page, INLINE_QUESTIONS_REVISED_TITLE)).toBeVisible({
      timeout: 30_000,
    });
    const replied = (await steers()).slice(steersBefore);
    expect(replied).toHaveLength(1);
    expect(replied[0]?.text).toContain(INLINE_QUESTIONS_REVISE_REPLY);
    expect(replied[0]?.text).toContain(
      [
        REPLY_SETTINGS_HEAD,
        ...cardAnswerLines([
          {
            name: "read-scope",
            values: ["all-visible"],
            labels: ["Every project your sign-in can see"],
            changed: true,
          },
          { name: "writes", values: [], changed: false },
          { name: "notes", values: ["Keep it short"], changed: true },
        ]),
      ].join("\n"),
    );

    // The revision kept `read-scope` and `notes` and renamed the required
    // question: the captain's picks come back by name, the renamed one fresh.
    const revised = cardBody(page, INLINE_QUESTIONS_REVISED_TITLE);
    await expect(revised.locator('input[name="read-scope"][value="all-visible"]')).toBeChecked();
    await expect(revised.locator('textarea[name="notes"]')).toHaveValue("Keep it short");
    await expect(revised.locator('input[name="write-scope"]:checked')).toHaveCount(0);
    await expect(answersLine(page)).toHaveText(pickedLine(2, 3, 2, { unanswered: 1 }));
    await expect(lock).toHaveAttribute("aria-disabled", "true");
    // Those picks went out with the reply, and its thread keeps them: a
    // close would lose none of them.
    const sentWithReply = (
      await page.evaluate((id) => window.infinitary.cards.thread(id), card?.id as string)
    ).messages.find((message) => message.who === "captain")?.answers;
    expect(sentWithReply).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "read-scope", values: ["all-visible"] }),
        expect.objectContaining({ name: "notes", values: ["Keep it short"] }),
      ]),
    );

    // A pick made after the reply is not sent yet.
    await pick(revised, 'input[name="write-scope"][value="shipping"]');
    await expect(answersLine(page)).toHaveText(pickedLine(3, 3, 3));
    await expect(lock).toBeEnabled();

    // INF-1879: putting away retains the latest unsent pick and sends no choice.
    await putAwayAndRestore(page, INLINE_QUESTIONS_REVISED_TITLE);
    await expect(revised.locator('input[name="write-scope"][value="shipping"]')).toBeChecked();

    // Nothing the picks did reached the author: one steer so far, the
    // reply's.
    expect((await steers()).slice(steersBefore)).toHaveLength(1);

    await lock.click();
    await expectNoCard(page, INLINE_QUESTIONS_REVISED_TITLE);
    await expect.poll(async () => (await steers()).slice(steersBefore).length).toBe(2);
    const chosen = (await steers()).at(-1)?.text ?? "";
    expect(chosen).toContain(
      choiceWords(
        INLINE_QUESTIONS_REVISED_TITLE,
        { id: "lock-plan", label: INLINE_QUESTIONS_LOCK_LABEL },
        [
          {
            name: "read-scope",
            values: ["all-visible"],
            labels: ["Every project your sign-in can see"],
            changed: true,
          },
          {
            name: "write-scope",
            values: ["shipping"],
            labels: ["Tasks that ship a change"],
            changed: true,
          },
          { name: "notes", values: ["Keep it short"], changed: true },
        ],
      ),
    );
    // The record keeps them on the resolution.
    const resolved = (
      await page.evaluate((id) => window.infinitary.tasks.detail(id), taskId)
    ).events.findLast((event) => event.kind === "card_resolved");
    expect(resolved?.data).toMatchObject({
      action: "lock-plan",
      answers: [
        { name: "read-scope", values: ["all-visible"], changed: true },
        { name: "write-scope", values: ["shipping"], changed: true },
        { name: "notes", values: ["Keep it short"], changed: true },
      ],
    });
  } finally {
    await launched.close();
  }
});

test("a required question written already answered is refused, and the card arrives unpicked with its recommendations tagged", async () => {
  const launched = await launchApp({
    withMockProvider: true,
    scenarios: [cardQuestions, inlineQuestions],
  });
  const { page, mockProvider } = launched;
  try {
    const prompt = page.getByRole("textbox", { name: "Task prompt" });
    await prompt.fill(`${SPAWN_PROMPT_MARKER} ${UNPICKED_PROMPT_MARKER}`);
    await prompt.press("Enter");
    await expect(shownCard(page, UNPICKED_TITLE)).toBeVisible({ timeout: 30_000 });

    // The first emit checked and selected the answers for the captain; the
    // card lint refused it and the crewmate read the refusal and the fix.
    const refusal = (mockProvider?.requestBodies() ?? [])
      .map((body) => JSON.stringify(JSON.parse(body)))
      .find((body) => body.includes(UNPICKED_REFUSAL));
    expect(refusal).toContain(
      JSON.stringify(`the required question "audience" ${UNPICKED_REFUSAL}`).slice(1, -1),
    );
    expect(refusal).toContain("data-inf-recommended");

    // Only the unpicked card reached the stage.
    const cards = (await page.evaluate(() => window.infinitary.cards.list())).filter(
      (card) => card.title === UNPICKED_TITLE,
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]?.body).toContain("data-inf-recommended");
    expect(cards[0]?.body).not.toMatch(/\b(checked|selected)\b/);
    const taskId = cards[0]?.taskId as string;

    const frame = cardBody(page, UNPICKED_TITLE);
    await expect(frame.locator("input:checked")).toHaveCount(0);
    await expect(frame.locator("select")).toHaveValue("");
    await expect(frame.locator("[data-inf-recommended-label]")).toHaveCount(1);
    await expect(frame.locator("[data-inf-recommendation]")).toHaveText("Recommended: Friday");
    await expect(answersLine(page)).toHaveText(pickedLine(0, 2, 0, { unanswered: 2 }));
    const ship = page.getByRole("button", { name: UNPICKED_DEFAULT_LABEL, exact: true });
    await expect(ship).toHaveAttribute("aria-disabled", "true");
    // The waiting default sends nothing; it takes the captain to the question.
    await focusOn(ship);
    await ship.press("Enter");
    await expect(frame.locator('input[name="audience"][value="project"]')).toBeFocused();
    await expect(frame.locator("input:checked")).toHaveCount(0);
    await page.screenshot({
      path: process.env.FM_TASK_EVIDENCE
        ? `${process.env.FM_TASK_EVIDENCE}/unpicked-card.png`
        : test.info().outputPath("unpicked-card.png"),
    });

    // Choosing the recommendations is the captain's own pick, recorded as proposed.
    await pick(frame, 'input[name="audience"][value="project"]');
    await frame.locator("select").evaluate((select: HTMLSelectElement) => {
      select.value = "friday";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expect(answersLine(page)).toHaveText(pickedLine(2, 2));
    await expect(ship).toBeEnabled();
    await page.screenshot({
      path: process.env.FM_TASK_EVIDENCE
        ? `${process.env.FM_TASK_EVIDENCE}/unpicked-card-picked.png`
        : test.info().outputPath("unpicked-card-picked.png"),
    });
    await ship.click();
    await expectNoCard(page, UNPICKED_TITLE);
    const chosen = async () =>
      (await page.evaluate((id) => window.infinitary.tasks.detail(id), taskId)).events
        .filter((event) => event.kind === "steered")
        .at(-1)?.text ?? "";
    await expect.poll(chosen, { timeout: 30_000 }).toContain(
      answersWordsBlock([
        { name: "audience", values: ["project"], labels: ["The whole project"], changed: false },
        { name: "ship-day", values: ["friday"], labels: ["Friday"], changed: false },
      ]),
    );
  } finally {
    await launched.close();
  }
});

test("a question's Something else row takes the captain's own words to the author as their answer", async () => {
  const userDataDir = scratchDir("infinitary-write-in-");
  const launched = await launchApp({
    userDataDir,
    withMockProvider: true,
    scenarios: [cardQuestions, inlineQuestions],
  });
  const { page, mockProvider } = launched;
  let cardId = "";
  try {
    const prompt = page.getByRole("textbox", { name: "Task prompt" });
    await prompt.fill(`${SPAWN_PROMPT_MARKER} ${WRITE_IN_PROMPT_MARKER}`);
    await prompt.press("Enter");
    await expect(shownCard(page, WRITE_IN_TITLE)).toBeVisible({ timeout: 30_000 });

    // The first card gave its questions no way out; the card lint refused it,
    // naming the question, and only the card with the rows reached the stage.
    const refusal = (mockProvider?.requestBodies() ?? [])
      .map((body) => JSON.stringify(JSON.parse(body)))
      .find((body) => body.includes(WRITE_IN_REFUSAL));
    expect(refusal).toContain(
      JSON.stringify(`the question "key_app" ${WRITE_IN_REFUSAL}`).slice(1, -1),
    );
    const cards = (await page.evaluate(() => window.infinitary.cards.list())).filter(
      (card) => card.title === WRITE_IN_TITLE,
    );
    expect(cards).toHaveLength(1);
    const taskId = cards[0]?.taskId as string;
    cardId = cards[0]?.id as string;

    const frame = cardBody(page, WRITE_IN_TITLE);
    const keyField = frame.getByRole("textbox", {
      name: /^Your own answer to: What should happen/,
    });
    const everyField = frame.getByRole("textbox", { name: /^Your own answer to: How often/ });
    // Each field waits under its row until the row is picked; the question
    // whose options are the only answers offers none.
    await expect(keyField).toBeHidden();
    await expect(everyField).toBeHidden();
    const optionsOnly = frame.getByRole("group", { name: OPTIONS_ONLY_QUESTION });
    await expect(optionsOnly).toBeVisible();
    await expect(optionsOnly.getByRole("textbox", { includeHidden: true })).toHaveCount(0);
    await expect(answersLine(page)).toHaveText(pickedLine(0, 3, 0, { unanswered: 1, defaults: 2 }));

    // From the keyboard: the waiting default takes the captain to the
    // question, and the arrows pick Something else, which opens its field
    // ready to write.
    const send = page.getByRole("button", { name: WRITE_IN_DEFAULT_LABEL, exact: true });
    await expect(send).toHaveAttribute("aria-disabled", "true");
    await focusOn(send);
    await send.press("Enter");
    await expect(frame.locator('input[name="key_app"][value="retry"]')).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(frame.locator('input[name="key_app"][data-inf-write-in]')).toBeChecked();
    await expect(keyField).toBeVisible();
    await expect(keyField).toBeFocused();
    // Empty, it is no answer yet: the default still waits, and takes the
    // captain back to the field.
    await expect(answersLine(page)).toHaveText(pickedLine(0, 3, 0, { unanswered: 1, defaults: 2 }));
    await expect(send).toHaveAttribute("aria-disabled", "true");
    await focusOn(send);
    await send.press("Enter");
    await expect(keyField).toBeFocused();
    await expect(shownCard(page, WRITE_IN_TITLE)).toBeVisible();

    // Words make it an answer of the captain's own: picked, and changed.
    await typeInto(keyField, "Try once after a minute, then tell me");
    await expect(answersLine(page)).toHaveText(pickedLine(1, 3, 1, { defaults: 2 }));
    await expect(send).toBeEnabled();
    await putAwayAndRestore(page, WRITE_IN_TITLE);
    await pressKey(keyField, "Shift+Tab");
    await page.keyboard.press("ArrowUp");
    await expect(frame.locator('input[name="key_app"][value="keep"]')).toBeChecked();
    await expect(keyField).toBeHidden();
    await expect(answersLine(page)).toHaveText(pickedLine(1, 3, 1, { defaults: 2 }));
    await page.keyboard.press("ArrowDown");
    await expect(keyField).toBeFocused();
    await expect(keyField).toHaveValue("Try once after a minute, then tell me");
    await expect(answersLine(page)).toHaveText(pickedLine(1, 3, 1, { defaults: 2 }));

    // A dropdown's Something else is its own last option, its field under it.
    await frame.locator("select").evaluate((select: HTMLSelectElement) => {
      select.value = "other";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expect(everyField).toBeVisible();
    await everyField.evaluate((field: HTMLTextAreaElement) => {
      field.value = "Every minute for the first ten";
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await expect(answersLine(page)).toHaveText(pickedLine(2, 3, 2, { defaults: 1 }));

    // Away in Settings and back, the card's body is drawn again from the
    // draft: the written words come back under their own rows.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.locator('[data-screen-label="Settings"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await showCard(page, WRITE_IN_TITLE);
    await expect(frame.locator('input[name="key_app"][data-inf-write-in]')).toBeChecked();
    await expect(keyField).toBeVisible();
    await expect(keyField).toHaveValue("Try once after a minute, then tell me");
    await expect(everyField).toBeVisible();
    await expect(everyField).toHaveValue("Every minute for the first ten");
    await expect(answersLine(page)).toHaveText(pickedLine(2, 3, 2, { defaults: 1 }));

    await send.click();
    await expectNoCard(page, WRITE_IN_TITLE);
    const chosen = async () =>
      (await page.evaluate((id) => window.infinitary.tasks.detail(id), taskId)).events
        .filter((event) => event.kind === "steered")
        .at(-1)?.text ?? "";
    await expect.poll(chosen, { timeout: 30_000 }).toContain(
      answersWordsBlock([
        {
          name: "key_app",
          values: [],
          changed: true,
          written: "Try once after a minute, then tell me",
        },
        {
          name: "retry_every",
          values: [],
          changed: true,
          written: "Every minute for the first ten",
        },
        ACCOUNT_SKIPPED,
      ]),
    );
    // The skipped question reads as the Default it sent (INF-4425).
    await expect.poll(chosen).toContain(skippedLine(ACCOUNT_SKIPPED));
    const resolved = (
      await page.evaluate((id) => window.infinitary.tasks.detail(id), taskId)
    ).events.findLast((event) => event.kind === "card_resolved");
    expect(resolved?.data).toMatchObject({
      action: "send-answers",
      answers: [
        {
          name: "key_app",
          values: [],
          changed: true,
          written: "Try once after a minute, then tell me",
        },
        {
          name: "retry_every",
          values: [],
          changed: true,
          written: "Every minute for the first ten",
        },
        ACCOUNT_SKIPPED,
      ],
    });
  } finally {
    await launched.close();
  }
  // The click's evidence says which questions offered a way to write one's own
  // answer, and keeps that row out of their options.
  const recordedDb = openDatabase(userDataDir);
  try {
    const [action] = new CardStore(recordedDb)
      .observations(cardId)
      .filter((entry) => entry.kind === "action");
    expect(action?.payload).toMatchObject({
      questions: [
        {
          name: "key_app",
          writeIn: true,
          options: [{ value: "retry" }, { value: "keep" }],
        },
        {
          name: "retry_every",
          writeIn: true,
          options: [{ value: "" }, { value: "5m" }, { value: "wake" }],
        },
        { name: "account", options: [{ value: "work" }, { value: "home" }] },
      ],
    });
    const questions =
      (action?.payload as { questions?: { name: string; writeIn?: true }[] } | undefined)
        ?.questions ?? [];
    expect(questions.find((question) => question.name === "account")?.writeIn).toBeUndefined();
  } finally {
    recordedDb.close();
  }
});

/** The scripted-body test's two cards, as it files them and finds them. */
const UNTOUCHED_TITLE = "Pick a wash";
const LOOK_TITLE = "Tune the glass";

test("a scripted body stages a snapshot beside its form, and the close confirms only a changed pick", async () => {
  const userDataDir = scratchDir("infinitary-card-questions-");
  const db = openDatabase(userDataDir);
  const store = new CardStore(db);
  const decision = (id: string, title: string, body: string) =>
    store.upsert({
      id,
      title,
      author: "firstmate",
      priority: 50,
      meta: "firstmate",
      body,
      status: "ready",
      createdAt: Date.now(),
      actions: [
        { id: "keep-looking", label: "Keep looking", variant: "secondary" },
        { id: "use-look", label: "Use this look", variant: "primary", default: true },
      ],
    });
  decision(
    "card-fm-untouched",
    UNTOUCHED_TITLE,
    '<p>Clear is proposed.</p><label><input type="radio" name="wash" value="clear" checked> Clear</label><label><input type="radio" name="wash" value="full"> Full wash</label>',
  );
  decision(
    "card-fm-look",
    LOOK_TITLE,
    [
      "<p>Drag the tilt, then choose.</p>",
      '<label><input type="checkbox" name="trail" value="on" checked> Leave a trail</label>',
      '<label>Tilt <input id="tilt" type="range" min="0" max="90" value="16"></label>',
      // The body gives the bridge `apply`, so a setting restored when the
      // card comes back moves its own dial (INF-5446).
      "<script>const tilt = document.getElementById('tilt'); const apply = (look) => { tilt.value = String(look.tiltDeg); stage(); }; function stage() { inf.stage('look', { tiltDeg: Number(tilt.value) }, apply); } tilt.oninput = stage; stage();</script>",
    ].join(""),
  );
  db.close();
  const launched = await launchApp({
    userDataDir,
    withMockProvider: true,
    scenarios: [cardQuestions, inlineQuestions],
  });
  const { page, mockProvider } = launched;
  try {
    // An untouched card closes at once: nothing the captain picked is lost.
    // The author's own proposal still reads as an answer, but it is not the
    // captain's pick, so closing does not ask.
    await showCard(page, UNTOUCHED_TITLE);
    await expect(answersLine(page)).toHaveText(pickedLine(1, 1));
    await cardLeave(page).first().click();
    await expect(shownCard(page, UNTOUCHED_TITLE)).toBeHidden();
    await expect(closeQuestion(page)).toHaveCount(0);

    await showCard(page, LOOK_TITLE);
    // The body's own script runs and stages its snapshot; the bridge still reads its form.
    await expect(answersLine(page)).toHaveText(answeredLine(2, 2, 1));
    const frame = cardBody(page, LOOK_TITLE);
    await frame.locator("#tilt").evaluate((input: HTMLInputElement) => {
      input.value = "42";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await putAwayAndRestore(page, LOOK_TITLE);
    // The restored setting moved the body's own dial back to what was picked.
    await expect(cardBody(page, LOOK_TITLE).locator("#tilt")).toHaveValue("42");

    await page.getByRole("button", { name: "Use this look", exact: true }).click();
    await expectNoCard(page, LOOK_TITLE);
    // The choice reaches the Firstmate as captain speech, answers in words.
    const served = () =>
      (mockProvider?.requestBodies() ?? []).some((body) => {
        const request = JSON.stringify(JSON.parse(body));
        return [
          `[user]\nUse this look\nChoice on card "${LOOK_TITLE}"`,
          ...answersWordsBlock([
            { name: "trail", values: ["on"], labels: ["Leave a trail"], changed: false },
            { name: "look", values: ['{"tiltDeg":42}'], json: true, changed: true },
          ]).split("\n"),
        ].every((line) => request.includes(JSON.stringify(line).slice(1, -1)));
      });
    await expect.poll(served, { timeout: 30_000 }).toBe(true);
  } finally {
    await launched.close();
  }
});

/** The recommendations test's two cards, as it files them and finds them. */
const PICK_TITLE = "Share the weekly report";
const DEFER_TITLE = "Defer the report";

test("tagged recommendations need explicit picks, waiting approval focuses the question, and deferral sends no picks", async () => {
  const userDataDir = scratchDir("infinitary-recommended-picks-");
  const db = openDatabase(userDataDir);
  const store = new CardStore(db);
  for (const id of ["card-fm-pick", "card-fm-defer"]) {
    store.upsert({
      id,
      title: id === "card-fm-pick" ? PICK_TITLE : DEFER_TITLE,
      author: "firstmate",
      priority: 50,
      meta: "firstmate",
      status: "ready",
      createdAt: Date.now(),
      body: `<p>Choose who can see the report and when to send it.</p>
        <fieldset><legend>Who can see it?</legend>
        <input id="me" type="radio" name="audience" value="me" required><label for="me">Only me</label>
        <label><input type="radio" name="audience" value="project" data-inf-current data-inf-recommended> The whole project</label></fieldset>
        <fieldset><legend>What should it include?</legend>
        <label><input type="checkbox" name="include" value="summary" data-inf-recommended required> Summary</label>
        <label><input type="checkbox" name="include" value="none"> None</label></fieldset>
        <label for="frequency">How often?</label><select id="frequency" name="frequency" required>
        <option value="">Choose</option><optgroup label="Schedules"><option value="weekly" data-inf-recommended>Weekly</option><option value="daily" data-inf-current>Daily</option></optgroup></select>`,
      actions: [
        { id: "defer", label: "Not now", variant: "secondary" },
        { id: "approve", label: "Approve", default: true, variant: "primary" },
      ],
    });
  }
  db.close();
  const launched = await launchApp({
    userDataDir,
    withMockProvider: true,
    scenarios: [cardQuestions, inlineQuestions],
  });
  const { page } = launched;
  try {
    await showCard(page, PICK_TITLE);
    const frame = cardBody(page, PICK_TITLE);
    await expect(answersLine(page)).toHaveText(pickedLine(0, 3, 0, { unanswered: 3 }));
    await expect(frame.locator("input:checked")).toHaveCount(0);
    await expect(frame.locator("select")).toHaveValue("");
    await expect(frame.locator("[data-inf-recommended-label]")).toHaveCount(2);
    await expect(frame.locator("[data-inf-recommendation]")).toHaveText("Recommended: Weekly");
    // INF-3598, the captain: "clearly label which is the current
    // implementation, using a similar pill UI as the recommended". The As
    // built tag sits before Recommended on an option carrying both, and a
    // select's As built line comes first under it; neither picks anything.
    await expect(frame.locator("[data-inf-current-label]")).toHaveCount(1);
    await expect(frame.locator("[data-inf-as-built]")).toHaveText(`${AS_BUILT_WORDS}: Daily`);
    await expect(frame.locator("[data-inf-as-built] + [data-inf-recommendation]")).toHaveCount(1);
    const pills = await frame.locator("[data-inf-current-label]").evaluate((label) => {
      const before = getComputedStyle(label, "::before");
      const after = getComputedStyle(label, "::after");
      // Neither pill is reordered, so ::before draws first, ahead of the words.
      return { asBuilt: before.content, first: Number(before.order) <= Number(after.order) };
    });
    expect(pills).toEqual({ asBuilt: JSON.stringify(AS_BUILT_WORDS), first: true });
    const approve = page.getByRole("button", { name: "Approve", exact: true });
    await expect(approve).toHaveAttribute("aria-disabled", "true");
    await focusOn(approve);
    await approve.press("Enter");
    await expect(frame.locator("#me")).toBeFocused();
    await expect(frame.locator("input:checked")).toHaveCount(0);
    await expect(shownCard(page, PICK_TITLE)).toBeVisible();
    await page.screenshot({
      path: process.env.FM_TASK_EVIDENCE
        ? `${process.env.FM_TASK_EVIDENCE}/recommendations-empty.png`
        : test.info().outputPath("recommendations-empty.png"),
    });
    await pick(frame, 'input[value="project"]');
    await pick(frame, 'input[value="summary"]');
    await frame.locator("select").evaluate((select: HTMLSelectElement) => {
      select.value = "weekly";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expect(answersLine(page)).toHaveText(pickedLine(3, 3));
    // A revised mount receives the shell's named draft, including picks that
    // match the recommendations. Exercise that bridge interface with an empty
    // new form rather than treating unchanged recommendations as disposable.
    await frame.locator("select").evaluate((select: HTMLSelectElement) => {
      document.querySelectorAll<HTMLInputElement>("input").forEach((input) => {
        input.checked = false;
      });
      select.value = "";
      window.dispatchEvent(
        new MessageEvent("message", {
          source: parent,
          data: {
            fm: 2,
            type: "form",
            fill: [
              { name: "audience", values: ["project"], changed: false },
              { name: "include", values: ["summary"], changed: false },
              { name: "frequency", values: ["weekly"], changed: false },
            ],
          },
        }),
      );
    });
    await expect(frame.locator('input[value="project"]')).toBeChecked();
    await expect(frame.locator('input[value="summary"]')).toBeChecked();
    await expect(frame.locator("select")).toHaveValue("weekly");
    await expect(answersLine(page)).toHaveText(pickedLine(3, 3));
    await putAwayAndRestore(page, PICK_TITLE);
    await page.screenshot({
      path: process.env.FM_TASK_EVIDENCE
        ? `${process.env.FM_TASK_EVIDENCE}/recommendations-picked.png`
        : test.info().outputPath("recommendations-picked.png"),
    });
    await approve.click();
    await expectNoCard(page, PICK_TITLE);
    const resolved = (await page.evaluate(() => window.infinitary.cards.list())).find(
      (card) => card.id === "card-fm-pick",
    );
    expect(resolved).toBeUndefined();
    await showCard(page, DEFER_TITLE);
    await expect(answersLine(page)).toHaveText(pickedLine(0, 3, 0, { unanswered: 3 }));
    await page.getByRole("button", { name: "Not now", exact: true }).click();
    await expectNoCard(page, DEFER_TITLE);
    const requests = () => JSON.stringify(launched.mockProvider?.requestBodies() ?? []);
    await expect.poll(requests).toContain(asProposedWords());
  } finally {
    await launched.close();
  }
  const recordedDb = openDatabase(userDataDir);
  try {
    const actions = new CardStore(recordedDb)
      .observations("card-fm-pick")
      .filter((entry) => entry.kind === "action");
    expect(actions).toHaveLength(1);
    expect(actions[0]?.payload).toMatchObject({
      answers: [
        { name: "audience", values: ["project"], changed: false },
        { name: "include", values: ["summary"], changed: false },
        { name: "frequency", values: ["weekly"], changed: false },
      ],
      questions: [
        {
          name: "audience",
          options: [
            { value: "me", authoredDefault: false },
            { value: "project", label: "The whole project", authoredDefault: true },
          ],
        },
        {
          name: "include",
          options: [
            { value: "summary", authoredDefault: true },
            { value: "none", authoredDefault: false },
          ],
        },
        {
          name: "frequency",
          options: [
            { value: "", authoredDefault: false },
            { value: "weekly", authoredDefault: true },
            { value: "daily", label: "Daily", authoredDefault: false },
          ],
        },
      ],
    });
  } finally {
    recordedDb.close();
  }
});

/** The skippable-questions test's card, as it files it and finds it. */
const SKIP_TITLE = "Four calls settle the weekly report";
const SKIP_ID = "card-fm-skippable";
const SKIP_SEND = "Send the report";
const SKIP_DISMISSED_ID = "card-fm-skippable-dismissed";

/**
 * A question the captain may skip (INF-4425, INF-4422 direction A; the
 * captain: "change the pill to "default" in such cases. the required cases
 * still say "recommended". and footer says "2 defaults"?", approved with a
 * cyan ring and a skip recorded with its default).
 *
 * Promised result: the required question keeps Recommended while each
 * skippable one tags and rings its Default; the footer counts the questions
 * to answer and the defaults a click sends; the author reads each skip as the
 * Default it sent and an emptied checkbox question as nothing; the past card
 * shows that Default with its tags, and a card dismissed without a choice
 * shows nothing picked. Data: a first mate card with one required radio
 * question and three skippable ones (radio, checkboxes, select), and a
 * dismissed copy of it. Completion signal: the mock provider's request
 * carries the skip line, and each past card's frame reads as above.
 * Platform: the hermetic launcher; in-frame picks are dispatched clicks.
 * Shared resources: none; the test owns its userData.
 */
test("a question the captain may skip tags its Default, rings it until touched, and a skip sends it", async () => {
  const userDataDir = scratchDir("infinitary-skippable-questions-");
  const db = openDatabase(userDataDir);
  const store = new CardStore(db);
  const card: Card = {
    id: SKIP_ID,
    title: SKIP_TITLE,
    author: "firstmate",
    priority: 50,
    meta: "firstmate",
    status: "ready",
    createdAt: Date.now(),
    body: `<p>The weekly report can go out once these calls are made.</p>
      <fieldset><legend>Who reads the report?</legend>
      <label><input type="radio" name="audience" value="me" required> Only me</label>
      <label><input type="radio" name="audience" value="project" required data-inf-recommended> The whole project</label>
      <label><input type="radio" name="audience" value="other" required data-inf-write-in> Something else</label></fieldset>
      <fieldset><legend>How wide should it be?</legend>
      <label><input type="radio" name="width" value="wide" data-inf-recommended> Wide</label>
      <label><input type="radio" name="width" value="narrow"> Narrow</label>
      <label><input type="radio" name="width" value="other" data-inf-write-in> Something else</label></fieldset>
      <fieldset><legend>What should it include?</legend>
      <label><input type="checkbox" name="include" value="summary" data-inf-recommended> Summary</label>
      <label><input type="checkbox" name="include" value="charts" data-inf-recommended> Charts</label>
      <label><input type="checkbox" name="include" value="raw"> Raw numbers</label>
      <label><input type="checkbox" name="include" value="other" data-inf-write-in> Something else</label></fieldset>
      <label for="send">When should it go out?</label><select id="send" name="send"><option value="">Choose</option><option value="friday" data-inf-recommended>Friday</option><option value="monday">Monday</option><option value="other" data-inf-write-in>Something else</option></select>`,
    actions: [
      { id: "defer", label: "Not now", variant: "secondary" },
      { id: "send", label: SKIP_SEND, default: true, variant: "primary" },
    ],
  };
  store.upsert(card);
  // A copy the captain dismissed: it sent no answers.
  store.upsert({ ...card, id: SKIP_DISMISSED_ID, createdAt: Date.now() - 60_000 });
  store.resolve(SKIP_DISMISSED_ID, "close");
  db.close();
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  const { page, mockProvider } = launched;
  try {
    await showCard(page, SKIP_TITLE);
    const frame = cardBody(page, SKIP_TITLE);
    const option = (value: string) => frame.locator(`input[value="${value}"]`);
    const ringed = frame.locator("input[data-inf-default-ring]");
    // The required question keeps Recommended; each skippable one tags the
    // option a skip sends Default and rings it, picking nothing.
    await expect(frame.locator("[data-inf-recommended-label]")).toHaveCount(1);
    await expect(frame.locator('label:has(input[value="project"])')).toHaveAttribute(
      "data-inf-recommended-label",
      "",
    );
    await expect(frame.locator("[data-inf-default-label]")).toHaveCount(3);
    await expect(frame.locator("[data-inf-recommendation]")).toHaveText(`${DEFAULT_WORDS}: Friday`);
    await expect(ringed).toHaveCount(3);
    await expect(frame.locator("input:checked")).toHaveCount(0);
    const pill = await frame
      .locator("[data-inf-default-label]")
      .first()
      .evaluate((label) => getComputedStyle(label, "::after").content);
    expect(pill).toBe(JSON.stringify(DEFAULT_WORDS));
    await expect(answersLine(page)).toHaveText(pickedLine(0, 4, 0, { unanswered: 1, defaults: 3 }));

    // Answering the required question leaves the three defaults to send.
    await pick(frame, 'input[value="project"]');
    await expect(answersLine(page)).toHaveText(pickedLine(1, 4, 0, { defaults: 3 }));
    // Any pick in a question takes its ring away.
    await pick(frame, 'input[value="narrow"]');
    await expect(option("wide")).not.toHaveAttribute("data-inf-default-ring");
    await expect(ringed).toHaveCount(2);
    await expect(answersLine(page)).toHaveText(pickedLine(2, 4, 1, { defaults: 2 }));
    // A checkbox question emptied by hand is the captain's: it sends none.
    await pick(frame, 'input[value="raw"]');
    await pick(frame, 'input[value="raw"]');
    await expect(frame.locator('input[name="include"]:checked')).toHaveCount(0);
    await expect(ringed).toHaveCount(0);
    await expect(answersLine(page)).toHaveText(pickedLine(2, 4, 2, { defaults: 1 }));

    await page.getByRole("button", { name: SKIP_SEND, exact: true }).click();
    await expectNoCard(page, SKIP_TITLE);
    // The author reads the skipped question as the Default it sent.
    const served = () =>
      JSON.stringify(
        (mockProvider?.requestBodies() ?? []).map((body) => JSON.stringify(JSON.parse(body))),
      );
    // The first mate reads its wake nested in more than one layer of JSON, so
    // the lines are matched with every escape taken out.
    const unescaped = (text: string) => text.replaceAll("\\", "");
    await expect
      .poll(() => unescaped(served()), { timeout: 30_000 })
      .toContain(unescaped(skippedLine(skippedAnswer("send", "friday", "Friday"))));
    const emptied = cardAnswerLines([{ name: "include", values: [], changed: true }])[0] ?? "";
    expect(unescaped(served())).toContain(unescaped(emptied));

    // The past card shows that Default as the answer it sent.
    await page.evaluate((id) => window.infinitary.cards.showPast(id), SKIP_ID);
    const past = page.locator(`[data-past-card="${SKIP_ID}"]`);
    await expect(past).toBeVisible();
    const pastFrame = bodyIn(past);
    await expect(pastFrame.locator("select")).toHaveValue("friday");
    await expect(pastFrame.locator('input[value="narrow"]')).toBeChecked();
    await expect(pastFrame.locator('input[name="include"]:checked')).toHaveCount(0);
    await expect(pastFrame.locator("input[data-inf-default-ring]")).toHaveCount(0);
    // Locked, it keeps its tags: Default on the skippable questions.
    await expect(pastFrame.locator("[data-inf-default-label]")).toHaveCount(3);
    await expect(pastFrame.locator("[data-inf-recommended-label]")).toHaveCount(1);
    await expect(pastFrame.locator("[data-inf-recommendation]")).toHaveText(
      `${DEFAULT_WORDS}: Friday`,
    );

    // A card dismissed without a choice sent nothing, so shows nothing picked.
    await page.evaluate((id) => window.infinitary.cards.showPast(id), SKIP_DISMISSED_ID);
    const dismissed = page.locator(`[data-past-card="${SKIP_DISMISSED_ID}"]`);
    await expect(dismissed).toBeVisible();
    const dismissedFrame = bodyIn(dismissed);
    await expect(dismissedFrame.locator("[data-inf-default-label]")).toHaveCount(3);
    await expect(dismissedFrame.locator("input:checked")).toHaveCount(0);
    await expect(dismissedFrame.locator("select")).toHaveValue("");
  } finally {
    await launched.close();
  }
});

/**
 * A decision whose body brings its own style sheet asks its questions as
 * every other decision does (INF-5452; the captain: "we need to make this
 * consistent with regular decision cards"). Only a body that runs controls
 * of its own is a playable preview whose controls are settings.
 *
 * Promised result: the footer counts picks with its Defaults line, each
 * skippable question tags its Default, and the count steps through the
 * questions. Data: a first mate plan card shaped like the one the captain
 * read - a leading style sheet, figures, and two skippable radio questions
 * with a Recommended option each. Completion signal: the footer's words
 * after a pick. Platform: the hermetic launcher; in-frame picks are
 * dispatched clicks. Shared resources: none; the test owns its userData.
 */
const STYLED_TITLE = "Two calls settle the plugin skills plan";

test("a decision whose body brings a style sheet counts picks and Defaults like every decision", async () => {
  const userDataDir = scratchDir("infinitary-styled-questions-");
  const db = openDatabase(userDataDir);
  new CardStore(db).upsert({
    id: "card-fm-styled-questions",
    title: STYLED_TITLE,
    author: "firstmate",
    priority: 50,
    meta: "firstmate",
    status: "ready",
    createdAt: Date.now(),
    body: `<style>.pf fieldset label{display:block;margin:6px 0}.pf .lit{fill:var(--accent-dim)}</style>
      <div class="pf"><p>One change gives crewmates the skills of turned-on plugins.</p>
      <figure aria-label="Where skills come from"><svg viewBox="0 0 750 40" width="100%"><rect class="lit" width="200" height="30"/><text x="10" y="20">Plugins</text></svg></figure>
      <fieldset><legend>1. What travels with a plugin's skills?</legend>
      <label><input type="radio" name="plugin_files" value="skill-folders"> Only its skill folders</label>
      <label><input type="radio" name="plugin_files" value="own-files" data-inf-recommended> Its own files too</label>
      <label><input type="radio" name="plugin_files" value="other" data-inf-write-in> Something else</label></fieldset>
      <fieldset><legend>2. Whose plugins?</legend>
      <label><input type="radio" name="plugin_sources" value="claude-code" data-inf-recommended> Claude Code only</label>
      <label><input type="radio" name="plugin_sources" value="both"> Claude Code and Codex</label>
      <label><input type="radio" name="plugin_sources" value="other" data-inf-write-in> Something else</label></fieldset></div>`,
    actions: [
      { id: "abandon", label: "Abandon", variant: "secondary" },
      { id: "build", label: "Approve and build", default: true, variant: "primary" },
    ],
  });
  db.close();
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  const { page } = launched;
  try {
    await showCard(page, STYLED_TITLE);
    const frame = cardBody(page, STYLED_TITLE);
    // Nothing is picked: both questions are left to send their Default.
    await expect(frame.locator("input:checked")).toHaveCount(0);
    await expect(frame.locator("[data-inf-default-label]")).toHaveCount(2);
    await expect(answersLine(page)).toHaveText(pickedLine(0, 2, 0, { defaults: 2 }));
    // The count is the stepper through the two questions.
    const entry = shownEntry(page);
    await expect(entry.locator('[data-card-question-step="next"]')).toBeVisible();
    // A pick counts as one, and its question no longer sends a Default.
    await pick(frame, 'input[value="both"]');
    await expect(answersLine(page)).toHaveText(pickedLine(1, 2, 1, { defaults: 1 }));
  } finally {
    await launched.close();
  }
});

/**
 * Moving between a card's questions by keys alone (INF-3963's approved plan;
 * the captain: "a user to easily switch between decisions, and change
 * their options all using keyboards smoothly"). ⌘J goes to the next
 * question, landing on its Recommended option; Enter takes the option it
 * rests on and goes on; a number key takes that option; Shift+Enter goes
 * back; Enter past the last question lands on the card's default button,
 * and ⌘1 sends. The footer's arrow is the pointer's: it brings the
 * question into view and takes no focus; the keys go on from the
 * question it showed.
 *
 * Promised result: every answer is given and sent from the keyboard, and
 * the footer's count follows. Data: a first mate card with three required
 * questions, two of them with a Recommended option. Completion signal: the
 * card is gone and its saved action holds the three answers. Platform: the
 * hermetic launcher; window keys go through the main process, and keys
 * inside the body go to the option that holds focus.
 * Shared resources: none; the test owns its userData.
 */
const STEPS_TITLE = "Three calls settle the weekly report";
const STEPS_ID = "card-fm-question-steps";

test("a card's questions are stepped through and answered by keys alone", async () => {
  const userDataDir = scratchDir("infinitary-question-steps-");
  const db = openDatabase(userDataDir);
  new CardStore(db).upsert({
    id: STEPS_ID,
    title: STEPS_TITLE,
    author: "firstmate",
    priority: 50,
    meta: "firstmate",
    status: "ready",
    createdAt: Date.now(),
    body: `<p>Choose who sees the weekly report, what it includes and when it goes out.</p>
      <fieldset><legend>Who can see it?</legend>
      <label><input type="radio" name="audience" value="me" required> Only me</label>
      <label><input type="radio" name="audience" value="project" data-inf-recommended required> The whole project</label>
      <label><input type="radio" name="audience" value="other" data-inf-write-in required> Something else</label></fieldset>
      <fieldset><legend>What should it include?</legend>
      <label><input type="checkbox" name="include" value="summary" data-inf-recommended required> Summary</label>
      <label><input type="checkbox" name="include" value="checks" required> Checks</label>
      <label><input type="checkbox" name="include" value="other" data-inf-write-in required> Something else</label></fieldset>
      <fieldset><legend>When should it go out?</legend>
      <label><input type="radio" name="when" value="monday" required> Monday</label>
      <label><input type="radio" name="when" value="friday" required> Friday</label>
      <label><input type="radio" name="when" value="other" data-inf-write-in required> Something else</label></fieldset>`,
    actions: [
      { id: "defer", label: "Not now", variant: "secondary" },
      { id: "approve", label: "Approve", default: true, variant: "primary" },
    ],
  });
  db.close();
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  const { app, page } = launched;
  try {
    await showCard(page, STEPS_TITLE);
    const frame = cardBody(page, STEPS_TITLE);
    const option = (value: string) => frame.locator(`input[value="${value}"]`);
    const prompt = page.getByRole("textbox", { name: "Task prompt" });
    await expect(answersLine(page)).toHaveText(pickedLine(0, 3, 0, { unanswered: 3 }));

    // The pointer's arrow brings the next question into view and leaves
    // focus in the main message.
    await focusOn(prompt);
    const scroller = shownEntry(page).locator("[data-card-body]");
    const next = shownEntry(page).getByRole("button", { name: m.uiCardNextQuestion() });
    for (let step = 0; step < 3; step++) await next.click();
    await expect.poll(() => scroller.evaluate((body) => body.scrollTop)).toBeGreaterThan(0);
    await expect(prompt).toBeFocused();

    // The keys go on from the question the arrow showed, the last: ⇧⌘J twice
    // is the first question, on its Recommended option, with nothing picked.
    await pressWindowKey(app, "J", ["meta", "shift"]);
    await untilFocused(option("summary"));
    await pressWindowKey(app, "J", ["meta", "shift"]);
    await untilFocused(option("project"));
    await expect(frame.locator("input:checked")).toHaveCount(0);
    // Enter takes it and goes on to the next question's Recommended option.
    await pressKey(option("project"), "Enter");
    await expect(option("project")).toBeChecked();
    await untilFocused(option("summary"));
    await expect(answersLine(page)).toHaveText(pickedLine(1, 3, 0, { unanswered: 2 }));
    // A number key takes that option: 2 is Checks.
    await pressKey(option("summary"), "2");
    await expect(option("checks")).toBeChecked();
    await expect(option("summary")).not.toBeChecked();
    await expect(answersLine(page)).toHaveText(pickedLine(2, 3, 1, { unanswered: 1 }));
    // Enter on a checkbox goes on without ticking it.
    await pressKey(option("checks"), "Enter");
    await untilFocused(option("monday"));
    await expect(option("checks")).toBeChecked();
    await expect(option("summary")).not.toBeChecked();
    await pressKey(option("monday"), "2");
    await expect(option("friday")).toBeChecked();
    await expect(answersLine(page)).toHaveText(pickedLine(3, 3, 2));
    // Shift+Enter goes back to the picked option and takes nothing; ⌘J goes on again.
    await pressKey(option("friday"), "Shift+Enter");
    await untilFocused(option("checks"));
    await pressWindowKey(app, "J", ["meta"]);
    await untilFocused(option("friday"));
    // Past the last question: the card's default button, pressed by nothing.
    await pressKey(option("friday"), "Enter");
    const approve = shownEntry(page).getByRole("button", { name: "Approve", exact: true });
    await expect(approve).toBeFocused();
    await expect(shownCard(page, STEPS_TITLE)).toBeVisible();
    // ⇧⌘J goes back into the body, to the last question.
    await pressWindowKey(app, "J", ["meta", "shift"]);
    await untilFocused(option("friday"));
    await pressWindowKey(app, "1", ["meta"]);
    await expectNoCard(page, STEPS_TITLE);
  } finally {
    await launched.close();
  }
  const recordedDb = openDatabase(userDataDir);
  try {
    const actions = new CardStore(recordedDb)
      .observations(STEPS_ID)
      .filter((entry) => entry.kind === "action");
    expect(actions).toHaveLength(1);
    expect(actions[0]?.payload).toMatchObject({
      answers: [
        { name: "audience", values: ["project"] },
        { name: "include", values: ["checks"] },
        { name: "when", values: ["friday"] },
      ],
    });
  } finally {
    recordedDb.close();
  }
});

/**
 * A long decision sends (the captain: "i filled out this card but the
 * finalize button is not working", on a card reading "37 of 37 picked ·
 * 15 changed"). The 37 questions keep the shape and lengths of real radio
 * groups (card-answers-37.questions.json), with the wording replaced; 15
 * picks differ from the recommendation. The default footer button sends
 * every answer, labels included, and the card leaves.
 *
 * Promised result: the finalize button is taken and the saved row holds
 * the 37 answers. Data: that fixture. Completion signal: the card is gone
 * from the stack and the saved answers match the picks. Platform: the
 * hermetic launcher, application lane, mock provider, no native focus.
 * Shared resources: none; the test owns its userData.
 */
const LONG_ANSWERS_TITLE = "Finalize the rules for these tasks";
const LONG_ANSWERS_KEEP = "Keep rules open";
const LONG_ANSWERS_FINALIZE = "Use answers to finalize tasks";
const LONG_ANSWERS_ID = "card-fm-long-answers";

type LongQuestion = { name: string; pick: string; changed: boolean; html: string };

test("a 37-question card's footer sends its answers", async () => {
  const questions = JSON.parse(
    readFileSync(new URL("./card-answers-37.questions.json", import.meta.url), "utf8"),
  ) as LongQuestion[];
  const changedCount = questions.filter((question) => question.changed).length;
  const userDataDir = scratchDir("infinitary-long-answers-");
  const db = openDatabase(userDataDir);
  new CardStore(db).upsert({
    id: LONG_ANSWERS_ID,
    title: LONG_ANSWERS_TITLE,
    author: "firstmate",
    priority: 50,
    meta: "firstmate",
    status: "ready",
    createdAt: Date.now(),
    body: `<p>Answer each rule, then I finalize the tasks.</p>${questions
      .map((question) => question.html)
      .join("\n")}`,
    actions: [
      { id: "keep-open", label: LONG_ANSWERS_KEEP, variant: "secondary" },
      { id: "finalize", label: LONG_ANSWERS_FINALIZE, default: true, variant: "primary" },
    ],
  });
  db.close();
  const launched = await launchApp({
    userDataDir,
    withMockProvider: true,
    scenarios: [cardQuestions, inlineQuestions],
  });
  const { page } = launched;
  try {
    await showCard(page, LONG_ANSWERS_TITLE);
    const frame = cardBody(page, LONG_ANSWERS_TITLE);
    await expect(answersLine(page)).toHaveText(
      pickedLine(0, questions.length, 0, { defaults: questions.length }),
    );
    for (const question of questions) {
      await pick(frame, `input[name="${question.name}"][value="${question.pick}"]`);
    }
    await expect(answersLine(page)).toHaveText(
      pickedLine(questions.length, questions.length, changedCount),
    );
    await page.getByRole("button", { name: LONG_ANSWERS_FINALIZE, exact: true }).click();
    await expectNoCard(page, LONG_ANSWERS_TITLE);
  } finally {
    await launched.close();
  }
  const recordedDb = openDatabase(userDataDir);
  try {
    const store = new CardStore(recordedDb);
    expect(store.chosenAction(LONG_ANSWERS_ID)).toBe("finalize");
    const answers = store.past(LONG_ANSWERS_ID)?.answers ?? [];
    expect(answers).toHaveLength(questions.length);
    for (const question of questions) {
      const answer = answers.find((item) => item.name === question.name);
      expect(answer?.values).toEqual([question.pick]);
      expect(answer?.changed).toBe(question.changed);
      expect(answer?.labels?.[0]?.length).toBeGreaterThan(0);
    }
  } finally {
    recordedDb.close();
  }
});

/** What the captain writes in the card's one field, as the spec types it. */
const COMMENT = "Check the light theme too";
/** The title of the note the one-field journey seeds, whose author gave it no choices. */
const NOTE_TITLE = "The access plan is filed";

/**
 * The captain's ask (INF-680): "every decision card has a "anything else?"
 * input box at the bottom of the card body, so i can leave additional
 * comments before clicking one of the action buttons". His Approve and build
 * on INF-924 made it the card's one field: "after typing, pressing "chat" or
 * "enter" will send the reply without making a choice. pressing any other
 * choice will send the text along with the choice", with the placeholder
 * "anything to add?". The words a choice carries ride as the answer named
 * `anything_else`.
 */
test("the card's one field replies on Chat and goes with whichever choice the captain clicks", async () => {
  const userDataDir = scratchDir("infinitary-anything-else-");
  const db = openDatabase(userDataDir);
  new CardStore(db).upsert({
    id: "card-fm-filed",
    title: NOTE_TITLE,
    author: "firstmate",
    priority: 10,
    meta: "firstmate",
    body: "<p>Nothing is left to decide.</p>",
    status: "ready",
    createdAt: Date.now(),
    actions: [],
  });
  db.close();
  const launched = await launchApp({
    userDataDir,
    withMockProvider: true,
    scenarios: [cardQuestions, inlineQuestions],
  });
  const { app, page } = launched;
  try {
    // A note its author gave no choices ends with the field, the note's own
    // Got it as its one choice (INF-2794) and Chat after it.
    await showCard(page, NOTE_TITLE);
    await expect(cardReply(page).field).toHaveAttribute("placeholder", CARD_REPLY_HINT);
    await expect(cardReply(page).send).toBeVisible();
    const noteChoices = shownCard(page, NOTE_TITLE).locator("[data-card-choice]");
    await expect(noteChoices).toHaveCount(1);
    await expect(noteChoices).toHaveAttribute("data-note-done", "got-it");
    await expect(noteChoices).toContainText(NOTE_GOT_IT_LABEL);
    await expect(
      shownEntry(page).locator("[data-card-actions] button").last(),
    ).toHaveAccessibleName(CARD_CHAT_LABEL);

    const prompt = page.getByRole("textbox", { name: "Task prompt" });
    await prompt.fill(`${SPAWN_PROMPT_MARKER} ${INLINE_QUESTIONS_PROMPT_MARKER}`);
    await prompt.press("Enter");
    // The crewmate starts and puts its card up behind the note, so the walk
    // retries until that card has joined the stack.
    await expect(() => showCard(page, INLINE_QUESTIONS_TITLE)).toPass({ timeout: 60_000 });
    const card = await page.evaluate(
      async (title) =>
        (await window.infinitary.cards.list()).find((entry) => entry.title === title),
      INLINE_QUESTIONS_TITLE,
    );
    const taskId = card?.taskId as string;
    const steers = async () =>
      (await page.evaluate((id) => window.infinitary.tasks.detail(id), taskId)).events.filter(
        (event) => event.kind === "steered",
      );
    const steersBefore = (await steers()).length;
    const commentLine = cardAnswerLines([
      { name: ANYTHING_ELSE_ANSWER, values: [], changed: true, written: COMMENT },
    ])[0] as string;

    // One field, above the choices; Chat sits after them, and no second box.
    const { field, send } = cardReply(page);
    await expect(field).toHaveAttribute("placeholder", CARD_REPLY_HINT);
    await expect(shownEntry(page).getByRole("textbox")).toHaveCount(1);
    await expect(
      shownEntry(page).locator("[data-card-actions] button").last(),
    ).toHaveAccessibleName(CARD_CHAT_LABEL);
    // Command search goes to it; typing there sends nothing and picks nothing.
    await runFromSearch(app, page, "focus.card-reply");
    await expect(field).toBeFocused();
    await typeInto(field, COMMENT);
    await expect(field).toHaveValue(COMMENT);
    await expect(send).toHaveAttribute("data-lit", "");
    await expect(answersLine(page)).toHaveText(pickedLine(1, 3, 0, { unanswered: 1 }));
    expect((await steers()).slice(steersBefore)).toHaveLength(0);

    await putAwayAndRestore(page, INLINE_QUESTIONS_TITLE);

    // A picture goes only as a reply: the choices wait, and a press sends nothing.
    await pastePictures(field, [{ name: "theme.png" }]);
    await expect(shownEntry(page).locator("[data-card-files-first]")).toHaveText(CARD_FILES_FIRST);
    const notNow = page.getByRole("button", { name: "Not now", exact: true });
    await expect(notNow).toHaveAttribute("aria-disabled", "true");
    // A dimmed choice still takes the pointer, so force past Playwright's own wait for an enabled button.
    await notNow.click({ force: true });
    await expect(shownCard(page, INLINE_QUESTIONS_TITLE)).toBeVisible();
    expect((await steers()).slice(steersBefore)).toHaveLength(0);
    await cardReply(page).row.getByRole("button", { name: "Remove theme.png" }).click();
    await expect(shownEntry(page).locator("[data-card-files-first]")).toHaveCount(0);

    // Chat sends the field's words as the reply itself, never as an answer
    // beside it; the revision the reply asked for comes up with the field empty.
    await field.fill(INLINE_QUESTIONS_REVISE_REPLY);
    await send.click();
    // A reply never moves the card (INF-770): the revision redraws it in place.
    await expect(shownCard(page, INLINE_QUESTIONS_REVISED_TITLE)).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await steers()).slice(steersBefore).length).toBe(1);
    const replied = (await steers()).at(-1)?.text ?? "";
    expect(replied).toContain(INLINE_QUESTIONS_REVISE_REPLY);
    expect(replied).not.toContain(
      cardAnswerLines([
        {
          name: ANYTHING_ELSE_ANSWER,
          values: [],
          changed: true,
          written: INLINE_QUESTIONS_REVISE_REPLY,
        },
      ])[0] as string,
    );
    await expect(cardReply(page).field).toHaveValue("");

    // ⌘2 from inside the field presses the button that is not the default,
    // and the words go with it.
    await cardReply(page).field.fill(COMMENT);
    await focusOn(cardReply(page).field);
    await pressWindowKey(app, "2", ["meta"]);
    await expectNoCard(page, INLINE_QUESTIONS_REVISED_TITLE);
    await expect.poll(async () => (await steers()).slice(steersBefore).length).toBe(2);
    const chosen = (await steers()).at(-1)?.text ?? "";
    expect(chosen).toContain(
      choiceWords(INLINE_QUESTIONS_REVISED_TITLE, { id: "later", label: "Not now" }),
    );
    expect(chosen).toContain(commentLine);
    const resolved = (
      await page.evaluate((id) => window.infinitary.tasks.detail(id), taskId)
    ).events.findLast((event) => event.kind === "card_resolved");
    expect(resolved?.data).toMatchObject({
      action: "later",
      answers: expect.arrayContaining([
        { name: ANYTHING_ELSE_ANSWER, values: [], changed: true, written: COMMENT },
      ]),
    });

    // The past card shows what went with the choice as one quiet line.
    await page.evaluate((id) => window.infinitary.cards.showPast(id), card?.id as string);
    const past = page.locator(`[data-past-card="${card?.id}"]`);
    await expect(past).toBeVisible();
    await expect(shownEntry(page).locator("[data-past-card-words]")).toHaveText(
      `${PAST_CARD_WORDS_LEAD} ${COMMENT}`,
    );
    await expect(shownEntry(page).getByRole("textbox")).toHaveCount(0);
  } finally {
    await launched.close();
  }
});

/** What the captain leaves in a note's field before pressing its own button. */
const NOTE_WORDS = "Does this message go through";
const ANSWER_WORDS = "Looks good, cut the next build now";
const CREW_NOTE_WORDS = "Check the weekly reading again tomorrow";
/** The seeded answer task's own note, the marked answer whose button is Done. */
const ANSWER_NOTE_TITLE = "Recent changes and the next build";

/**
 * The captain's report (INF-4435): "why my words in the reply box didn't go
 * through when i click done". A note's own button (Done on a marked answer,
 * Got it on any other note, INF-2794) is a button other than Chat, so the
 * words left in the card's one field go with it (INF-924): to the note's
 * author as their reply, a crewmate's included, and to the first mate when
 * Done closes the task. A picture in the field holds the button, as it holds
 * any choice, until it goes as a reply.
 */
test("a note's Done and Got it take the words left in the card's field with them", async () => {
  const userDataDir = scratchDir("infinitary-note-words-");
  const { repoDir } = seedRepo(userDataDir);
  const db = openDatabase(userDataDir);
  const store = new CardStore(db);
  seedTask(new TaskService({ db, strict: true }), {
    id: "answer",
    title: "Check what the next build holds",
    status: "idle",
    repoDir,
    shape: { kind: "research", kind_source: "classifier:test", deliverable: "answer" },
  });
  store.upsert({
    id: "card-answer-1",
    taskId: "answer",
    author: "crewmate",
    title: ANSWER_NOTE_TITLE,
    body: "<p>Two merged changes are not in the newest build.</p>",
    meta: "crew",
    status: "ready",
    priority: 10,
    createdAt: Date.now(),
    answering: true,
    actions: [],
  });
  store.upsert({
    id: "card-fm-filed",
    title: NOTE_TITLE,
    author: "firstmate",
    priority: 10,
    meta: "firstmate",
    body: "<p>Nothing is left to decide.</p>",
    status: "ready",
    createdAt: Date.now() - 1,
    actions: [],
  });
  db.close();
  const launched = await launchApp({
    userDataDir,
    withMockProvider: true,
    scenarios: [everyCardKind],
  });
  const { app, page } = launched;
  // A turn the first mate was served whose input carries the words.
  const firstmateHeard = (words: string) =>
    (launched.mockProvider?.requestBodies() ?? []).some(
      (body) => body.includes(words) && !body.includes("You are a crewmate"),
    );
  const captainLines = async (cardId: string) =>
    (await page.evaluate((id) => window.infinitary.cards.thread(id), cardId)).messages
      .filter((message) => message.who === "captain")
      .map((message) => message.text);
  try {
    // Got it on the first mate's note: the words reach the first mate as the
    // captain's reply under it.
    await showCard(page, NOTE_TITLE);
    await expect(noteDone(page)).toHaveAttribute("data-note-done", "got-it");
    // A picture goes only as a reply: the note's button waits, as any choice does.
    await pastePictures(cardReply(page).field, [{ name: "chart.png" }]);
    await expect(shownEntry(page).locator("[data-card-files-first]")).toHaveText(CARD_FILES_FIRST);
    // It stays pressable, so a press that queues an open note lands, and its press is held.
    await noteDone(page).click();
    await expect(shownCard(page, NOTE_TITLE)).toBeVisible();
    await cardReply(page).row.getByRole("button", { name: "Remove chart.png" }).click();
    await expect(shownEntry(page).locator("[data-card-files-first]")).toHaveCount(0);
    await cardReply(page).field.fill(NOTE_WORDS);
    await focusOn(cardReply(page).field);
    await pressWindowKey(app, "1", ["meta"]);
    await expectNoCard(page, NOTE_TITLE);
    expect(await captainLines("card-fm-filed")).toEqual([NOTE_WORDS]);
    await expect.poll(() => firstmateHeard(NOTE_WORDS), { timeout: 30_000 }).toBe(true);

    // Done on the answer task's note closes the task, and the words go to the
    // first mate, who carries on after it.
    await showCard(page, ANSWER_NOTE_TITLE);
    await expect(noteDone(page)).toHaveAttribute("data-note-done", "done");
    await expect(noteDone(page)).toContainText(ANSWER_DONE_LABEL);
    await cardReply(page).field.fill(ANSWER_WORDS);
    await noteDone(page).click();
    await expectNoCard(page, ANSWER_NOTE_TITLE);
    expect(await captainLines("card-answer-1")).toEqual([ANSWER_WORDS]);
    await expect.poll(() => firstmateHeard(ANSWER_WORDS), { timeout: 30_000 }).toBe(true);
    await expect
      .poll(
        async () =>
          (await page.evaluate((id) => window.infinitary.tasks.detail(id), "answer")).status,
      )
      .toBe("done");

    // Got it on a crewmate's note on a live task: the words reach that
    // crewmate as the captain's reply under the note it just read.
    const prompt = page.getByRole("textbox", { name: "Task prompt" });
    await prompt.fill(`${SPAWN_PROMPT_MARKER} ${EMIT_CARDS_PROMPT_MARKER}`);
    await prompt.press("Enter");
    await expect(() => showCard(page, MOCK_QUOTA_NOTE_TITLE)).toPass({ timeout: 60_000 });
    const crewNote = (await page.evaluate(() => window.infinitary.cards.list())).find(
      (entry) => entry.title === MOCK_QUOTA_NOTE_TITLE,
    );
    const crewTask = crewNote?.taskId as string;
    await expect(noteDone(page)).toHaveAttribute("data-note-done", "got-it");
    await cardReply(page).field.fill(CREW_NOTE_WORDS);
    await noteDone(page).click();
    await expectNoCard(page, MOCK_QUOTA_NOTE_TITLE);
    expect(await captainLines(crewNote?.id as string)).toEqual([CREW_NOTE_WORDS]);
    await expect
      .poll(async () =>
        (await page.evaluate((id) => window.infinitary.tasks.detail(id), crewTask)).events.some(
          (event) => event.kind === "steered" && (event.text ?? "").includes(CREW_NOTE_WORDS),
        ),
      )
      .toBe(true);
  } finally {
    await launched.close();
  }
});
