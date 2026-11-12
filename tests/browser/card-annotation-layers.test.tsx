import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { NOTE_COMMENT_LABEL } from "../../src/shared/cardNotes";
import {
  ANNOTATION_COMMENT,
  ANNOTATION_RANGE,
  ANNOTATION_TITLE,
} from "../fixtures/cardAnnotations";
import { fakeBridge } from "./bridge";
import { seededHome } from "./freshHome";
import { bodyDrawn, inCardBody, stageAtRest } from "./stack";
import { openSize, openWindow } from "./window";

/** Bug: an annotation obscured host modals; opening them must retain its comment without changing Copy. */
test("picture viewer and command search cover the annotation popover without clearing its draft", async () => {
  await openSize();
  await openWindow(fakeBridge(await seededHome()));
  const frame = await bodyDrawn(ANNOTATION_TITLE);
  await stageAtRest();
  const { useShellStore } = await import("../../src/renderer/src/app/store");
  const { runWindowCommand } = await import("../../src/renderer/src/app/shellCommands");
  frame.focus();
  await inCardBody(
    ANNOTATION_TITLE,
    (words) => {
      const p = document.querySelector("p"),
        node = p?.firstChild;
      if (!p || !node) throw new Error("missing actual paragraph");
      const start = (node.textContent ?? "").indexOf(words);
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + words.length);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      p.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    },
    ANNOTATION_RANGE,
  );
  // INF-3786: a selection only offers Annotate; Enter in the card opens its comment.
  await userEvent.keyboard("{Enter}");
  const comment = page.getByRole("textbox", { name: NOTE_COMMENT_LABEL });
  await expect.element(comment).toBeVisible();
  await userEvent.fill(comment, ANNOTATION_COMMENT);
  const pick = useShellStore.getState().annotationPick;
  const coversPick = (modal: Element) => {
    const popover = comment.element().closest('[role="dialog"]');
    if (!popover) throw new Error("missing retained host popover");
    const box = popover.getBoundingClientRect();
    return modal.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  };
  frame.focus();
  await inCardBody(ANNOTATION_TITLE, () => {
    window.getSelection()?.removeAllRanges();
    document.querySelector<SVGElement>("figure svg")?.focus();
  });
  await userEvent.keyboard("{Enter}");
  const viewer = page.getByRole("dialog", { name: `Pictures from ${ANNOTATION_TITLE}` });
  await expect.element(viewer).toBeVisible();
  expect.soft(coversPick(viewer.element())).toBe(true);
  await userEvent.keyboard("{Escape}");
  await expect.element(viewer).not.toBeInTheDocument();
  expect(runWindowCommand("commands.search")).toBe(true);
  const search = page.getByRole("dialog", { name: "Search commands" });
  await expect.element(search).toBeVisible();
  const backdrop = search.element().closest("[data-command-search-backdrop]");
  if (!backdrop) throw new Error("missing actual search modal backdrop");
  expect.soft(coversPick(backdrop)).toBe(true);
  await userEvent.keyboard("{Escape}");
  await expect.element(search).not.toBeInTheDocument();
  expect(useShellStore.getState().annotationPick).toEqual(pick);
  await expect.element(comment).toHaveValue(ANNOTATION_COMMENT);
});
