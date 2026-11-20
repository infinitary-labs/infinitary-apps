import { execFileSync } from "node:child_process";
import { constants, copyFileSync } from "node:fs";
import { hostEnv } from "../hostEnv";
import { hostPlatform } from "../platform";

/**
 * Copy `from` to the new path `to` so that later writes to either never reach the other.
 * A disk that can clone (APFS on a Mac, btrfs or XFS on Linux) shares the blocks until one side changes, so even a database of a gigabyte copies in milliseconds; any other disk, or a pair of volumes a clone cannot span, gets a full copy.
 * Node's own clone flag does not clone on macOS, so there the system's `cp -c` makes the clone (clonefile(2)).
 */
export function privateCopy(from: string, to: string): void {
  if (hostPlatform() === "darwin") {
    try {
      execFileSync("/bin/cp", ["-c", "--", from, to], { env: hostEnv(), stdio: "ignore" });
      return;
    } catch {
      // A disk or volume pair that cannot clone falls through to the full copy, which replaces anything cp left.
    }
  }
  copyFileSync(from, to, constants.COPYFILE_FICLONE);
}
