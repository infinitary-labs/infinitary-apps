import { APP_PANEL_COMMAND_WORDS } from "./appPanelWords.ts";
import {
  type CommandScope,
  KEYBOARD_COMMANDS,
  type KeyBinding,
  type KeyboardCommand,
  type KeyChord,
  searchWords,
} from "./keyboardCommands.ts";
import type { KeySystem } from "./platform";

/**
 * The app's keyboard commands (docs/keyboard.md). One catalog names every
 * command a key can run - its stable id, its words, its default keys, where
 * it works, whether a held key repeats it and what it may change - and one
 * resolver turns a pressed key into the command it runs where it was
 * pressed. Pure, so the main process, the renderer and the tests read one
 * table. A command's handler stays with the code that owns what it changes.
 */

// The catalog, and the types its entries are written in, live in keyboardCommands.ts, which
// imports nothing from this file; the app reads them here, beside the resolver.
export type {
  CommandRisk,
  CommandScope,
  CommandSection,
  CommandSections,
  KeyBinding,
  KeyboardCommand,
  KeyChord,
  WindowCommandRunner,
} from "./keyboardCommands.ts";
export { KEYBOARD_COMMANDS } from "./keyboardCommands.ts";

/** A pressed key, as a DOM keydown and Electron's `before-input-event` both report it. */
export type KeyPress = {
  /** What the layout types, or the key's name (`KeyboardEvent.key`). */
  key: string;
  /** The physical key (`KeyboardEvent.code`). */
  code: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** The key belongs to an input method's composition, which keeps every key it uses. */
  composing: boolean;
  /** The platform repeats a held key. */
  repeat: boolean;
};

/** Whether the installed map needs the document's not-typing path. */
export function hasNotTypingKeys(bindings: Bindings): boolean {
  return Object.values(bindings).some((keys) => keys?.some((key) => key.when === "not-typing"));
}

/** The binding's place is independent of the command's scope. */
export function bindingIsActive(binding: KeyBinding, context: KeyContext): boolean {
  return binding.when !== "not-typing" || context.notTyping === true;
}

export type CommandId = keyof typeof KEYBOARD_COMMANDS;

/** The commands the main process runs, wherever focus is in the window. */
export type WindowCommandId = {
  [Id in CommandId]: (typeof KEYBOARD_COMMANDS)[Id]["scope"] extends "window" ? Id : never;
}[CommandId];

/** The window commands the shell page runs once the main process tells it which. */
export type ShellCommandId = {
  [Id in CommandId]: (typeof KEYBOARD_COMMANDS)[Id] extends { runs: "shell" } ? Id : never;
}[CommandId];

/** The shown card's footer choices: the default, then the rest from the right edge leftward. */
export const CARD_CHOICE_COMMANDS = [
  "cards.choice-1",
  "cards.choice-2",
  "cards.choice-3",
  "cards.choice-4",
] as const satisfies readonly ShellCommandId[];

/** The window commands the main process runs itself. */
export type MainCommandId = Exclude<WindowCommandId, ShellCommandId>;

/** Whether a command's keys are the window's, heard by the main process wherever focus is. */
export function isWindowCommand(id: CommandId): id is WindowCommandId {
  return KEYBOARD_COMMANDS[id].scope === "window";
}

export function isShellCommand(id: CommandId): id is ShellCommandId {
  const command: KeyboardCommand = KEYBOARD_COMMANDS[id];
  return command.runs === "shell";
}

export const COMMAND_IDS = Object.keys(KEYBOARD_COMMANDS) as CommandId[];

export const SHELL_COMMAND_IDS = COMMAND_IDS.filter(isShellCommand);

export const MAIN_COMMAND_IDS = COMMAND_IDS.filter(
  (id): id is MainCommandId => isWindowCommand(id) && !isShellCommand(id),
);

/**
 * The key each movement command presses where focus is (docs/keyboard.md,
 * "Moving by a key of your own"), as `KeyboardEvent.key` names it.
 */
export const MOVE_KEYS = {
  "move.left": "ArrowLeft",
  "move.down": "ArrowDown",
  "move.up": "ArrowUp",
  "move.right": "ArrowRight",
  "move.first": "Home",
  "move.last": "End",
  "move.page-up": "PageUp",
  "move.page-down": "PageDown",
  cancel: "Escape",
} as const satisfies Partial<Record<MainCommandId, string>>;

/** A movement command: it presses one of `MOVE_KEYS` where focus is. */
export type MoveCommandId = keyof typeof MOVE_KEYS;

export type MoveKey = (typeof MOVE_KEYS)[MoveCommandId];

export const MOVE_KEY_NAMES = Object.values(MOVE_KEYS) as MoveKey[];

/** The window's size commands, the other commands the main process runs. */
export type SizeCommandId = Exclude<MainCommandId, MoveCommandId>;

export function isMoveCommand(id: string): id is MoveCommandId {
  return Object.hasOwn(MOVE_KEYS, id);
}

// --- A panel's commands (docs/keyboard.md, "A panel's commands") -----------

/**
 * A command a panel adds to command search (FI3-1015): `panel:<panel>/<command>`,
 * from the panel's id and the command's own in its `manifest.json`. It is
 * how a key a person gives it is kept, so it never changes while the panel
 * keeps the command, and a saved one whose panel is gone waits, unrun, for
 * the panel to come back.
 */
export type PanelCommandId = `panel:${string}`;

/** The longest a panel command's id may be: as long as a saved key may be named by. */
export const PANEL_COMMAND_ID_MAX = 64;

export function panelCommandId(panel: string, command: string): PanelCommandId {
  return `panel:${panel}/${command}`;
}

export function isPanelCommandId(id: string): id is PanelCommandId {
  return /^panel:[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/.test(id);
}

export function panelCommandParts(id: PanelCommandId): { panel: string; command: string } {
  const [panel = "", command = ""] = id.slice("panel:".length).split("/");
  return { panel, command };
}

/**
 * A panel's command as the window's keys read it: its words, the title of
 * the panel it is listed under, and the key the panel suggests. It works
 * anywhere in the window, the shell page runs it, a held key never repeats
 * it, and it only shows or brings forward (`navigate`).
 */
export type PanelCommand = {
  id: PanelCommandId;
  label: string;
  /** The panel's title: command search and Keyboard settings list it under it. */
  panel: string;
  /** The key its panel suggests, or none; the window gives it only where nothing else uses it. */
  keys: readonly KeyBinding[];
  /** Other words command search finds it by, as its panel's manifest names them. */
  words?: readonly string[];
  /**
   * One of the app's own panels' commands: it reads as one of the window's
   * own, listed among the catalog's (`APP_PANEL_COMMANDS_BEFORE`) under no
   * panel's title, as the app's own panels carry no maker's name.
   */
  own?: true;
};

export type AnyCommandId = CommandId | PanelCommandId;

/**
 * The catalog entry a panel command reads as, its suggested key as this
 * system presses it. One of the app's own panels' commands reads in the
 * catalog's words (`APP_PANEL_COMMAND_WORDS`), worded each time they are
 * read, so it follows the language as the catalog's commands do; any other
 * panel's reads as its manifest names it.
 */
export function panelCommandEntry(
  command: PanelCommand,
  system: KeySystem = "mac",
): KeyboardCommand {
  const entry: KeyboardCommand = {
    label: command.label,
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: systemKeys(command.keys, system),
    ...(command.words?.length ? { searchWords: command.words } : {}),
  };
  const worded = command.own ? APP_PANEL_COMMAND_WORDS[command.id] : undefined;
  if (!worded) return entry;
  const { label, words } = worded;
  return Object.defineProperties(entry, {
    label: { get: label, enumerable: true },
    ...(words ? { searchWords: { get: () => searchWords(words()), enumerable: true } } : {}),
  });
}

export function isCatalogCommand(id: string): id is CommandId {
  return Object.hasOwn(KEYBOARD_COMMANDS, id);
}

/**
 * A command's entry: the catalog's, or the panel command's in `panels`, or
 * none; its own keys as this system presses them.
 */
export function commandEntry(
  id: string,
  panels: readonly PanelCommand[] = [],
  system: KeySystem = "mac",
): KeyboardCommand | undefined {
  if (isCatalogCommand(id))
    return system === "mac"
      ? KEYBOARD_COMMANDS[id]
      : { ...KEYBOARD_COMMANDS[id], keys: catalogKeys(id, system) };
  const panel = panels.find((command) => command.id === id);
  return panel ? panelCommandEntry(panel, system) : undefined;
}

/**
 * Where the app's own panels' commands sit among the catalog's: after the
 * commands for the stage and its cards, before Settings.
 */
export const APP_PANEL_COMMANDS_BEFORE: CommandId = "settings.open";

/**
 * Every command a key may run: the catalog's, in its order, with the app's
 * own panels' among them (`APP_PANEL_COMMANDS_BEFORE`), then every other
 * panel's, in the order the panels were added.
 */
export function allCommandIds(panels: readonly PanelCommand[] = []): AnyCommandId[] {
  const own = panels.filter((command) => command.own).map((command) => command.id);
  const at = COMMAND_IDS.indexOf(APP_PANEL_COMMANDS_BEFORE);
  return [
    ...COMMAND_IDS.slice(0, at),
    ...own,
    ...COMMAND_IDS.slice(at),
    ...panels.filter((command) => !command.own).map((command) => command.id),
  ];
}

/**
 * The keys each command answers to; an empty list leaves a command without
 * keys. Every catalog command has its list; a panel command has one once
 * the window installed it with its panel.
 */
export type Bindings = Readonly<Record<CommandId, readonly KeyBinding[]>> &
  Readonly<Partial<Record<PanelCommandId, readonly KeyBinding[]>>>;

/** A command's keys in `bindings`, a panel command's none when it has no list there. */
export function keysOf(bindings: Bindings, id: AnyCommandId): readonly KeyBinding[] {
  return (bindings as Readonly<Record<string, readonly KeyBinding[] | undefined>>)[id] ?? [];
}

/**
 * A chord as this system's keyboard presses it (docs/keyboard.md, "Keys on
 * each system"). The catalog, and a panel's suggested key, are written as a
 * Mac writes them: on a Ctrl system Ctrl takes ⌘'s place, and a chord a Mac
 * holds ⌃ for has no place there, since Ctrl already holds ⌘'s - so the
 * message box's Mac-style Control keys have none, and the size keys keep
 * their ⌘ chords as Ctrl ones.
 */
export function systemChord(chord: KeyChord, system: KeySystem): KeyChord | null {
  if (system === "mac" || (!chord.meta && !chord.ctrl)) return chord;
  if (chord.ctrl) return null;
  return {
    key: chord.key,
    ctrl: true,
    ...(chord.alt ? { alt: true } : {}),
    ...(chord.shift ? { shift: true } : {}),
  };
}

/** Keys as this system presses them (`systemChord`), each once; the Mac's are the keys as written. */
export function systemKeys(keys: readonly KeyBinding[], system: KeySystem): readonly KeyBinding[] {
  if (system === "mac") return keys;
  const pressed: KeyBinding[] = [];
  for (const binding of keys) {
    const first = systemChord(binding, system);
    const second = binding.second ? systemChord(binding.second, system) : undefined;
    if (!first || second === null) continue;
    const next: KeyBinding = {
      ...first,
      ...(second ? { second } : {}),
      ...(binding.when ? { when: binding.when } : {}),
    };
    if (!pressed.some((kept) => JSON.stringify(kept) === JSON.stringify(next))) pressed.push(next);
  }
  return pressed;
}

export function catalogKeys(id: CommandId, system: KeySystem = "mac"): readonly KeyBinding[] {
  return systemKeys(KEYBOARD_COMMANDS[id].keys, system);
}

export function catalogBindings(system: KeySystem): Bindings {
  return Object.fromEntries(
    COMMAND_IDS.map((id): [CommandId, readonly KeyBinding[]] => [id, catalogKeys(id, system)]),
  ) as Record<CommandId, readonly KeyBinding[]>;
}

export const DEFAULT_BINDINGS: Bindings = catalogBindings("mac");

/** What the listener that hears a key knows about where it was pressed. */
export type KeyContext = {
  /** The focused document offered an unused key from outside a typing control. */
  notTyping?: boolean;
  /** The message field that has focus, when the listener is one. */
  field?: "main-message" | "reply";
};

export function scopeIsActive(scope: CommandScope, context: KeyContext): boolean {
  if (scope === "window") return true;
  if (scope === "message-field") return context.field !== undefined;
  return context.field === "main-message";
}

/**
 * The letter a press types: the layout's own Latin letter, or the physical
 * key's on a layout without Latin letters (or under a modifier that types
 * another character), so a chord on `u` still works there.
 */
function letterOf(press: KeyPress): string | undefined {
  if (/^[a-z]$/i.test(press.key)) return press.key.toLowerCase();
  return /^Key([A-Z])$/.exec(press.code)?.[1]?.toLowerCase();
}

export function chordMatches(chord: KeyChord, press: KeyPress): boolean {
  if (
    press.meta !== (chord.meta === true) ||
    press.ctrl !== (chord.ctrl === true) ||
    press.alt !== (chord.alt === true)
  )
    return false;
  if (/^[a-z]$/.test(chord.key))
    return letterOf(press) === chord.key && press.shift === (chord.shift === true);
  if (chord.key.length > 1 || chord.shift === true)
    return press.key === chord.key && press.shift === (chord.shift === true);
  return press.key === chord.key;
}

/**
 * The command whose keys a press is, where it was pressed, whether or not
 * the key is held. An input method's composition keeps every key. A
 * two-key shortcut is never one press (`startsTwoKeys`, `secondKeyCommand`).
 */
export function boundCommand(
  press: KeyPress,
  context: KeyContext,
  bindings: Bindings = DEFAULT_BINDINGS,
): CommandId | undefined {
  if (press.composing) return undefined;
  return COMMAND_IDS.find(
    (candidate) =>
      scopeIsActive(KEYBOARD_COMMANDS[candidate].scope, context) &&
      bindings[candidate].some(
        (binding) =>
          !binding.second && bindingIsActive(binding, context) && chordMatches(binding, press),
      ),
  );
}

/**
 * The panel command whose keys a press is, or nothing: a panel's commands
 * work anywhere in the window and are only looked at once no catalog
 * command took the press (`boundCommand`).
 */
export function panelCommandFor(
  press: KeyPress,
  bindings: Bindings,
  panels: readonly PanelCommand[],
  context: KeyContext = {},
): PanelCommandId | undefined {
  if (press.composing || press.repeat) return undefined;
  return panels.find((command) =>
    keysOf(bindings, command.id).some(
      (binding) =>
        !binding.second && bindingIsActive(binding, context) && chordMatches(binding, press),
    ),
  )?.id;
}

export function startsTwoKeys(
  press: KeyPress,
  context: KeyContext,
  bindings: Bindings = DEFAULT_BINDINGS,
  panels: readonly PanelCommand[] = [],
): boolean {
  if (press.composing) return false;
  const starts = (keys: readonly KeyBinding[]) =>
    keys.some(
      (binding) =>
        binding.second && bindingIsActive(binding, context) && chordMatches(binding, press),
    );
  return (
    COMMAND_IDS.some(
      (candidate) =>
        scopeIsActive(KEYBOARD_COMMANDS[candidate].scope, context) && starts(bindings[candidate]),
    ) || panels.some((command) => starts(keysOf(bindings, command.id)))
  );
}

/** The panel command a two-key shortcut runs, as `secondKeyCommand` finds a catalog one. */
export function secondKeyPanelCommand(
  first: KeyPress,
  second: KeyPress,
  bindings: Bindings,
  panels: readonly PanelCommand[],
  context: KeyContext = {},
): PanelCommandId | undefined {
  if (first.composing || second.composing) return undefined;
  return panels.find((command) =>
    keysOf(bindings, command.id).some(
      (binding) =>
        binding.second !== undefined &&
        bindingIsActive(binding, context) &&
        chordMatches(binding, first) &&
        chordMatches(binding.second, second),
    ),
  )?.id;
}

/**
 * The command a two-key shortcut runs: the one whose first key is `first`
 * and whose second is `second`, where they were pressed, or nothing.
 */
export function secondKeyCommand(
  first: KeyPress,
  second: KeyPress,
  context: KeyContext,
  bindings: Bindings = DEFAULT_BINDINGS,
): CommandId | undefined {
  if (first.composing || second.composing) return undefined;
  return COMMAND_IDS.find(
    (candidate) =>
      scopeIsActive(KEYBOARD_COMMANDS[candidate].scope, context) &&
      bindings[candidate].some(
        (binding) =>
          binding.second !== undefined &&
          bindingIsActive(binding, context) &&
          chordMatches(binding, first) &&
          chordMatches(binding.second, second),
      ),
  );
}

/** One two-key shortcut whose first key was pressed, and the command it runs. */
export type NextKey = { id: AnyCommandId; binding: KeyBinding & { second: KeyChord } };

/**
 * Every key that may follow `first` where it was pressed, with the command
 * each pair runs, in the catalog's order and then the panels' (docs/keyboard.md,
 * "Two-key shortcuts"): what the next-keys hint lists while the window waits.
 */
export function nextKeys(
  first: KeyPress,
  context: KeyContext,
  bindings: Bindings,
  panels: readonly PanelCommand[] = [],
): NextKey[] {
  if (first.composing) return [];
  const following = (id: AnyCommandId): NextKey[] =>
    keysOf(bindings, id).flatMap((binding) =>
      binding.second !== undefined &&
      bindingIsActive(binding, context) &&
      chordMatches(binding, first)
        ? [{ id, binding: { ...binding, second: binding.second } }]
        : [],
    );
  return [
    ...COMMAND_IDS.filter((id) => scopeIsActive(KEYBOARD_COMMANDS[id].scope, context)).flatMap(
      following,
    ),
    ...panels.flatMap((command) => following(command.id)),
  ];
}

export function runsOnPress(id: CommandId, press: KeyPress): boolean {
  return !press.repeat || KEYBOARD_COMMANDS[id].repeat;
}

/**
 * The command a press runs where it was pressed, if any. An input method's
 * composition keeps every key, and a held key repeats only a command that
 * allows it.
 */
export function commandFor(
  press: KeyPress,
  context: KeyContext,
  bindings: Bindings = DEFAULT_BINDINGS,
): CommandId | undefined {
  const id = boundCommand(press, context, bindings);
  return id !== undefined && runsOnPress(id, press) ? id : undefined;
}

/** What one of a desktop's own window keys does (docs/keyboard.md, "Keys on each system"). */
export type DesktopKeyAction = "quit" | "close-window";

/**
 * The window keys a Mac's app menu holds (⌘Q, ⌘W) and the window takes
 * itself on a Ctrl system, which has no menu bar: Ctrl+Q quits Firstmate and
 * Ctrl+W closes the window. They are a Ctrl system's own keys, so no
 * command can take them (`src/shared/keymap.ts`).
 */
const DESKTOP_KEYS: readonly { chord: KeyChord; action: DesktopKeyAction }[] = [
  { chord: { key: "q", ctrl: true }, action: "quit" },
  { chord: { key: "w", ctrl: true }, action: "close-window" },
];

/** The desktop key a press is on this system, if any; a Mac's are its menu's. */
export function desktopKeyAction(press: KeyPress, system: KeySystem): DesktopKeyAction | undefined {
  if (system === "mac" || press.composing) return undefined;
  return DESKTOP_KEYS.find((entry) => chordMatches(entry.chord, press))?.action;
}

// i18n-exempt: Electron's own accelerator names, read by the menu and never shown as words
const ACCELERATOR_KEYS: Readonly<Record<string, string>> = {
  "+": "Plus",
  " ": "Space",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Escape: "Esc",
};

/** A chord as an Electron menu accelerator (`Command+Plus`). */
export function chordAccelerator(chord: KeyChord): string {
  // i18n-exempt: Electron's own accelerator names, never shown as words
  const modifiers = [
    chord.meta && "Command",
    chord.ctrl && "Control",
    chord.alt && "Alt",
    chord.shift && "Shift",
  ].filter((modifier): modifier is string => typeof modifier === "string");
  const key = ACCELERATOR_KEYS[chord.key] ?? chord.key.toUpperCase();
  return [...modifiers, key].join("+");
}

/**
 * The accelerator a menu item shows for a command: its first key a menu can
 * show, which is never a two-key shortcut, or none.
 */
export function menuAccelerator(
  id: CommandId,
  bindings: Bindings = DEFAULT_BINDINGS,
): string | undefined {
  const first = bindings[id].find((binding) => !binding.second && binding.when !== "not-typing");
  return first ? chordAccelerator(first) : undefined;
}

/** A named key as a Mac draws it on a key and in a menu. */
const KEY_GLYPHS: Readonly<Record<string, string>> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Escape: "⎋",
  Enter: "↩",
  Tab: "⇥",
  Backspace: "⌫",
  " ": "Space",
};

/** A named key as Linux and other Ctrl systems write it in a hint and on a key cap. */
// i18n-exempt: key names stay as the keyboard writes them (docs/i18n.md, "What stays English")
const KEY_WORDS: Readonly<Record<string, string>> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Escape: "Esc",
  " ": "Space",
  "+": "Plus",
  "-": "Minus",
};

/**
 * A chord as a person reads it in a hint: on a Mac its modifier glyphs in
 * the Mac's order, then the key (`⇧⌘L`, `⌘,`); on a Ctrl system the words
 * Linux writes, joined by `+` (`Ctrl+Shift+L`, `Ctrl+,`).
 */
export function chordLabel(chord: KeyChord, system: KeySystem = "mac"): string {
  if (system !== "mac") {
    const key =
      KEY_WORDS[chord.key] ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key);
    // i18n-exempt: key names stay as the keyboard writes them
    return [
      chord.ctrl && "Ctrl",
      chord.alt && "Alt",
      chord.shift && "Shift",
      chord.meta && "Super",
      key,
    ]
      .filter((part): part is string => typeof part === "string")
      .join("+");
  }
  const key =
    KEY_GLYPHS[chord.key] ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key);
  return `${chord.ctrl ? "⌃" : ""}${chord.alt ? "⌥" : ""}${chord.shift ? "⇧" : ""}${chord.meta ? "⌘" : ""}${key}`;
}

/** A command's keys as a person reads them: a chord, or a two-key shortcut's two (`⌘K S`). */
export function bindingLabel(binding: KeyBinding, system: KeySystem = "mac"): string {
  return binding.second
    ? `${chordLabel(binding, system)} ${chordLabel(binding.second, system)}`
    : chordLabel(binding, system);
}

export function keyHint(
  id: AnyCommandId,
  bindings: Bindings = DEFAULT_BINDINGS,
  system: KeySystem = "mac",
): string | undefined {
  const first = keysOf(bindings, id)[0];
  return first ? bindingLabel(first, system) : undefined;
}

/**
 * A command's keys as `aria-keyshortcuts` names them (`Meta+Shift+L`), or
 * none. The attribute has no way to say two keys in turn, so a two-key
 * shortcut is left out.
 */
export function ariaKeyShortcuts(
  id: AnyCommandId,
  bindings: Bindings = DEFAULT_BINDINGS,
): string | undefined {
  const names = keysOf(bindings, id)
    .filter((binding) => !binding.second)
    .map((chord) =>
      [
        chord.ctrl && "Control",
        chord.alt && "Alt",
        chord.shift && "Shift",
        chord.meta && "Meta",
        chord.key === " "
          ? "Space"
          : /^[a-z]$/.test(chord.key)
            ? chord.key.toUpperCase()
            : chord.key,
      ]
        .filter((part): part is string => typeof part === "string")
        .join("+"),
    );
  return names.length > 0 ? names.join(" ") : undefined;
}
