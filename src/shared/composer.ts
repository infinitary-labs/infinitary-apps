import { TURN_IMAGE_MAX_BYTES, TURN_IMAGES_MAX } from "./cards";
import { COMPUTER } from "./deviceNames";
import { formatNumber } from "./i18n/format.ts";
import * as m from "./i18n/messages.generated.ts";
import type { KeySystem } from "./platform";

/**
 * Why the composer held on to what the captain typed or pasted instead of
 * sending or taking it ("too long" is past `CONVERSE_TEXT_MAX_CHARS`). One
 * quiet line under the input says so (design skill
 * `components/voice/VoiceInput.prompt.md`, "Under the pill").
 */
export type ComposerNotice =
  | "pictures-max"
  | "picture-too-big"
  | "too-long"
  | "not-sent"
  | "away"
  | "files-max"
  | "file-too-big"
  | "file-unreadable"
  | "file-folder"
  | "file-shortcut"
  | "file-not-local"
  | "file-other-mac"
  | "files-preparing";

export const COMPOSER_NOTICE_WORDS: Record<ComposerNotice, string> = {
  "files-max": "Up to 4 files per message.",
  "file-too-big": "That text is over 5 MB.",
  "file-unreadable": "That file could not be read, so it was not added.",
  "file-folder": "Folders cannot be added. Drop the files inside it instead.",
  "file-shortcut": "That is a shortcut. Drop the file it points to instead.",
  "file-not-local":
    "That file has no place on this computer, so there is no path to add. Save it first, then drop it.",
  // A file that is neither a picture nor text, given to an app controlling
  // Firstmate on another Mac (docs/view.md): that Mac cannot open a file on
  // this one. The window names that Mac when it knows it.
  "file-other-mac": `Only pictures and text files can go to the other ${COMPUTER.one}. Other files were not added.`,
  "files-preparing": "A file is still being prepared. Send when it is ready.",
  "pictures-max": `Up to ${TURN_IMAGES_MAX} pictures per message.`,
  "picture-too-big": `That picture is over ${TURN_IMAGE_MAX_BYTES / (1024 * 1024)} MB.`,
  "too-long": "Too long to send. Trim it, or paste the long part so it goes as a file.",
  "not-sent": "That message did not send.",
  // An app controlling Firstmate on another Mac that is out of reach
  // (docs/view.md): the window names that Mac when it knows it.
  away: `Not sent. Your words stay here until the other ${COMPUTER.one} is back.`,
};

/**
 * A long paste, or a dropped or chosen text file, held as a chip in the
 * composer until the turn leaves (never persisted). `name` is the file's
 * display name; a paste has none.
 */
export type PastedText = { id: string; text: string; name?: string };

/** A paste over this many lines becomes a chip instead of inline text. */
export const PASTE_CHIP_LINES = 20;
/** A paste over this many characters becomes a chip instead of inline text. */
export const PASTE_CHIP_CHARS = 2_000;
/** The composer's count shows from this share of `CONVERSE_TEXT_MAX_CHARS`. */
export const COMPOSER_COUNT_FROM = 0.8;

/** `\r\n` and a lone `\r` become `\n`, the only line break a turn carries. */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** How many lines a text runs to (an empty text is one line, as in the field). */
export function lineCount(text: string): number {
  let lines = 1;
  for (const char of text) if (char === "\n") lines++;
  return lines;
}

/** Whether a paste is long enough to become a chip: over 20 lines or 2,000 characters. */
export function shouldChip(text: string): boolean {
  return text.length > PASTE_CHIP_CHARS || lineCount(text) > PASTE_CHIP_LINES;
}

/**
 * The turn's text as it leaves the composer: leading blank lines and
 * trailing whitespace go, the first line's indentation and interior blank
 * lines stay, and each pasted text follows the typed words after a blank
 * line, verbatim. Whitespace alone is empty.
 */
export function composeTurnText(text: string, pastes: readonly Pick<PastedText, "text">[]): string {
  const typed = text.replace(/^(?:[ \t]*\n)+/, "").replace(/\s+$/, "");
  const parts = [typed, ...pastes.map((paste) => paste.text)].filter((part) => part.trim());
  return parts.join("\n\n");
}

/** One piece of the key hint: words, or a key drawn as a keycap. */
export type ComposerHintPart = { key: string } | { words: string };

/**
 * The foot row's key hint (design skill `components/voice/VoiceInput.prompt.md`):
 * the keys, the keys inside an open code block, and what to do over the limit.
 */
export const COMPOSER_HINTS = {
  keys: [{ key: "⏎" }, { words: "send ·" }, { key: "⇧⏎" }, { words: "new line" }],
  fence: [
    { words: "in a code block" },
    { key: "⏎" },
    { words: "adds a line ·" },
    { key: "⌘⏎" },
    { words: "sends" },
  ],
  "too-long": [{ words: COMPOSER_NOTICE_WORDS["too-long"] }],
} satisfies Record<string, ComposerHintPart[]>;

export type ComposerHint = keyof typeof COMPOSER_HINTS;

/** The same hints with a key's words as Linux writes them (design skill readme, "Linux desktop conventions"). */
const CTRL_HINT_KEYS: Readonly<Record<string, string>> = {
  "⏎": "Enter",
  "⇧⏎": "Shift+Enter",
  "⌘⏎": "Ctrl+Enter",
};

/** The foot row's hint in this keyboard's words: a Mac's glyphs, or the words Linux writes. */
export function composerHint(hint: ComposerHint, system: KeySystem = "mac"): ComposerHintPart[] {
  const parts: ComposerHintPart[] = COMPOSER_HINTS[hint];
  return system === "mac"
    ? parts
    : parts.map((part) => ("key" in part ? { key: CTRL_HINT_KEYS[part.key] ?? part.key } : part));
}

/**
 * The form of an empty field's hint it shows (docs/composer.md, "Growth and
 * reflow"): of `forms`, fullest first, the first that sets within `room`
 * pixels on the field's one line, else the shortest.
 */
export function fittingHint(
  forms: readonly string[],
  room: number,
  widthOf: (form: string) => number,
): string | undefined {
  return forms.find((form) => widthOf(form) <= room) ?? forms[forms.length - 1];
}

/** "1 line", "240 lines". */
function lines(count: number): string {
  return m.composerLines({ count });
}

/** The pasted-text chip's words: what it says, and its remove control's name. */
export const PASTED_TEXT_WORDS = {
  meta: (lineTotal: number, bytes = 0) =>
    m.pastedFileMeta({ lines: lines(lineTotal), kilobytes: String(Math.ceil(bytes / 1024)) }),
  remove: (lineTotal: number, name?: string) =>
    name ? m.pastedFileRemoveNamed({ name }) : m.pastedFileRemove({ lines: lines(lineTotal) }),
};

/**
 * The file controls' words: the picker's button, a chip being prepared, and
 * what a screen reader hears. Each is read from the catalog when it is
 * shown (docs/i18n.md), so it follows the app's language.
 */
export const FILE_WORDS = {
  get add() {
    return m.fileAdd();
  },
  get preparing() {
    return m.filePreparing();
  },
  get ready() {
    return m.fileReady();
  },
  cancel: (name: string) => m.fileCancel({ name }),
  readyAnnounce: (name: string) => m.fileReadyAnnounce({ name }),
  pathsAnnounce: (count: number) => m.filePathsAnnounce({ count }),
  get dropHere() {
    return m.fileDropHere();
  },
};

/**
 * Where a draft stands against its send limit: `near` from
 * `COMPOSER_COUNT_FROM` of it (the count shows), `over` past it (nothing
 * sends), `none` below.
 */
export type LimitBand = "none" | "near" | "over";

export function limitBand(length: number, max: number): LimitBand {
  if (length > max) return "over";
  return length >= COMPOSER_COUNT_FROM * max ? "near" : "none";
}

/** The mono count under a long draft: "16,240 / 20,000". */
export function composerCount(length: number, max: number): string {
  return `${formatNumber(length)} / ${formatNumber(max)}`;
}

export const PASTE_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const PASTE_FILES_MAX = 4;
export function pasteRefusal(text: string, held: number): ComposerNotice | null {
  if (new TextEncoder().encode(text).length > PASTE_FILE_MAX_BYTES) return "file-too-big";
  return held >= PASTE_FILES_MAX ? "files-max" : null;
}
