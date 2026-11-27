import { expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";

import { ANNOTATE, NOTE_COMMENT_LABEL, POINT_AT } from "../../src/shared/cardNotes";
import { ANNOTATION_OPTION_WORDS, ANNOTATION_TITLE } from "../fixtures/cardAnnotations";
import { fakeBridge } from "./bridge";
import { seededHome } from "./freshHome";
import { bodyDrawn, inCardBody, stageAtRest } from "./stack";
import { openSize, openWindow } from "./window";

/**
 * The captain's report: words selected in a card's question offer no Annotate. An option's
 * words sit in its label, and the frame refused every selection inside a label.
 */
test("words dragged across in an option offer Annotate and leave the option unticked", async () => {
  await openSize();
  await openWindow(fakeBridge(await seededHome()));
  await bodyDrawn(ANNOTATION_TITLE);
  await stageAtRest();
  const { useShellStore } = await import("../../src/renderer/src/app/store");
  const annotate = page.getByRole("button", { name: new RegExp(`^${ANNOTATE}`) });
  const comment = page.getByRole("textbox", { name: NOTE_COMMENT_LABEL });
  const ticked = () =>
    inCardBody(
      ANNOTATION_TITLE,
      () => document.querySelector<HTMLInputElement>("input[name=checks]")?.checked,
    );
  const dragOption = () =>
    commands.dragAcrossWordsInFrame(`${ANNOTATION_TITLE} body`, "label", ANNOTATION_OPTION_WORDS);

  await dragOption();
  expect(await inCardBody(ANNOTATION_TITLE, () => window.getSelection()?.toString())).toBe(
    ANNOTATION_OPTION_WORDS,
  );
  await expect.element(annotate).toBeVisible();
  expect(useShellStore.getState().annotationOffer?.note).toMatchObject({
    kind: "text",
    excerpt: ANNOTATION_OPTION_WORDS,
  });
  expect(await ticked()).toBe(false);
  await userEvent.keyboard("{Escape}");
  await expect.element(annotate).not.toBeInTheDocument();

  // With Point at on, the same drag opens the note editor on those words.
  await userEvent.click(page.getByRole("button", { name: new RegExp(`^${POINT_AT}`) }));
  await dragOption();
  await expect.element(comment).toBeVisible();
  expect(useShellStore.getState().annotationPick?.note).toMatchObject({
    kind: "text",
    excerpt: ANNOTATION_OPTION_WORDS,
  });
  expect(await ticked()).toBe(false);
  await userEvent.keyboard("{Escape}");
  await expect.element(comment).not.toBeInTheDocument();

  // A click on the choice's words, even with Point at on, still ticks it and opens no note.
  await userEvent.click(page.getByRole("button", { name: new RegExp(`^${POINT_AT}`) }));
  await commands.clickWordsInFrame(`${ANNOTATION_TITLE} body`, "label", ANNOTATION_OPTION_WORDS);
  await expect.poll(ticked).toBe(true);
  expect(comment.query()).toBeNull();
  expect(useShellStore.getState().annotationPick).toBeNull();
});
