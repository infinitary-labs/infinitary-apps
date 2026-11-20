import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { configureBundledGit } from "../hostEnv";
import { adoptBundledGit, type BundledGitApp, bundledGitLocation } from "../workspace/bundledGit";
import { gitFound } from "./found";

/**
 * Whether a computer that runs work has git, as it tells its home when it
 * joins (docs/helper.md, "Joining"): the app's own git when its copy
 * carries one, which every git it starts runs, else the git on the search
 * path. Nothing here runs a git; a search path that held the Mac's own
 * stand-in would ask about the developer tools, so none does.
 */

function program(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
}

/** An installed app whose own git is a stand-in: its tree's program and the folder a shell finds it through. */
function packagedApp(): BundledGitApp {
  const resourcesDir = scratchDir("infinitary-found-app-");
  const { dir, shimDir } = bundledGitLocation({ packaged: true, appDir: "", resourcesDir });
  program(join(dir, "bin", "git"));
  program(join(shimDir, "git"));
  return { packaged: true, appDir: join(resourcesDir, "app.asar"), resourcesDir };
}

afterEach(() => configureBundledGit(undefined));

describe("git, as a computer that runs work finds it", () => {
  it("accepts Linux system git without asking for Apple developer tools", async () => {
    expect(await gitFound({ PATH: "/usr/bin" }, "linux")).toBe(true);
  });

  // INF-4650: a Windows PC's task waited on "a required program was missing"
  // with Git for Windows installed, since only a file named git counted.
  it("is git.exe in Git for Windows' cmd folder on a Windows search path", async () => {
    const system32 = scratchDir("infinitary-found-system32-");
    const gitCmd = join(scratchDir("infinitary-found-git-for-windows-"), "cmd");
    program(join(gitCmd, "git.exe"));
    const pathext = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";
    expect(await gitFound({ PATH: system32, PATHEXT: pathext }, "win32")).toBe(false);
    expect(await gitFound({ PATH: `${system32};${gitCmd}`, PATHEXT: pathext }, "win32")).toBe(true);
  });
  it("is the app's own when its copy carries one, though the search path holds no git", async () => {
    const noGit = scratchDir("infinitary-found-path-");
    expect(await gitFound({ PATH: noGit })).toBe(false);
    adoptBundledGit(packagedApp(), {});
    expect(await gitFound({ PATH: noGit })).toBe(true);
  });

  it("is the git on the search path when its copy carries none", async () => {
    adoptBundledGit(
      { packaged: false, appDir: scratchDir("infinitary-found-checkout-"), resourcesDir: "" },
      {},
    );
    const noGit = scratchDir("infinitary-found-path-");
    expect(await gitFound({ PATH: noGit })).toBe(false);
    const withGit = scratchDir("infinitary-found-git-");
    program(join(withGit, "git"));
    expect(await gitFound({ PATH: [noGit, withGit].join(delimiter) })).toBe(true);
  });
});
