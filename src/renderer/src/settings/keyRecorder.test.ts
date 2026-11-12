import * as m from "@shared/i18n/messages.generated";
import type { RecordedKey } from "@shared/ipc";
import { bindingLabel, DEFAULT_BINDINGS } from "@shared/keyboard";
import { DEFAULT_SAVED_KEYMAP, presetKeymap, resolveBindings } from "@shared/keymap";
import { TMUX_PREFIX } from "@shared/keyPresets";
import { describe, expect, it } from "vitest";
import {
  keysAfterPress,
  recorderKey,
  recorderVerdict,
  savedAfterRecording,
  takesSecondKey,
} from "./keyRecorder";

const key = (pressed: string, held: Partial<RecordedKey> = {}): RecordedKey => ({
  key: pressed,
  code: /^[a-z]$/i.test(pressed) ? `Key${pressed.toUpperCase()}` : "",
  meta: false,
  ctrl: false,
  alt: false,
  shift: false,
  ...held,
});

describe("Keyboard settings' recorder", () => {
  it("saves on Enter, adds on Shift+Enter, stops on Escape, and records every other key", () => {
    expect(recorderKey(key("Enter"))).toEqual({ kind: "save", mode: "replace" });
    expect(recorderKey(key("Enter", { shift: true }))).toEqual({ kind: "save", mode: "add" });
    expect(recorderKey(key("Escape"))).toEqual({ kind: "cancel" });
    expect(recorderKey(key("Enter", { meta: true })).kind).toBe("press");
    expect(recorderKey(key("Escape", { shift: true })).kind).toBe("press");
    expect(recorderKey(key("k", { meta: true })).kind).toBe("press");
  });

  it("makes a window command's ⌘ or ⌃ key the first of two, and starts over after two", () => {
    const first = keysAfterPress("settings.keyboard", null, key("k", { meta: true }));
    expect(first).toEqual({ key: "k", meta: true });
    expect(takesSecondKey("settings.keyboard", first)).toBe(true);
    const both = keysAfterPress("settings.keyboard", first, key("s"));
    expect(bindingLabel(both)).toBe("⌘K S");
    expect(takesSecondKey("settings.keyboard", both)).toBe(false);
    expect(keysAfterPress("settings.keyboard", both, key("j", { meta: true }))).toEqual({
      key: "j",
      meta: true,
    });
    // A message field's command, and a first key that is no shortcut, start over instead.
    const field = keysAfterPress("message.delete-word-before", null, key("j", { ctrl: true }));
    expect(keysAfterPress("message.delete-word-before", field, key("k", { ctrl: true }))).toEqual({
      key: "k",
      ctrl: true,
    });
    const typed = keysAfterPress("settings.keyboard", null, key(" "));
    expect(keysAfterPress("settings.keyboard", typed, key("j", { meta: true }))).toEqual({
      key: "j",
      meta: true,
    });
  });

  // Accepted layers plan, piece 3: a first key may be plain while not typing, and the second an arrow.
  it("makes a plain key the first of two when not typing, and takes an arrow as the second", () => {
    const first = keysAfterPress("settings.keyboard", null, key("g"));
    expect(takesSecondKey("settings.keyboard", first)).toBe(true);
    const both = keysAfterPress("settings.keyboard", first, key("ArrowRight"));
    expect(both).toEqual({ key: "g", when: "not-typing", second: { key: "ArrowRight" } });
    expect(bindingLabel(both)).toBe("G →");
    expect(recorderVerdict("settings.keyboard", both, DEFAULT_BINDINGS)).toEqual({ kind: "free" });
  });

  // INF-3547's accepted plan, piece 2: "a key may hold Option".
  it("records a key held with ⌥ as one that works anywhere, a plain one only when not typing", () => {
    expect(keysAfterPress("regions.next", null, key("≈", { code: "KeyX", alt: true }))).toEqual({
      key: "x",
      alt: true,
    });
    expect(keysAfterPress("regions.next", null, key("x"))).toEqual({
      key: "x",
      when: "not-typing",
    });
  });

  it("says what saving would do: refuse, keep, take a free key, or move another command's", () => {
    expect(recorderVerdict("cards.next", null, DEFAULT_BINDINGS)).toEqual({ kind: "empty" });
    expect(recorderVerdict("cards.next", { key: "q", meta: true }, DEFAULT_BINDINGS)).toEqual({
      kind: "refused",
      reason: "⌘Q quits Infinitary",
    });
    expect(
      recorderVerdict("cards.next", { key: "]", meta: true, shift: true }, DEFAULT_BINDINGS),
    ).toEqual({ kind: "own" });
    expect(recorderVerdict("cards.next", { key: "j", meta: true }, DEFAULT_BINDINGS)).toEqual({
      kind: "free",
    });
    const moves = recorderVerdict("cards.next", { key: "k", meta: true }, DEFAULT_BINDINGS);
    expect(moves.kind === "moves" && moves.words).toBe(
      "⌘K already runs “Search commands” anywhere in the window. Saving moves it here, and “Search commands” will have no key.",
    );
    const keeps = recorderVerdict("cards.next", { key: "=", meta: true }, DEFAULT_BINDINGS);
    expect(keeps.kind === "moves" && keeps.words).toMatch(
      /“Make everything larger” keeps its other keys\.$/,
    );
    expect(
      recorderVerdict(
        "settings.keyboard",
        { key: "k", meta: true, second: { key: "s" } },
        DEFAULT_BINDINGS,
      ),
    ).toEqual({
      kind: "refused",
      reason: "⌘K runs “Search commands” anywhere in the window, so it can't start two keys",
    });
  });

  it("saves the recorded key in place of the command's keys, or beside them, and moves a clash", () => {
    expect(
      savedAfterRecording(
        DEFAULT_SAVED_KEYMAP,
        DEFAULT_BINDINGS,
        "commands.search",
        { key: "p", meta: true },
        "replace",
      ),
    ).toEqual({ ...DEFAULT_SAVED_KEYMAP, keys: { "commands.search": [{ key: "p", meta: true }] } });
    expect(
      savedAfterRecording(
        DEFAULT_SAVED_KEYMAP,
        DEFAULT_BINDINGS,
        "commands.search",
        { key: "p", meta: true },
        "add",
      ),
    ).toEqual({
      ...DEFAULT_SAVED_KEYMAP,
      keys: {
        "commands.search": [
          { key: "k", meta: true },
          { key: "p", meta: true },
        ],
      },
    });
    expect(
      savedAfterRecording(
        DEFAULT_SAVED_KEYMAP,
        DEFAULT_BINDINGS,
        "cards.next",
        { key: "k", meta: true },
        "replace",
      ),
    ).toEqual({
      ...DEFAULT_SAVED_KEYMAP,
      keys: { "commands.search": [], "cards.next": [{ key: "k", meta: true }] },
    });
    expect(
      savedAfterRecording(
        DEFAULT_SAVED_KEYMAP,
        DEFAULT_BINDINGS,
        "cards.next",
        { key: "q", meta: true },
        "replace",
      ),
    ).toBeNull();
    expect(
      savedAfterRecording(
        DEFAULT_SAVED_KEYMAP,
        DEFAULT_BINDINGS,
        "commands.search",
        { key: "k", meta: true },
        "add",
      ),
    ).toBeNull();
  });
});

// INF-3547's accepted plan, piece 6: tmux's keys all start with its prefix, ⌃B.
describe("recording on tmux", () => {
  const tmux = presetKeymap("tmux");
  const bindings = resolveBindings(tmux);

  it("takes a key after the prefix, and says the prefix alone is not a key", () => {
    const first = keysAfterPress(
      "settings.open",
      null,
      key("b", { ctrl: true }),
      [],
      "mac",
      TMUX_PREFIX,
    );
    expect(first).toEqual({ key: "b", ctrl: true });
    expect(takesSecondKey("settings.open", first, [], "mac", TMUX_PREFIX)).toBe(true);
    expect(recorderVerdict("settings.open", first, bindings, [], "mac", TMUX_PREFIX)).toEqual({
      kind: "refused",
      reason: m.settingsKeyboardPrefixAlone({ key: "⌃B" }),
    });
    const both = keysAfterPress("settings.open", first, key(","), [], "mac", TMUX_PREFIX);
    expect(bindingLabel(both)).toBe("⌃B ,");
    expect(recorderVerdict("settings.open", both, bindings, [], "mac", TMUX_PREFIX).kind).toBe(
      "free",
    );
    const saved = savedAfterRecording(
      tmux,
      bindings,
      "settings.open",
      both,
      "replace",
      [],
      "mac",
      TMUX_PREFIX,
    );
    expect(saved?.keys["settings.open"]).toEqual([{ key: "b", ctrl: true, second: { key: "," } }]);
    // Without a prefix, as on Vim, ⌃B is the text field's and takes no second key.
    expect(takesSecondKey("settings.open", first)).toBe(false);
  });
});
