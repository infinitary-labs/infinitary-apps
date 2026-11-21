import { expect, test } from "@playwright/test";
import { ANNOTATE, NOTE_COMMENT_LABEL } from "../../src/shared/cardNotes";
import { ANNOTATION_TITLE } from "../fixtures/cardAnnotations";
import { DICTATION_KEY, holdPastTheHold, voiceSettled } from "./dictation";
import { cardBody } from "./frames";
import { launchApp } from "./launch";
import { promptInput } from "./prompt";
import { ANNOTATION_FIRSTMATE_PROMPT, cardAnnotations } from "./scenarios/cardAnnotations";
import { provideSpeech, waitForSpeechCapture } from "./speech";
import { cardReply, shownCard } from "./stack";
import { focusOn, pressKey, runFromSearch, typeInto } from "./windowKeys";

/**
 * Intent: INF-5369's approved plan, piece 2, "the dictation key writes into
 * whichever field has focus": with focus in a card's reply or a note's
 * comment, the dictation key records into that field, its words land at the
 * field's caret, the field keeps focus, and the main message stays as it was;
 * Esc while the field records abandons the recording and keeps its draft
 * (docs/composer.md, "Where the words go"). A real card from the note
 * journey's scenario, the real keys, the stand-in voice helper and supplied
 * PCM (`speech.ts`). Voice stays in the serial desktop lane.
 */
const TRANSCRIPT = "an ocean of stars";
const REPLY_DRAFT = "Ship it once";
const NOTE_DRAFT = "Make this bold";

test("the dictation key writes into a card's reply and a note's comment by keys", async () => {
  const a = await launchApp({
    withMockProvider: true,
    voiceTranscript: TRANSCRIPT,
    scenarios: [cardAnnotations([])],
  });
  try {
    const { page, app } = a;
    await provideSpeech(page);
    await voiceSettled(page);
    const prompt = promptInput(page);
    await prompt.fill(ANNOTATION_FIRSTMATE_PROMPT);
    await pressKey(prompt, "Enter");
    await expect(shownCard(page, ANNOTATION_TITLE)).toBeVisible();
    await expect(prompt).toHaveValue("");
    const reply = cardReply(page);
    const replyMark = reply.row.locator("[data-dictation-mark]");

    await test.step("a hold in the reply writes at its caret", async () => {
      await focusOn(reply.field);
      await typeInto(reply.field, REPLY_DRAFT);
      await page.keyboard.down(DICTATION_KEY);
      await expect(replyMark).toHaveAttribute("data-dictation-mark", "recording");
      await expect(reply.field).not.toBeEditable();
      await expect(reply.field).toHaveValue(REPLY_DRAFT);
      await waitForSpeechCapture(page);
      await holdPastTheHold(page);
      await page.keyboard.up(DICTATION_KEY);
      const landed = `${REPLY_DRAFT} ${TRANSCRIPT} `;
      await expect(reply.field).toHaveValue(landed);
      await expect(reply.field).toBeFocused();
      expect(await reply.field.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(
        landed.length,
      );
      await expect(replyMark).toHaveCount(0);
      await expect(prompt).toHaveValue("");
    });

    await test.step("Esc while the reply records abandons it and keeps the draft", async () => {
      const draft = await reply.field.inputValue();
      await page.keyboard.down(DICTATION_KEY);
      await page.keyboard.up(DICTATION_KEY);
      await expect(replyMark).toHaveAttribute("data-dictation-mark", "recording");
      await waitForSpeechCapture(page);
      await pressKey(reply.field, "Escape");
      await expect(replyMark).toHaveCount(0);
      await expect(reply.field).toBeEditable();
      await expect(reply.field).toHaveValue(draft);
      await expect(reply.field).toBeFocused();
      // The Escape went to the recording, never on to put the card away.
      await expect(shownCard(page, ANNOTATION_TITLE)).toBeVisible();
      await expect(prompt).toHaveValue("");
    });

    await test.step("a tap in a note's comment writes at its caret", async () => {
      const body = cardBody(page, ANNOTATION_TITLE).locator("body");
      const pop = page.getByRole("dialog", { name: new RegExp(`^${ANNOTATE} `) });
      const comment = pop.getByRole("textbox", { name: NOTE_COMMENT_LABEL });
      const noteMark = pop.locator("[data-dictation-mark]");
      await runFromSearch(app, page, "cards.point-at");
      await pressKey(body, "ArrowDown");
      await pressKey(body, "Enter");
      await expect(comment).toBeFocused();
      await typeInto(comment, NOTE_DRAFT);
      await page.keyboard.down(DICTATION_KEY);
      await page.keyboard.up(DICTATION_KEY);
      await expect(noteMark).toHaveAttribute("data-dictation-mark", "recording");
      await expect(comment).not.toBeEditable();
      await waitForSpeechCapture(page);
      await page.keyboard.down(DICTATION_KEY);
      await page.keyboard.up(DICTATION_KEY);
      const landed = `${NOTE_DRAFT} ${TRANSCRIPT} `;
      await expect(comment).toHaveValue(landed);
      await expect(comment).toBeFocused();
      expect(await comment.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(
        landed.length,
      );
      await expect(prompt).toHaveValue("");
    });
  } finally {
    await a.close();
  }
});
