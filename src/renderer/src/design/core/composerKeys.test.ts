import type { KeyPress } from "@shared/keyboard";
import { describe, expect, it } from "vitest";
import {
  type EnterKeys,
  enterAction,
  historyKey,
  isInsideOpenFence,
  joinKill,
  killRange,
  messageKey,
  type ShellKill,
} from "./composerKeys";

const plain: EnterKeys = {
  shift: false,
  alt: false,
  meta: false,
  ctrl: false,
  composing: false,
  inFence: false,
  recording: false,
};

const MODIFIERS = ["shift", "alt", "meta", "ctrl"] as const;
const modifierSets: Array<Partial<EnterKeys>> = Array.from(
  { length: 1 << MODIFIERS.length },
  (_, bits) => Object.fromEntries(MODIFIERS.map((key, i) => [key, (bits & (1 << i)) !== 0])),
);

describe("enterAction (key model A)", () => {
  it("sends on a plain Enter", () => {
    expect(enterAction(plain)).toBe("send");
  });

  it("adds a line on Shift+Enter and Option+Enter", () => {
    expect(enterAction({ ...plain, shift: true })).toBe("newline");
    expect(enterAction({ ...plain, alt: true })).toBe("newline");
    expect(enterAction({ ...plain, shift: true, alt: true })).toBe("newline");
  });

  it("always sends on Cmd+Enter or Ctrl+Enter, whatever else is held or wherever the caret is", () => {
    for (const set of modifierSets.filter((s) => s.meta || s.ctrl)) {
      expect(enterAction({ ...plain, ...set })).toBe("send");
      expect(enterAction({ ...plain, ...set, inFence: true })).toBe("send");
    }
  });

  it("adds a line on a plain Enter inside an open code block", () => {
    expect(enterAction({ ...plain, inFence: true })).toBe("newline");
    expect(enterAction({ ...plain, inFence: true, shift: true })).toBe("newline");
  });

  it("does nothing at all for an input method's Enter, with any modifier, in or out of a block", () => {
    for (const set of modifierSets) {
      expect(enterAction({ ...plain, ...set, composing: true })).toBe("ignore");
      expect(enterAction({ ...plain, ...set, composing: true, inFence: true })).toBe("ignore");
    }
  });

  it("does nothing while recording", () => {
    for (const set of modifierSets) {
      expect(enterAction({ ...plain, ...set, recording: true })).toBe("ignore");
    }
  });

  it("sends once for a held Enter, and keeps adding lines for a held Shift+Enter", () => {
    expect(enterAction({ ...plain, repeat: true })).toBe("ignore");
    expect(enterAction({ ...plain, meta: true, repeat: true })).toBe("ignore");
    expect(enterAction({ ...plain, shift: true, repeat: true })).toBe("newline");
    expect(enterAction({ ...plain, inFence: true, repeat: true })).toBe("newline");
  });
});

describe("isInsideOpenFence", () => {
  const at = (text: string) => ({ text: text.replace("|", ""), caret: text.indexOf("|") });
  const inside = (marked: string) => {
    const { text, caret } = at(marked);
    return isInsideOpenFence(text, caret);
  };

  it("is outside with no fence, inside after an opening one, outside after it closes", () => {
    expect(inside("plain words|")).toBe(false);
    expect(inside("look:\n```ts\nawait flush();|")).toBe(true);
    expect(inside("```\ncode\n```\nafter|")).toBe(false);
    expect(inside("```\none\n```\nmid\n```\ntwo|")).toBe(true);
  });

  it("counts the caret's own line up to the caret", () => {
    expect(inside("```ts|")).toBe(true);
    expect(inside("|```ts")).toBe(false);
    expect(inside("```\ncode\n```|")).toBe(false);
    expect(inside("```\ncode\n|```")).toBe(true);
  });

  it("allows indented fences", () => {
    expect(inside("  ```\n  code|")).toBe(true);
    expect(inside("\t```py\ncode|")).toBe(true);
  });

  it("does not count ~~~ or a fence in the middle of a line", () => {
    expect(inside("~~~\ncode|")).toBe(false);
    expect(inside("use ``` for code\nmore|")).toBe(false);
  });

  it("reads a caret past either end as the nearest end", () => {
    expect(isInsideOpenFence("```\ncode", 99)).toBe(true);
    expect(isInsideOpenFence("```\ncode", -1)).toBe(false);
  });
});

const control = (key: string, code = `Key${key.toUpperCase()}`): KeyPress => ({
  key,
  code,
  shift: false,
  alt: false,
  meta: false,
  ctrl: true,
  composing: false,
  repeat: false,
});

const FIELDS = ["main-message", "reply"] as const;

describe("messageKey: the shell keys", () => {
  it("takes Ctrl+U, Ctrl+K, Ctrl+W and Ctrl+Y in either message field, held keys included", () => {
    for (const field of FIELDS) {
      expect(messageKey(control("u"), field)).toBe("kill-line-before");
      expect(messageKey(control("k"), field)).toBe("kill-line-after");
      expect(messageKey(control("w"), field)).toBe("kill-word-before");
      expect(messageKey(control("y"), field)).toBe("yank");
      expect(messageKey({ ...control("w"), repeat: true }, field)).toBe("kill-word-before");
    }
  });

  it("leaves macOS's own Control keys and every other letter to the platform", () => {
    for (const field of FIELDS) {
      for (const letter of "abdefhlnotv")
        expect(messageKey(control(letter), field)).toBeUndefined();
    }
    expect(messageKey(control("p"), "reply")).toBeUndefined();
  });

  it("takes nothing with Cmd, Option or Shift held, without Control, or while composing", () => {
    for (const extra of [{ meta: true }, { alt: true }, { shift: true }, { ctrl: false }]) {
      expect(messageKey({ ...control("u"), ...extra }, "main-message")).toBeUndefined();
    }
    expect(messageKey({ ...control("k"), composing: true }, "main-message")).toBeUndefined();
  });

  it("reads the physical key on a layout without Latin letters", () => {
    expect(messageKey(control("г", "KeyU"), "reply")).toBe("kill-line-before");
    expect(messageKey(control("\u0015", "KeyU"), "reply")).toBe("kill-line-before");
    expect(messageKey(control("1", "Digit1"), "reply")).toBeUndefined();
  });
});

describe("messageKey: recall", () => {
  const up: KeyPress = { ...control("ArrowUp", "ArrowUp"), ctrl: false };

  it("is a bare Up or Ctrl+P in the main message", () => {
    expect(messageKey(up, "main-message")).toBe("recall");
    expect(messageKey(control("p"), "main-message")).toBe("recall");
  });

  it("is never a reply's: Up and Ctrl+P stay the platform's there", () => {
    expect(messageKey(up, "reply")).toBeUndefined();
    expect(messageKey(control("p"), "reply")).toBeUndefined();
  });

  it("is not Up with a modifier, Ctrl+P with another, either while composing, or a held key", () => {
    for (const extra of [{ shift: true }, { alt: true }, { meta: true }, { ctrl: true }]) {
      expect(messageKey({ ...up, ...extra }, "main-message")).toBeUndefined();
    }
    for (const extra of [{ shift: true }, { alt: true }, { meta: true }]) {
      expect(messageKey({ ...control("p"), ...extra }, "main-message")).toBeUndefined();
    }
    expect(messageKey({ ...up, composing: true }, "main-message")).toBeUndefined();
    expect(messageKey({ ...control("p"), composing: true }, "main-message")).toBeUndefined();
    expect(messageKey({ ...up, repeat: true }, "main-message")).toBeUndefined();
    expect(messageKey(control("n"), "main-message")).toBeUndefined();
  });
});

describe("historyKey", () => {
  const command = (key: string, code = `Key${key.toUpperCase()}`): KeyPress => ({
    ...control(key, code),
    ctrl: false,
    meta: true,
  });

  it("is Cmd+Z back and Shift+Cmd+Z forward", () => {
    expect(historyKey(command("z"))).toBe("undo");
    expect(historyKey({ ...command("Z"), shift: true })).toBe("redo");
    expect(historyKey({ ...command("z"), repeat: true })).toBe("undo");
  });

  it("reads the physical key on a layout without Latin letters", () => {
    expect(historyKey(command("я", "KeyZ"))).toBe("undo");
  });

  it("is nothing with Control or Option held, without Cmd, or while composing", () => {
    expect(historyKey({ ...command("z"), ctrl: true })).toBeUndefined();
    expect(historyKey({ ...command("z"), alt: true })).toBeUndefined();
    expect(historyKey({ ...command("z"), meta: false })).toBeUndefined();
    expect(historyKey({ ...command("z"), composing: true })).toBeUndefined();
    expect(historyKey(command("y"))).toBeUndefined();
  });
});

describe("killRange", () => {
  /** The draft with the killed part in [brackets], `|` marking the caret. */
  const kill = (marked: string, edit: ShellKill) => {
    const caret = marked.indexOf("|");
    const text = marked.replace("|", "");
    const { start, end } = killRange(text, caret, caret, edit);
    return `${text.slice(0, start)}[${text.slice(start, end)}]${text.slice(end)}`;
  };

  it("Ctrl+U takes the caret's line back to its start, and only its line", () => {
    expect(kill("alpha beta| gamma", "kill-line-before")).toBe("[alpha beta] gamma");
    expect(kill("first line\nsecond| line", "kill-line-before")).toBe("first line\n[second] line");
  });

  it("Ctrl+U at a line's start takes the line break, and at the very start nothing", () => {
    expect(kill("first\n|second", "kill-line-before")).toBe("first[\n]second");
    expect(kill("|alpha", "kill-line-before")).toBe("[]alpha");
    expect(kill("|\nalpha", "kill-line-before")).toBe("[]\nalpha");
  });

  it("Ctrl+K takes the caret's line on to its end, then the line break, then nothing", () => {
    expect(kill("alpha |beta gamma", "kill-line-after")).toBe("alpha [beta gamma]");
    expect(kill("first| line\nsecond", "kill-line-after")).toBe("first[ line]\nsecond");
    expect(kill("first|\nsecond", "kill-line-after")).toBe("first[\n]second");
    expect(kill("alpha|", "kill-line-after")).toBe("alpha[]");
  });

  it("Ctrl+W takes the whitespace-separated word before the caret, with the space after it", () => {
    expect(kill("alpha beta| gamma", "kill-word-before")).toBe("alpha [beta] gamma");
    expect(kill("alpha beta |gamma", "kill-word-before")).toBe("alpha [beta ]gamma");
    expect(kill("open src/app/store.ts|", "kill-word-before")).toBe("open [src/app/store.ts]");
    expect(kill("first\n  |second", "kill-word-before")).toBe("[first\n  ]second");
    expect(kill("  |", "kill-word-before")).toBe("[  ]");
    expect(kill("|alpha", "kill-word-before")).toBe("[]alpha");
  });

  it("takes a selection whole, whichever kill it is", () => {
    for (const edit of ["kill-line-before", "kill-line-after", "kill-word-before"] as const) {
      expect(killRange("alpha beta gamma", 6, 10, edit)).toEqual({ start: 6, end: 10 });
      expect(killRange("alpha beta gamma", 10, 6, edit)).toEqual({ start: 6, end: 10 });
    }
  });
});

describe("joinKill", () => {
  it("replaces the buffer unless the kill follows straight on from the last", () => {
    expect(joinKill("old", "new", "kill-word-before", false)).toBe("new");
    expect(joinKill("old", "new", "kill-line-after", false)).toBe("new");
  });

  it("joins consecutive kills in the order the text stood", () => {
    // "alpha beta gamma|": Ctrl+W takes "gamma", then "beta ".
    expect(joinKill("gamma", "beta ", "kill-word-before", true)).toBe("beta gamma");
    expect(joinKill("first", "\n", "kill-line-after", true)).toBe("first\n");
    expect(joinKill("second", "\n", "kill-line-before", true)).toBe("\nsecond");
  });
});
