import {
  ATTACHMENT_HEAD_BYTES,
  ATTACHMENT_MAX_BYTES,
  CHOSEN_FILES_MAX,
  type ChosenFile,
  classifyHead,
  type DroppedPath,
  decodeText,
  safeDisplayName,
  sniffImageType,
} from "@shared/attachments";
import { type ComposerNotice, FILE_WORDS } from "@shared/composer";
import * as m from "@shared/i18n/messages.generated";
import { create } from "zustand";
import type { ImageAttachment } from "../design/core/ComposerField";

/**
 * Files given to an input (`docs/composer.md`, "Files"): the one path a
 * dropped File and a picked file both take, for the main input and a card's
 * reply alike.
 *
 * A supported file - a picture, or text that is strict UTF-8 - becomes a
 * chip in the draft it was given to. An unsupported format becomes its
 * absolute path, typed into that input as ordinary text; it is never copied,
 * read past its head or opened. On an app controlling Firstmate on another
 * Mac, where a path on this Mac means nothing (docs/view.md), it is not
 * added and a notice says so. Work is bound to a destination key, not to
 * whichever input is on screen when it finishes.
 */

/** The main input's destination key; a card reply's is its card id. */
export const MAIN_FILES_KEY = "main";

/** One file's outcome, before it touches a draft. */
export type IntakeResult =
  | { kind: "image"; item: ImageAttachment }
  | { kind: "text"; text: string; name: string }
  /** Neither a picture nor text: its path on this Mac, or null when it has no place on disk. */
  | { kind: "unsupported"; path: string | null }
  | { kind: "folder"; path: string }
  | { kind: "notice"; notice: ComposerNotice };

/** Where a file's outcome lands: one draft, named by key, applied through the store. */
export type FileDestination = {
  /** "main", or a card's id. */
  key: string;
  /** Whether the input takes files now (not gated, not sending). */
  accepts: () => boolean;
  /** Whether a path on this Mac means anything where its words go: not on another Mac. */
  takesPaths: () => boolean;
  applyImages: (items: ImageAttachment[]) => void;
  applyText: (text: string, name: string) => void;
  notice: (notice: ComposerNotice) => void;
  insertPaths: (paths: string[]) => void;
  /**
   * Offers a dropped folder as a project (docs/composer.md, "Files"): the
   * main input on the first mate's own computer only. Without it, a folder
   * is refused with a notice.
   */
  addFolder?: (path: string) => void;
};

type Host = {
  dropped: (file: File) => Promise<DroppedPath>;
  choose: () => Promise<ChosenFile[] | null>;
};

const noticeFor = (kind: "folder" | "shortcut" | "other"): ComposerNotice =>
  kind === "folder" ? "file-folder" : kind === "shortcut" ? "file-shortcut" : "file-unreadable";

/** Base64 of bytes without a FileReader, in blocks the string builder can take. */
function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

let pictureCounter = 0;

/** A picture's chip and send payload from its verified bytes. */
function pictureOf(
  bytes: Uint8Array,
  name: string,
  mimeType: NonNullable<ReturnType<typeof sniffImageType>>,
): IntakeResult {
  const data = base64Of(bytes);
  return {
    kind: "image",
    item: {
      id: `picture-${++pictureCounter}-${Math.random().toString(36).slice(2)}`,
      preview: `data:${mimeType};base64,${data}`,
      name,
      mimeType,
      data,
    },
  };
}

/**
 * What a dropped File is. Classified from its leading bytes through the
 * browser's own File reads; the host is asked only where it lives on disk,
 * and only an unsupported format uses the answer.
 */
export async function readDroppedFile(
  file: File,
  host: Pick<Host, "dropped">,
): Promise<IntakeResult> {
  const name = safeDisplayName(file.name);
  let place: DroppedPath;
  try {
    place = await host.dropped(file);
  } catch {
    place = { kind: "no-path" };
  }
  if (place.kind === "folder" && place.path) return { kind: "folder", path: place.path };
  if (place.kind === "folder" || place.kind === "shortcut" || place.kind === "other") {
    return { kind: "notice", notice: noticeFor(place.kind) };
  }
  let head: Uint8Array;
  try {
    head = new Uint8Array(await file.slice(0, ATTACHMENT_HEAD_BYTES).arrayBuffer());
  } catch {
    return { kind: "notice", notice: "file-unreadable" };
  }
  const kind = classifyHead(head, file.size);
  const unsupported = (): IntakeResult => ({
    kind: "unsupported",
    path: place.kind === "regular" ? place.path : null,
  });
  if (kind.kind === "unsupported") return unsupported();
  if (file.size > ATTACHMENT_MAX_BYTES) {
    return { kind: "notice", notice: kind.kind === "image" ? "picture-too-big" : "file-too-big" };
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return { kind: "notice", notice: "file-unreadable" };
  }
  if (kind.kind === "image") {
    const mimeType = sniffImageType(bytes);
    return mimeType
      ? pictureOf(bytes, name, mimeType)
      : { kind: "notice", notice: "file-unreadable" };
  }
  const text = decodeText(bytes);
  return text === undefined ? unsupported() : { kind: "text", text, name };
}

/** What a file the picker brought back is: the host already read it as far as its class allows. */
export async function readChosenFile(chosen: ChosenFile): Promise<IntakeResult> {
  switch (chosen.kind) {
    case "image":
      return pictureOf(chosen.data, chosen.name, chosen.mimeType);
    case "text": {
      const text = decodeText(chosen.data);
      return text === undefined
        ? { kind: "notice", notice: "file-unreadable" }
        : { kind: "text", text, name: chosen.name };
    }
    case "unsupported":
      return { kind: "unsupported", path: chosen.path };
    case "too-big":
      return { kind: "notice", notice: chosen.image ? "picture-too-big" : "file-too-big" };
    case "folder":
      return { kind: "notice", notice: "file-folder" };
    case "shortcut":
      return { kind: "notice", notice: "file-shortcut" };
    case "unreadable":
      return { kind: "notice", notice: "file-unreadable" };
  }
}

export type PendingFile = { id: string; name: string };

type IntakeState = {
  /** Files being prepared, by destination key, in selection order. */
  pending: Record<string, PendingFile[]>;
  /** What a screen reader is told about each destination's files. */
  status: Record<string, string>;
};

export const useIntakeStore = create<IntakeState>()(() => ({ pending: {}, status: {} }));

const cancelled = new Set<string>();
let counter = 0;

function setPending(key: string, update: (held: PendingFile[]) => PendingFile[]) {
  useIntakeStore.setState((s) => {
    const next = update(s.pending[key] ?? []);
    const pending = { ...s.pending };
    if (next.length === 0) delete pending[key];
    else pending[key] = next;
    return { pending };
  });
}

function say(key: string, text: string) {
  useIntakeStore.setState((s) => ({ status: { ...s.status, [key]: text } }));
}

/** Stops preparing one file: whatever it would have added is dropped. */
export function cancelPending(key: string, id: string): void {
  cancelled.add(id);
  const name = useIntakeStore.getState().pending[key]?.find((file) => file.id === id)?.name;
  setPending(key, (held) => held.filter((file) => file.id !== id));
  if (name) say(key, m.attachCancelled({ name }));
}

export function isPreparing(key: string): boolean {
  return (useIntakeStore.getState().pending[key]?.length ?? 0) > 0;
}

/** Resolves once nothing is being prepared for this destination (a voice send waits on it). */
export function whenPrepared(key: string): Promise<void> {
  if (!isPreparing(key)) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = useIntakeStore.subscribe(() => {
      if (isPreparing(key)) return;
      stop();
      resolve();
    });
  });
}

async function run(
  dest: FileDestination,
  entries: { name: string; read: () => Promise<IntakeResult> }[],
): Promise<void> {
  const tagged = entries.slice(0, CHOSEN_FILES_MAX).map((entry) => ({
    ...entry,
    id: `file-${++counter}`,
  }));
  if (tagged.length === 0) return;
  setPending(dest.key, (held) => [...held, ...tagged.map(({ id, name }) => ({ id, name }))]);
  const paths: string[] = [];
  const added: string[] = [];
  // In selection order: each file is read, then applied, before the next, so
  // slots go to files in the order they were given.
  for (const entry of tagged) {
    const result = await entry
      .read()
      .catch((): IntakeResult => ({ kind: "notice", notice: "file-unreadable" }));
    if (cancelled.delete(entry.id)) continue;
    setPending(dest.key, (held) => held.filter((file) => file.id !== entry.id));
    // An input that no longer takes files (its card closed, its send under
    // way) never has a late result land in a message it was not for.
    if (!dest.accepts()) continue;
    switch (result.kind) {
      case "image":
        dest.applyImages([result.item]);
        added.push(FILE_WORDS.readyAnnounce(entry.name));
        break;
      case "text":
        dest.applyText(result.text, result.name);
        added.push(FILE_WORDS.readyAnnounce(entry.name));
        break;
      case "unsupported":
        if (!dest.takesPaths()) dest.notice("file-other-mac");
        else if (result.path === null) dest.notice("file-not-local");
        else paths.push(result.path);
        break;
      case "folder":
        if (dest.addFolder && dest.takesPaths()) dest.addFolder(result.path);
        else dest.notice("file-folder");
        break;
      case "notice":
        dest.notice(result.notice);
        break;
    }
  }
  if (paths.length > 0) {
    dest.insertPaths(paths);
    added.push(FILE_WORDS.pathsAnnounce(paths.length));
  }
  if (added.length > 0) say(dest.key, added.join(". "));
}

/** Files dropped on an input. A destination that takes none leaves them untouched. */
export async function giveFiles(
  dest: FileDestination,
  files: readonly File[],
  host: Pick<Host, "dropped">,
): Promise<void> {
  if (!dest.accepts()) return;
  await run(
    dest,
    files.map((file) => ({
      name: safeDisplayName(file.name),
      read: () => readDroppedFile(file, host),
    })),
  );
}

/** Files chosen in the system picker: cancelling changes nothing. */
export async function pickFiles(dest: FileDestination, host: Pick<Host, "choose">): Promise<void> {
  if (!dest.accepts()) return;
  const chosen = await host.choose().catch(() => null);
  if (!chosen || chosen.length === 0 || !dest.accepts()) return;
  await run(
    dest,
    chosen.map((file) => ({ name: file.name, read: () => readChosenFile(file) })),
  );
}
