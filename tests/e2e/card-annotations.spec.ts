import { expect, test } from "@playwright/test";
import { NOTE_GOT_IT_LABEL } from "../../src/shared/cardLeave";
import {
  ANNOTATE,
  EMPTY_NOTE,
  NOTE_COMMENT_LABEL,
  NOTE_EDIT,
  NOTE_REMOVE,
  POINT_AT,
  POINTED_AT,
  queuedNotesWords,
  sendNotesLabel,
} from "../../src/shared/cardNotes";
import {
  ANNOTATION_COMMENT,
  ANNOTATION_RANGE,
  ANNOTATION_RANGE_END,
  ANNOTATION_TITLE,
  ANNOTATION_WORDS,
} from "../fixtures/cardAnnotations";
import { cardBody, cardBodyElement } from "./frames";
import { launchApp } from "./launch";
import { readInMain } from "./mainProcess";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { readSavedData } from "./savedData";
import {
  ANNOTATION_ACK,
  ANNOTATION_CREW_PROMPT,
  ANNOTATION_FIRSTMATE_PROMPT,
  cardAnnotations,
} from "./scenarios/cardAnnotations";
import { cardReply, cardThread, shownCard } from "./stack";
import { focusOn, pressKey, runFromSearch, typeInto, untilFocused } from "./windowKeys";

/**
 * Intent: the captain-approved desktop annotation plan, and INF-3786's approved
 * plan (Annotate on selected words, keep a note on a press outside, open a note
 * from its mark, Remove in the editor, Send N notes). Real card text from its
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
      await focusOn(cardBodyElement(a.page, ANNOTATION_TITLE));
      await frame.locator('input[name="checks"]').dispatchEvent("click");
      await expect(frame.locator('input[name="checks"]')).toBeChecked();
      await expect(pop).toHaveCount(0);
      await frame.locator("p").nth(1).dispatchEvent("click");
      await expect(pop).toBeVisible();
      await pressKey(comment, "Enter");
      await pointAt.click();
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
      await pressKey(comment, "Escape");
      await expect(pop).toHaveCount(0);
      await expect(shownCard(a.page, ANNOTATION_TITLE)).toBeVisible();
      await runFromSearch(a.app, a.page, "cards.point-at");
      await expect(pointAt).toHaveAttribute("aria-pressed", "false");
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
