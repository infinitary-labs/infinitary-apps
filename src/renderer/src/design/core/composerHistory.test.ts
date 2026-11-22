import { describe, expect, it } from "vitest";
import {
  type ComposerHistory,
  changedRange,
  type EditKind,
  editKind,
  emptyHistory,
  type FieldState,
  HISTORY_STEPS,
  noteCaret,
  recordEdit,
  redoStep,
  undoStep,
} from "./composerHistory";

const at = (value: string, start = value.length, end = start): FieldState => ({
  value,
  start,
  end,
});

function typeChars(history: ComposerHistory, from: string, text: string): ComposerHistory {
  let next = history;
  let value = from;
  for (const char of text) {
    next = recordEdit(next, at(value), at(value + char), "type");
    value += char;
  }
  return next;
}

function edit(
  history: ComposerHistory,
  before: FieldState,
  after: FieldState,
  kind: EditKind,
): ComposerHistory {
  return recordEdit(history, before, after, kind);
}

/** Every value Cmd+Z goes back through from `current`, nearest first. */
function undoAll(history: ComposerHistory, current: FieldState): string[] {
  const seen: string[] = [];
  let state = current;
  let next = history;
  for (let step = undoStep(next, state); step; step = undoStep(next, state)) {
    seen.push(step.state.value);
    state = step.state;
    next = step.history;
  }
  return seen;
}

describe("composer undo history", () => {
  it("takes back a run of typing in one step, not one character", () => {
    const history = typeChars(emptyHistory, "", "fix the login bug");
    expect(undoAll(history, at("fix the login bug"))).toEqual([""]);
  });

  it("starts a new step when the caret moves, even back to where it was", () => {
    let history = typeChars(emptyHistory, "", "fix the bug");
    history = noteCaret(history, 10, 10);
    history = noteCaret(history, 11, 11);
    history = typeChars(history, "fix the bug", " now");
    expect(undoAll(history, at("fix the bug now"))).toEqual(["fix the bug", ""]);
  });

  it("keeps the run while the caret only follows the typing", () => {
    let history = typeChars(emptyHistory, "", "fix");
    history = noteCaret(history, 3, 3);
    history = typeChars(history, "fix", " it");
    expect(undoAll(history, at("fix it"))).toEqual([""]);
  });

  it("ends a line's run with its line break, so lines come back one at a time", () => {
    let history = typeChars(emptyHistory, "", "one two");
    history = edit(history, at("one two"), at("one two\n"), "line");
    history = typeChars(history, "one two\n", "three");
    history = edit(history, at("one two\nthree"), at("one two\nthree\n"), "line");
    history = typeChars(history, "one two\nthree\n", "four");
    expect(undoAll(history, at("one two\nthree\nfour"))).toEqual([
      "one two\nthree\n",
      "one two\n",
      "",
    ]);
  });

  it("runs deletions together, apart from the typing around them", () => {
    let history = typeChars(emptyHistory, "", "bugg");
    history = edit(history, at("bugg"), at("bug"), "delete");
    history = edit(history, at("bug"), at("bu"), "delete");
    history = typeChars(history, "bu", "t");
    expect(undoAll(history, at("but"))).toEqual(["bu", "bugg", ""]);
  });

  it("keeps a paste, a removal or any other edit as a step of its own", () => {
    let history = typeChars(emptyHistory, "", "hello ");
    history = edit(history, at("hello "), at("hello a\nb"), "step");
    history = typeChars(history, "hello a\nb", " world");
    expect(undoAll(history, at("hello a\nb world"))).toEqual(["hello a\nb", "hello ", ""]);
  });

  it("starts a new step when typing replaces a selection", () => {
    let history = typeChars(emptyHistory, "", "fix the bug");
    history = edit(history, at("fix the bug", 4, 7), at("fix a bug", 5), "type");
    expect(undoAll(history, at("fix a bug"))).toEqual(["fix the bug", ""]);
  });

  it("goes forward again with redo until a new edit is made", () => {
    let history = typeChars(emptyHistory, "", "one");
    history = noteCaret(history, 0, 0);
    history = edit(history, at("one", 0), at("zone", 1), "type");
    const back = undoStep(history, at("zone", 1));
    expect(back?.state.value).toBe("one");
    const forward = back && redoStep(back.history, back.state);
    expect(forward?.state).toEqual(at("zone", 1));
    const after = back && edit(back.history, back.state, at("one!"), "type");
    expect(after && redoStep(after, at("one!"))).toBeUndefined();
  });

  it("restores the selection the edit started from", () => {
    const history = edit(emptyHistory, at("fix the bug", 4, 7), at("fix bug", 4), "delete");
    expect(undoStep(history, at("fix bug", 4))?.state).toEqual(at("fix the bug", 4, 7));
  });

  it("records nothing for an edit that changed no words", () => {
    expect(recordEdit(emptyHistory, at("a"), at("a", 0), "step")).toBe(emptyHistory);
  });

  it("keeps the most recent steps", () => {
    let history = emptyHistory;
    let value = "";
    for (let i = 0; i < HISTORY_STEPS + 5; i++) {
      history = edit(history, at(value), at(`${value}x`), "step");
      value += "x";
    }
    expect(history.undo).toHaveLength(HISTORY_STEPS);
    expect(history.undo[0]?.value).toBe("x".repeat(5));
  });

  it("reads the platform's edits by input type", () => {
    expect(editKind("insertText")).toBe("type");
    expect(editKind("insertCompositionText")).toBe("type");
    expect(editKind("deleteContentBackward")).toBe("delete");
    expect(editKind("insertLineBreak")).toBe("line");
    expect(editKind("insertFromPaste")).toBe("step");
    expect(editKind("deleteWordBackward")).toBe("step");
    expect(editKind("")).toBe("step");
  });

  it("finds the smallest change between two drafts", () => {
    expect(changedRange("fix the bug", "fix a bug")).toEqual({ start: 4, end: 7, text: "a" });
    expect(changedRange("abc", "abc!")).toEqual({ start: 3, end: 3, text: "!" });
    expect(changedRange("aaa", "aa")).toEqual({ start: 2, end: 3, text: "" });
    expect(changedRange("", "new")).toEqual({ start: 0, end: 0, text: "new" });
  });
});
