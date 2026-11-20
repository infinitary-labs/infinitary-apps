import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { join } from "node:path";

/** The folder downloaded workflow artifacts go in, at the top of a task's working copy. */
export const ARTIFACTS_FOLDER = ".infinitary-artifacts";
/**
 * The folder a computer from before the Infinitary rename writes them in
 * (`INFINITARY_NAMES_SINCE`), so the home names that path to its crewmate.
 */
export const OLDER_ARTIFACTS_FOLDER = ".firstmate-artifacts";

/** A selection's name in its path: the first twelve hex digits of its SHA-256. */
export const ARTIFACT_PART = /^[0-9a-f]{12}$/;

/**
 * Where a downloaded workflow artifact goes in a task's working copy:
 * host-controlled parts only, never an artifact's name or a path a caller
 * chose. A selection of its files (`part`, the start of the saved
 * archive's SHA-256) sits beside the whole archive.
 */
export function artifactPath(
  runId: number,
  artifactId: number,
  folder: string = ARTIFACTS_FOLDER,
  part?: string,
): string {
  if (part !== undefined && !ARTIFACT_PART.test(part))
    throw new Error("An artifact part is twelve hexadecimal digits.");
  return `${folder}/run-${runId}/artifact-${artifactId}${part ? `-${part}` : ""}.zip`;
}

/** The artifact folder is a link, or not a folder: nothing is written through it. */
export class ArtifactFolderError extends Error {
  constructor() {
    super("The artifact folder must be a directory inside the working copy, not a link.");
    this.name = "ArtifactFolderError";
  }
}

/**
 * Writes a downloaded artifact into the working copy at `cwd`, the same on
 * this Mac and on a computer that runs work (docs/helper.md, "Its working
 * copies"): each folder made 0700 and refused when it is a link, and the
 * file created 0600, never following a link and never over a file already
 * there (`EEXIST`). Answers the path it wrote, relative to the working copy.
 */
export async function writeArtifact(
  cwd: string,
  runId: number,
  artifactId: number,
  bytes: Uint8Array,
  part?: string,
): Promise<string> {
  const root = await realpath(cwd);
  const directory = join(root, ARTIFACTS_FOLDER, `run-${runId}`);
  for (const dir of [join(root, ARTIFACTS_FOLDER), directory]) {
    await mkdir(dir, { mode: 0o700 }).catch((caught: NodeJS.ErrnoException) => {
      if (caught.code !== "EEXIST") throw caught;
    });
    const stat = await lstat(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ArtifactFolderError();
  }
  const relativePath = artifactPath(runId, artifactId, ARTIFACTS_FOLDER, part);
  const file = await open(
    join(root, relativePath),
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(bytes);
  } finally {
    await file.close();
  }
  return relativePath;
}
