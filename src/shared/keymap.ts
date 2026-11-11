import { z } from "zod";
import {
  type AnyCommandId,
  allCommandIds,
  type Bindings,
  bindingLabel,
  COMMAND_IDS,
  type CommandId,
  type CommandScope,
  catalogKeys,
  chordLabel,
  commandEntry,
  DEFAULT_BINDINGS,
  isPanelCommandId,
  KEYBOARD_COMMANDS,
  type KeyBinding,
  type KeyChord,
  type KeyContext,
  type KeyPress,
  keysOf,
  type PanelCommand,
  type PanelCommandId,
  scopeIsActive,
  systemKeys,
} from "./keyboard";
import type { KeySystem } from "./platform";

/**
 * The keys a person chose (docs/keyboard.md, "Changing keys"): what is
 * saved, which keys a recording may take, where two commands' keys clash,
 * and the one map the window installs from what is saved. Pure, so the main
 * process, Keyboard settings and the tests read one set of rules.
 */

const chordSchema = z.strictObject({
  key: z.string().min(1).max(32),
  meta: z.boolean().optional(),
  ctrl: z.boolean().optional(),
  alt: z.boolean().optional(),
  shift: z.boolean().optional(),
});

const bindingSchema = chordSchema.extend({
  second: chordSchema.optional(),
  when: z.literal("not-typing").optional(),
});

/** The most keys one command keeps. */
export const MAX_KEYS_PER_COMMAND = 8;

/**
 * What is saved: only the commands whose keys a person changed, each with
 * the keys that replace the catalog's. An empty list is a command with no
 * key at all, which is not the same as a command missing here, which keeps
 * the catalog's keys. An id this version does not know is kept as it was
 * saved and runs nothing (`unknownCommands`).
 */
export const savedKeymapSchema = z.strictObject({
  version: z.literal(1),
  keys: z.record(z.string().min(1).max(64), z.array(bindingSchema).max(MAX_KEYS_PER_COMMAND)),
});
export type SavedKeymap = z.infer<typeof savedKeymapSchema>;

/** Nothing changed: every command has the catalog's keys. */
export const DEFAULT_SAVED_KEYMAP: SavedKeymap = { version: 1, keys: {} };

/** The saved keys as read, and whether a saved value was there but could not be read. */
export type SavedKeymapRead = { saved: SavedKeymap; unreadable: boolean };

/**
 * Catalog commands that became a panel's own (docs/keyboard.md, "A panel's
 * commands"): the Tasks panel's search and its board, once the catalog's
 * `tasks.*`, are the commands of its ordinary folder now. A key a person
 * saved under the old id is read as the new command's, so it carries over;
 * one saved under the new id already wins. Saved-data compatibility only:
 * nothing else in the app knows the panel by its id.
 */
export const RETIRED_COMMANDS: Readonly<Record<string, PanelCommandId>> = {
  "tasks.find": "panel:now/find",
  "tasks.board": "panel:now/board",
  "tasks.board-find": "panel:now/board-find",
  "tasks.board-dropped": "panel:now/board-dropped",
  "tasks.board-move": "panel:now/board-move",
};

/** A saved keymap with every retired command's keys under the command that took it over. */
function carriedOver(saved: SavedKeymap): SavedKeymap {
  const keys: SavedKeymap["keys"] = {};
  for (const [id, bindings] of Object.entries(saved.keys)) {
    // INF-1879: Close retired; its custom binding cannot acquire another effect.
    if (id === "cards.close") continue;
    const now = RETIRED_COMMANDS[id];
    if (now === undefined) keys[id] = bindings;
    else if (!Object.hasOwn(saved.keys, now)) keys[now] = bindings;
  }
  return { ...saved, keys };
}

/** Reads a saved value: none is nothing changed; one that cannot be read is too, said so. */
export function readSavedKeymap(raw: unknown): SavedKeymapRead {
  if (raw === undefined) return { saved: DEFAULT_SAVED_KEYMAP, unreadable: false };
  const parsed = savedKeymapSchema.safeParse(raw);
  return parsed.success
    ? { saved: carriedOver(parsed.data), unreadable: false }
    : { saved: DEFAULT_SAVED_KEYMAP, unreadable: true };
}

/**
 * The map the window has installed (docs/keyboard.md, "The installed map"):
 * what is saved, the keys every command answers to, and a version one more
 * at each install, so the window's keys, the menu, the hints and command
 * search can say which map they read.
 */
export type KeymapSnapshot = {
  version: number;
  saved: SavedKeymap;
  bindings: Bindings;
  /** A saved value was there but could not be read, so the catalog's keys are in use. */
  unreadable: boolean;
  /**
   * The panels' commands the window installed with the catalog's
   * (docs/keyboard.md, "A panel's commands"), in the order their panels
   * were added: command search and Keyboard settings list them, and their
   * keys are in `bindings`.
   */
  panels: readonly PanelCommand[];
};

const panelCommandSchema = z.object({
  id: z
    .string()
    .max(64)
    .refine(isPanelCommandId, "a panel command's id")
    .transform((id) => id as PanelCommandId),
  label: z.string().min(1).max(60),
  panel: z.string().min(1).max(40),
  keys: z.array(bindingSchema).max(MAX_KEYS_PER_COMMAND),
  words: z.array(z.string().min(1).max(24)).max(8).optional(),
  own: z.literal(true).optional(),
});

/** The panels' commands the window is told about, at most this many in all. */
export const MAX_PANEL_COMMANDS = 256;

export const panelCommandsSchema = z.array(panelCommandSchema).max(MAX_PANEL_COMMANDS);

export const keymapSnapshotSchema = z.object({
  version: z.number().int().nonnegative(),
  saved: savedKeymapSchema,
  bindings: z.record(z.string(), z.array(bindingSchema)),
  unreadable: z.boolean(),
  panels: panelCommandsSchema,
}) as unknown as z.ZodType<KeymapSnapshot>;

/** The catalog's own keys, before anything is installed. */
export const DEFAULT_KEYMAP_SNAPSHOT: KeymapSnapshot = {
  version: 0,
  saved: DEFAULT_SAVED_KEYMAP,
  bindings: DEFAULT_BINDINGS,
  unreadable: false,
  panels: [],
};

/** Whether a command is one this window runs: the catalog's, or a panel's it has now. */
function isKnown(id: string, panels: readonly PanelCommand[]): id is AnyCommandId {
  return commandEntry(id, panels) !== undefined;
}

/**
 * The saved ids this window does not know - another version's, or a
 * panel's that is not here now: kept, shown, and never run.
 */
export function unknownCommands(
  saved: SavedKeymap,
  panels: readonly PanelCommand[] = [],
): string[] {
  return Object.keys(saved.keys).filter((id) => !isKnown(id, panels));
}

/** Whether a person changed a command's keys. */
export function isChanged(saved: SavedKeymap, id: AnyCommandId): boolean {
  return Object.hasOwn(saved.keys, id);
}

/** A command's entry, the catalog's or a panel's; one the window does not know reads as a window command. */
function entryOf(id: AnyCommandId, panels: readonly PanelCommand[], system: KeySystem = "mac") {
  return (
    commandEntry(id, panels, system) ?? {
      label: id,
      scope: "window" as const,
      keys: [] as readonly KeyBinding[],
    }
  );
}

// --- Which keys a command may take ---------------------------------------

const LETTER = /^[a-z]$/;
const FUNCTION_KEY = /^F([1-9]|1[0-9]|2[0-4])$/;

/** Keys that keep their own job everywhere, and the words that say which. */
const OWN_JOBS: Readonly<Record<string, string>> = {
  Enter: "Enter sends and chooses, and keeps that job",
  Tab: "Tab moves between controls, and keeps that job",
  Escape: "Escape closes what is open, and keeps that job",
  Backspace: "Delete erases text, and keeps that job",
  Delete: "Delete erases text, and keeps that job",
  ArrowUp: "The arrow keys move the cursor and through lists, and keep that job",
  ArrowDown: "The arrow keys move the cursor and through lists, and keep that job",
  ArrowLeft: "The arrow keys move the cursor and through lists, and keep that job",
  ArrowRight: "The arrow keys move the cursor and through lists, and keep that job",
  Home: "Home, End and the page keys scroll, and keep that job",
  End: "Home, End and the page keys scroll, and keep that job",
  PageUp: "Home, End and the page keys scroll, and keep that job",
  PageDown: "Home, End and the page keys scroll, and keep that job",
};

/** The Mac's own keys and the app's native ones: a recording never takes them. */
const PLATFORM_KEYS: readonly { chord: KeyChord; job: string }[] = [
  { chord: { key: "q", meta: true }, job: "quits Infinitary" },
  { chord: { key: "w", meta: true }, job: "closes the window" },
  { chord: { key: "h", meta: true }, job: "hides Infinitary" },
  { chord: { key: "h", meta: true, alt: true }, job: "hides the other apps" },
  { chord: { key: "m", meta: true }, job: "minimizes the window" },
  { chord: { key: "c", meta: true }, job: "copies" },
  { chord: { key: "x", meta: true }, job: "cuts" },
  { chord: { key: "v", meta: true }, job: "pastes" },
  { chord: { key: "v", meta: true, alt: true, shift: true }, job: "pastes" },
  { chord: { key: "a", meta: true }, job: "selects all" },
  { chord: { key: "z", meta: true }, job: "undoes" },
  { chord: { key: "z", meta: true, shift: true }, job: "redoes" },
  { chord: { key: "`", meta: true }, job: "moves between windows" },
  { chord: { key: " ", meta: true }, job: "opens Spotlight" },
  { chord: { key: " ", ctrl: true }, job: "changes the input source" },
  { chord: { key: " ", ctrl: true, alt: true }, job: "changes the input source" },
  { chord: { key: " ", ctrl: true, meta: true }, job: "opens the character viewer" },
  { chord: { key: "f", ctrl: true, meta: true }, job: "makes the window full screen" },
  { chord: { key: "q", ctrl: true, meta: true }, job: "locks the screen" },
  { chord: { key: "3", meta: true, shift: true }, job: "takes a screenshot" },
  { chord: { key: "4", meta: true, shift: true }, job: "takes a screenshot" },
  { chord: { key: "5", meta: true, shift: true }, job: "takes a screenshot" },
  // A text field's own Control keys on a Mac.
  { chord: { key: "a", ctrl: true }, job: "moves to the start of the line" },
  { chord: { key: "e", ctrl: true }, job: "moves to the end of the line" },
  { chord: { key: "b", ctrl: true }, job: "moves back a character" },
  { chord: { key: "f", ctrl: true }, job: "moves forward a character" },
  { chord: { key: "n", ctrl: true }, job: "moves down a line" },
  { chord: { key: "d", ctrl: true }, job: "deletes the next character" },
  { chord: { key: "h", ctrl: true }, job: "deletes the character before" },
  { chord: { key: "o", ctrl: true }, job: "opens a new line" },
  { chord: { key: "t", ctrl: true }, job: "swaps two characters" },
];

/**
 * A Ctrl system's own keys - Linux's desktops, its editing keys and its
 * input methods' - and the app's native ones there (docs/keyboard.md, "Keys
 * on each system"): a recording never takes them. Every chord that holds
 * the Super key belongs to the desktop too (`keyProblem`).
 */
const CTRL_SYSTEM_KEYS: readonly { chord: KeyChord; job: string }[] = [
  { chord: { key: "q", ctrl: true }, job: "quits Infinitary" },
  { chord: { key: "w", ctrl: true }, job: "closes the window" },
  { chord: { key: "F4", alt: true }, job: "closes the window" },
  { chord: { key: "c", ctrl: true }, job: "copies" },
  { chord: { key: "x", ctrl: true }, job: "cuts" },
  { chord: { key: "v", ctrl: true }, job: "pastes" },
  { chord: { key: "v", ctrl: true, shift: true }, job: "pastes" },
  { chord: { key: "a", ctrl: true }, job: "selects all" },
  { chord: { key: "z", ctrl: true }, job: "undoes" },
  { chord: { key: "z", ctrl: true, shift: true }, job: "redoes" },
  { chord: { key: "y", ctrl: true }, job: "redoes" },
  { chord: { key: " ", ctrl: true }, job: "changes the input source" },
  { chord: { key: "u", ctrl: true, shift: true }, job: "types a character by its code" },
  { chord: { key: ".", ctrl: true }, job: "opens the emoji picker" },
  { chord: { key: "t", ctrl: true, alt: true }, job: "opens a terminal" },
  ...Array.from({ length: 12 }, (_, index) => ({
    chord: { key: `F${index + 1}`, ctrl: true, alt: true },
    job: "switches to a text console",
  })),
];

/** The keys a system and the app's native items keep for themselves. */
function reservedKeys(system: KeySystem): readonly { chord: KeyChord; job: string }[] {
  return system === "mac" ? PLATFORM_KEYS : CTRL_SYSTEM_KEYS;
}

/** A chord as the recorder makes it from a press: the letter in lower case, Shift as held. */
export function chordOfPress(press: KeyPress): KeyChord {
  const letter = /^[a-z]$/i.test(press.key)
    ? press.key.toLowerCase()
    : /^Key([A-Z])$/.exec(press.code)?.[1]?.toLowerCase();
  const key = letter ?? press.key;
  return {
    key,
    ...(press.meta ? { meta: true } : {}),
    ...(press.ctrl ? { ctrl: true } : {}),
    ...(press.alt ? { alt: true } : {}),
    ...(press.shift ? { shift: true } : {}),
  };
}

/** Whether some press is both chords. */
export function chordsOverlap(a: KeyChord, b: KeyChord): boolean {
  if (
    (a.meta === true) !== (b.meta === true) ||
    (a.ctrl === true) !== (b.ctrl === true) ||
    (a.alt === true) !== (b.alt === true)
  )
    return false;
  const key = (chord: KeyChord) =>
    /^[a-z]$/i.test(chord.key) ? chord.key.toLowerCase() : chord.key;
  if (key(a) !== key(b)) return false;
  const exactShift = LETTER.test(key(a)) || a.key.length > 1;
  // A typed character without Shift in its chord is that character, Shift or not.
  return exactShift
    ? (a.shift === true) === (b.shift === true)
    : (a.shift === true) === (b.shift === true) || a.shift !== true || b.shift !== true;
}

/** Whether a chord is one a keyboard can press as a shortcut at all, and if not, why. */
const NOT_TYPING_NAMED_KEYS = new Set(["Backspace", "Delete", "Home", "End", "PageUp", "PageDown"]);

function keyProblem(chord: KeyChord, system: KeySystem, notTyping = false): string | null {
  const own = OWN_JOBS[chord.key];
  if (own && !(notTyping && NOT_TYPING_NAMED_KEYS.has(chord.key))) return own;
  if (
    chord.key.length > 1 &&
    !FUNCTION_KEY.test(chord.key) &&
    !(notTyping && NOT_TYPING_NAMED_KEYS.has(chord.key))
  )
    return chord.key === "Dead"
      ? "That key starts an accent, so it can't be a shortcut"
      : "That key can't be a shortcut";
  if (system !== "mac" && chord.meta) return `${chordLabel(chord, system)} belongs to your desktop`;
  const platform = reservedKeys(system).find((entry) => chordsOverlap(entry.chord, chord));
  return platform ? `${chordLabel(chord, system)} ${platform.job}` : null;
}

/** Whether a chord holds ⌘ or ⌃ - Ctrl on a Ctrl system - so typing never presses it. */
function holdsCommandOrControl(chord: KeyChord, system: KeySystem): boolean {
  return chord.ctrl === true || (system === "mac" && chord.meta === true);
}

/** Which keys a shortcut must hold, in the words the recorder shows. */
const COMMAND_KEY_WORDS: Readonly<Record<KeySystem, string>> = { mac: "⌘ or ⌃", ctrl: "Ctrl" };

/**
 * Why a command cannot take these keys, in the words Keyboard settings
 * shows, or null. Anywhere keys hold ⌘ or ⌃ or are function keys; bare
 * keys belong to a window command outside typing. Reserved controls and
 * platform keys keep their jobs, and only a window command takes two keys.
 * A risky key's non-blocking reminder belongs to `bindingWarning`.
 */
export function bindingProblem(
  binding: KeyBinding,
  id: AnyCommandId,
  panels: readonly PanelCommand[] = [],
  system: KeySystem = "mac",
): string | null {
  const entry = commandEntry(id, panels, system);
  if (binding.when === "not-typing" && entry?.scope !== "window")
    return "Only a window command can work when not typing";
  if (binding.when === "not-typing" && binding.key === " ")
    return "Space scrolls and presses controls, and keeps that job";
  const first = keyProblem(binding, system, binding.when === "not-typing");
  if (first) return first;
  if (
    binding.when !== "not-typing" &&
    !holdsCommandOrControl(binding, system) &&
    !FUNCTION_KEY.test(binding.key)
  )
    return `A shortcut holds ${COMMAND_KEY_WORDS[system]}, so typing never runs it`;
  if (!binding.second) return null;
  if (entryOf(id, panels).scope !== "window")
    return "Only a command that works anywhere in the window takes two keys";
  if (!holdsCommandOrControl(binding, system))
    return `A two-key shortcut starts with ${COMMAND_KEY_WORDS[system]}`;
  return keyProblem(binding.second, system);
}

/** Advice for a risky key, never a refusal or an extra confirmation. */
export function bindingWarning(
  binding: KeyBinding,
  id: AnyCommandId,
  panels: readonly PanelCommand[] = [],
  system: KeySystem = "mac",
): string | null {
  return commandEntry(id, panels, system)?.risk === "close" &&
    !holdsCommandOrControl(binding, system)
    ? "One press of this key can answer or close a card. This can also happen while typing inside a card if Infinitary does not recognize its text field."
    : null;
}

// --- Where two commands' keys clash ---------------------------------------

const CONTEXTS: readonly KeyContext[] = [{}, { field: "main-message" }, { field: "reply" }];

/** Whether two scopes share some place a key is pressed. */
export function scopesOverlap(a: CommandScope, b: CommandScope): boolean {
  return CONTEXTS.some((context) => scopeIsActive(a, context) && scopeIsActive(b, context));
}

/** Where a command works, as Keyboard settings says it. */
export const SCOPE_WORDS: Readonly<Record<CommandScope, string>> = {
  window: "Anywhere in the window",
  "message-field": "In the main message and a card's reply",
  "main-message": "In the main message",
};

/** Where two overlapping scopes both work, in the words a clash names: the narrower's. */
export function sharedPlace(a: CommandScope, b: CommandScope): string {
  const narrower = a === "window" ? b : b === "window" ? a : a === "main-message" ? a : b;
  return SCOPE_WORDS[narrower].replace(/^./, (first) => first.toLowerCase());
}

/**
 * How two keys clash when their commands work in the same place: `same`
 * when one press (or one pair) runs both, `prefix` when one is a whole
 * shortcut and the other starts with it, so neither could be told apart.
 */
export type ClashKind = "same" | "prefix";

export function bindingsClash(a: KeyBinding, b: KeyBinding): ClashKind | null {
  if (!chordsOverlap(a, b)) return null;
  if (!a.second && !b.second) return "same";
  if (a.second && b.second) return chordsOverlap(a.second, b.second) ? "same" : null;
  return "prefix";
}

/** Whether two keys are the same keys, as a list of keys holds them. */
export function sameBinding(a: KeyBinding, b: KeyBinding): boolean {
  return a.when === b.when && bindingsClash(a, b) === "same";
}

/** Another command's key a binding clashes with, where both work. */
export type KeyClash = { id: AnyCommandId; binding: KeyBinding; kind: ClashKind };

/** Every key of another command that clashes with `binding` for command `id`. */
export function clashesWith(
  bindings: Bindings,
  id: AnyCommandId,
  binding: KeyBinding,
  panels: readonly PanelCommand[] = [],
): KeyClash[] {
  const scope = entryOf(id, panels).scope;
  return allCommandIds(panels)
    .filter((other) => other !== id && scopesOverlap(scope, entryOf(other, panels).scope))
    .flatMap((other) =>
      keysOf(bindings, other).flatMap((theirs) => {
        const otherScope = entryOf(other, panels).scope;
        if (
          (binding.when === "not-typing" && otherScope !== "window") ||
          (theirs.when === "not-typing" && scope !== "window")
        )
          return [];
        const kind = bindingsClash(binding, theirs);
        return kind ? [{ id: other, binding: theirs, kind }] : [];
      }),
    );
}

/** A clash in the words Keyboard settings shows: both commands, the key, and where. */
export function clashWords(
  id: AnyCommandId,
  clash: KeyClash,
  panels: readonly PanelCommand[] = [],
  system: KeySystem = "mac",
): string {
  const theirs = entryOf(clash.id, panels);
  const where = sharedPlace(entryOf(id, panels).scope, theirs.scope);
  const keys = bindingLabel(clash.binding, system);
  return clash.kind === "same"
    ? `${keys} already runs “${theirs.label}” ${where}`
    : clash.binding.second
      ? `${keys} runs “${theirs.label}” ${where}, and starts with this key`
      : `${keys} runs “${theirs.label}” ${where}, so it can't start two keys`;
}

// --- The installed map -----------------------------------------------------

type Taken = { id: AnyCommandId; scope: CommandScope; binding: KeyBinding };

function takenBy(
  taken: readonly Taken[],
  id: AnyCommandId,
  scope: CommandScope,
  binding: KeyBinding,
): boolean {
  return taken.some(
    (entry) =>
      entry.id !== id &&
      scopesOverlap(scope, entry.scope) &&
      !(binding.when === "not-typing" && entry.scope !== "window") &&
      !(entry.binding.when === "not-typing" && scope !== "window") &&
      bindingsClash(binding, entry.binding) !== null,
  );
}

/**
 * The keys every command answers to: a changed command's own, then each
 * other command's catalog keys. A key that cannot be a shortcut, or that
 * clashes with one already placed where both work, is left out, so the map
 * is always one a key resolves in only one way: the changed commands come
 * first, in the catalog's order, and a catalog key a person gave another
 * command stays with that command.
 *
 * A panel's commands come after the catalog's at each step (docs/keyboard.md,
 * "A panel's commands"): a key a person gave one is placed with the other
 * changed commands, and the key a panel only suggests is placed last of
 * all, in the order the panels were added - so it is taken only where no
 * other command already uses it, and a panel added first keeps the key it
 * asked for.
 */
export function resolveBindings(
  saved: SavedKeymap,
  panels: readonly PanelCommand[] = [],
  system: KeySystem = "mac",
): Bindings {
  const taken: Taken[] = [];
  const resolved: Partial<Record<AnyCommandId, KeyBinding[]>> = {};
  const place = (id: AnyCommandId, keys: readonly KeyBinding[], check: boolean) => {
    const scope = entryOf(id, panels).scope;
    const kept: KeyBinding[] = [];
    for (const binding of keys) {
      if (check && bindingProblem(binding, id, panels, system) !== null) continue;
      if (kept.some((other) => bindingsClash(other, binding) === "same")) continue;
      if (takenBy(taken, id, scope, binding)) continue;
      kept.push(binding);
      taken.push({ id, scope, binding });
    }
    resolved[id] = kept;
  };
  const ids = allCommandIds(panels);
  for (const id of ids) {
    const own = saved.keys[id];
    if (own) place(id, own, true);
  }
  for (const id of COMMAND_IDS)
    if (!isChanged(saved, id)) place(id, catalogKeys(id, system), false);
  // A suggestion is checked like a person's own key: a panel names it as text,
  // as a Mac writes it.
  for (const command of panels)
    if (!isChanged(saved, command.id)) place(command.id, systemKeys(command.keys, system), true);
  return resolved as Bindings;
}

/** The catalog keys of unchanged commands that the map leaves out for a person's own. */
function droppedCatalogKeys(
  saved: SavedKeymap,
  bindings: Bindings,
  system: KeySystem,
): { id: CommandId; binding: KeyBinding }[] {
  return COMMAND_IDS.filter((id) => !isChanged(saved, id)).flatMap((id) =>
    catalogKeys(id, system)
      .filter((binding) => !bindings[id].some((kept) => sameBinding(kept, binding)))
      .map((binding) => ({ id, binding })),
  );
}

/**
 * Why the window refuses to install `next` in place of `current`, or null.
 * A change is installed whole or not at all: every changed command keeps
 * every key it names, no key it names is one a command may not take, and
 * no catalog key moves to another command without the person saying so
 * (which changes that command too). A catalog key a newer catalog gave a
 * command a person's own key already holds stays with the person's.
 */
export function keymapRefusal(
  next: SavedKeymap,
  current: SavedKeymap,
  panels: readonly PanelCommand[] = [],
  system: KeySystem = "mac",
): string | null {
  const bindings = resolveBindings(next, panels, system);
  for (const id of allCommandIds(panels)) {
    const own = next.keys[id];
    if (!own) continue;
    const label = entryOf(id, panels).label;
    for (const [index, binding] of own.entries()) {
      const problem = bindingProblem(binding, id, panels, system);
      if (problem) return `${label}: ${problem}`;
      if (own.slice(0, index).some((earlier) => bindingsClash(earlier, binding) === "same"))
        return `${label} lists ${bindingLabel(binding, system)} twice`;
      if (!keysOf(bindings, id).some((kept) => sameBinding(kept, binding))) {
        const clash = clashesWith(bindings, id, binding, panels)[0];
        return clash
          ? `${label}: ${clashWords(id, clash, panels, system)}`
          : `${label}: ${bindingLabel(binding, system)} clashes with another key`;
      }
    }
  }
  const before = droppedCatalogKeys(current, resolveBindings(current, panels, system), system);
  const moved = droppedCatalogKeys(next, bindings, system).find(
    (entry) =>
      !before.some((was) => was.id === entry.id && sameBinding(was.binding, entry.binding)),
  );
  if (!moved) return null;
  const holder = clashesWith(bindings, moved.id, moved.binding, panels)[0];
  const label = KEYBOARD_COMMANDS[moved.id].label;
  return holder
    ? `${bindingLabel(moved.binding, system)} runs “${entryOf(holder.id, panels).label}” now, so “${label}” can't have it too`
    : `“${label}” can't keep ${bindingLabel(moved.binding, system)}`;
}

/** The installed map for what is saved, with the panels' commands the window has now. */
export function keymapSnapshot(
  read: SavedKeymapRead,
  version: number,
  panels: readonly PanelCommand[] = [],
  system: KeySystem = "mac",
): KeymapSnapshot {
  return {
    version,
    saved: read.saved,
    bindings: resolveBindings(read.saved, panels, system),
    unreadable: read.unreadable,
    panels,
  };
}

// --- Changes Keyboard settings makes ----------------------------------------

function sameKeys(a: readonly KeyBinding[], b: readonly KeyBinding[]): boolean {
  return (
    a.length === b.length &&
    a.every((binding, index) => sameBinding(binding, b[index] as KeyBinding))
  );
}

/**
 * A command's keys set to `keys`; its own keys - the catalog's, or the key
 * its panel suggests - are no change at all.
 */
export function withKeys(
  saved: SavedKeymap,
  id: AnyCommandId,
  keys: readonly KeyBinding[],
  panels: readonly PanelCommand[] = [],
  system: KeySystem = "mac",
): SavedKeymap {
  const { [id]: _previous, ...rest } = saved.keys;
  return sameKeys(keys, entryOf(id, panels, system).keys)
    ? { ...saved, keys: rest }
    : { ...saved, keys: { ...rest, [id]: keys.map(plainBinding) } };
}

/** A command back to its own keys. */
export function withCatalogKeys(saved: SavedKeymap, id: AnyCommandId): SavedKeymap {
  const { [id]: _previous, ...rest } = saved.keys;
  return { ...saved, keys: rest };
}

/**
 * Every command back to its own keys; the ones this window does not know -
 * another version's, a panel's that is not here - stay as saved.
 */
export function withAllCatalogKeys(
  saved: SavedKeymap,
  panels: readonly PanelCommand[] = [],
): SavedKeymap {
  return {
    ...saved,
    keys: Object.fromEntries(Object.entries(saved.keys).filter(([id]) => !isKnown(id, panels))),
  };
}

/**
 * The person chose to move a key here (`replace` it or `add` it beside the
 * command's other keys): each command it clashes with gives that key up and
 * keeps its others, and this command takes it.
 */
export function withKeyMoved(
  saved: SavedKeymap,
  bindings: Bindings,
  id: AnyCommandId,
  binding: KeyBinding,
  mode: "replace" | "add",
  panels: readonly PanelCommand[] = [],
  system: KeySystem = "mac",
): SavedKeymap {
  let next = saved;
  for (const clash of clashesWith(bindings, id, binding, panels)) {
    if (clash.kind !== "same") continue;
    next = withKeys(
      next,
      clash.id,
      keysOf(bindings, clash.id).filter((kept) => bindingsClash(kept, clash.binding) !== "same"),
      panels,
      system,
    );
  }
  const keys =
    mode === "replace"
      ? [binding]
      : [
          ...keysOf(bindings, id).filter((kept) => bindingsClash(kept, binding) !== "same"),
          binding,
        ];
  return withKeys(next, id, keys, panels, system);
}

/** A binding with only its own fields, as it is saved. */
function plainBinding(binding: KeyBinding): KeyBinding {
  const plain = (chord: KeyChord): KeyChord => ({
    key: chord.key,
    ...(chord.meta ? { meta: true } : {}),
    ...(chord.ctrl ? { ctrl: true } : {}),
    ...(chord.alt ? { alt: true } : {}),
    ...(chord.shift ? { shift: true } : {}),
  });
  return {
    ...plain(binding),
    ...(binding.second ? { second: plain(binding.second) } : {}),
    ...(binding.when ? { when: binding.when } : {}),
  };
}
