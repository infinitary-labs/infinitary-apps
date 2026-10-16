// Copy-on-write copies for what `pnpm install` places in every working copy
// of this project (the app's git, the ONNX runtime files): on APFS a clone
// shares its blocks with its source, so another working copy costs no disk
// for them until a file in it is changed.
//
// Node cannot clone on macOS - copyFile's COPYFILE_FICLONE quietly makes a
// full copy there and COPYFILE_FICLONE_FORCE fails - so a Mac runs the
// system's own `cp -c`, which clones each file and itself falls back to an
// ordinary copy when the two paths are on different volumes or the disk
// cannot clone. Elsewhere Node's copy asks for a reflink (btrfs, XFS) and
// makes a plain copy where there is none.

import { spawnSync } from "node:child_process";
import { constants, cpSync, existsSync, rmSync } from "node:fs";

/**
 * Copy `source`, a file or a folder whose symbolic links stay links, to
 * `target`, which must not exist yet: a clone where the disk allows it, a
 * plain copy where it does not. `cp` is the macOS copier, by path because a
 * GNU cp earlier on the search path reads `-c` as something else.
 */
export function cloneOrCopy(
  source: string,
  target: string,
  { cp = "/bin/cp" }: { cp?: string } = {},
): void {
  if (existsSync(target)) throw new Error(`${target} already exists`);
  if (process.platform === "darwin") {
    if (spawnSync(cp, ["-c", "-R", source, target], { stdio: "ignore" }).status === 0) return;
    rmSync(target, { recursive: true, force: true });
  }
  cpSync(source, target, {
    recursive: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
  });
}
