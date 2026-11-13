import * as m from "@shared/i18n/messages.generated";
import type { RecordedKey } from "@shared/ipc";
import {
  type AnyCommandId,
  type Bindings,
  chordLabel,
  commandEntry,
  type KeyBinding,
  type KeyChord,
  keysOf,
  type PanelCommand,
} from "@shared/keyboard";
import {
  bindingProblem,
  chordOfPress,
  clashesWith,
  clashWords,
  type KeyClash,
  type SavedKeymap,
  sameBinding,
  withKeyMoved,
} from "@shared/keymap";
import { sameChord } from "@shared/keyPresets";
import type { KeySystem } from "@shared/platform";

/**
 * Keyboard settings' recorder (docs/keyboard.md, "Recording a key"): what
 * the keys pressed so far make, and what saving them would do. Pure, so
 * every verdict is tested without a window. The main process sends each
 * key while it records; Enter saves, Shift+Enter adds the key beside the
 * command's others, and Escape stops without saving.
 */

/** What the recorder does with a key the window sent it. */
export type RecorderKey =
  | { kind: "save"; mode: "replace" | "add" }
  | { kind: "cancel" }
  | { kind: "press"; key: RecordedKey };

/** Enter and Escape, with nothing but Shift held, run the recorder; every other key is recorded. */
export function recorderKey(key: RecordedKey): RecorderKey {
  const plain = !key.meta && !key.ctrl && !key.alt;
  if (plain && key.key === "Escape" && !key.shift) return { kind: "cancel" };
  if (plain && key.key === "Enter") return { kind: "save", mode: key.shift ? "add" : "replace" };
  return { kind: "press", key };
}

/**
 * The keys after one more press: a window command's chord that holds ⌘ or
 * ⌃ (Ctrl on a Ctrl system), or a plain key that works when not typing,
 * takes a second key and becomes a two-key shortcut; anything else starts
 * over with the new key. A key held with ⌘, ⌃ or ⌥, or an F key, works
 * anywhere; any other works only when not typing. `prefix` is the prefix
 * in use (`prefixOf`), which always takes a second key.
 */
export function keysAfterPress(
  id: AnyCommandId,
  current: KeyBinding | null,
  key: RecordedKey,
  panels: readonly PanelCommand[] = [],
  system: KeySystem = "mac",
  prefix?: KeyChord,
): KeyBinding {
  const chord = chordOfPress({ ...key, composing: false, repeat: false });
  const binding: KeyBinding =
    !chord.meta && !chord.ctrl && !chord.alt && !/^F([1-9]|1[0-9]|2[0-4])$/.test(chord.key)
      ? { ...chord, when: "not-typing" }
      : chord;
  return current && takesSecondKey(id, current, panels, system, prefix)
    ? { ...current, second: chord }
    : binding;
}

/** Whether the recorded keys could still take a second key. */
export function takesSecondKey(
  id: AnyCommandId,
  keys: KeyBinding | null,
  panels: readonly PanelCommand[] = [],
  system: KeySystem = "mac",
  prefix?: KeyChord,
): boolean {
  return (
    keys !== null &&
    keys.second === undefined &&
    commandEntry(id, panels)?.scope === "window" &&
    (keys.meta === true || keys.ctrl === true || keys.when === "not-typing") &&
    (isPrefixAlone(keys, prefix) || bindingProblem(keys, id, panels, system) === null)
  );
}

/** Whether the keys are the prefix in use and nothing after it yet. */
function isPrefixAlone(keys: KeyBinding, prefix: KeyChord | undefined): boolean {
  return (
    prefix !== undefined &&
    keys.second === undefined &&
    keys.when !== "not-typing" &&
    sameChord(keys, prefix)
  );
}

/** What saving the recorded keys would do, in the words Keyboard settings shows. */
export type RecorderVerdict =
  | { kind: "empty" }
  | { kind: "refused"; reason: string }
  | { kind: "own" }
  | { kind: "free" }
  | { kind: "moves"; clashes: KeyClash[]; words: string };

export function recorderVerdict(
  id: AnyCommandId,
  keys: KeyBinding | null,
  bindings: Bindings,
  panels: readonly PanelCommand[] = [],
  system: KeySystem = "mac",
  prefix?: KeyChord,
): RecorderVerdict {
  if (!keys) return { kind: "empty" };
  if (isPrefixAlone(keys, prefix) && commandEntry(id, panels)?.scope === "window")
    return {
      kind: "refused",
      reason: m.settingsKeyboardPrefixAlone({ key: chordLabel(keys, system) }),
    };
  const problem = bindingProblem(keys, id, panels, system, prefix);
  if (problem) return { kind: "refused", reason: problem };
  if (keysOf(bindings, id).some((own) => sameBinding(own, keys))) return { kind: "own" };
  const clashes = clashesWith(bindings, id, keys, panels);
  const starts = clashes.find((clash) => clash.kind === "prefix");
  if (starts) return { kind: "refused", reason: clashWords(id, starts, panels, system) };
  if (clashes.length === 0) return { kind: "free" };
  const words = clashes
    .map((clash) => {
      const left = keysOf(bindings, clash.id).filter((kept) => !sameBinding(kept, clash.binding));
      const label = commandEntry(clash.id, panels)?.label ?? clash.id;
      const words = { clash: clashWords(id, clash, panels, system), command: label };
      return left.length === 0
        ? m.settingsKeyboardClashMovesNoKey(words)
        : m.settingsKeyboardClashMovesKeeps(words);
    })
    .join(" ");
  return { kind: "moves", clashes, words };
}

/** What is saved once the recorded keys are saved, or null when there is nothing to save. */
export function savedAfterRecording(
  saved: SavedKeymap,
  bindings: Bindings,
  id: AnyCommandId,
  keys: KeyBinding | null,
  mode: "replace" | "add",
  panels: readonly PanelCommand[] = [],
  system: KeySystem = "mac",
  prefix?: KeyChord,
): SavedKeymap | null {
  const verdict = recorderVerdict(id, keys, bindings, panels, system, prefix);
  if (!keys || verdict.kind === "empty" || verdict.kind === "refused") return null;
  if (verdict.kind === "own" && mode === "add") return null;
  return withKeyMoved(saved, bindings, id, keys, mode, panels, system);
}
