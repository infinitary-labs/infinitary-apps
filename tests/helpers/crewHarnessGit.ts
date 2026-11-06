/**
 * Real git for the crew supervisor's tests: a project folder with one
 * empty commit on main. It is apart from crewHarness.ts so a test file that
 * spawns git says so in its own imports.
 */
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { scratchDir } from "./scratchDirs";

/** A project folder on main with one empty commit, named as the task's project. */
export function gitRepo(name = "meterlab") {
  const dir = scratchDir("infinitary-crew-git-");
  execFileSync("git", ["-C", dir, "init", "--initial-branch=main"]);
  execFileSync("git", [
    "-C",
    dir,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "--allow-empty",
    "-m",
    "init",
  ]);
  return { dir, name, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}
