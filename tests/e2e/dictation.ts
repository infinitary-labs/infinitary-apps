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
