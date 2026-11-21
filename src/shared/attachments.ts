import { z } from "zod";
import { cutText } from "./textCut.ts";

/**
 * Files in the composer (`docs/composer.md`, "Files"). One home for what a
 * file is, so the renderer that reads a dropped File, the host that reads a
 * chosen one and the core that keeps an accepted message's pictures agree.
 *
 * A file is supported when its CONTENT says so - a picture by its leading
 * bytes, text by strict UTF-8 - never by its extension or the renderer's
 * MIME type. Anything else is an unsupported format: it is never read in
 * full, copied or opened; the composer enters its absolute path as ordinary
 * text instead.
 */

/** Each attachment's size cap, before base64. */
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
/** How many leading bytes classify a file. */
export const ATTACHMENT_HEAD_BYTES = 8192;
/** The most files one picker answer carries; the rest are not read. */
export const CHOSEN_FILES_MAX = 20;

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type AttachmentImageType = (typeof IMAGE_TYPES)[number];

/** A picture's type from its leading bytes; undefined when they are none of the four. */
export function sniffImageType(head: Uint8Array): AttachmentImageType | undefined {
  const at = (i: number) => head[i] ?? -1;
  if (
    at(0) === 0x89 &&
    at(1) === 0x50 &&
    at(2) === 0x4e &&
    at(3) === 0x47 &&
    at(4) === 0x0d &&
    at(5) === 0x0a &&
    at(6) === 0x1a &&
    at(7) === 0x0a
  ) {
    return "image/png";
  }
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return "image/gif";
  if (
    at(0) === 0x52 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x46 &&
    at(8) === 0x57 &&
    at(9) === 0x45 &&
    at(10) === 0x42 &&
    at(11) === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}

/** Whether `bytes` is text: strict UTF-8 (a BOM allowed) with no binary control bytes. */
export function looksLikeText(bytes: Uint8Array, truncated = false): boolean {
  for (const byte of bytes) {
    // NUL and the other C0 controls are binary; tab, line feed, form feed,
    // carriage return and escape are text.
    if (
      byte < 0x20 &&
      byte !== 0x09 &&
      byte !== 0x0a &&
      byte !== 0x0c &&
      byte !== 0x0d &&
      byte !== 0x1b
    ) {
      return false;
    }
  }
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  // A head cut mid-character is not invalid: allow up to three unfinished bytes.
  for (let drop = 0; drop <= (truncated ? 3 : 0); drop++) {
    try {
      decoder.decode(bytes.subarray(0, bytes.length - drop));
      return true;
    } catch {
      // try shorter
    }
  }
  return false;
}

/** Strict UTF-8 text with its BOM and line endings kept; undefined when it is not text. */
export function decodeText(bytes: Uint8Array): string | undefined {
  if (!looksLikeText(bytes)) return undefined;
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

/**
 * What a file is, from its size and leading bytes alone: a supported picture,
 * text that must still pass the strict whole-file read, or an unsupported
 * format. Nothing past the head is read to decide an unsupported file.
 */
export type FileClass =
  | { kind: "image"; mimeType: AttachmentImageType }
  | { kind: "text" }
  | { kind: "unsupported" };

export function classifyHead(head: Uint8Array, size: number): FileClass {
  const mimeType = sniffImageType(head);
  if (mimeType) return { kind: "image", mimeType };
  if (size === 0) return { kind: "text" };
  return looksLikeText(head, size > head.length) ? { kind: "text" } : { kind: "unsupported" };
}

/** "2 pictures: a.png, b.png", for a receipt or a thread line. */
export function attachmentWords(refs: readonly { name: string }[]): string {
  const names = refs.map((ref) => ref.name).join(", ");
  return `${refs.length === 1 ? "1 picture" : `${refs.length} pictures`}: ${names}`;
}

/** A name safe to show and to put in a file name: its last segment, no controls, bounded. */
export function safeDisplayName(raw: string, fallback = "file"): string {
  const last = raw.split(/[\\/]/).filter(Boolean).pop() ?? "";
  const clean = Array.from(last)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .trim();
  const trimmed = cutText(clean.replace(/^\.+/, ""), 120);
  return trimmed || fallback;
}

/** "24 KB", "1.5 MB", "2.3 GB": a file's size as the chip says it. */
export function fileSizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * The text a set of file paths adds at the caret: one path per line, each
 * set apart from the words around it, the paths themselves untouched (spaces
 * and Unicode kept; never a URL, a basename or a quoted command).
 */
export function pathInsertion(
  text: string,
  from: number,
  to: number,
  paths: readonly string[],
): string {
  if (paths.length === 0) return "";
  const before = text.slice(0, from);
  const after = text.slice(to);
  const lead = before !== "" && !before.endsWith("\n") ? "\n" : "";
  const tail = after !== "" && !after.startsWith("\n") ? "\n" : "";
  return `${lead}${paths.join("\n")}${tail}`;
}

/** A picture or text file the message owns a copy of (`src/core/attachments.ts`). */
export const attachmentRefSchema = z.strictObject({
  id: z.string().min(1).max(64),
  kind: z.enum(["image"]),
  name: z.string().max(120),
  mimeType: z.enum(IMAGE_TYPES),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().length(64),
  /** The copy's path relative to the attachments folder: `<message id>/<file>`. */
  file: z.string().min(1).max(200),
});
export type AttachmentRef = z.infer<typeof attachmentRefSchema>;

/** What the host answers about a dropped File's place on disk. */
export const droppedPathSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("regular"), path: z.string().min(1).max(4096) }),
  z.object({ kind: z.literal("no-path") }),
  /** A folder, with its path: the main message box offers it as a project (docs/composer.md, "Files"). */
  z.object({ kind: z.literal("folder"), path: z.string().min(1).max(4096).optional() }),
  z.object({ kind: z.literal("shortcut") }),
  z.object({ kind: z.literal("other") }),
]);
export type DroppedPath = z.infer<typeof droppedPathSchema>;

/** One file the picker brought back, read as far as its class allows. */
export const chosenFileSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("image"),
    name: z.string().max(120),
    mimeType: z.enum(IMAGE_TYPES),
    data: z.instanceof(Uint8Array),
  }),
  z.object({
    kind: z.literal("text"),
    name: z.string().max(120),
    data: z.instanceof(Uint8Array),
  }),
  /** An unsupported format: only its path comes back, for the composer to type. */
  z.object({
    kind: z.literal("unsupported"),
    name: z.string().max(120),
    path: z.string().min(1).max(4096),
  }),
  z.object({ kind: z.literal("too-big"), name: z.string().max(120), image: z.boolean() }),
  z.object({ kind: z.literal("folder"), name: z.string().max(120) }),
  z.object({ kind: z.literal("shortcut"), name: z.string().max(120) }),
  z.object({ kind: z.literal("unreadable"), name: z.string().max(120) }),
]);
export type ChosenFile = z.infer<typeof chosenFileSchema>;
