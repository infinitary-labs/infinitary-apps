import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { locateProject, renderLocated } from "./projectLocator";

/**
 * locate_project's disk lookup (contract v1, G-2): bounded roots under a
 * fake home, exact-before-substring matching, symlink and hidden/system
 * exclusions, and managed repos surfacing their repo_id.
 */

function fakeHome(): string {
  const home = scratchDir("infinitary-locate-");
  mkdirSync(join(home, "projects", "meter-scan"), { recursive: true });
  mkdirSync(join(home, "github", "kunchenguid", "meter-scan-tools"), { recursive: true });
  mkdirSync(join(home, "github", "kunchenguid", "other-repo"), { recursive: true });
  mkdirSync(join(home, "code", "unrelated"), { recursive: true });
  mkdirSync(join(home, "Library", "meter-scan"), { recursive: true });
  mkdirSync(join(home, ".hidden", "meter-scan"), { recursive: true });
  // A git repo with an origin remote, read without spawning git.
  const gitted = join(home, "projects", "meter-scan", ".git");
  mkdirSync(gitted);
  writeFileSync(
    join(gitted, "config"),
    '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = git@github.com:kunchenguid/meter-scan.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
  );
  return home;
}

describe("locateProject", () => {
  it("finds exact matches before substrings, with git and origin detail", () => {
    const home = fakeHome();
    const results = locateProject("meter-scan", { home, managed: [] });
    expect(results[0]).toEqual({
      path: join(home, "projects", "meter-scan"),
      isGitRepo: true,
      origin: "git@github.com:kunchenguid/meter-scan.git",
    });
    // The org-level and repo-level github scan found the substring match.
    expect(results.map((result) => result.path)).toContain(
      join(home, "github", "kunchenguid", "meter-scan-tools"),
    );
    // Hidden and system directories are never entered.
    expect(results.map((result) => result.path)).not.toContain(join(home, "Library", "meter-scan"));
    expect(results.every((result) => !result.path.includes(".hidden"))).toBe(true);
  });

  it("matches case-insensitively and reports managed repos by repo_id", () => {
    const home = fakeHome();
    const managedPath = join(home, "somewhere-else", "meter-scan");
    mkdirSync(managedPath, { recursive: true });
    const results = locateProject("Meter-SCAN", {
      home,
      managed: [{ id: "repo-1", name: "meter-scan", path: managedPath }],
    });
    expect(results.some((result) => result.repoId === "repo-1")).toBe(true);
  });

  it("skips symlinked children so the scan cannot leave its roots", () => {
    const home = fakeHome();
    const outside = scratchDir("infinitary-outside-");
    mkdirSync(join(outside, "meter-scan-secret"));
    symlinkSync(outside, join(home, "code", "linked"));
    const results = locateProject("meter-scan", { home, managed: [] });
    expect(results.every((result) => !result.path.includes("linked"))).toBe(true);
    expect(results.every((result) => !result.path.includes("secret"))).toBe(true);
  });

  it("renders candidates and an honest not-found", () => {
    const home = fakeHome();
    const found = renderLocated("meter-scan", locateProject("meter-scan", { home, managed: [] }));
    expect(found).toContain("git repo");
    expect(found).toContain("origin git@github.com:kunchenguid/meter-scan.git");
    expect(renderLocated("ghost", locateProject("ghost", { home, managed: [] }))).toContain(
      'No project matching "ghost" found on disk',
    );
  });
});
