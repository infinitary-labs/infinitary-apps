import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { workingCopyFacts } from "./gitFacts";
import { captureFile, checkFile } from "./sources";

/**
 * Evidence from a real working copy, with the app's own git: the commit a
 * cited file was kept at, whether it differed from it, and a later look at
 * the same path. Spawns git, so it is an integration test; each case
 * measured under 0.1 s, inside vitest's 5 s default (docs/test-cohorts.md).
 */

function repo(): string {
  const dir = scratchDir("fm-knowledge-sources-");
  const run = (...args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@localhost", ...args]);
  run("init", "--initial-branch=main");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "inbox.ts"), "line one\nline two\nline three\n");
  run("add", ".");
  run("commit", "-m", "init");
  return dir;
}

describe("evidence from a working copy", () => {
  it("keeps a clean file's lines with its commit, and sees the file change later", async () => {
    const dir = repo();
    const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"]).toString().trim();
    const kept = await captureFile({
      root: dir,
      project: "repo-1",
      path: "src/inbox.ts",
      startLine: 2,
      endLine: 3,
      gitFacts: workingCopyFacts,
    });
    if ("refused" in kept) throw new Error(kept.refused);
    expect(kept.text).toBe("line two\nline three");
    expect(kept.origin).toMatchObject({ path: "src/inbox.ts", commit: head, dirty: false });
    expect(checkFile(kept.origin, dir).state).toBe("unchanged");

    writeFileSync(join(dir, "src", "inbox.ts"), "line one\nline 2\nline three\n");
    expect(checkFile(kept.origin, dir).state).toBe("changed");
    const dirty = await captureFile({
      root: dir,
      project: "repo-1",
      path: "src/inbox.ts",
      gitFacts: workingCopyFacts,
    });
    if ("refused" in dirty) throw new Error(dirty.refused);
    expect(dirty.origin).toMatchObject({ commit: head, dirty: true, startLine: 1, endLine: 3 });
    expect(checkFile(kept.origin, undefined).state).toBe("unknown");
  });

  it("refuses a link out of the working copy, and calls a folder that is not a repository uncommitted", async () => {
    const dir = repo();
    const outside = scratchDir("fm-knowledge-outside-");
    writeFileSync(join(outside, "secret.txt"), "outside\n");
    symlinkSync(join(outside, "secret.txt"), join(dir, "link.txt"));
    symlinkSync(outside, join(dir, "linked"));
    for (const path of ["link.txt", "linked/secret.txt"]) {
      const refused = await captureFile({
        root: dir,
        project: "p",
        path,
        gitFacts: workingCopyFacts,
      });
      expect(refused, path).toMatchObject({ refused: expect.stringContaining("link") });
    }
    const plain = scratchDir("fm-knowledge-plain-");
    writeFileSync(join(plain, "notes.md"), "hello\n");
    const kept = await captureFile({
      root: plain,
      project: "p",
      path: "notes.md",
      gitFacts: workingCopyFacts,
    });
    expect(kept).toMatchObject({ origin: { commit: null, dirty: true } });
  });
});
