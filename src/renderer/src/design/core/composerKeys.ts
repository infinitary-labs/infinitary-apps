/**
 * The composer's key model (design skill `components/voice/VoiceInput.prompt.md`,
 * "Keys"; `docs/composer.md`): every Enter, recall, and the shell keys. Pure,
 * so the whole table is tested without a page. Recall and the shell keys are
 * keyboard commands (`src/shared/keyboard.ts`), so their keys come from there.
 */

import {
  type Bindings,
  type CommandId,
  chordMatches,
  commandFor,
  DEFAULT_BINDINGS,
  type KeyContext,
  type KeyPress,
} from "@shared/keyboard";
import type { KeySystem } from "@shared/platform";

/** What an Enter keydown does. `ignore` still swallows the key: no send, no line. */
export type EnterAction = "send" | "newline" | "ignore";

export type EnterKeys = {
  shift: boolean;
  alt: boolean;
  meta: boolean;
  ctrl: boolean;
  /** The Enter confirms an input-method candidate (`isComposing` or keyCode 229). */
  composing: boolean;
  /** The caret sits inside an open ``` code block (`isInsideOpenFence`). */
  inFence: boolean;
  recording: boolean;
  /** The platform repeats a held Enter. */
  repeat?: boolean;
};

/**
 * Enter sends; Shift or Option adds a line; Cmd or Ctrl always sends; inside
 * an open code block Enter adds a line. An input method's Enter and an Enter
 * while recording do nothing at all - in particular, never a line (the
 * Korean 2-Set trap, where a guard that only skips the send lets the
 * textarea insert one).
 *
 * A held Enter sends once: its repeats send nothing, so an Enter held on a
 * card's button that closes the card never sends the main message focus
 * goes back to (docs/keyboard.md, "Cards and frames"). A held Shift+Enter
 * still adds a line per repeat, as any held key types.
 *
 * Option cannot say which side is held on an Enter keydown, and need not:
 * the chosen dictation key starts a recording, and Enter while recording is
 * `ignore`, so an Option+Enter that gets here is either side when not recording, and a line is harmless in both.
 */
export function enterAction(keys: EnterKeys): EnterAction {
  if (keys.composing || keys.recording) return "ignore";
  const send = keys.repeat ? "ignore" : "send";
  if (keys.meta || keys.ctrl) return send;
  if (keys.shift || keys.alt) return "newline";
  if (keys.inFence) return "newline";
  return send;
}

/**
 * A shell's editing key the field takes for itself: by default Ctrl+U,
 * Ctrl+K and Ctrl+W remove text into the kill buffer, and Ctrl+Y types it
 * back. Chromium has no Ctrl+U or Ctrl+W, and its Ctrl+Y brings back
 * nothing, so the field owns these four; macOS's own Control keys (Ctrl+A,
 * Ctrl+E, ...) stay the platform's.
 */
export type ShellEdit = "kill-line-before" | "kill-line-after" | "kill-word-before" | "yank";

/** A kill: every shell edit but the yank. */
export type ShellKill = Exclude<ShellEdit, "yank">;

/** What a message field does for a key it owns: a shell edit, or bringing back the last message. */
export type MessageKey = ShellEdit | "recall";

/** Which message field heard the key: the main message, or a card's reply. */
export type MessageField = NonNullable<KeyContext["field"]>;

const MESSAGE_KEYS: Partial<Readonly<Record<CommandId, MessageKey>>> = {
  "message.delete-to-line-start": "kill-line-before",
  "message.delete-to-line-end": "kill-line-after",
  "message.delete-word-before": "kill-word-before",
  "message.put-back-deleted": "yank",
  "message.recall": "recall",
};

/**
 * What a keydown asks of a message field, through the app's keyboard
 * commands (`src/shared/keyboard.ts`, docs/keyboard.md): a shell edit, in
 * either field, or - in the main message only - recall, which by default is
 * Up or Ctrl+P (a shell's previous line) with nothing else held. Never
 * during an input method's composition, which uses Control keys of its own;
 * a held recall key brings back the message once and then moves the caret.
 * Its keys are the window's installed ones (`bindings`), so a key a person
 * changed in Keyboard settings works here the moment it is installed.
 */
export function messageKey(
  press: KeyPress,
  field: MessageField,
  bindings: Bindings = DEFAULT_BINDINGS,
): MessageKey | undefined {
  const id = commandFor(press, { field }, bindings);
  return id === undefined ? undefined : MESSAGE_KEYS[id];
}

/**
 * The undo keys, which a message field answers from its own history
 * (`composerHistory.ts`, docs/composer.md "Undo"): on a Mac ⌘Z steps back
 * and ⇧⌘Z steps forward; on a Ctrl system Ctrl+Z steps back and
 * Ctrl+Shift+Z or Ctrl+Y forward, on the layout's letter or the physical
 * key. An input method's composition keeps its keys.
 */
export function historyKey(
  press: KeyPress,
  system: KeySystem = "mac",
): "undo" | "redo" | undefined {
  if (press.composing) return undefined;
  if (system !== "mac") {
    if (chordMatches({ key: "z", ctrl: true }, press)) return "undo";
    if (
      chordMatches({ key: "z", ctrl: true, shift: true }, press) ||
      chordMatches({ key: "y", ctrl: true }, press)
    )
      return "redo";
    return undefined;
  }
  if (chordMatches({ key: "z", meta: true }, press)) return "undo";
  if (chordMatches({ key: "z", meta: true, shift: true }, press)) return "redo";
  return undefined;
}

/**
 * What a kill removes from `text`, as `[start, end)`. A selection is killed
 * whole. Otherwise: from the caret back to its line's start
 * (`kill-line-before`), from the caret on to its line's end
 * (`kill-line-after`), or back over any whitespace and then the run of
 * non-whitespace before it (`kill-word-before`, bash's Ctrl+W, so `src/app`
 * goes as one word). A line kill with the caret already at that edge of its
 * line takes the line break, so pressing it again joins the lines, as
 * macOS's Ctrl+K does. Empty when there is nothing to take.
 */
export function killRange(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  kill: ShellKill,
): { start: number; end: number } {
  if (selectionStart !== selectionEnd) {
    return {
      start: Math.min(selectionStart, selectionEnd),
      end: Math.max(selectionStart, selectionEnd),
    };
  }
  const caret = selectionEnd;
  if (kill === "kill-line-before") {
    const lineStart = caret === 0 ? 0 : text.lastIndexOf("\n", caret - 1) + 1;
    return { start: lineStart === caret ? Math.max(0, caret - 1) : lineStart, end: caret };
  }
  if (kill === "kill-line-after") {
    const found = text.indexOf("\n", caret);
    const lineEnd = found === -1 ? text.length : found;
    return { start: caret, end: lineEnd === caret ? Math.min(text.length, caret + 1) : lineEnd };
  }
  let start = caret;
  while (start > 0 && /\s/.test(text.charAt(start - 1))) start--;
  while (start > 0 && !/\s/.test(text.charAt(start - 1))) start--;
  return { start, end: caret };
}

/**
 * The kill buffer after a kill. A kill straight after another joins it in
 * the order the text stood, as a shell's does: Ctrl+K appends, Ctrl+U and
 * Ctrl+W put theirs in front. Any other kill replaces the buffer.
 */
export function joinKill(
  buffer: string,
  killed: string,
  kill: ShellKill,
  continues: boolean,
): string {
  if (!continues) return killed;
  return kill === "kill-line-after" ? buffer + killed : killed + buffer;
}

const FENCE_LINE = /^[ \t]*```/;

/**
 * Whether the caret is inside an unclosed ``` block: an odd number of lines
 * before the caret open with a fence (indentation allowed). The caret's own
 * line counts up to the caret, so Enter right after an opening fence adds a
 * line and Enter right after the closing one sends. `~~~` and a ``` in the
 * middle of a line are not fences here.
 */
export function isInsideOpenFence(text: string, caret: number): boolean {
  let fences = 0;
  for (const line of text.slice(0, Math.max(0, caret)).split("\n")) {
    if (FENCE_LINE.test(line)) fences++;
  }
  return fences % 2 === 1;
}
