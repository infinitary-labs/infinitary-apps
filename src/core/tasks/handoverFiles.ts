import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";
import { HANDOVER_FILE_NAME, type HandoverFile } from "@shared/work";

/**
 * Files one task hands another (INF-992, direction B): a crewmate names
 * files in its report, the host keeps verified copies, and the first mate's
 * steer delivers them into the waiting task's hand-over folder. A handed
 * file may hold secrets, so nothing here reads its content into a string,
 * logs it or names more than its kept name, size and sha256. Every copy is
 * 0600 in a 0700 folder. A task's kept files stay past its close, so a
 * steer after it still hands them, and go with its other leftover files a
 * week on (`closedTaskFiles.ts`); a delivered copy goes with the receiving
 * task's temporary folder at its close.
 */

/** The folder a task's reported files are kept in, beside its other folders. */
export const HANDOVER_OUT_DIR_NAME = "handover-out";
/** The folder inside a task's temporary folder that handed files arrive in. */
export const HANDOVER_IN_DIR_NAME = "handover";
/** The largest file a task hands on: the source-file order's own bound. */
export const HANDOVER_FILE_BYTES = 1024 * 1024 * 1024;

/** The sha256 of a file, read in a stream so its content is never held whole. */
export function sha256OfFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * A kept file's name: its sha256's first sixteen digits, then its own name
 * reduced to letters, digits, `_` and `-`, with one extension (`bin` when
 * it has none), so two files of one name never collide and the name passes
 * every order that carries it.
 */
export function handoverFileName(original: string, sha256: string): string {
  const name = basename(original);
  const ext =
    extname(name)
      .slice(1)
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 16) || "bin";
  const stem =
    (extname(name) ? name.slice(0, -extname(name).length) : name)
      .replace(/[^A-Za-z0-9_-]/g, "_")
      .slice(0, 100) || "file";
  return `${sha256.slice(0, 16)}-${stem}.${ext}`;
}

/** A verified copy: copied, made 0600 and checked against the size and sha256 it must have. */
async function copyVerified(from: string, to: string, size: number, sha256: string): Promise<void> {
  const part = `${to}.part`;
  await copyFile(from, part);
  await chmod(part, 0o600);
  if ((await stat(part)).size !== size || (await sha256OfFile(part)) !== sha256) {
    await rm(part, { force: true });
    throw new Error("A handed file changed while it was copied; report it again.");
  }
  await rename(part, to);
}

/**
 * Keeps verified copies of the files a crewmate's report names, in `dir`
 * on the computer it runs on. Each must be an absolute path to a regular,
 * non-empty file of at most 1 GB; a refusal names the path, never content.
 */
export async function keepHandoverFiles(
  paths: readonly string[],
  dir: string,
): Promise<HandoverFile[]> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const kept: HandoverFile[] = [];
  for (const path of paths) {
    if (!isAbsolute(path)) throw new Error(`Hand on files by absolute path: ${path} is not one.`);
    const real = await realpath(path).catch(() => {
      throw new Error(`There is no file at ${path} to hand on.`);
    });
    const info = await stat(real);
    if (!info.isFile()) throw new Error(`${path} is not a file; hand on files, never a folder.`);
    if (info.size === 0) throw new Error(`${path} is empty, so there is nothing to hand on.`);
    if (info.size > HANDOVER_FILE_BYTES)
      throw new Error(`${path} is larger than 1 GB, the most one handed file may be.`);
    const sha256 = await sha256OfFile(real);
    const file = handoverFileName(path, sha256);
    await copyVerified(real, join(dir, file), info.size, sha256);
    kept.push({ file, size: info.size, sha256 });
  }
  return kept;
}

/** Each file a report declared is kept in `dir` as it was declared, or this throws. */
export async function verifyHandoverFiles(
  dir: string,
  files: readonly HandoverFile[],
): Promise<void> {
  for (const declared of files) {
    if (!HANDOVER_FILE_NAME.test(declared.file))
      throw new Error("That handed file's name is not one the app keeps.");
    const file = join(dir, declared.file);
    const info = await stat(file).catch(() => undefined);
    if (
      !info?.isFile() ||
      info.size !== declared.size ||
      (await sha256OfFile(file)) !== declared.sha256
    )
      throw new Error(`${declared.file} did not arrive whole; report it again.`);
  }
}

export async function keptHandoverFiles(
  dir: string,
): Promise<{ file: string; path: string; size: number }[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const files: { file: string; path: string; size: number }[] = [];
  for (const file of names.filter((name) => HANDOVER_FILE_NAME.test(name)).sort()) {
    const path = join(dir, file);
    const info = await stat(path).catch(() => undefined);
    if (info?.isFile()) files.push({ file, path, size: info.size });
  }
  return files;
}

/** Delivers a kept file into a task's hand-over folder on this computer, verified, and answers its path. */
export async function deliverHandoverFile(
  from: string,
  dir: string,
  file: string,
): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await stat(from);
  const to = join(dir, file);
  await copyVerified(from, to, info.size, await sha256OfFile(from));
  return to;
}
