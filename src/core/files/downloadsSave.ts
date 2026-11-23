import { createHash, randomBytes } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, link, lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { CardFilePiece, CardFileSaved, CardFilesSaved } from "@shared/cardFiles";

/**
 * Saves a card's file for the captain into Downloads on the computer whose
 * window he clicked Save in (docs/card-authoring.md, "Files for the
 * captain"). The window's own process runs it, reading the file a piece at
 * a time from wherever its kept copy is; the bytes land in a hidden part
 * file, are checked against the card's sha256, and only then take a name.
 * It never writes over another file: a file already there under the name
 * with the same content is the saved file, and one with other content keeps
 * its name while the saved file takes the next free one, as `name (2).ext`.
 */

/** How many numbered names are tried before the save is refused. */
const NUMBERED_NAMES = 999;

/** A name a file can take in a folder: its own last part, without control characters or a leading dot. */
export function downloadsName(name: string): string {
  const plain = basename(name.replace(/\\/g, "/"))
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes.
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^\.+/, "")
    .trim();
  return plain || "file";
}

function numbered(name: string, n: number): string {
  if (n === 1) return name;
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  return `${stem} (${n})${ext}`;
}

function sha256Of(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

async function sameFile(path: string, bytes: number, sha256: string): Promise<boolean> {
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.nlink !== 1 || info.size !== bytes) return false;
  return (await sha256Of(path).catch(() => undefined)) === sha256;
}

/** Gives the checked part file a name no other file has, without ever replacing one. */
async function claimName(
  part: string,
  path: string,
  mark?: (path: string) => Promise<void>,
): Promise<boolean> {
  try {
    await link(part, path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    // A disk that keeps no hard links still refuses to copy over a file that is there.
    try {
      await copyFile(part, path, constants.COPYFILE_EXCL);
    } catch (copied) {
      if ((copied as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw copied;
    }
    try {
      await mark?.(path);
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
    return true;
  }
}

export async function saveIntoDownloads(options: {
  folder: string;
  /** One piece of the file from an offset (`inf:cards:file`). */
  read: (offset: number) => Promise<CardFilePiece>;
  mark?: (path: string) => Promise<void>;
}): Promise<CardFileSaved> {
  const first = await options.read(0);
  const name = downloadsName(first.name.replace(/:/g, "-"));
  const { bytes, sha256 } = first;
  await mkdir(options.folder, { recursive: true });
  const folder = await realpath(options.folder);
  const existing = join(folder, name);
  if (await sameFile(existing, bytes, sha256)) {
    await options.mark?.(existing);
    return { savedAs: name, path: existing };
  }
  const part = join(folder, `.${name}.${randomBytes(6).toString("hex")}.part`);
  const handle = await open(part, "wx", 0o600);
  const hash = createHash("sha256");
  let offset = 0;
  try {
    let piece: CardFilePiece = first;
    for (;;) {
      if (piece.offset !== offset || piece.sha256 !== sha256 || piece.bytes !== bytes)
        throw new Error(`${name} changed while it was saved. Save it again.`);
      const data = Buffer.from(piece.data, "base64");
      if (data.length === 0) break;
      await handle.write(data, 0, data.length, offset);
      hash.update(data);
      offset += data.length;
      if (offset >= bytes) break;
      piece = await options.read(offset);
    }
  } catch (error) {
    await handle.close();
    await rm(part, { force: true });
    throw error;
  }
  await handle.close();
  try {
    if (offset !== bytes || hash.digest("hex") !== sha256)
      throw new Error(`${name} did not arrive whole. Save it again.`);
    await options.mark?.(part);
    for (let n = 1; n <= NUMBERED_NAMES; n++) {
      const savedAs = numbered(name, n);
      const path = join(folder, savedAs);
      if (await claimName(part, path, options.mark)) return { savedAs, path };
      if (await sameFile(path, bytes, sha256)) {
        await options.mark?.(path);
        return { savedAs, path };
      }
    }
    throw new Error(`Downloads already holds too many files named like ${name}.`);
  } finally {
    await rm(part, { force: true });
  }
}

/** A folder name from a task's title: one name, without slashes, control characters or a leading dot. */
export function downloadsFolderName(title: string): string {
  return (
    downloadsName(title.replace(/[\\/:]/g, "-"))
      .slice(0, 120)
      .trim() || "files"
  );
}

/** One file of a card's Save all: its id on the card and how to read it a piece at a time. */
export type SaveAllFile = { id: string; read: (offset: number) => Promise<CardFilePiece> };

/**
 * Save all on a card's files (docs/card-authoring.md, "Files for the
 * captain"): every file into one new folder in Downloads, named for the
 * task, taking `name (2)` and on when a folder or file of that name is
 * there, so it never writes into an existing folder. Each file is saved and
 * checked as a single Save is; one that cannot be saved is named with why,
 * and the rest are still saved.
 */
export async function saveAllIntoDownloads(options: {
  folder: string;
  /** The task's title, which names the new folder. */
  name: string;
  files: readonly SaveAllFile[];
  mark?: (path: string) => Promise<void>;
  onSaved?: (id: string, file: CardFileSaved) => void;
}): Promise<CardFilesSaved> {
  const name = downloadsFolderName(options.name);
  await mkdir(options.folder, { recursive: true });
  const folder = await realpath(options.folder);
  let made: { savedAs: string; path: string } | undefined;
  for (let n = 1; n <= NUMBERED_NAMES && !made; n++) {
    const savedAs = n === 1 ? name : `${name} (${n})`;
    const path = join(folder, savedAs);
    try {
      await mkdir(path);
      made = { savedAs, path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  if (!made) throw new Error(`Downloads already holds too many folders named like ${name}.`);
  const failed: CardFilesSaved["failed"] = [];
  let saved = 0;
  for (const file of options.files) {
    try {
      const result = await saveIntoDownloads({
        folder: made.path,
        read: file.read,
        mark: options.mark,
      });
      options.onSaved?.(file.id, result);
      saved++;
    } catch (error) {
      failed.push({
        id: file.id,
        why: error instanceof Error && error.message ? error.message : String(error),
      });
    }
  }
  return { savedAs: made.savedAs, path: made.path, saved, failed };
}
