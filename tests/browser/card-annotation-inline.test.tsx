import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import {
  NOTE_COMMENT_LABEL,
  NOTE_REMOVE,
  POINT_AT,
  queuedNotesWords,
} from "../../src/shared/cardNotes";
import { ANNOTATION_RANGE, ANNOTATION_TITLE, ANNOTATION_WORDS } from "../fixtures/cardAnnotations";
import { fakeBridge } from "./bridge";
import { seededHome } from "./freshHome";
import { bodyDrawn, inCardBody, stageAtRest } from "./stack";
import { openSize, openWindow } from "./window";

/** Captain's approved prototype: cursor outside the bordered field, bottom-aligned, with a visible choices-row count. */
test("the reply-row cursor keeps its placement, keyboard action and visible unsent count", async () => {
  await openSize();
  await openWindow(fakeBridge(await seededHome()));
  const frame = await bodyDrawn(ANNOTATION_TITLE);
  await stageAtRest();
  const point = page.getByRole("button", { name: POINT_AT, exact: true });
  const reply = page.getByRole("textbox", { name: "Reply to this card", exact: true });
  await expect.element(point).toBeVisible();
  const button = point.element();
  const field = reply.element();
  expect(button.textContent).toBe("");
  expect(button.querySelector("svg")).not.toBeNull();
  await expect.element(point).not.toHaveAttribute("title");
  const fieldBox = () => {
    const border = field.parentElement;
    if (!border) throw new Error("missing reply field surface");
    return border.getBoundingClientRect();
  };
  const besideField = () => {
    const icon = button.getBoundingClientRect(),
      border = fieldBox();
    expect(icon.right).toBeLessThanOrEqual(border.left);
    expect(icon.bottom).toBe(border.bottom);
  };
  besideField();
  const singleLineHeight = fieldBox().height;
  await userEvent.fill(reply, `${ANNOTATION_RANGE}\n${ANNOTATION_WORDS}`);
  await expect.poll(() => fieldBox().height).toBeGreaterThan(singleLineHeight);
  besideField();
  await userEvent.fill(reply, "");

  button.focus();
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement).toBe(field);
  await userEvent.click(point);
  await expect.element(point).toHaveAttribute("aria-pressed", "true");
  await userEvent.click(point);
  await expect.element(point).toHaveAttribute("aria-pressed", "false");
  button.focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(point).toHaveAttribute("aria-pressed", "true");

  frame.focus();
  await inCardBody(
    ANNOTATION_TITLE,
    (words) => {
      const paragraph = document.querySelector("p"),
        node = paragraph?.firstChild;
      if (!paragraph || !node) throw new Error("missing annotation example paragraph");
      const start = (node.textContent ?? "").indexOf(words);
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + words.length);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      paragraph.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    },
    ANNOTATION_RANGE,
  );
  const comment = page.getByRole("textbox", { name: NOTE_COMMENT_LABEL });
  await expect.element(comment).toBeVisible();
  await userEvent.click(comment);
  await userEvent.keyboard("{Enter}");
  const count = page.getByText(queuedNotesWords(1), { exact: true });
  await expect.element(count).toBeVisible();
  expect(count.element().closest("[data-card-actions]")).not.toBeNull();
  await userEvent.click(page.getByRole("button", { name: NOTE_REMOVE, exact: true }));
  await expect.element(count).not.toBeInTheDocument();
});
