// The app's git on a crewmate's search path (git integration phase 2,
// docs/forge.md "The app's own git"): scripts/git-launcher.c, compiled.
//
// On a Mac, `pnpm install` (through scripts/ensure-bundled-git.ts) builds it
// once for both chips into one file, gitignored vendor/git-bin/git, which
// electron-builder.yml ships as Contents/Resources/git-bin/ and an
// unpackaged checkout runs in place (src/core/workspace/bundledGit.ts).
// A file that already holds both chips is one @electron/universal takes as
// it is, so it needs no line in mac.x64ArchFiles.
//
// Only a Mac that builds Infinitary compiles it, with Apple's developer
// tools; a person who installs the app gets it built. A Mac with no
// developer tools skips it with a note, and that checkout then runs the
// system git (resolveBundledGit finds no launcher).
//
// A launcher whose stamp names the source's hash is left alone, so a repeat
// install does no work.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** The launcher's source. */
export const GIT_LAUNCHER_SOURCE = join(root, "scripts", "git-launcher.c");
/** The oldest macOS the app runs on, read from electron-builder.yml's `mac.minimumSystemVersion`. */
function oldestMacOS(): string {
  const found = /^\s+minimumSystemVersion:\s*"([\d.]+)"/m.exec(
    readFileSync(join(root, "electron-builder.yml"), "utf8"),
  );
  if (!found?.[1]) throw new Error("electron-builder.yml names no mac.minimumSystemVersion");
  return found[1];
}
const STAMP = ".infinitary-source";

/**
 * Compiles the launcher to `out`: for both Mac chips with Apple's clang when
 * `universal`, else for this machine with its own C compiler (`cc`), the way
 * a test builds it. Throws with the compiler's words when it fails.
 */
export function compileGitLauncher(out: string, { universal }: { universal: boolean }): void {
  const [program, ...args] = universal
    ? [
        "/usr/bin/xcrun",
        "clang",
        "-arch",
        "arm64",
        "-arch",
        "x86_64",
        `-mmacosx-version-min=${oldestMacOS()}`,
      ]
    : ["cc"];
  const run = spawnSync(
    program as string,
    [...args, "-O2", "-Wall", "-Werror", "-o", out, GIT_LAUNCHER_SOURCE],
    { encoding: "utf8" },
  );
  if (run.status !== 0) {
    throw new Error(
      `could not compile the app's git launcher: ${run.error?.message ?? run.stderr.trim()}`,
    );
  }
}

/** Whether this Mac has Apple's developer tools; asks without starting their installer. */
function hasDeveloperTools(): boolean {
  return spawnSync("/usr/bin/xcode-select", ["-p"], { stdio: "ignore" }).status === 0;
}

function sourceStamp(): string {
  return createHash("sha256").update(readFileSync(GIT_LAUNCHER_SOURCE)).digest("hex");
}

/**
 * Builds `<binDir>/git` for both chips unless the one there was built from
 * this source. Returns whether a launcher is in place.
 */
export function ensureGitLauncher(binDir: string = join(root, "vendor", "git-bin")): boolean {
  const stamp = join(binDir, STAMP);
  const want = sourceStamp();
  if (
    existsSync(join(binDir, "git")) &&
    existsSync(stamp) &&
    readFileSync(stamp, "utf8").trim() === want
  ) {
    return true;
  }
  if (!hasDeveloperTools()) {
    console.warn(
      "[infinitary] this Mac has no developer tools, so the app's git launcher was not built; " +
        "this checkout runs the system git. Install them with `xcode-select --install` and re-run `pnpm install`.",
    );
    return false;
  }
  const partial = `${binDir}.${process.pid}.partial`;
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial, { recursive: true });
  try {
    compileGitLauncher(join(partial, "git"), { universal: true });
    writeFileSync(join(partial, STAMP), `${want}\n`);
    rmSync(binDir, { recursive: true, force: true });
    renameSync(partial, binDir);
  } finally {
    rmSync(partial, { recursive: true, force: true });
  }
  console.log(`[infinitary] the app's git launcher is in ${binDir}`);
  return true;
}
