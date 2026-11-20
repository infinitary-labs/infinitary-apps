import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { git } from "./git";

/**
 * Work that crosses between two Macs as a git bundle over the connection
 * (docs/helper.md, "Its working copies"), never through where the project
 * lives: a task's branch, before the home's own git reads it, and the
 * commit a closed task's work was kept in, before the computer that ran it
 * deletes its working copy. One side bundles a ref, leaving out the commits
 * the other says it has; the other checks the bundle's digest, lets git
 * verify it, and fetches the ref into place.
 */

export type MadeBundle = {
  /** Where the ref points; null when it does not exist. */
  sha: string | null;
  /** The bundle written, absent when the other side has that commit already. */
  bundle?: { size: number; sha256: string };
};

/**
 * Writes `ref` to `file` as a bundle that leaves out what `have` reaches,
 * of the commits this repository has. No bundle when `have` already reaches
 * the ref's commit.
 */
export async function bundleRef(
  repoDir: string,
  ref: string,
  have: readonly string[],
  file: string,
): Promise<MadeBundle> {
  const sha = await commitOf(repoDir, ref);
  if (!sha) return { sha: null };
  const known: string[] = [];
  for (const commit of have) if (await commitOf(repoDir, commit)) known.push(commit);
  const missing = Number.parseInt(
    await git(repoDir, ["rev-list", "--count", sha, ...(known.length ? ["--not", ...known] : [])]),
    10,
  );
  if (!missing) return { sha };
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await rm(file, { force: true });
  await git(repoDir, ["bundle", "create", "--quiet", file, ref, ...known.map((c) => `^${c}`)]);
  return { sha, bundle: { size: (await stat(file)).size, sha256: await sha256Of(file) } };
}

/**
 * Takes a bundle into this repository: its digest first, then git's own
 * check that this repository has every commit it leaves out, then `from`
 * fetched to `to`, which must then point at `sha`. Throws, changing
 * nothing that is not fetched, when any of it fails.
 */
export async function takeBundle(
  repoDir: string,
  file: string,
  expected: { size: number; sha256: string },
  from: string,
  to: string,
  sha: string,
): Promise<void> {
  const size = (await stat(file)).size;
  if (size !== expected.size || (await sha256Of(file)) !== expected.sha256)
    throw new Error("The bundle that arrived is not the one that was sent.");
  await git(repoDir, ["bundle", "verify", "--quiet", file]);
  await git(repoDir, [
    "fetch",
    "--quiet",
    "--no-tags",
    "--no-write-fetch-head",
    file,
    `+${from}:${to}`,
  ]);
  if ((await commitOf(repoDir, to)) !== sha)
    throw new Error(`${to} does not point at ${sha} after the bundle was fetched.`);
}

/** The commit `ref` names here, or null. */
export async function commitOf(repoDir: string, ref: string): Promise<string | null> {
  try {
    return (await git(repoDir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) || null;
  } catch {
    return null;
  }
}

export function sha256Of(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}
