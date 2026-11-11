import type { RecordedKey } from "@shared/ipc";
import {
  type AnyCommandId,
  type Bindings,
  commandEntry,
  type KeyBinding,
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
 * anywhere; any other works only when not typing.
 */
export function keysAfterPress(
  id: AnyCommandId,
  current: KeyBinding | null,
  key: RecordedKey,
  panels: readonly PanelCommand[] = [],
  system: KeySystem = "mac",
): KeyBinding {
  const chord = chordOfPress({ ...key, composing: false, repeat: false });
  const binding: KeyBinding =
    !chord.meta && !chord.ctrl && !chord.alt && !/^F([1-9]|1[0-9]|2[0-4])$/.test(chord.key)
      ? { ...chord, when: "not-typing" }
      : chord;
  return current && takesSecondKey(id, current, panels, system)
    ? { ...current, second: chord }
    : binding;
}

/** Whether the recorded keys could still take a second key. */
export function takesSecondKey(
  id: AnyCommandId,
  keys: KeyBinding | null,
  panels: readonly PanelCommand[] = [],
  system: KeySystem = "mac",
): boolean {
  return (
    keys !== null &&
    keys.second === undefined &&
    commandEntry(id, panels)?.scope === "window" &&
    (keys.meta === true || keys.ctrl === true || keys.when === "not-typing") &&
    bindingProblem(keys, id, panels, system) === null
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
): RecorderVerdict {
  if (!keys) return { kind: "empty" };
  const problem = bindingProblem(keys, id, panels, system);
  if (problem) return { kind: "refused", reason: problem };
  if (keysOf(bindings, id).some((own) => sameBinding(own, keys))) return { kind: "own" };
  const clashes = clashesWith(bindings, id, keys, panels);
  const prefix = clashes.find((clash) => clash.kind === "prefix");
  if (prefix) return { kind: "refused", reason: clashWords(id, prefix, panels, system) };
  if (clashes.length === 0) return { kind: "free" };
  const words = clashes
    .map((clash) => {
      const left = keysOf(bindings, clash.id).filter((kept) => !sameBinding(kept, clash.binding));
      const label = commandEntry(clash.id, panels)?.label ?? clash.id;
      return `${clashWords(id, clash, panels, system)}. Saving moves it here, and “${label}” ${
        left.length === 0 ? "will have no key" : "keeps its other keys"
      }.`;
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
): SavedKeymap | null {
  const verdict = recorderVerdict(id, keys, bindings, panels, system);
  if (!keys || verdict.kind === "empty" || verdict.kind === "refused") return null;
  if (verdict.kind === "own" && mode === "add") return null;
  return withKeyMoved(saved, bindings, id, keys, mode, panels, system);
}
