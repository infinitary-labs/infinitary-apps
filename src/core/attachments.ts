import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  constants,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { lstat, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  ATTACHMENT_HEAD_BYTES,
  ATTACHMENT_MAX_BYTES,
  type AttachmentRef,
  type ChosenFile,
  classifyHead,
  type DroppedPath,
  decodeText,
  safeDisplayName,
  sniffImageType,
} from "@shared/attachments";
import type { TurnImage } from "@shared/cards";

/**
 * The one owner of the files a captain's message carries
 * (`docs/composer.md`, "Files"; `docs/inbox.md`).
 *
 * - An ACCEPTED message's pictures get message-owned copies here, outside
 *   every project, so a queued, parked or retried message still has its
 *   bytes after a restart (`keepImages`, `loadImages`). Nothing is copied
 *   before acceptance: an unsent draft is session memory only.
 * - A file the captain CHOSE through the system picker is read here
 *   (`importChosenFile`): regular files only, never through a symlink,
 *   bounded while reading, and an unsupported format is never read past its
 *   head - only its path comes back.
 *
 * Originals are never edited, moved or deleted.
 */

const MESSAGE_FILE_MODE = 0o600;
const MESSAGE_DIR_MODE = 0o700;

let attachmentsDir: string | undefined;

/** Wires the app-scoped folder (services.ts, at boot); tests and scripts fall back to the temp dir. */
export function initAttachmentsDir(dir: string): void {
  attachmentsDir = dir;
}

function rootDir(): string {
  return attachmentsDir ?? join(tmpdir(), "infinitary-attachments");
}

/** A copy that is missing, changed or not the picture it was recorded as. */
export class AttachmentUnavailableError extends Error {
  constructor(
    readonly attachment: AttachmentRef,
    why: string,
  ) {
    super(`The picture "${attachment.name}" is not available (${why}).`);
    this.name = "AttachmentUnavailableError";
  }
}

const EXTENSIONS: Record<AttachmentRef["mimeType"], string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** The path a ref names, only ever inside the attachments folder. */
export function attachmentPath(ref: Pick<AttachmentRef, "file">): string {
  const root = resolve(rootDir());
  const full = resolve(root, ref.file);
  const rel = relative(root, full);
  if (rel === "" || rel.startsWith("..") || rel.split(sep).includes("..")) {
    throw new Error("An attachment reference points outside the attachments folder.");
  }
  return full;
}

function writePrivate(file: string, bytes: Uint8Array): void {
  mkdirSync(dirname(file), { recursive: true, mode: MESSAGE_DIR_MODE });
  chmodSync(dirname(file), MESSAGE_DIR_MODE);
  const temp = `${file}.${randomUUID().slice(0, 8)}.part`;
  try {
    writeFileSync(temp, bytes, { mode: MESSAGE_FILE_MODE });
    renameSync(temp, file);
  } catch (caught) {
    rmSync(temp, { force: true });
    throw caught;
  }
}

/**
 * Give an accepted message its own copies of its pictures. Each is verified
 * from its bytes (not its claimed type) and under the cap; a failure removes
 * whatever was written, so a refused message leaves nothing behind.
 */
export function keepImages(
  messageId: string,
  images: readonly { mimeType: string; data: string; name?: string }[],
): AttachmentRef[] {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(messageId)) throw new Error("A message id is malformed.");
  const refs: AttachmentRef[] = [];
  try {
    for (const [index, image] of images.entries()) {
      const bytes = Buffer.from(image.data, "base64");
      if (bytes.length === 0 || bytes.length > ATTACHMENT_MAX_BYTES) {
        throw new Error("A picture is empty or over 5 MB.");
      }
      const verified = sniffImageType(bytes);
      if (!verified || verified !== image.mimeType) {
        throw new Error("A picture's bytes do not match its type.");
      }
      const id = randomUUID();
      const file = `${messageId}/${index + 1}-${id.slice(0, 8)}.${EXTENSIONS[verified]}`;
      writePrivate(attachmentPath({ file }), bytes);
      refs.push({
        id,
        kind: "image",
        name: safeDisplayName(image.name ?? "", EXTENSIONS[verified]),
        mimeType: verified,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        file,
      });
    }
  } catch (caught) {
    rmSync(join(resolve(rootDir()), messageId), { recursive: true, force: true });
    throw caught;
  }
  return refs;
}

/**
 * The pictures a message's refs name, read back and checked against their
 * recorded size, digest and type. A missing or changed copy throws: the
 * caller blocks delivery rather than sending the words without them.
 */
export function loadImages(refs: readonly AttachmentRef[]): TurnImage[] {
  const images: TurnImage[] = [];
  for (const ref of refs) {
    let file: string;
    try {
      file = attachmentPath(ref);
    } catch {
      throw new AttachmentUnavailableError(ref, "its reference points outside the saved copies");
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch {
      throw new AttachmentUnavailableError(ref, "the saved copy is missing");
    }
    if (
      bytes.length !== ref.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== ref.sha256 ||
      sniffImageType(bytes) !== ref.mimeType
    ) {
      throw new AttachmentUnavailableError(ref, "the saved copy changed");
    }
    images.push({ mimeType: ref.mimeType, data: bytes.toString("base64") });
  }
  return images;
}

/** What a path is on disk without following a link: a regular file, a folder, a shortcut or other. */
export async function inspectPath(path: string): Promise<DroppedPath> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return { kind: "shortcut" };
    if (stat.isDirectory()) return { kind: "folder", path };
    if (stat.isFile()) return { kind: "regular", path };
  } catch {
    // fall through
  }
  return { kind: "other" };
}

/**
 * Read one file the captain chose in the picker. A regular file only, opened
 * without following a link; the head says what it is, and only a supported
 * format is read on, up to the cap. An unsupported format returns its path
 * and nothing else.
 */
export async function importChosenFile(path: string): Promise<ChosenFile> {
  const name = safeDisplayName(basename(path));
  const place = await inspectPath(path);
  if (place.kind === "folder") return { kind: "folder", name };
  if (place.kind === "shortcut") return { kind: "shortcut", name };
  if (place.kind !== "regular") return { kind: "unreadable", name };
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile()) return { kind: "unreadable", name };
    const head = Buffer.alloc(Math.min(ATTACHMENT_HEAD_BYTES, before.size));
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const kind = classifyHead(head.subarray(0, bytesRead), before.size);
    if (kind.kind === "unsupported") return { kind: "unsupported", name, path };
    if (before.size > ATTACHMENT_MAX_BYTES) {
      return { kind: "too-big", name, image: kind.kind === "image" };
    }
    // Bounded while reading: a file that grows past the cap is refused.
    const body = Buffer.alloc(Math.min(before.size, ATTACHMENT_MAX_BYTES) + 1);
    let filled = 0;
    while (filled < body.length) {
      const read = await handle.read(body, filled, body.length - filled, filled);
      if (read.bytesRead === 0) break;
      filled += read.bytesRead;
    }
    const after = await handle.stat();
    if (filled !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      return { kind: "unreadable", name };
    }
    const data = new Uint8Array(body.subarray(0, filled));
    if (kind.kind === "image") {
      const mimeType = sniffImageType(data);
      return mimeType ? { kind: "image", name, mimeType, data } : { kind: "unreadable", name };
    }
    // Text must hold up as strict UTF-8 over the whole file; if not, it is a
    // binary format after all and only its path comes back.
    return decodeText(data) === undefined
      ? { kind: "unsupported", name, path }
      : { kind: "text", name, data };
  } catch {
    return { kind: "unreadable", name };
  } finally {
    await handle?.close().catch(() => {});
  }
}
