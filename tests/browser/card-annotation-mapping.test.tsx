import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { NOTE_COMMENT_LABEL, NOTE_EDIT } from "../../src/shared/cardNotes";
import { cardNavigationParts } from "../../src/shared/cardParts";
import { splitSettleFacts } from "../../src/shared/cards";
import {
  ANNOTATION_COMMENT,
  ANNOTATION_RANGE,
  ANNOTATION_RANGE_END,
  ANNOTATION_TITLE,
} from "../fixtures/cardAnnotations";
import { fakeBridge } from "./bridge";
import { seededHome } from "./freshHome";
import { bodyDrawn, inCardBody, stageAtRest } from "./stack";
import { openSize, openWindow } from "./window";

/** Intent: the requested repeated-part repair protects actual frame highlights, not the disposable reader's signature. */
test("a refreshed merge card keeps the repeated occurrence through selection, queue, Edit, reveal and both range endpoints", async () => {
  await openSize();
  await openWindow(fakeBridge(await seededHome()));
  const frame = await bodyDrawn(ANNOTATION_TITLE);
  await stageAtRest();
  const { useShellStore } = await import("../../src/renderer/src/app/store");
  const card = useShellStore.getState().cards.find((card) => card.title === ANNOTATION_TITLE);
  if (!card) throw new Error("missing actual merge example");
  const split = splitSettleFacts(card.body);
  if (!split) throw new Error("missing host-refreshed task facts");
  const source = cardNavigationParts(card.body),
    rendered = cardNavigationParts(split.body);
  const start = source.filter((part) => part.key === source[0]?.key).at(-1);
  const end = source.filter((part) => part.key === source[1]?.key).at(-1);
  const renderedStart = rendered.filter((part) => part.key === start?.key).at(-1);
  const renderedEnd = rendered.filter((part) => part.key === end?.key).at(-1);
  if (!start || !end || !renderedStart || !renderedEnd)
    throw new Error("missing repeated real paragraphs");
  expect(start.start).toBeGreaterThan(renderedStart.start);
  const comment = page.getByRole("textbox", { name: NOTE_COMMENT_LABEL });
  const readHighlights = () =>
    inCardBody(ANNOTATION_TITLE, () =>
      Object.fromEntries(
        ["inf-point", "inf-point-queued", "inf-point-reveal"].map((name) => [
          name,
          Array.from(CSS.highlights.get(name) ?? []).map((range) => ({
            text: range.toString(),
            first: Number(
              range.startContainer.parentElement
                ?.closest("[data-inf-target]")
                ?.getAttribute("data-inf-target"),
            ),
            last: Number(
              range.endContainer.parentElement
                ?.closest("[data-inf-target]")
                ?.getAttribute("data-inf-target"),
            ),
          })),
        ]),
      ),
    );
  const select = async (across = false) => {
    frame.focus();
    await expect.poll(() => document.activeElement === frame).toBe(true);
    await inCardBody(
      ANNOTATION_TITLE,
      ({ words, endWords, across }) => {
        const paragraph = document.querySelectorAll("p")[2],
          last = across ? paragraph?.nextElementSibling : paragraph;
        if (!paragraph?.firstChild || !last?.firstChild)
          throw new Error("missing real frame endpoints");
        const offset = (paragraph.firstChild.textContent ?? "").indexOf(words);
        const range = document.createRange();
        range.setStart(paragraph.firstChild, offset);
        range.setEnd(last.firstChild, across ? endWords.length : offset + words.length);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        paragraph.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      },
      { words: ANNOTATION_RANGE, endWords: ANNOTATION_RANGE_END, across },
    );
    // INF-3786: a selection only offers Annotate; Tab in the card opens its comment.
    await userEvent.keyboard("{Tab}");
    await expect.element(comment).toBeVisible();
  };
  await select();
  const exact = [{ text: ANNOTATION_RANGE, first: renderedStart.start, last: renderedStart.start }];
  await expect.poll(async () => (await readHighlights())["inf-point"]).toEqual(exact);
  expect(useShellStore.getState().annotationPick?.note.start).toBe(start.start);
  await expect.poll(() => document.activeElement === comment.element()).toBe(true);
  await userEvent.keyboard("{Enter}");
  await expect.poll(async () => (await readHighlights())["inf-point-queued"]).toEqual(exact);
  await userEvent.click(page.getByRole("button", { name: NOTE_EDIT, exact: true }));
  await expect.element(comment).toBeVisible();
  await expect.poll(async () => (await readHighlights())["inf-point"]).toEqual(exact);
  await userEvent.fill(comment, ANNOTATION_COMMENT);
  await userEvent.keyboard("{Enter}");
  const anchor = document.querySelector<HTMLButtonElement>(
    ".inf-queued-note .inf-note-anchor button",
  );
  if (!anchor) throw new Error("missing actual queued anchor");
  await userEvent.click(anchor);
  await expect.poll(async () => (await readHighlights())["inf-point-reveal"]).toEqual(exact);

  await select(true);
  const selected = await inCardBody(ANNOTATION_TITLE, () =>
    window.getSelection()?.getRangeAt(0).toString(),
  );
  await expect
    .poll(async () => (await readHighlights())["inf-point"])
    .toEqual([{ text: selected, first: renderedStart.start, last: renderedEnd.start }]);
  await expect.poll(() => document.activeElement === comment.element()).toBe(true);
  await userEvent.keyboard("{Enter}");
  const notes = useShellStore.getState().replyNotes[card.id];
  expect(notes).toHaveLength(2);
  expect(notes?.[1]).toMatchObject({
    start: start.start,
    span: { endPart: end.start },
    endKey: end.key,
  });
  await expect
    .poll(async () => (await readHighlights())["inf-point-queued"])
    .toEqual([...exact, { text: selected, first: renderedStart.start, last: renderedEnd.start }]);
});
