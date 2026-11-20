import { constants as bufferConstants } from "node:buffer";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { RecoverySave } from "../../core/secrets/protected";
import type { RecoveryFiles } from "../../core/secrets/recoveryArchive";

/** Paths chosen by native dialogs, never accepted from an agent or a renderer argument. */
export type RecoveryDestinations = { archive: string; key: string };

/**
 * Never replace an existing backup or key. Two different destinations cannot
 * commit atomically; an incomplete save leaves its new files in place and says
 * partial. It never removes an earlier working pair to make room for this one.
 */
export async function saveSecretRecoveryFiles(
  destinations: RecoveryDestinations,
  files: RecoveryFiles,
): Promise<RecoverySave> {
  const archive = resolve(destinations.archive);
  const key = resolve(destinations.key);
  if (archive === key) return "unavailable";
  // Check both choices before creating anything. Exclusive opens enforce the
  // same rule again if another program creates a file after this observation.
  for (const path of [key, archive]) {
    try {
      await lstat(path);
      return "unavailable";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "unavailable";
    }
  }
  let created = false;
  try {
    for (const [path, bytes] of [
      [key, files.key],
      [archive, files.archive],
    ] as const) {
      const file = await open(path, "wx", 0o600);
      created = true;
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      const folder = await open(dirname(path), "r");
      try {
        // Recovery must not report a complete pair after a failed directory sync.
        await folder.sync();
      } finally {
        await folder.close();
      }
    }
    return "saved";
  } catch {
    return created ? "partial" : "unavailable";
  }
}

/** Read only explicitly selected regular files, with no final-link following. */
export async function readSecretRecoveryFiles(
  sources: RecoveryDestinations,
): Promise<RecoveryFiles | undefined> {
  let key: Buffer | undefined;
  let archive: Buffer | undefined;
  try {
    for (const [kind, path] of [
      ["key", sources.key],
      ["archive", sources.archive],
    ] as const) {
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await file.stat();
        // The key is the cipher's 256-bit key; JSON decoding needs one V8 string.
        // These are format/runtime limits, not a chosen archive size policy.
        if (
          !stat.isFile() ||
          (kind === "key" ? stat.size !== 32 : stat.size > bufferConstants.MAX_STRING_LENGTH)
        )
          return undefined;
        const bytes = await file.readFile();
        if (kind === "key") key = bytes;
        else archive = bytes;
      } finally {
        await file.close();
      }
    }
    if (key?.length !== 32 || !archive || archive.length > bufferConstants.MAX_STRING_LENGTH)
      return undefined;
    const result = { archive, key };
    archive = undefined;
    key = undefined;
    return result;
  } catch {
    return undefined;
  } finally {
    key?.fill(0);
    archive?.fill(0);
  }
}
