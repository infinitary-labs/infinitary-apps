import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { RELEASE_UPLOAD_MAX_BYTES, releaseFileIn, releaseUploadSizeRefusal } from "./releaseFile";

describe("a release file in the working copy (INF-205)", () => {
  it("names a regular file and refuses a link, a directory and a path outside it", () => {
    const dir = scratchDir("fm-release-file-");
    writeFileSync(join(dir, "app.dmg"), "bytes");
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "notes.txt"), "hi");
    symlinkSync(join(dir, "app.dmg"), join(dir, "linked.dmg"));
    symlinkSync(dir, join(dir, "loop"));

    expect(releaseFileIn(dir, "app.dmg")).toMatchObject({
      rel: "app.dmg",
      size: 5,
      contentType: "application/x-apple-diskimage",
      filename: "app.dmg",
    });
    expect(releaseFileIn(dir, "nested/notes.txt")).toMatchObject({
      rel: "nested/notes.txt",
      contentType: "text/plain",
    });
    expect(releaseFileIn(dir, "linked.dmg")).toEqual({
      refusal: "linked.dmg is a link. Name the file itself, never a link.",
    });
    expect(releaseFileIn(dir, "loop/app.dmg")).toEqual({
      refusal: "loop/app.dmg is a link. Name the file itself, never a link.",
    });
    expect(releaseFileIn(dir, "nested")).toEqual({ refusal: "nested is not a file." });
    expect(releaseFileIn(dir, "../outside")).toEqual({
      refusal: "Give a regular file inside your working copy, relative to it, never a link.",
    });
    expect(releaseFileIn(undefined, "app.dmg")).toEqual({
      refusal: "This task has no working copy on this computer, so the file was not sent.",
    });
  });

  it("refuses a file over the 2 GB cap without reading one that large", () => {
    expect(releaseUploadSizeRefusal(RELEASE_UPLOAD_MAX_BYTES)).toBeUndefined();
    expect(releaseUploadSizeRefusal(RELEASE_UPLOAD_MAX_BYTES + 1)).toContain("2 GB");
  });
});
