import type { KeyChord } from "./keyboardCommands";

/**
 * macOS's own keyboard shortcuts (System Settings → Keyboard → Keyboard
 * Shortcuts), so the card overlay can refuse one (docs/card-overlay.md).
 * A Mac registers a system-wide key another program already holds without
 * complaint, and the system's own shortcut then takes the key first, so the
 * overlay checks these itself.
 *
 * The system keeps them in the `com.apple.symbolichotkeys` defaults as
 * `AppleSymbolicHotKeys`: each by a number, with `enabled` and
 * `value.parameters` = [character, virtual key code, modifier flags].
 * It writes only the entries a person changed, so the defaults below stand
 * for the rest.
 */
export type SymbolicHotKey = { enabled: boolean; parameters: readonly number[] };

const SHIFT = 0x20000;
const CONTROL = 0x40000;
const OPTION = 0x80000;
const COMMAND = 0x100000;
const FN = 0x800000;

/** The shortcuts a new Mac has on, by their number, as macOS 15 and 26 ship them. */
const ON_BY_DEFAULT: Record<string, readonly number[]> = {
  "7": [65535, 120, FN | CONTROL], // ⌃F2: focus the menu bar
  "8": [65535, 99, FN | CONTROL], // ⌃F3: focus the Dock
  "9": [65535, 118, FN | CONTROL], // ⌃F4: focus the active or next window
  "10": [65535, 96, FN | CONTROL], // ⌃F5: focus the window toolbar
  "11": [65535, 97, FN | CONTROL], // ⌃F6: focus the floating window
  "12": [65535, 122, FN | CONTROL], // ⌃F1: turn keyboard access on or off
  "13": [65535, 98, FN | CONTROL], // ⌃F7: change the way Tab moves focus
  "15": [56, 28, OPTION | COMMAND], // ⌥⌘8: zoom
  "17": [61, 24, OPTION | COMMAND], // ⌥⌘=: zoom in
  "19": [45, 27, OPTION | COMMAND], // ⌥⌘-: zoom out
  "21": [56, 28, CONTROL | OPTION | COMMAND], // ⌃⌥⌘8: invert colours
  "25": [46, 47, CONTROL | OPTION | COMMAND], // ⌃⌥⌘.: more contrast
  "26": [44, 43, CONTROL | OPTION | COMMAND], // ⌃⌥⌘,: less contrast
  "27": [96, 50, COMMAND], // ⌘`: the next window
  "28": [51, 20, SHIFT | COMMAND], // ⇧⌘3: screenshot
  "29": [51, 20, SHIFT | CONTROL | COMMAND], // ⌃⇧⌘3: screenshot to the clipboard
  "30": [52, 21, SHIFT | COMMAND], // ⇧⌘4: screenshot of an area
  "31": [52, 21, SHIFT | CONTROL | COMMAND], // ⌃⇧⌘4: area to the clipboard
  "32": [65535, 126, FN | CONTROL], // ⌃↑: Mission Control
  "33": [65535, 125, FN | CONTROL], // ⌃↓: application windows
  "36": [65535, 103, FN], // F11: show the desktop
  "52": [100, 2, OPTION | COMMAND], // ⌥⌘D: hide the Dock
  "57": [65535, 100, FN | CONTROL], // ⌃F8: focus the status menus
  "59": [65535, 96, FN | COMMAND], // ⌘F5: VoiceOver
  "60": [32, 49, CONTROL], // ⌃Space: previous input source
  "61": [32, 49, CONTROL | OPTION], // ⌃⌥Space: next input source
  "64": [32, 49, COMMAND], // ⌘Space: Spotlight
  "65": [32, 49, OPTION | COMMAND], // ⌥⌘Space: Finder search
  "79": [65535, 123, FN | CONTROL], // ⌃←: a Space to the left
  "81": [65535, 124, FN | CONTROL], // ⌃→: a Space to the right
  "98": [47, 44, SHIFT | COMMAND], // ⇧⌘/: the help menu
  "162": [65535, 96, FN | OPTION | COMMAND], // ⌥⌘F5: accessibility shortcuts
  "184": [53, 23, SHIFT | COMMAND], // ⇧⌘5: screenshot and recording options
};

/**
 * The shortcuts on now: the defaults, each as a person changed or turned it
 * off, and any other a person turned on. `saved` is `AppleSymbolicHotKeys`
 * as read, or null when it could not be read.
 */
export function systemHotKeys(saved: unknown): SymbolicHotKey[] {
  const changed =
    saved !== null && typeof saved === "object" ? (saved as Record<string, unknown>) : {};
  const numbers = new Set([...Object.keys(ON_BY_DEFAULT), ...Object.keys(changed)]);
  const on: SymbolicHotKey[] = [];
  for (const number of numbers) {
    const entry = changed[number] as
      | { enabled?: unknown; value?: { parameters?: unknown } }
      | undefined;
    const fallback = ON_BY_DEFAULT[number];
    const enabled = typeof entry?.enabled === "boolean" ? entry.enabled : fallback !== undefined;
    const given = entry?.value?.parameters;
    const parameters =
      Array.isArray(given) && given.length === 3 && given.every((n) => typeof n === "number")
        ? given
        : fallback;
    if (enabled && parameters) on.push({ enabled, parameters });
  }
  return on;
}

/** The ANSI key each character or key name sits on, unshifted and shifted. */
const KEY_CODES: Record<string, number> = {
  a: 0,
  s: 1,
  d: 2,
  f: 3,
  h: 4,
  g: 5,
  z: 6,
  x: 7,
  c: 8,
  v: 9,
  b: 11,
  q: 12,
  w: 13,
  e: 14,
  r: 15,
  y: 16,
  t: 17,
  o: 31,
  u: 32,
  i: 34,
  p: 35,
  l: 37,
  j: 38,
  k: 40,
  n: 45,
  m: 46,
  "1": 18,
  "!": 18,
  "2": 19,
  "@": 19,
  "3": 20,
  "#": 20,
  "4": 21,
  $: 21,
  "6": 22,
  "^": 22,
  "5": 23,
  "%": 23,
  "=": 24,
  "+": 24,
  "9": 25,
  "(": 25,
  "7": 26,
  "&": 26,
  "-": 27,
  _: 27,
  "8": 28,
  "*": 28,
  "0": 29,
  ")": 29,
  "]": 30,
  "}": 30,
  "[": 33,
  "{": 33,
  "'": 39,
  '"': 39,
  ";": 41,
  ":": 41,
  "\\": 42,
  "|": 42,
  ",": 43,
  "<": 43,
  "/": 44,
  "?": 44,
  ".": 47,
  ">": 47,
  "`": 50,
  "~": 50,
  " ": 49,
  ArrowLeft: 123,
  ArrowRight: 124,
  ArrowDown: 125,
  ArrowUp: 126,
  F1: 122,
  F2: 120,
  F3: 99,
  F4: 118,
  F5: 96,
  F6: 97,
  F7: 98,
  F8: 100,
  F9: 101,
  F10: 109,
  F11: 103,
  F12: 111,
};
/** Characters typed with Shift on an ANSI layout: their chord holds Shift whether or not it says so. */
const SHIFTED = new Set('!@#$%^&*()_+{}|:"<>?~');

/**
 * Whether `chord` is one of `hotKeys`: the same key and the same ⌃, ⌥, ⌘
 * and ⇧. The key is found by its place on an ANSI keyboard, as the system
 * keeps its shortcuts by key, not by character; a key outside that table
 * matches nothing.
 */
export function isSystemHotKey(chord: KeyChord, hotKeys: readonly SymbolicHotKey[]): boolean {
  const key = chord.key.length === 1 ? chord.key.toLowerCase() : chord.key;
  const code = KEY_CODES[key];
  if (code === undefined) return false;
  const shift = Boolean(chord.shift) || SHIFTED.has(key);
  const flags =
    (shift ? SHIFT : 0) |
    (chord.ctrl ? CONTROL : 0) |
    (chord.alt ? OPTION : 0) |
    (chord.meta ? COMMAND : 0);
  return hotKeys.some(
    ({ parameters }) =>
      parameters[1] === code &&
      ((parameters[2] ?? 0) & (SHIFT | CONTROL | OPTION | COMMAND)) === flags,
  );
}
