import {
  type AnyCommandId,
  type CommandId,
  isCatalogCommand,
  KEYBOARD_COMMANDS,
  type KeyBinding,
  type KeyChord,
  systemKeys,
} from "./keyboard";
import type { KeySystem } from "./platform";

/**
 * Keyboard presets (docs/keyboard.md, "Presets"; INF-3547's accepted plan,
 * piece 4, and tmux, piece 6): each is a whole table of keys, so a person
 * coming from Vim, Emacs, VS Code or tmux finds the moves they already
 * know. Legacy is the catalog's own keys, as every version before presets
 * had them; the others are the catalog's keys with the commands a preset
 * changes replaced here.
 * Pure data, written as a Mac writes keys; each system reads them through
 * `systemKeys`, as it reads the catalog.
 */

/** The presets, in the order the Preset row lists them. */
export const PRESET_IDS = ["vim", "emacs", "vscode", "tmux", "legacy"] as const;
export type PresetId = (typeof PRESET_IDS)[number];

/** The preset a profile that never ran an older version starts on. */
export const NEW_PROFILE_PRESET: PresetId = "vim";

/** A preset's name, as the Preset row shows it. */
export const PRESET_LABELS: Readonly<Record<PresetId, string>> = {
  vim: "Vim",
  emacs: "Emacs",
  vscode: "VS Code",
  tmux: "Tmux",
  legacy: "Legacy",
};

export function isPresetId(value: string): value is PresetId {
  return (PRESET_IDS as readonly string[]).includes(value);
}

/** A key that works only while the person is not typing. */
function bare(key: string, more: Omit<KeyChord, "key"> = {}, second?: KeyChord): KeyBinding {
  return { key, ...more, ...(second ? { second } : {}), when: "not-typing" };
}

/** Two keys in a row, the first held with the given modifiers. */
function pair(first: KeyChord, second: KeyChord, notTyping = false): KeyBinding {
  return { ...first, second, ...(notTyping ? { when: "not-typing" as const } : {}) };
}

const ctrl = (key: string, shift = false): KeyChord => ({
  key,
  ctrl: true,
  ...(shift ? { shift: true } : {}),
});
const cmd = (key: string, shift = false): KeyChord => ({
  key,
  meta: true,
  ...(shift ? { shift: true } : {}),
});

/** The preset's own keys for a command, then the catalog's it keeps beside them. */
function withLegacy(id: CommandId, ...more: KeyBinding[]): readonly KeyBinding[] {
  return [...more, ...KEYBOARD_COMMANDS[id].keys];
}

/** A preset's keys for the commands it changes; every other command keeps the catalog's. */
type PresetTable = Partial<Readonly<Record<AnyCommandId, readonly KeyBinding[]>>>;

/** Ctrl+W, then a key: Vim's window commands, while not typing. */
const wincmd = (key: string): KeyBinding => pair(ctrl("w"), { key }, true);
/** g, then a key: Vim's "go to" commands, while not typing. */
const go = (key: string, shift = false): KeyBinding =>
  bare("g", {}, { key, ...(shift ? { shift: true } : {}) });
/** Ctrl+X, then a key: Emacs's prefix, anywhere. */
const ctrlX = (second: KeyChord): KeyBinding => pair(ctrl("x"), second);
/** ⌘K, then a key: VS Code's chord prefix. */
const cmdK = (second: KeyChord): KeyBinding => pair(cmd("k"), second);

/**
 * Vim: every ⌘ key of today stays, listed after Vim's own so a hint names
 * Vim's, and while the person is not typing h j k
 * l move, g starts a "go to", : searches commands, / finds a task and Ctrl+W
 * moves between the window's parts. Anywhere, Ctrl+N and Ctrl+P move down
 * and up, Ctrl+[ cancels and Ctrl+Tab steps through a card's tabs. While
 * typing, Ctrl+W, U, K and Y keep editing text.
 */
const VIM: PresetTable = {
  "commands.search": withLegacy("commands.search", bare(":")),
  "focus.main-message": withLegacy("focus.main-message", bare("i")),
  "focus.card-reply": withLegacy("focus.card-reply", bare("r")),
  "focus.card-body": [go("c")],
  "focus.card-actions": [go("a")],
  "regions.next": withLegacy("regions.next", wincmd("w")),
  "regions.previous": withLegacy("regions.previous", wincmd("p")),
  "regions.left": [wincmd("h"), bare("h", { ctrl: true })],
  "regions.down": [wincmd("j"), bare("j", { ctrl: true })],
  "regions.up": [wincmd("k"), bare("k", { ctrl: true })],
  "regions.right": [wincmd("l"), bare("l", { ctrl: true })],
  "move.left": [bare("h")],
  "move.down": [bare("j"), ctrl("n")],
  "move.up": [bare("k"), ctrl("p")],
  "move.right": [bare("l")],
  "move.first": [go("g")],
  "move.last": [bare("g", { shift: true })],
  "move.page-down": [bare("d", { ctrl: true }), bare("f", { ctrl: true })],
  "move.page-up": [bare("u", { ctrl: true }), bare("b", { ctrl: true })],
  cancel: [ctrl("[")],
  "cards.previous": withLegacy("cards.previous", bare("h", { shift: true })),
  "cards.next": withLegacy("cards.next", bare("l", { shift: true })),
  "cards.minimize": withLegacy("cards.minimize", bare("q"), wincmd("c")),
  "cards.maximize": [wincmd("o")],
  "cards.next-revision": [bare("]", {}, { key: "c" })],
  "cards.thread": withLegacy("cards.thread", bare("z", {}, { key: "a" })),
  "cards.next-tab": [go("t"), ctrl("Tab")],
  "cards.previous-tab": [go("t", true), ctrl("Tab", true)],
  "settings.open": withLegacy("settings.open", go("s")),
  "settings.keyboard": [bare("?")],
  "project-focus.open": withLegacy("project-focus.open", go("p")),
  "panel:now/find": [bare("/"), cmd("f", true)],
  "panel:now/board": [go("b"), cmd("b")],
  // Ctrl+P moves up anywhere, which in the main message brings back the last one.
  "message.recall": [{ key: "ArrowUp" }],
};

/**
 * Emacs: every ⌘ key of today stays; Option is Meta. ⌥X searches commands,
 * Ctrl+G cancels, Ctrl+N, P, F and B move, Ctrl+V and ⌥V page, and Ctrl+X
 * starts the window's commands: o the next part, b a task, 1 maximize, 0
 * and k put a card aside. Ctrl+H, then b or n, open the keys and what's
 * new while not typing, since Ctrl+H deletes in a text field. < and >
 * go to the start and the end while not typing, as they do in Emacs's
 * read-only buffers.
 */
const EMACS: PresetTable = {
  "commands.search": withLegacy("commands.search", { key: "x", alt: true }),
  cancel: [ctrl("g")],
  "move.down": [ctrl("n")],
  "move.up": [ctrl("p")],
  "move.right": [ctrl("f")],
  "move.left": [ctrl("b")],
  "move.page-down": [ctrl("v")],
  "move.page-up": [{ key: "v", alt: true }],
  "move.first": [bare("<")],
  "move.last": [bare(">")],
  // Ctrl+P moves up anywhere, which in the main message brings back the last one.
  "message.recall": [{ key: "ArrowUp" }],
  "regions.next": withLegacy("regions.next", ctrlX({ key: "o" })),
  "panel:now/find": [ctrlX({ key: "b" }), ctrl("s"), cmd("f", true)],
  "panel:now/board": [ctrlX(ctrl("b")), cmd("b")],
  "project-focus.open": withLegacy("project-focus.open", ctrlX({ key: "p" })),
  "cards.minimize": withLegacy("cards.minimize", ctrlX({ key: "0" }), ctrlX({ key: "k" })),
  "cards.maximize": [ctrlX({ key: "1" })],
  "cards.previous": withLegacy("cards.previous", ctrlX({ key: "ArrowLeft" })),
  "cards.next": withLegacy("cards.next", ctrlX({ key: "ArrowRight" })),
  "cards.next-tab": [ctrl("Tab")],
  "cards.previous-tab": [ctrl("Tab", true)],
  "focus.main-message": withLegacy("focus.main-message", ctrlX({ key: "m" })),
  "settings.keyboard": [pair(ctrl("h"), { key: "b" }, true)],
  "whats-new.show": [pair(ctrl("h"), { key: "n" }, true)],
  "size.larger": withLegacy("size.larger", ctrlX(ctrl("+")), ctrlX(ctrl("="))),
  "size.smaller": withLegacy("size.smaller", ctrlX(ctrl("-"))),
  "size.reset": withLegacy("size.reset", ctrlX(ctrl("0"))),
};

/**
 * VS Code: no plain keys, and the ⌘ layer remapped the way VS Code has it:
 * ⇧⌘P and F1 search commands, ⌘P finds a task, ⌘K starts a second key
 * (⌘K ⌘S the keys, ⌘K Z maximize, ⌘K W put aside, ⌘K ⌘ and an arrow the
 * part in that direction), so ⌘K alone no longer searches.
 */
const VSCODE: PresetTable = {
  "commands.search": [cmd("p", true), { key: "F1" }],
  "panel:now/find": [cmd("p"), cmd("f", true)],
  "settings.keyboard": [cmdK(cmd("s"))],
  "cards.maximize": [cmdK({ key: "z" })],
  "cards.minimize": [cmdK({ key: "w" }), cmd("m", true)],
  "cards.show-crewmate": [ctrl("`")],
  "project-focus.open": [ctrl("r")],
  "focus.main-message": [{ key: "i", meta: true, ctrl: true }, cmd("l")],
  "regions.left": [cmdK(cmd("ArrowLeft"))],
  "regions.down": [cmdK(cmd("ArrowDown"))],
  "regions.up": [cmdK(cmd("ArrowUp"))],
  "regions.right": [cmdK(cmd("ArrowRight"))],
  "cards.next-tab": [ctrl("Tab")],
  "cards.previous-tab": [ctrl("Tab", true)],
  "cards.next-revision": [{ key: "F7" }],
};

/**
 * Emacs on a Ctrl system (INF-3547's later piece 5, the captain's approved
 * Linux keys), written as Linux presses them, since a Mac's Control keys have
 * no place there (`systemChord`). Ctrl+X and Ctrl+V cut and paste while
 * typing, as in every Linux app, and outside a text field Ctrl+X starts
 * Emacs's commands and Ctrl+V pages down, the split Emacs's CUA mode makes.
 * Ctrl+G cancels, which leaves a message too; Ctrl+N, P, F and B move
 * anywhere, a message's cursor included; Alt+X searches commands, so Ctrl+K
 * deletes to the end of the line in a message, with Alt+Y putting it back;
 * the task board moves from Ctrl+B to Ctrl+X Ctrl+B.
 */
const lin = (key: string, shift = false): KeyChord => ({
  key,
  ctrl: true,
  ...(shift ? { shift: true } : {}),
});
/** Ctrl+X, then a key: Emacs's prefix, outside a text field. */
const linX = (second: KeyChord): KeyBinding => pair(lin("x"), second, true);
/** Ctrl+H, then a key, outside a text field. */
const linH = (key: string): KeyBinding => pair(lin("h"), { key }, true);
const EMACS_CTRL: PresetTable = {
  "commands.search": [{ key: "x", alt: true }],
  cancel: [lin("g")],
  "move.down": [lin("n")],
  "move.up": [lin("p")],
  "move.right": [lin("f")],
  "move.left": [lin("b")],
  "move.page-down": [bare("v", { ctrl: true })],
  "move.page-up": [{ key: "v", alt: true }],
  "move.first": [bare("<")],
  "move.last": [bare(">")],
  // Ctrl+P moves up anywhere, which in the main message brings back the last one.
  "message.recall": [{ key: "ArrowUp" }],
  "message.delete-to-line-end": [lin("k")],
  "message.put-back-deleted": [{ key: "y", alt: true }],
  "regions.next": [linX({ key: "o" }), { key: "F6" }],
  "panel:now/find": [linX({ key: "b" }), lin("s"), lin("f", true)],
  "panel:now/board": [linX(lin("b"))],
  "project-focus.open": [linX({ key: "p" }), lin("p", true)],
  "cards.minimize": [linX({ key: "0" }), linX({ key: "k" }), lin("m", true)],
  "cards.maximize": [linX({ key: "1" })],
  "cards.previous": [linX({ key: "ArrowLeft" }), lin("[", true), lin("{", true)],
  "cards.next": [linX({ key: "ArrowRight" }), lin("]", true), lin("}", true)],
  "cards.next-tab": [lin("Tab")],
  "cards.previous-tab": [lin("Tab", true)],
  "focus.main-message": [linX({ key: "m" }), lin("l")],
  "settings.keyboard": [linH("b")],
  "whats-new.show": [linH("n")],
  "size.larger": [linX(lin("+")), linX(lin("=")), lin("+"), lin("=")],
  "size.smaller": [linX(lin("-")), lin("-")],
  "size.reset": [linX(lin("0")), lin("0")],
};

/** The presets written as a table of their own; tmux is Vim's table plus its prefix layer. */
type TabledPreset = Exclude<PresetId, "tmux">;

/** A preset's own table for a Ctrl system, written as that system presses keys, where the Mac's cannot be read there. */
const CTRL_TABLES: Partial<Readonly<Record<TabledPreset, PresetTable>>> = { emacs: EMACS_CTRL };

/**
 * tmux's prefix, as tmux has it: ⌃B, then the second key of the prefix
 * layer. A person changes it in one place (`SavedKeymap.prefix`), and every
 * key of the layer moves with it.
 */
export const TMUX_PREFIX: KeyChord = { key: "b", ctrl: true };

/**
 * tmux: Vim's keys for moving inside content, as tmux borrows them, and
 * tmux's prefix layer, which works anywhere, mid-sentence too, as it does
 * in a terminal. A session is a project, a window is a card and a pane is a
 * part of the window: the prefix, then : searches commands, ? opens the
 * keys, s the project focus, w or f finds a task, n and p the next and the
 * previous card, o the next part and an arrow the part that way, z
 * maximizes a card, d puts it aside (tmux's detach) and [ goes to the
 * card's body (tmux's copy mode). Each entry is the layer's second key.
 */
const TMUX_LAYER: Partial<Readonly<Record<AnyCommandId, readonly KeyChord[]>>> = {
  "commands.search": [{ key: ":" }],
  "settings.keyboard": [{ key: "?" }],
  "project-focus.open": [{ key: "s" }],
  "panel:now/find": [{ key: "w" }, { key: "f" }],
  "cards.next": [{ key: "n" }],
  "cards.previous": [{ key: "p" }],
  "regions.next": [{ key: "o" }],
  "regions.left": [{ key: "ArrowLeft" }],
  "regions.down": [{ key: "ArrowDown" }],
  "regions.up": [{ key: "ArrowUp" }],
  "regions.right": [{ key: "ArrowRight" }],
  "cards.maximize": [{ key: "z" }],
  "cards.minimize": [{ key: "d" }],
  "focus.card-body": [{ key: "[" }],
};

const TABLES: Readonly<Record<TabledPreset, PresetTable>> = {
  legacy: {},
  vim: VIM,
  emacs: EMACS,
  vscode: VSCODE,
};

/** Whether a preset gives this command keys of its own, a panel's command among them. */
export function presetChanges(
  preset: PresetId,
  id: AnyCommandId,
  system: KeySystem = "mac",
): boolean {
  if (preset === "tmux") return presetChanges("vim", id, system) || Object.hasOwn(TMUX_LAYER, id);
  return Object.hasOwn(tableOn(preset, system), id);
}

/** A preset's table on a system: its own Ctrl table there, if it has one. */
function tableOn(preset: TabledPreset, system: KeySystem): PresetTable {
  return (system === "ctrl" ? CTRL_TABLES[preset] : undefined) ?? TABLES[preset];
}

/** Whether two chords are one press: the same key, a letter in either case, and the same modifiers. */
export function sameChord(a: KeyChord, b: KeyChord): boolean {
  const key = (chord: KeyChord) =>
    /^[a-z]$/i.test(chord.key) ? chord.key.toLowerCase() : chord.key;
  return (
    key(a) === key(b) &&
    (a.meta === true) === (b.meta === true) &&
    (a.ctrl === true) === (b.ctrl === true) &&
    (a.alt === true) === (b.alt === true) &&
    (a.shift === true) === (b.shift === true)
  );
}

/** The two keys of the prefix layer: the prefix, then this second key, anywhere. */
export function prefixed(prefix: KeyChord, second: KeyChord): KeyBinding {
  const { key, meta, ctrl, alt, shift } = prefix;
  return {
    key,
    ...(meta ? { meta: true } : {}),
    ...(ctrl ? { ctrl: true } : {}),
    ...(alt ? { alt: true } : {}),
    ...(shift ? { shift: true } : {}),
    second,
  };
}

/** Whether two bindings are the same press, or the same pair of presses. */
function sameKeys(a: KeyBinding, b: KeyBinding): boolean {
  return (
    sameChord(a, b) &&
    (a.second === undefined || b.second === undefined
      ? a.second === b.second
      : sameChord(a.second, b.second))
  );
}

/**
 * A command's tmux keys on a system: Vim's, less any that the prefix takes
 * (⌃B pages up in Vim, so with tmux's own prefix it does not), with the
 * prefix layer's listed after Vim's own and before the catalog's keys Vim
 * keeps (a panel's suggested key Vim keeps is not split out), so a hint names a key of tmux's own (the captain's pick "Show each
 * preset's own keys first"). The prefix is pressed as it is, on every system.
 */
function tmuxKeys(id: AnyCommandId, system: KeySystem, prefix: KeyChord): readonly KeyBinding[] {
  const vim = presetKeys("vim", id, system).filter((binding) => !sameChord(binding, prefix));
  const legacy = isCatalogCommand(id) ? systemKeys(KEYBOARD_COMMANDS[id].keys, system) : [];
  const isKept = (binding: KeyBinding) => legacy.some((old) => sameKeys(old, binding));
  return [
    ...vim.filter((binding) => !isKept(binding)),
    ...(TMUX_LAYER[id] ?? []).map((second) => prefixed(prefix, second)),
    ...vim.filter(isKept),
  ];
}

/**
 * A command's own keys in a preset on a system: the preset's, or the
 * catalog's where it changes nothing. `prefix` is tmux's, which a person
 * may change (`SavedKeymap.prefix`). A panel's command the preset leaves
 * alone has none here; its panel's suggested key stands (`resolveBindings`).
 */
export function presetKeys(
  preset: PresetId,
  id: AnyCommandId,
  system: KeySystem = "mac",
  prefix: KeyChord = TMUX_PREFIX,
): readonly KeyBinding[] {
  if (preset === "tmux") return tmuxKeys(id, system, prefix);
  const native = system === "ctrl" ? CTRL_TABLES[preset] : undefined;
  if (native) {
    const own = native[id];
    if (own) return own;
  } else {
    const own = TABLES[preset][id];
    if (own) return systemKeys(own, system);
  }
  return isCatalogCommand(id) ? systemKeys(KEYBOARD_COMMANDS[id].keys, system) : [];
}

/**
 * The presets the Preset row offers. Legacy only where the profile had it -
 * it ran a version from before presets; the chosen preset is always offered.
 */
export function presetsOffered(legacy: boolean, chosen?: PresetId): PresetId[] {
  return PRESET_IDS.filter((id) => id === chosen || id !== "legacy" || legacy);
}
