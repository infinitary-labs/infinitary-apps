/**
 * The composer's own undo history (`docs/composer.md`, "Undo"). Pure, so its
 * steps are tested without a page. `ComposerField` records every edit here
 * and answers Cmd+Z and Cmd+Shift+Z from it, instead of from the platform's
 * history: Chromium ends its run of typing whenever anything leaves the page,
 * so a card or a feed line going away would split what one Cmd+Z takes back.
 */

export type FieldState = { value: string; start: number; end: number };

/**
 * How an edit joins the history. `type` and `delete` run on while the caret
 * carries on from where the run left it; `line` joins the run of typing it
 * ends; `step` is always a step of its own, as a paste is.
 */
export type EditKind = "type" | "delete" | "line" | "step";

export type ComposerHistory = {
  /** The states Cmd+Z goes back to, oldest first. */
  undo: readonly FieldState[];
  /** The states Cmd+Shift+Z goes forward to, nearest last. */
  redo: readonly FieldState[];
  /** The run that is still open, and where its caret stands. */
  run?: { kind: "type" | "delete"; caret: number };
};

export const HISTORY_STEPS = 200;

export const emptyHistory: ComposerHistory = { undo: [], redo: [] };

/** The kind of an edit the platform makes, from its input event's `inputType`. */
export function editKind(inputType: string): EditKind {
  switch (inputType) {
    case "insertText":
    case "insertCompositionText":
    case "insertFromComposition":
      return "type";
    case "deleteContentBackward":
    case "deleteContentForward":
      return "delete";
    case "insertLineBreak":
    case "insertParagraph":
      return "line";
    default:
      return "step";
  }
}

/** Records one edit from `before` to `after`: a new step, or more of the open run. */
export function recordEdit(
  history: ComposerHistory,
  before: FieldState,
  after: FieldState,
  kind: EditKind,
): ComposerHistory {
  if (before.value === after.value) return history;
  const runKind = kind === "line" ? "type" : kind;
  const continues =
    runKind !== "step" &&
    history.run?.kind === runKind &&
    history.run.caret === before.start &&
    before.start === before.end;
  const run =
    runKind === "step" || kind === "line" ? undefined : { kind: runKind, caret: after.end };
  if (continues) return { undo: history.undo, redo: [], run };
  return { undo: [...history.undo, before].slice(-HISTORY_STEPS), redo: [], run };
}

/** The caret moved: a run it no longer carries on from ends. */
export function noteCaret(history: ComposerHistory, start: number, end: number): ComposerHistory {
  const run = history.run;
  if (!run || (start === run.caret && end === run.caret)) return history;
  return { undo: history.undo, redo: history.redo };
}

/** One step back from `current`: the state to show, and the history after it. */
export function undoStep(
  history: ComposerHistory,
  current: FieldState,
): { state: FieldState; history: ComposerHistory } | undefined {
  const state = history.undo.at(-1);
  if (!state) return undefined;
  return { state, history: { undo: history.undo.slice(0, -1), redo: [...history.redo, current] } };
}

export function redoStep(
  history: ComposerHistory,
  current: FieldState,
): { state: FieldState; history: ComposerHistory } | undefined {
  const state = history.redo.at(-1);
  if (!state) return undefined;
  return { state, history: { undo: [...history.undo, current], redo: history.redo.slice(0, -1) } };
}

/**
 * The smallest edit that turns `from` into `to`: the range of `from` to
 * replace and the text to put there, so applying a step moves as little of
 * the field as it can.
 */
export function changedRange(
  from: string,
  to: string,
): { start: number; end: number; text: string } {
  let start = 0;
  while (start < from.length && start < to.length && from[start] === to[start]) start++;
  let fromEnd = from.length;
  let toEnd = to.length;
  while (fromEnd > start && toEnd > start && from[fromEnd - 1] === to[toEnd - 1]) {
    fromEnd--;
    toEnd--;
  }
  return { start, end: fromEnd, text: to.slice(start, toEnd) };
}
