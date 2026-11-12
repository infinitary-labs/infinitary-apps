import { createHash, randomBytes } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, link, mkdir, open, rm, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { CardFilePiece, CardFileSaved } from "@shared/cardFiles";

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

/** `name.ext`, then `name (2).ext`, `name (3).ext` and on. */
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

/** Whether a file at `path` is this one already, by size and sha256. */
async function sameFile(path: string, bytes: number, sha256: string): Promise<boolean> {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile() || info.size !== bytes) return false;
  return (await sha256Of(path).catch(() => undefined)) === sha256;
}

/** Gives the checked part file a name no other file has, without ever replacing one. */
async function claimName(part: string, path: string): Promise<boolean> {
  try {
    await link(part, path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    // A disk that keeps no hard links still refuses to copy over a file that is there.
    try {
      await copyFile(part, path, constants.COPYFILE_EXCL);
      return true;
    } catch (copied) {
      if ((copied as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw copied;
    }
  }
}

export async function saveIntoDownloads(options: {
  /** This computer's Downloads folder. */
  folder: string;
  /** One piece of the file from an offset (`inf:cards:file`). */
  read: (offset: number) => Promise<CardFilePiece>;
}): Promise<CardFileSaved> {
  const first = await options.read(0);
  const name = downloadsName(first.name);
  const { bytes, sha256 } = first;
  await mkdir(options.folder, { recursive: true });
  // Saved before with the same content: nothing more is written.
  const existing = join(options.folder, name);
  if (await sameFile(existing, bytes, sha256)) return { savedAs: name, path: existing };
  const part = join(options.folder, `.${name}.${randomBytes(6).toString("hex")}.part`);
  const handle = await open(part, "wx");
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
    for (let n = 1; n <= NUMBERED_NAMES; n++) {
      const savedAs = numbered(name, n);
      const path = join(options.folder, savedAs);
      if (await claimName(part, path)) return { savedAs, path };
      if (await sameFile(path, bytes, sha256)) return { savedAs, path };
    }
    throw new Error(`Downloads already holds too many files named like ${name}.`);
  } finally {
    await rm(part, { force: true });
  }
}
