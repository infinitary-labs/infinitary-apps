import { z } from "zod";
import type { KeySystem } from "./platform";

export const dictationKeySchema = z.enum(["AltRight", "MetaRight", "ControlRight"]);
export type DictationKey = z.infer<typeof dictationKeySchema>;
export const dictationSettingsSchema = z.object({ enabled: z.boolean(), key: dictationKeySchema });
export type DictationSettings = z.infer<typeof dictationSettingsSchema>;
export const DEFAULT_DICTATION: DictationSettings = { enabled: true, key: "AltRight" };

/** The key on its key cap: `⌥` on a Mac, `Alt` on Linux. */
export function dictationKeyCap(key: DictationKey, words: KeySystem = "mac"): string {
  return words === "mac"
    ? { AltRight: "⌥", MetaRight: "⌘", ControlRight: "⌃" }[key]
    : { AltRight: "Alt", MetaRight: "Super", ControlRight: "Ctrl" }[key];
}

/**
 * Whether the key also holds shortcuts: right ⌘ and right ⌃ (right Super and
 * right Ctrl on Linux) do, so a press of one records only once it is clearly
 * not one (docs/composer.md, "Voice"). Right ⌥ types characters instead, and
 * records the moment it goes down.
 */
export function dictationKeyHoldsShortcuts(key: DictationKey): boolean {
  return key !== "AltRight";
}

/** The key in a sentence: "right ⌥" on a Mac, "right Ctrl" on Linux. */
export function dictationKeyLabel(key: DictationKey, words: KeySystem = "mac"): string {
  return `right ${dictationKeyCap(key, words)}`;
}

/** The keys Settings' Dictation key takes, as its prompt names them. */
export function dictationKeyChoices(words: KeySystem = "mac"): string {
  const [first, second, third] = dictationKeySchema.options.map((key) =>
    dictationKeyLabel(key, words),
  );
  return `${first}, ${second} or ${third}`;
}
/** What Settings' Dictation key button says while it waits for the new key. */
export const DICTATION_KEY_PICKING = "press a key…";
