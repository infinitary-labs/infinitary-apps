import { readFileSync } from "node:fs";
import { expect, type FrameLocator, type Page, test } from "@playwright/test";
import { CAPTAIN_WORDS } from "../../src/core/orchestrator/captainWakes";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { answersLine as answersWords } from "../../src/renderer/src/cards/answersLine";
import { NOTE_GOT_IT_LABEL } from "../../src/shared/cardLeave";
import {
  ANYTHING_ELSE_ANSWER,
  CARD_CHAT_LABEL,
  CARD_FILES_FIRST,
  CARD_REPLY_HINT,
  type CardAnswer,
  cardAnswerLines,
  PAST_CARD_WORDS_LEAD,
  REPLY_SETTINGS_HEAD,
} from "../../src/shared/cards";
import { AS_BUILT_WORDS } from "../../src/shared/plugins/bridge";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody, cardBodyElement } from "./frames";
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
  putAwayAndRestore,
  showCard,
  shownCard,
  shownEntry,
} from "./stack";
import { focusOn, pressKey, pressWindowKey, runFromSearch, typeInto } from "./windowKeys";

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

/** The footer's answers line for these counts: picks on a card, answers on a preview. */
const pickedLine = (answered: number, of: number, changed = 0) =>
  answersWords({ answered, of, changed }, false);
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
    await expect(answersLine(page)).toHaveText(pickedLine(1, 3));
    await expect(lock).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("button", { name: "Not now", exact: true })).toBeEnabled();

    const frame = cardBody(page, INLINE_QUESTIONS_TITLE);
    await pick(frame, 'input[name="read-scope"][value="all-visible"]');
    await type(frame, 'textarea[name="notes"]', "Keep it short");
    await expect(answersLine(page)).toHaveText(pickedLine(2, 3, 2));
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
    await expect(answersLine(page)).toHaveText(pickedLine(2, 3, 2));
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
    await expect(answersLine(page)).toHaveText(pickedLine(0, 2));
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
    await expect(answersLine(page)).toHaveText(pickedLine(0, 3));

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
    await expect(answersLine(page)).toHaveText(pickedLine(0, 3));
    await expect(send).toHaveAttribute("aria-disabled", "true");
    await focusOn(send);
    await send.press("Enter");
    await expect(keyField).toBeFocused();
    await expect(shownCard(page, WRITE_IN_TITLE)).toBeVisible();

    // Words make it an answer of the captain's own: picked, and changed.
    await typeInto(keyField, "Try once after a minute, then tell me");
    await expect(answersLine(page)).toHaveText(pickedLine(1, 3, 1));
    await expect(send).toBeEnabled();
    await putAwayAndRestore(page, WRITE_IN_TITLE);
    await pressKey(keyField, "Shift+Tab");
    await page.keyboard.press("ArrowUp");
    await expect(frame.locator('input[name="key_app"][value="keep"]')).toBeChecked();
    await expect(keyField).toBeHidden();
    await expect(answersLine(page)).toHaveText(pickedLine(1, 3, 1));
    await page.keyboard.press("ArrowDown");
    await expect(keyField).toBeFocused();
    await expect(keyField).toHaveValue("Try once after a minute, then tell me");
    await expect(answersLine(page)).toHaveText(pickedLine(1, 3, 1));

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
    await expect(answersLine(page)).toHaveText(pickedLine(2, 3, 2));

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
    await expect(answersLine(page)).toHaveText(pickedLine(2, 3, 2));

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
        { name: "account", values: [], changed: false },
      ]),
    );
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
        { name: "account", values: [], changed: false },
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
      "<script>document.getElementById('tilt').oninput = (event) => inf.stage('look', { tiltDeg: Number(event.target.value) });</script>",
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
    // The body's own script runs; the bridge still reads its form.
    await expect(answersLine(page)).toHaveText(answeredLine(1, 1));
    const frame = cardBody(page, LOOK_TITLE);
    await frame.locator("#tilt").evaluate((input: HTMLInputElement) => {
      input.value = "42";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await expect(answersLine(page)).toHaveText(answeredLine(2, 2, 1));

    await putAwayAndRestore(page, LOOK_TITLE);

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
    await expect(answersLine(page)).toHaveText(pickedLine(0, 3));
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
      return { asBuilt: before.content, first: Number(before.order) < Number(after.order) };
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
    await expect(answersLine(page)).toHaveText(pickedLine(0, 3));
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
    await expect(answersLine(page)).toHaveText(pickedLine(0, questions.length));
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
    await expect(answersLine(page)).toHaveText(pickedLine(1, 3));
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
