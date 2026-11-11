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
 * piece 4): each is a whole table of keys, so a person coming from Vim,
 * Emacs or VS Code finds the moves they already know. Legacy is the
 * catalog's own keys, as every version before presets had them; the others
 * are the catalog's keys with the commands a preset changes replaced here.
 * Pure data, written as a Mac writes keys; each system reads them through
 * `systemKeys`, as it reads the catalog.
 */

/** The presets, in the order the Preset row lists them. */
export const PRESET_IDS = ["vim", "emacs", "vscode", "legacy"] as const;
export type PresetId = (typeof PRESET_IDS)[number];

/** The preset a profile that never ran an older version starts on. */
export const NEW_PROFILE_PRESET: PresetId = "vim";

/** A preset's name, as the Preset row shows it. */
export const PRESET_LABELS: Readonly<Record<PresetId, string>> = {
  vim: "Vim",
  emacs: "Emacs",
  vscode: "VS Code",
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

/** The catalog's own keys for a command, then the preset's beside them. */
function withLegacy(id: CommandId, ...more: KeyBinding[]): readonly KeyBinding[] {
  return [...KEYBOARD_COMMANDS[id].keys, ...more];
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
 * Vim: every ⌘ key of today stays, and while the person is not typing h j k
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
  "panel:now/find": [cmd("f", true), bare("/")],
  "panel:now/board": [cmd("b"), go("b")],
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
  "panel:now/find": [cmd("f", true), ctrlX({ key: "b" }), ctrl("s")],
  "panel:now/board": [cmd("b"), ctrlX(ctrl("b"))],
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
  "focus.main-message": [cmd("l"), { key: "i", meta: true, ctrl: true }],
  "regions.left": [cmdK(cmd("ArrowLeft"))],
  "regions.down": [cmdK(cmd("ArrowDown"))],
  "regions.up": [cmdK(cmd("ArrowUp"))],
  "regions.right": [cmdK(cmd("ArrowRight"))],
  "cards.next-tab": [ctrl("Tab")],
  "cards.previous-tab": [ctrl("Tab", true)],
  "cards.next-revision": [{ key: "F7" }],
};

const TABLES: Readonly<Record<PresetId, PresetTable>> = {
  legacy: {},
  vim: VIM,
  emacs: EMACS,
  vscode: VSCODE,
};

/** Whether a preset gives this command keys of its own, a panel's command among them. */
export function presetChanges(preset: PresetId, id: AnyCommandId): boolean {
  return Object.hasOwn(TABLES[preset], id);
}

/**
 * A command's own keys in a preset on a system: the preset's, or the
 * catalog's where it changes nothing. A panel's command the preset leaves
 * alone has none here; its panel's suggested key stands (`resolveBindings`).
 */
export function presetKeys(
  preset: PresetId,
  id: AnyCommandId,
  system: KeySystem = "mac",
): readonly KeyBinding[] {
  const own = TABLES[preset][id];
  if (own) return systemKeys(own, system);
  return isCatalogCommand(id) ? systemKeys(KEYBOARD_COMMANDS[id].keys, system) : [];
}

/**
 * The presets the Preset row offers on a system. Legacy only where the
 * profile had it - it ran a version from before presets - and Emacs only
 * on a Mac for now: Linux takes Ctrl+X, C, V, K and B for itself, so its
 * Emacs keys are separate work. The chosen preset is always offered.
 */
export function presetsOffered(system: KeySystem, legacy: boolean, chosen?: PresetId): PresetId[] {
  return PRESET_IDS.filter(
    (id) => id === chosen || (id === "legacy" ? legacy : id === "emacs" ? system === "mac" : true),
  );
}
