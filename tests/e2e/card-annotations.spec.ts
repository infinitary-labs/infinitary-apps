import { expect, type Locator, test } from "@playwright/test";
import { NOTE_GOT_IT_LABEL } from "../../src/shared/cardLeave";
import { boxPlace, keyStep, middleBox, movedBox, sizedBox } from "../../src/shared/cardNoteMarks";
import {
  ANNOTATE,
  type CardNote,
  EMPTY_NOTE,
  MARKED_PICTURES_LINE,
  NOTE_COMMENT_LABEL,
  NOTE_EDIT,
  NOTE_REMOVE,
  noteLabel,
  POINT_AT,
  POINTED_AT,
  pointedAtLines,
  queuedNotesWords,
  sendNotesLabel,
} from "../../src/shared/cardNotes";
import { carriedWithChoiceWords } from "../../src/shared/choiceCarried";
import {
  ANNOTATION_COMMENT,
  ANNOTATION_RANGE,
  ANNOTATION_RANGE_END,
  ANNOTATION_TITLE,
  ANNOTATION_WORDS,
} from "../fixtures/cardAnnotations";
import { cardBody, cardBodyElement } from "./frames";
import { launchApp } from "./launch";
import { type Rect, within } from "./layout";
import { readInMain } from "./mainProcess";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { encodeInBrowser, WIDE_PICTURE, WORKING_COPY_PICTURES } from "./pictureFixtures";
import { pastePictures, promptInput } from "./prompt";
import { providerMessages } from "./providerRequest";
import { readSavedData } from "./savedData";
import {
  ANNOTATION_ACK,
  ANNOTATION_CREW_PROMPT,
  ANNOTATION_FIRSTMATE_PROMPT,
  cardAnnotations,
} from "./scenarios/cardAnnotations";
import {
  CARD_DIAGRAM,
  CARD_PICTURES_PROMPT_MARKER,
  cardPictures,
  PICTURE_CARD_TITLES,
} from "./scenarios/cardPictures";
import { newestPictures } from "./scenarios/pictureRetry";
import { cardReply, cardThread, clickInBody, pager, showCard, shownCard } from "./stack";
import {
  focusOn,
  pressKey,
  pressWindowKey,
  runFromSearch,
  typeInto,
  untilFocused,
} from "./windowKeys";

/**
 * Intent: the captain-approved desktop annotation plan, INF-3786's approved
 * plan (Annotate on selected words, keep a note on a press outside, open a note
 * from its mark, Remove in the editor, Send N notes), and the captain's "after
 * the "point at" annotation selects an element, we should deactivate
 * annotation, not leaving it still activated". Real card text from its
 * queue-check example, the real frame bridge, reply, database and author turn.
 * Portable: no sign-in; native Copy/Paste uses only the disposable Linux desktop.
 * One disposable app per author case.
 */
for (const author of ["crewmate", "firstmate"] as const) {
  test(`${author} receives queued whole-part and exact-range notes as one reply`, async () => {
    const readings: string[] = [];
    const a = await launchApp({ withMockProvider: true, scenarios: [cardAnnotations(readings)] });
    try {
      const prompt = promptInput(a.page);
      await prompt.fill(
        author === "crewmate"
          ? `${SPAWN_PROMPT_MARKER} ${ANNOTATION_CREW_PROMPT}`
          : ANNOTATION_FIRSTMATE_PROMPT,
      );
      await pressKey(prompt, "Enter");
      await expect(shownCard(a.page, ANNOTATION_TITLE)).toBeVisible();
      const frame = cardBody(a.page, ANNOTATION_TITLE),
        body = frame.locator("body");
      const pop = a.page.getByRole("dialog", { name: new RegExp(`^${ANNOTATE} `) });
      const comment = pop.getByRole("textbox", { name: NOTE_COMMENT_LABEL });
      const annotate = a.page.getByRole("button", { name: new RegExp(`^${ANNOTATE}`) });
      const pointAt = a.page.getByRole("button", { name: new RegExp(`^${POINT_AT}`) });
      const title = shownCard(a.page, ANNOTATION_TITLE).getByText(ANNOTATION_TITLE).first();
      await runFromSearch(a.app, a.page, "cards.point-at");
      await pressKey(body, "ArrowDown");
      await pressKey(body, "Enter");
      await expect(pop).toBeVisible();
      // Point at turns off once it has picked a part; the pick stays open.
      await expect(pointAt).toHaveAttribute("aria-pressed", "false");
      await pressKey(comment, "Enter");
      await expect(a.page.getByText(queuedNotesWords(1), { exact: true })).toBeVisible();
      await expect(a.page.getByText(EMPTY_NOTE, { exact: true })).toBeVisible();
      // Edit and remove are queue operations, not sends.
      await a.page.getByRole("button", { name: NOTE_EDIT, exact: true }).click();
      await comment.fill(ANNOTATION_COMMENT);
      await pressKey(comment, "Enter");
      await a.page.getByRole("button", { name: NOTE_REMOVE, exact: true }).click();
      await expect(a.page.getByText(queuedNotesWords(1), { exact: true })).toHaveCount(0);
      // Pointer picking reopens the same host popover; controls keep their own meaning.
      // Pointing at another part takes Point at again.
      await pointAt.click();
      await focusOn(cardBodyElement(a.page, ANNOTATION_TITLE));
      await frame.locator('input[name="checks"]').dispatchEvent("click");
      await expect(frame.locator('input[name="checks"]')).toBeChecked();
      await expect(pop).toHaveCount(0);
      await frame.locator("p").nth(1).dispatchEvent("click");
      await expect(pop).toBeVisible();
      await expect(pointAt).toHaveAttribute("aria-pressed", "false");
      await pressKey(comment, "Enter");
      // A browser Selection is the real range input to the bridge, including inline text.
      const selectWords = async () => {
        await focusOn(body);
        await frame
          .locator("p")
          .first()
          .evaluate((element, words) => {
            const node = element.firstChild;
            if (!node) throw new Error("paragraph has no text");
            const start = (node.textContent ?? "").indexOf(words);
            if (start < 0) throw new Error("example words missing");
            const range = document.createRange();
            range.setStart(node, start);
            range.setEnd(node, start + words.length);
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
          }, ANNOTATION_RANGE);
        await frame.locator("p").first().dispatchEvent("pointerup");
      };
      // Frame-local keys follow the selection's focused body, not native window injection.
      // With Point at off a selection only offers Annotate; Escape takes the offer before the card.
      await selectWords();
      await expect(annotate).toBeVisible();
      await expect(pop).toHaveCount(0);
      await pressKey(body, "Escape");
      await expect(annotate).toHaveCount(0);
      await expect(shownCard(a.page, ANNOTATION_TITLE)).toBeVisible();
      // With Point at on a selection opens the editor at once, the caret in its comment.
      await runFromSearch(a.app, a.page, "cards.point-at");
      await selectWords();
      await expect(pop).toBeVisible();
      await untilFocused(comment);
      await expect(pop.getByText(ANNOTATION_RANGE, { exact: true })).toBeVisible();
      await expect(pointAt).toHaveAttribute("aria-pressed", "false");
      await pressKey(comment, "Escape");
      await expect(pop).toHaveCount(0);
      await expect(shownCard(a.page, ANNOTATION_TITLE)).toBeVisible();
      // Tab enters the optional comment; Enter queues as-is. Removing it is not a send.
      await selectWords();
      await expect(annotate).toBeVisible();
      await pressKey(body, "Tab");
      await untilFocused(comment);
      await pressKey(comment, "Enter");
      await expect(a.page.getByText(queuedNotesWords(2), { exact: true })).toBeVisible();
      expect(readings).toHaveLength(0);
      await a.page.getByRole("button", { name: NOTE_REMOVE, exact: true }).nth(1).click();
      await expect(a.page.getByText(queuedNotesWords(1), { exact: true })).toBeVisible();
      // A click on Annotate opens the editor with the caret in its comment; a press
      // outside closes it and keeps its words as a queued note, never sending.
      await selectWords();
      await annotate.click();
      await untilFocused(comment);
      await typeInto(comment, ANNOTATION_COMMENT);
      await title.click();
      await expect(pop).toHaveCount(0);
      await expect(a.page.getByText(queuedNotesWords(2), { exact: true })).toBeVisible();
      await expect(a.page.getByText(ANNOTATION_COMMENT, { exact: true })).toBeVisible();
      expect(readings).toHaveLength(0);
      await expect(
        frame.locator("body").evaluate(() => window.getSelection()?.toString()),
      ).resolves.toBe("");
      // A click on the queued words, Point at off, opens that note; Remove is reached by Tab.
      await focusOn(body);
      await frame
        .locator("p")
        .first()
        .evaluate((element, words) => {
          const node = element.firstChild;
          if (!node) throw new Error("paragraph has no text");
          const start = (node.textContent ?? "").indexOf(words);
          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, start + words.length);
          const box = range.getBoundingClientRect();
          element.dispatchEvent(
            new MouseEvent("click", {
              bubbles: true,
              cancelable: true,
              clientX: box.left + box.width / 2,
              clientY: box.top + box.height / 2,
            }),
          );
        }, ANNOTATION_RANGE);
      await expect(pop).toBeVisible();
      await untilFocused(comment);
      await expect(comment).toHaveValue(ANNOTATION_COMMENT);
      const remove = pop.getByRole("button", { name: NOTE_REMOVE, exact: true });
      await pressKey(comment, "Tab");
      await untilFocused(remove);
      await pressKey(remove, "Enter");
      await expect(pop).toHaveCount(0);
      await expect(a.page.getByText(queuedNotesWords(1), { exact: true })).toBeVisible();
      await untilFocused(pointAt);
      // An empty new note closes on a press outside and queues nothing.
      await selectWords();
      await pressKey(body, "Enter");
      await untilFocused(comment);
      await title.click();
      await expect(pop).toHaveCount(0);
      await expect(a.page.getByText(queuedNotesWords(1), { exact: true })).toBeVisible();
      // A press on a card choice that queues the note does not take the choice.
      await selectWords();
      await pressKey(body, "Enter");
      await comment.fill(ANNOTATION_COMMENT);
      await a.page.getByRole("button", { name: new RegExp(`^${NOTE_GOT_IT_LABEL}`) }).click();
      await expect(a.page.getByText(queuedNotesWords(2), { exact: true })).toBeVisible();
      await expect(shownCard(a.page, ANNOTATION_TITLE)).toBeVisible();
      expect(readings).toHaveLength(0);
      await a.page.getByRole("button", { name: NOTE_REMOVE, exact: true }).nth(1).click();
      await expect(a.page.getByText(queuedNotesWords(1), { exact: true })).toBeVisible();
      await selectWords();
      await expect(annotate).toBeVisible();
      // Native Copy/Paste is exercised only on the disposable Linux CI desktop.
      // Local browser coverage uses a private headless clipboard instead.
      if (process.platform === "linux" && process.env.CI === "true") {
        // A different example value prevents an earlier copy from satisfying this one.
        await readInMain(() =>
          a.app.evaluate(
            ({ clipboard }, previous) => clipboard.writeText(previous),
            ANNOTATION_COMMENT,
          ),
        );
        await pressKey(body, "ControlOrMeta+c");
        await expect
          .poll(() => readInMain(() => a.app.evaluate(({ clipboard }) => clipboard.readText())))
          .toBe(ANNOTATION_RANGE);
      }
      await pressKey(body, "Tab");
      await untilFocused(comment);
      await expect(pop.getByText(ANNOTATION_RANGE, { exact: true })).toBeVisible();
      if (process.platform === "linux" && process.env.CI === "true") {
        await pressKey(comment, "ControlOrMeta+v");
        await expect(comment).toHaveValue(ANNOTATION_RANGE);
      }
      expect(await frame.locator("p").first().getAttribute("data-inf-point-lit")).toBeNull();
      expect(
        await frame
          .locator("body")
          .evaluate(() =>
            Array.from(CSS.highlights.get("inf-point") ?? []).map((range) => range.toString()),
          ),
      ).toEqual([ANNOTATION_RANGE]);
      await comment.click();
      await comment.fill(ANNOTATION_COMMENT);
      await expect(frame.getByText(ANNOTATION_COMMENT, { exact: true })).toHaveCount(0);
      await pressKey(comment, "Escape");
      await expect(comment).toHaveValue(ANNOTATION_COMMENT);
      await pressKey(comment, "Enter");
      await expect(a.page.getByText(queuedNotesWords(2), { exact: true })).toBeVisible();
      expect(await frame.locator("p").first().getAttribute("data-inf-point-queued")).toBeNull();
      expect(
        await body.evaluate(() =>
          Array.from(CSS.highlights.get("inf-point-queued") ?? []).map((range) => range.toString()),
        ),
      ).toEqual([ANNOTATION_RANGE]);
      await cardReply(a.page).field.fill(ANNOTATION_WORDS);
      // While notes wait the send button names them, and its key sends them.
      const send = a.page.getByRole("button", { name: new RegExp(`^${sendNotesLabel(2)}`) });
      await pressKey(send, "Enter");
      await expect.poll(() => readings.length).toBe(1);
      expect(readings[0]).toContain(ANNOTATION_WORDS);
      expect(readings[0]).toContain(`${POINTED_AT}:`);
      expect(readings[0]).toContain(ANNOTATION_RANGE);
      expect(readings[0]).toContain(ANNOTATION_COMMENT);
      const sent = readSavedData(
        a.userDataDir,
        (db) =>
          db
            .prepare(
              "SELECT m.card_id, m.text, m.notes_json FROM card_messages m JOIN cards c ON c.id=m.card_id WHERE c.title=? AND m.who='captain' ORDER BY m.id",
            )
            .all(ANNOTATION_TITLE) as { card_id: string; text: string; notes_json: string }[],
      );
      expect(sent).toHaveLength(1);
      const savedNotes = JSON.parse(sent[0]?.notes_json ?? "[]");
      expect(savedNotes).toHaveLength(2);
      expect(savedNotes[1].span).toBeDefined();
      const thread = cardThread(a.page, sent[0]?.card_id ?? "");
      const said = thread.locator(`[data-thread-message="${author}"]`);
      await expect(said).toBeVisible();
      await expect(said).toContainText(ANNOTATION_ACK);
      await thread.getByRole("button", { name: new RegExp(`^${POINTED_AT} text`) }).click();
      expect(
        await cardBody(a.page, ANNOTATION_TITLE)
          .locator("p")
          .first()
          .getAttribute("data-inf-revision-highlight"),
      ).toBeNull();
      await expect
        .poll(() =>
          cardBody(a.page, ANNOTATION_TITLE)
            .locator("body")
            .evaluate(() =>
              Array.from(CSS.highlights.get("inf-point-reveal") ?? []).map((range) =>
                range.toString(),
              ),
            ),
        )
        .toEqual([ANNOTATION_RANGE]);
      // The popover's modified Enter sends a range across two parts with no comment.
      await focusOn(cardBodyElement(a.page, ANNOTATION_TITLE));
      const paragraphs = cardBody(a.page, ANNOTATION_TITLE).locator("p");
      await paragraphs.first().evaluate(
        (element, { startWords, endWords }) => {
          const last = element.nextElementSibling;
          if (!element.firstChild || !last?.firstChild) throw new Error("missing range endpoints");
          const range = document.createRange();
          range.setStart(element.firstChild, (element.textContent ?? "").indexOf(startWords));
          range.setEnd(last.firstChild, endWords.length);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
        },
        { startWords: ANNOTATION_RANGE, endWords: ANNOTATION_RANGE_END },
      );
      await paragraphs.first().dispatchEvent("pointerup");
      await expect(annotate).toBeVisible();
      await pressKey(cardBody(a.page, ANNOTATION_TITLE).locator("body"), "Enter");
      await untilFocused(comment);
      await pressKey(comment, "ControlOrMeta+Enter");
      await expect.poll(() => readings.length).toBe(2);
      expect(readings[1]).toContain(ANNOTATION_RANGE_END);
    } finally {
      await a.close();
    }
  });
}

/** Where the viewer draws its picture once it has stopped moving: two reads in a row agree. */
async function drawnAt(picture: Locator) {
  let last = "";
  await expect
    .poll(async () => {
      const read = JSON.stringify(await picture.boundingBox());
      const same = read === last && read !== "null";
      last = read;
      return same;
    })
    .toBe(true);
  return JSON.parse(last) as { x: number; y: number; width: number; height: number };
}

const BOX_COMMENT = "Make this meter wider";
const LINE_COMMENT = "Underline the total";
const KEYS_COMMENT = "Name the viewer here";

/**
 * Intent: the accepted Point at plan's place in a picture - "a journey that
 * marks by keys and by pointer and reads the author's side". Promised result:
 * the crewmate reads each numbered mark's place and gets one picture per
 * marked picture, and nothing leaves before the send. Data: the crewmate's
 * real card of working-copy pictures and a drawing (`cardPictures`).
 * Completion signal: the provider request that carries the Pointed at lines.
 * Portable: no sign-in; the pointer is the window's own, on the viewer, which
 * is no frame. One disposable app.
 */
test("the crewmate receives marks made by pointer and by keys, one marked picture per picture", async () => {
  const a = await launchApp({ withMockProvider: true, scenarios: [cardPictures] });
  try {
    const { page, app } = a;
    await encodeInBrowser(page, WORKING_COPY_PICTURES);
    const prompt = promptInput(page);
    await prompt.fill(`${SPAWN_PROMPT_MARKER} ${CARD_PICTURES_PROMPT_MARKER}`);
    await pressKey(prompt, "Enter");
    await expect(pager(page, 4)).toBeVisible({ timeout: 30_000 });
    const title = PICTURE_CARD_TITLES.mixed;
    await showCard(page, title);
    const frame = cardBody(page, title);
    const viewer = page.locator("[data-picture-viewer]");
    const shown = viewer.locator("[data-picture-image]");
    const marks = viewer.locator("[data-picture-marks]");
    const pointAt = viewer.locator("[data-viewer-point-at]");
    const pop = page.getByRole("dialog", { name: new RegExp(`^${ANNOTATE} `) });
    const comment = pop.getByRole("textbox", { name: NOTE_COMMENT_LABEL });
    const reads = () =>
      (a.mockProvider?.requestBodies() ?? []).filter((body) =>
        providerMessages(body)
          .findLast((message) => message.role === "user")
          ?.text.includes(`${POINTED_AT}:`),
      );

    // By pointer: a box dragged on the wide picture, then a line drawn on it.
    await clickInBody(frame.getByRole("img", { name: WIDE_PICTURE.alt }));
    await expect(viewer).toBeVisible();
    await expect.poll(() => shown.evaluate((image: HTMLImageElement) => image.complete)).toBe(true);
    await pointAt.click();
    await expect(marks).toHaveAttribute("data-picture-marking", "box");
    const drawn = await drawnAt(shown);
    const at = (x: number, y: number) => ({
      x: drawn.x + drawn.width * x,
      y: drawn.y + drawn.height * y,
    });
    const from = at(0.2, 0.25);
    const to = at(0.4, 0.75);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up();
    await expect(pop).toBeVisible();
    // The picture's caption is the note's excerpt, and Point at turned off once it marked.
    await expect(pop.getByText(WIDE_PICTURE.alt, { exact: true })).toBeVisible();
    await expect(pointAt).toHaveAttribute("aria-pressed", "false");
    await typeInto(comment, BOX_COMMENT);
    await pressKey(comment, "Enter");
    await expect(pop).toHaveCount(0);
    await expect(marks).toHaveAttribute("data-picture-marks", "1");
    await pointAt.click();
    await viewer.locator('[data-viewer-tool="line"]').click();
    await expect(marks).toHaveAttribute("data-picture-marking", "line");
    const start = at(0.6, 0.5);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (let step = 1; step <= 8; step++) {
      const next = at(0.6 + step * 0.02, 0.5 + (step % 2) * 0.1);
      await page.mouse.move(next.x, next.y);
    }
    await page.mouse.up();
    await expect(pop).toBeVisible();
    await typeInto(comment, LINE_COMMENT);
    await pressKey(comment, "Enter");
    await expect(marks).toHaveAttribute("data-picture-marks", "1 2");
    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);

    // By keys: the drawing opens with Enter, the command's key turns Point at on, the arrows
    // move a box, Shift with them sizes it and Enter opens its note.
    await focusOn(frame.getByRole("img", { name: "Card, card page and viewer" }));
    await page.keyboard.press("Enter");
    await expect(viewer.locator("[data-picture-caption]")).toHaveText(CARD_DIAGRAM.caption);
    await pressWindowKey(app, "A", ["meta", "shift"]);
    await expect(pointAt).toHaveAttribute("aria-pressed", "true");
    for (const key of ["ArrowRight", "ArrowRight", "ArrowDown", "Shift+ArrowRight", "Enter"])
      await page.keyboard.press(key);
    await expect(pop).toBeVisible();
    await untilFocused(comment);
    await typeInto(comment, KEYS_COMMENT);
    await pressKey(comment, "Enter");
    // The third mark is the drawing's first: the other two are on their own picture.
    await expect(marks).toHaveAttribute("data-picture-marks", "3");
    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);

    // Three notes wait with their small marked copies, and nothing has left.
    await expect(page.getByText(queuedNotesWords(3), { exact: true })).toBeVisible();
    await expect(page.locator("[data-marked-copy]")).toHaveCount(3);
    expect(reads()).toHaveLength(0);
    const send = page.getByRole("button", { name: new RegExp(`^${sendNotesLabel(3)}`) });
    await pressKey(send, "Enter");
    await expect.poll(() => reads().length).toBeGreaterThan(0);
    const request = reads()[0] ?? "";
    const served =
      providerMessages(request).findLast((message) => message.role === "user")?.text ?? "";

    const sent = readSavedData(
      a.userDataDir,
      (db) =>
        db
          .prepare(
            "SELECT m.card_id, m.notes_json FROM card_messages m JOIN cards c ON c.id=m.card_id WHERE c.title=? AND m.who='captain' ORDER BY m.id",
          )
          .all(title) as { card_id: string; notes_json: string }[],
    );
    expect(sent).toHaveLength(1);
    const notes = JSON.parse(sent[0]?.notes_json ?? "[]") as CardNote[];
    const [boxed, lined, keyed] = notes;
    const wide = { width: WIDE_PICTURE.width, height: WIDE_PICTURE.height };
    expect(boxed).toMatchObject({
      kind: "picture",
      excerpt: WIDE_PICTURE.alt,
      comment: BOX_COMMENT,
    });
    expect(boxed?.place).toMatchObject(wide);
    // The dragged box is kept in the picture's own pixels. The pointer is aimed in window
    // pixels, so the kept box lies between the aimed one drawn two window pixels smaller and
    // two larger.
    const slack = 2 * Math.ceil(wide.width / drawn.width);
    const aimedBy = (grow: number) =>
      boxPlace(
        wide,
        { x: wide.width * 0.2 - grow, y: wide.height * 0.25 - grow },
        { x: wide.width * 0.4 + grow, y: wide.height * 0.75 + grow },
      ).box as Rect;
    const kept = boxed?.place?.box as Rect;
    expect(within(kept, aimedBy(slack))).toEqual([]);
    expect(within(aimedBy(-slack), kept)).toEqual([]);
    expect(lined?.place?.lines?.[0]?.length).toBeGreaterThan(2);
    expect(lined?.place?.box).toBeUndefined();
    const diagram = { width: CARD_DIAGRAM.width, height: CARD_DIAGRAM.height };
    const step = keyStep(diagram);
    expect(keyed).toMatchObject({
      kind: "drawing",
      excerpt: CARD_DIAGRAM.caption,
      comment: KEYS_COMMENT,
      place: sizedBox(movedBox(movedBox(middleBox(diagram), step, 0), 0, step), step, 0),
    });

    // The author reads each numbered mark's place, and one marked picture per marked picture.
    const lines = pointedAtLines(notes);
    expect(lines).toHaveLength(5);
    expect(lines.at(-1)).toBe(MARKED_PICTURES_LINE);
    for (const line of lines) expect(served).toContain(line);
    expect(newestPictures(request)).toHaveLength(2);

    // A press on a sent note opens the viewer at its mark, numbered as its reply numbered it.
    const thread = cardThread(page, sent[0]?.card_id ?? "");
    await thread
      .getByRole("button", { name: noteLabel(keyed as CardNote, 3), exact: true })
      .click();
    await expect(viewer.locator("[data-picture-caption]")).toHaveText(CARD_DIAGRAM.caption);
    await expect(marks).toHaveAttribute("data-picture-marks", "3");
  } finally {
    await a.close();
  }
});

/**
 * Intent: INF-5608's approved plan, piece 1, from the captain's "attachments and queued
 * annotations cannot be sent along with an action button click ... can we allow sending these
 * queued stuff along with an action button click?". A queued text note, a marked picture and a
 * pasted picture wait in the card's field, the button stays lit, and one press by key sends them
 * all: the crewmate reads every note's place and gets both pictures in the same turn.
 */
test("a button pressed by key carries the queued notes, the marked picture and a pasted one", async () => {
  const a = await launchApp({ withMockProvider: true, scenarios: [cardPictures] });
  try {
    const { page, app } = a;
    await encodeInBrowser(page, WORKING_COPY_PICTURES);
    const prompt = promptInput(page);
    await prompt.fill(`${SPAWN_PROMPT_MARKER} ${CARD_PICTURES_PROMPT_MARKER}`);
    await pressKey(prompt, "Enter");
    await expect(pager(page, 4)).toBeVisible({ timeout: 30_000 });
    const title = PICTURE_CARD_TITLES.mixed;
    await showCard(page, title);
    const frame = cardBody(page, title);
    const body = frame.locator("body");
    const viewer = page.locator("[data-picture-viewer]");
    const shown = viewer.locator("[data-picture-image]");
    const pointAt = viewer.locator("[data-viewer-point-at]");
    const pop = page.getByRole("dialog", { name: new RegExp(`^${ANNOTATE} `) });
    const comment = pop.getByRole("textbox", { name: NOTE_COMMENT_LABEL });
    const reads = () =>
      (a.mockProvider?.requestBodies() ?? []).filter((request) =>
        providerMessages(request)
          .findLast((message) => message.role === "user")
          ?.text.includes(`${POINTED_AT}:`),
      );

    // A box marked on the wide picture.
    await clickInBody(frame.getByRole("img", { name: WIDE_PICTURE.alt }));
    await expect(viewer).toBeVisible();
    await expect.poll(() => shown.evaluate((image: HTMLImageElement) => image.complete)).toBe(true);
    await pointAt.click();
    const drawn = await drawnAt(shown);
    await page.mouse.move(drawn.x + drawn.width * 0.2, drawn.y + drawn.height * 0.25);
    await page.mouse.down();
    await page.mouse.move(drawn.x + drawn.width * 0.4, drawn.y + drawn.height * 0.75, {
      steps: 6,
    });
    await page.mouse.up();
    await expect(pop).toBeVisible();
    await typeInto(comment, BOX_COMMENT);
    await pressKey(comment, "Enter");
    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);

    // A note on the card's first words, by keys.
    await runFromSearch(app, page, "cards.point-at");
    await pressKey(body, "ArrowDown");
    await pressKey(body, "Enter");
    await expect(pop).toBeVisible();
    await typeInto(comment, KEYS_COMMENT);
    await pressKey(comment, "Enter");
    await expect(page.getByText(queuedNotesWords(2), { exact: true })).toBeVisible();

    // A pasted picture joins them; Got it stays lit, and the line names all three.
    const { field } = cardReply(page);
    await pastePictures(field, [{ name: "settings-now.png" }]);
    await expect(page.locator("[data-card-carried]")).toHaveText(
      carriedWithChoiceWords({ pictures: 1, files: 0, notes: 2 }) ?? "",
    );
    const gotIt = page.getByRole("button", { name: new RegExp(`^${NOTE_GOT_IT_LABEL}`) });
    await expect(gotIt).not.toHaveAttribute("aria-disabled", "true");
    expect(reads()).toHaveLength(0);

    // One press by key sends them, and the field empties.
    await focusOn(field);
    await pressWindowKey(app, "1", ["meta"]);
    await expect(shownCard(page, title)).toHaveCount(0);
    await expect.poll(() => reads().length).toBeGreaterThan(0);
    const request = reads()[0] ?? "";
    const served =
      providerMessages(request).findLast((message) => message.role === "user")?.text ?? "";
    const sent = readSavedData(
      a.userDataDir,
      (db) =>
        db
          .prepare(
            "SELECT m.notes_json, m.text FROM card_messages m JOIN cards c ON c.id=m.card_id WHERE c.title=? AND m.who='captain' ORDER BY m.id",
          )
          .all(title) as { notes_json: string; text: string }[],
    );
    expect(sent).toHaveLength(1);
    const notes = JSON.parse(sent[0]?.notes_json ?? "[]") as CardNote[];
    expect(notes.map((note) => note.comment)).toEqual([BOX_COMMENT, KEYS_COMMENT]);
    for (const line of pointedAtLines(notes)) expect(served).toContain(line);
    expect(sent[0]?.text).toContain("settings-now.png");
    // The marked copy of the wide picture and the pasted picture, in the same turn.
    expect(newestPictures(request)).toHaveLength(2);
  } finally {
    await a.close();
  }
});
