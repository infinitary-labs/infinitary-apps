import { chmod, copyFile, mkdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { type CardFile, cardFileId, cardFileStoredName } from "@shared/cardFiles";
import { isProtectedFile } from "../files/fileReach";
import { HANDOVER_FILE_BYTES, sha256OfFile } from "../tasks/handoverFiles";

/**
 * Files for the captain on a card (docs/card-authoring.md, "Files for the
 * captain"): a crewmate names each by path in `files`, and the host keeps
 * one checked copy of it in the task's `cards` folder on the computer the
 * crewmate runs on, so it outlives the temporary folder it came from. The
 * card carries only the reference this answers - name, size, sha256 and
 * where the copy is - never the bytes; they move only when the captain
 * clicks Save. A file may hold secrets: nothing here reads its content
 * into words, logs it or names more than its name, size and sha256.
 */

/** Where a crewmate's card files are kept: its task's card copies, beside its pictures. */
export type CardFileRoot = {
  /** The working copy a relative path is read against. */
  worktree: string;
  /** `crewmates/<taskId>/cards` here, the task's `cards` folder on a computer that runs work. */
  dir: string;
  taskId: string;
  /**
   * The app's own sign-ins and keys on that computer (`protectedPlaces`),
   * which a card never copies, as the files command never reads them.
   */
  protectedPlaces: readonly string[];
};

/**
 * Keeps a checked copy of each file a card names and answers its reference.
 * Each is an absolute path, or one relative to the working copy, to a
 * regular, non-empty file of at most 1 GB; two names for one file, or two
 * files of one name, are refused. A refusal names the path, never content.
 */
export async function keepCardFiles(
  paths: readonly string[],
  root: CardFileRoot | undefined,
): Promise<CardFile[]> {
  if (paths.length === 0) return [];
  if (!root)
    throw new Error(
      "Card refused: this task has no folder to keep files in, so its cards cannot carry files.",
    );
  await mkdir(root.dir, { recursive: true, mode: 0o700 });
  const kept: CardFile[] = [];
  for (const named of paths) {
    const path = named.trim();
    if (!path)
      throw new Error("Card refused: a file in files is empty; name each file by its path.");
    const full = isAbsolute(path) ? path : resolve(root.worktree, path);
    const real = await realpath(full).catch(() => {
      throw new Error(`Card refused: there is no file at ${path} to put on the card.`);
    });
    if (await isProtectedFile(real, root.protectedPlaces))
      throw new Error(
        `Card refused: ${path} holds the app's own sign-ins or keys, which a card never carries.`,
      );
    const info = await stat(real);
    if (!info.isFile())
      throw new Error(`Card refused: ${path} is not a file; put files on a card, never a folder.`);
    if (info.size === 0)
      throw new Error(
        `Card refused: ${path} is empty, so there is nothing for the captain to save.`,
      );
    if (info.size > HANDOVER_FILE_BYTES)
      throw new Error(`Card refused: ${path} is larger than 1 GB, the most one card file may be.`);
    const name = basename(full);
    if (kept.some((file) => file.name === name))
      throw new Error(
        `Card refused: two files are named ${name}; the captain's Downloads takes one file of a name, so rename one.`,
      );
    const sha256 = await sha256OfFile(real);
    const id = cardFileId(root.taskId, sha256);
    if (kept.some((file) => file.id === id))
      throw new Error(`Card refused: ${path} is the same file as another one on this card.`);
    const to = join(root.dir, cardFileStoredName(id));
    // The same content kept before (an earlier version of the card) is reused as it is.
    const there = await stat(to).catch(() => undefined);
    if (!there || there.size !== info.size || (await sha256OfFile(to)) !== sha256) {
      const part = `${to}.part`;
      await copyFile(real, part);
      await chmod(part, 0o600);
      if ((await stat(part)).size !== info.size || (await sha256OfFile(part)) !== sha256) {
        await rm(part, { force: true });
        throw new Error(`Card refused: ${path} changed while it was copied; emit the card again.`);
      }
      await rename(part, to);
    }
    kept.push({ id, name, bytes: info.size, sha256, path: to });
  }
  return kept;
}
