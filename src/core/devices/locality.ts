import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Whether a Mac the home reaches over SSH is this Mac itself (docs/devices.md,
 * "Where a computer joins from"). A connection forwarded through SSH reaches
 * the home from its own loopback, so where the socket says it dialed from
 * cannot tell; the home asks before the link exists instead. It leaves a
 * fresh token in a file under `/tmp`, which only this Mac has and which every
 * user on this Mac can read, and the look over SSH reads that path there:
 * the token read back means the other end is this Mac, as the captain's user
 * or another one; anything else is another Mac. The file goes once read.
 *
 * The token is no secret, and nothing is kept that names this Mac's hardware.
 * It tells a mistake - adding the captain's own user on this Mac - from
 * another Mac with the same user number; code already running as the captain
 * could answer either way, and pairing never guarded against that.
 */

/** Where a computer joins from, as the home found it. */
export type Locality = "this-mac" | "elsewhere";

export type LocalityChallenge = {
  /** The file the other end reads, if it is this Mac. */
  readonly path: string;
  /** What it holds: a fresh random token, no secret. */
  readonly token: string;
  /** Where the other end is, from what it read at `path`; nothing read is another Mac. */
  readonly localityOf: (read: string | undefined) => Locality;
  /** Removes the file and its folder; safe to call twice. */
  readonly dispose: () => void;
};

/**
 * Leaves the token in a fresh folder of its own under `base` (`/tmp`, which
 * every user here can reach), readable by every user on this Mac and
 * writable by none but this one. Throws when it cannot be left.
 */
export function placeLocalityChallenge(base = "/tmp"): LocalityChallenge {
  const dir = mkdtempSync(join(base, "infinitary-here-"));
  const token = randomBytes(32).toString("base64url");
  const path = join(dir, "here");
  try {
    writeFileSync(path, `${token}\n`, { mode: 0o644, flag: "wx" });
    chmodSync(path, 0o644);
    chmodSync(dir, 0o755);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    path,
    token,
    localityOf: (read) => (read?.trim() === token ? "this-mac" : "elsewhere"),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}
