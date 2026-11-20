import type { Page } from "@playwright/test";
import { type DictationKey, dictationKeyCap, dictationKeyLabel } from "@shared/dictation";
import {
  FIRST_RUN_PLACEHOLDER,
  FIRST_RUN_PLACEHOLDER_SHORT,
  withDictationKey,
} from "@shared/firstRun";
import { THIS_DESKTOP } from "./desktop";

/**
 * The dictation key on this computer until a journey picks another (docs/
 * architecture.md section 8, "Keybind"): right ⌥ on a Mac and right Ctrl on
 * Linux, which a journey holds and taps with `page.keyboard`.
 */
export const DICTATION_KEY: DictationKey = THIS_DESKTOP.dictationKey;

/** A dictation key's cap on this computer's keys: `⌥` on a Mac, `Ctrl` on Linux. */
export function dictationCap(key: DictationKey = DICTATION_KEY): string {
  return dictationKeyCap(key, THIS_DESKTOP.keys);
}

/** A dictation key in a sentence on this computer: "right ⌥" on a Mac, "right Ctrl" on Linux. */
export function dictationWords(key: DictationKey = DICTATION_KEY): string {
  return dictationKeyLabel(key, THIS_DESKTOP.keys);
}

/** An input hint as this computer shows it, naming its dictation key (`withDictationKey`). */
export function hintOnThisComputer(hint: string, key: DictationKey = DICTATION_KEY): string {
  return withDictationKey(hint, dictationWords(key));
}

/**
 * The first-run hint as this computer shows it, in either form that names its
 * dictation key: the field shows the fullest form that fits its one line
 * (docs/composer.md), and Linux's "right Ctrl" takes the shorter at the
 * default window.
 */
export function firstRunHintOnThisComputer(key: DictationKey = DICTATION_KEY): RegExp {
  const forms = [FIRST_RUN_PLACEHOLDER, FIRST_RUN_PLACEHOLDER_SHORT].map((hint) =>
    hintOnThisComputer(hint, key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return new RegExp(`^(?:${forms.join("|")})$`);
}

/**
 * Returns once the window has settled what decides whether the dictation key
 * starts a recording, which it reads once as it opens (`store.ts`): the saved
 * dictation choice, whether the voice model is on this computer, and where
 * speech runs with the window's graphics check on that answer. A press before
 * then starts nothing, or asks for the model. Each read here is asked after
 * the window's own: where speech runs is settled once per run, the main
 * process answers the others in the order asked, and the graphics check
 * answers in order too, so the window took each answer in before these come
 * back, and one task later its store holds them.
 */
export async function voiceSettled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.infinitary.settings.getDictation();
    await window.infinitary.voice.status();
    const { where } = await window.infinitary.voice.recognizer();
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter?: () => Promise<unknown> } })
      .gpu;
    if (where === "window") await gpu?.requestAdapter?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * How long a press is held to be a hold and not a tap: a bound above the
 * dictation key's hold, 250 ms in `dictationKey.ts`, which keeps it private.
 */
const PAST_THE_HOLD_MS = 300;

/**
 * Holds a press past the dictation key's hold, timed on the window's own
 * clock: the window's hold timer started with the press, before this one, so
 * it has run by the time this one ends, however long a busy computer stops
 * the window. A wait in the test process can end before the window ran it.
 */
export async function holdPastTheHold(page: Page): Promise<void> {
  await page.evaluate((ms) => new Promise((resolve) => setTimeout(resolve, ms)), PAST_THE_HOLD_MS);
}
