import { constants, createWriteStream } from "node:fs";
import { chmod, type FileHandle, lstat, open, realpath, rm } from "node:fs/promises";
import { basename } from "node:path";
import { pipeline } from "node:stream/promises";
import Database from "better-sqlite3";
import { HANDOVER_FILE_BYTES } from "../tasks/handoverFiles";

/**
 * One checked file set aside whole, as the files command copies it
 * (docs/files.md, "How a copy travels"): opened through the handle to the
 * very file that was checked, and copied from it, or, for a database,
 * through its own backup.
 *
 * It runs in a process of its own (./setAsideProcess.ts) wherever the app
 * holds a database: closing any handle to a file drops every lock the
 * process holds on that file, SQLite's included, so a copy of the app's own
 * record, its log or its shared memory made in the app's process would let
 * the next program that opens the record take it over while the app still
 * reads it (`FileReachOptions.setAsideProcess`).
 */

/** A refusal in words that say what to do, never an error code. */
export class FileRefusal extends Error {}

export type FileIdentity = { dev: number; ino: number };

export type SetAsideOrder = {
  /** The path as the crewmate named it, which a refusal's words name. */
  path: string;
  /** The checked file's real path. */
  file: string;
  /** What `file` named when checked, which every read must still find there. */
  checked: FileIdentity;
  /** Where the copy goes, in the app's own folder for copies. */
  to: string;
};

/** What a set-aside said: whether the file was a database, copied through its backup. */
export type SetAsideAnswer = { database: boolean };

/** What the process a file is set aside in is told, and what it answers. */
export type SetAsideParentMessage = { type: "set-aside"; order: SetAsideOrder };
export type SetAsideChildMessage =
  | { type: "set"; database: boolean }
  | { type: "refused"; words: string }
  | { type: "failed"; message: string };

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "binary");

/** The files SQLite opens by name beside a database: its log, its shared memory and its journal. */
const DATABASE_SIDECARS = ["-wal", "-shm", "-journal"];

/**
 * How a checked file is opened: to read, never through a link at its end,
 * and never waiting on a pipe swapped in for it.
 */
const OPEN_CHECKED = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/**
 * Sets one checked file aside at `order.to`, made 0600: an empty file, one
 * over 1 GB, and one swapped for another since the check are refused, and
 * nothing is left at `to` for a refusal.
 */
export async function setAsideFile(order: SetAsideOrder): Promise<SetAsideAnswer> {
  const { path, file, checked, to } = order;
  const { handle, info } = await openChecked(path, file, checked);
  try {
    if (info.size === 0) throw new FileRefusal(`${path} is empty, so there is nothing to copy.`);
    if (info.size > HANDOVER_FILE_BYTES)
      throw new FileRefusal(`${path} is larger than 1 GB, the most a hand-over folder takes.`);
    try {
      const database = await isDatabase(handle);
      if (database) await backUp(path, file, info, to);
      else await copyFrom(handle, to);
      await chmod(to, 0o600);
      return { database };
    } catch (error) {
      await rm(to, { force: true });
      if (error instanceof FileRefusal) throw error;
      throw new FileRefusal(`${path} could not be copied: ${reasonOf(error)}.`);
    }
  } finally {
    await handle.close();
  }
}

/**
 * That a checked path still names the file it named: reached with no link
 * along it, at the same device and inode. Asked after each read by name -
 * the open, a folder's names, SQLite's own open and backup - so a link
 * swapped in for the path or a folder on it is refused.
 */
export async function stillChecked(
  path: string,
  real: string,
  checked: FileIdentity,
): Promise<void> {
  const now = await realpath(real).catch(() => undefined);
  const facts = now === real ? await lstat(real).catch(() => undefined) : undefined;
  if (!facts || !sameFile(facts, checked)) throw changedRefusal(path);
}

export function changedRefusal(path: string): FileRefusal {
  return new FileRefusal(`${path} changed while it was being read; ask for it again.`);
}

export function unreadable(path: string, error: unknown): FileRefusal {
  return new FileRefusal(
    (error as NodeJS.ErrnoException)?.code === "ENOENT"
      ? `There is nothing at ${path}.`
      : `${path} could not be read: ${reasonOf(error)}.`,
  );
}

export function sameFile(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

export function reasonOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "EACCES" || code === "EPERM") return "this computer's user may not read it";
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\.$/, "");
}

/**
 * Opens the file a checked path named, never through a link at its end,
 * and holds it only while that path still names it (`stillChecked`): a
 * link swapped in after the check is refused before anything is read.
 */
async function openChecked(
  path: string,
  real: string,
  checked: FileIdentity,
): Promise<{ handle: FileHandle; info: { size: number } & FileIdentity }> {
  let handle: FileHandle;
  try {
    handle = await open(real, OPEN_CHECKED);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw changedRefusal(path);
    throw unreadable(path, error);
  }
  try {
    const info = await handle.stat();
    if (!sameFile(info, checked)) throw changedRefusal(path);
    await stillChecked(path, real, info);
    return { handle, info };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * A database copied through its own backup: read through SQLite, with what
 * its write-ahead log holds, so a database another program writes arrives
 * complete and consistent. It is opened to read only. SQLite opens it, and
 * the files beside it, by name, so it must still be the file checked when
 * SQLite has it open and once the copy is done, and none of those files
 * beside it may be a link.
 */
async function backUp(
  path: string,
  file: string,
  checked: FileIdentity,
  to: string,
): Promise<void> {
  await sidecarsPlain(path, file);
  let db: Database.Database;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
  } catch (error) {
    throw new FileRefusal(`${file} could not be opened as a database: ${reasonOf(error)}.`);
  }
  try {
    await stillChecked(path, file, checked);
    await db.backup(to);
    await stillChecked(path, file, checked);
    await sidecarsPlain(path, file);
  } finally {
    db.close();
  }
}

async function sidecarsPlain(path: string, file: string): Promise<void> {
  for (const suffix of DATABASE_SIDECARS) {
    const facts = await lstat(`${file}${suffix}`).catch(() => undefined);
    if (facts?.isSymbolicLink())
      throw new FileRefusal(
        `${path} is a database whose ${basename(file)}${suffix} beside it is a link, which the files command does not follow.`,
      );
  }
}

async function isDatabase(handle: FileHandle): Promise<boolean> {
  const head = Buffer.alloc(SQLITE_HEADER.length);
  const { bytesRead } = await handle.read(head, 0, head.length, 0);
  return bytesRead === head.length && head.equals(SQLITE_HEADER);
}

/** A file copied from its open handle, whatever its path names by now. */
async function copyFrom(handle: FileHandle, to: string): Promise<void> {
  await pipeline(
    handle.createReadStream({ start: 0, autoClose: false }),
    createWriteStream(to, { flags: "wx", mode: 0o600 }),
  );
}
