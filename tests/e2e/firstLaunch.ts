import { expect, type Page } from "@playwright/test";
import { FIRST_CREWMATE_TITLE } from "@shared/firstCrewmateNote";
import { WELCOME_TITLE } from "@shared/welcome";
import { promptInput, TASK_PROMPT_SELECTOR } from "./prompt";
import { expectNoCard, noteDone, shownCard } from "./stack";

export type WelcomeReadinessEvent = {
  kind: "cards" | "ready";
  ids: string[];
  cardVisible?: boolean;
};
/**
 * What the page's own typist met before the gate showed (`reloadTypingEarly`):
 * how often it found the main input, and the words the input took.
 */
export type EarlyInput = { seen: number; took: string[] };
declare global {
  interface Window {
    welcomeReadiness: WelcomeReadinessEvent[];
    earlyInput: EarlyInput;
  }
}

/**
 * Starts the window again on the same profile with someone typing and
 * sending at the first moment the main input takes words, before the shell
 * has read whether the gate is up. That moment is shorter than Playwright's
 * round trip, so the page types itself: the field's own insertText and
 * Enter run the real handlers. It stops once the gate shows; read what it
 * met from `window.earlyInput`.
 */
export async function reloadTypingEarly(page: Page): Promise<void> {
  await page.addInitScript(
    ({ selector, words }) => {
      window.earlyInput = { seen: 0, took: [] };
      const observer = new MutationObserver(() => {
        if (document.querySelector('[data-first-run-gate="open"]')) {
          observer.disconnect();
          return;
        }
        const input = document.querySelector<HTMLTextAreaElement>(selector);
        if (!input) return;
        window.earlyInput.seen += 1;
        if (input.disabled || window.earlyInput.took.length > 0) return;
        input.focus();
        document.execCommand("insertText", false, words);
        window.earlyInput.took.push(input.value);
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      observer.observe(document, { attributes: true, childList: true, subtree: true });
    },
    { selector: TASK_PROMPT_SELECTOR, words: "typed before the gate was read" },
  );
  await page.reload();
}

/** Capture order/work at the actual first enabled prompt, without a guessed time budget. */
export async function observeWelcomeReadiness(page: Page): Promise<void> {
  // Start at confirmed setup, not before the shell's initial readiness read.
  await expect(page.locator("[data-first-run-gate]")).toHaveAttribute(
    "data-first-run-gate",
    "open",
  );
  await expect(promptInput(page)).toBeDisabled();
  await page.evaluate((selector) => {
    window.welcomeReadiness = [];
    let ids: string[] = [];
    window.infinitary.cards.onCards((cards) => {
      ids = cards.filter((card) => card.author === "firstmate").map((card) => card.id);
      if (ids.length) window.welcomeReadiness.push({ kind: "cards", ids });
    });
    const observer = new MutationObserver(() => {
      const input = document.querySelector<HTMLTextAreaElement>(selector);
      if (!input || input.disabled) return;
      window.welcomeReadiness.push({
        kind: "ready",
        ids,
        cardVisible: Boolean(document.querySelector("[data-card-layer]")),
      });
      observer.disconnect();
    });
    observer.observe(document.body, { attributes: true, childList: true, subtree: true });
  }, TASK_PROMPT_SELECTOR);
}

export async function committedWelcome(page: Page) {
  const state = await page.evaluate(async () => ({
    record: await window.infinitary.app.firstRun(),
    cards: await window.infinitary.cards.list(),
  }));
  const id = state.record.welcomeCardId;
  expect(state.record).toMatchObject({ gateOpen: false, welcomeState: "consumed" });
  expect(id).toBeTruthy();
  expect(state.cards.filter((card) => card.id === id)).toHaveLength(1);
  expect(state.cards.find((card) => card.id === id)).toMatchObject({
    author: "firstmate",
    title: WELCOME_TITLE,
    actions: [],
    status: "ready",
    // It takes no reply: the message box under it is where to type.
    replies: false,
    // The regular card its picture is drawn for.
    width: "regular",
  });
  return { ...state, id: id as string };
}

/**
 * A new person's first crewmate started (docs/first-launch.md, "The first
 * crewmate's note"): its note is the shown card, and its Got it puts it
 * away, so the crewmate's own card arrives on an open stage. A journey that
 * signs a new profile in through the gate and starts a crewmate calls it
 * once the start shows.
 */
export async function putAwayFirstCrewmateNote(page: Page): Promise<void> {
  const note = shownCard(page, FIRST_CREWMATE_TITLE);
  await expect(note).toBeVisible();
  await noteDone(page, note).click();
  await expectNoCard(page, FIRST_CREWMATE_TITLE);
}

/**
 * Presses one of the first launch's three choices of where the first mate
 * lives (docs/first-launch.md): This computer opens the subscription chips,
 * One already running the chips that join a first mate on another computer.
 * A journey reaching either from a fresh profile presses its choice first.
 */
export async function chooseWhereFirstMateLives(
  page: Page,
  choice: "here" | "another" | "running",
): Promise<void> {
  await page.locator(`[data-first-run-gate="open"] [data-gate-choice="${choice}"]`).click();
}
