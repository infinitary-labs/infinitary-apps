import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * The folder beside a session's record that holds every session's staged
 * skills: one folder per session under it, `staged/<id>`.
 */
export const STAGED_FOLDER = "staged";

/**
 * What earlier versions staged straight into the record folder, shared by
 * every session of the task; nothing reads them now.
 */
export const SHARED_STAGING: readonly string[] = [
  "project-skills",
  "personal-skills",
  "runbook-files",
  "runbook-skills",
];

/** The staging folders an open session of this process holds, by path. */
const held = new Set<string>();

/** A session's own staging folder: its path, and the call that lets it go. */
export type StagingFolder = { dir: string; release: () => void };

/**
 * A folder of its own, beside the session's record, for what a coding
 * session stages for its model - its skills, linked or written. Every
 * session of a task records into the same folder, and two of them can be
 * open at once: staged into one shared folder, each rebuilt it from nothing
 * under the other, and an attach failed on a folder the other had just made
 * (INF-2054).
 * The session holds its folder until it releases it at its end; each claim
 * removes the folders no open session holds - a session that ended, or an
 * app that stopped - and the shared ones earlier versions left. One process
 * at a time works from a data folder (the app's single-instance lock, a work
 * computer's running lock), so what it holds is every folder in use.
 */
export async function claimStagingFolder(recordDir: string): Promise<StagingFolder> {
  const root = join(recordDir, STAGED_FOLDER);
  const dir = join(root, randomUUID());
  held.add(dir);
  const names = await readdir(root).catch(() => []);
  // A folder that is not removed now is removed by a later claim.
  await Promise.all(
    [
      ...names.map((name) => join(root, name)).filter((path) => !held.has(path)),
      ...SHARED_STAGING.map((name) => join(recordDir, name)),
    ].map((path) => rm(path, { recursive: true, force: true }).catch(() => {})),
  );
  return {
    dir,
    release: () => {
      held.delete(dir);
    },
  };
}
