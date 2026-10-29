import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clientFrameSchema, homeFrameSchema } from "@shared/connection";
import { PROTOCOL_VERSION, VIEW_FLOOR } from "@shared/ipc";
import { describe, expect, it } from "vitest";
import {
  CONTRACT_CHANGES,
  contractChange,
  contractChangeFiles,
  contractChangesDir,
  listsChange,
  protocolVersionOf,
  readContractChanges,
  viewFloorAgrees,
  viewsDeclaration,
} from "./contractChanges";

/**
 * One named file per contract change, and a version that moves only on a
 * break (INF-519, the captain's choices: features wait by name, the minor
 * stays as it is until the next major, and a major types its number once,
 * in its file name). Read from the real folder, and from its file list with
 * one change added or a major replaced, as a pull request would.
 */
describe("the contract's changes by name", () => {
  it("names one major in this build's folder, and the version is the one it allows", () => {
    expect(
      PROTOCOL_VERSION,
      "Only a major moves PROTOCOL_VERSION; a minor change adds a file (src/shared/contract-changes/README.md).",
    ).toBe(protocolVersionOf(CONTRACT_CHANGES));
    // Each name its hello and its welcome list reaches the other side whole.
    const hello = clientFrameSchema.parse({
      t: "hello",
      protocolVersion: PROTOCOL_VERSION,
      changes: CONTRACT_CHANGES.names,
    });
    expect(hello).toMatchObject({ changes: CONTRACT_CHANGES.names });
    const welcome = homeFrameSchema.parse({
      t: "welcome",
      protocolVersion: PROTOCOL_VERSION,
      epoch: "e",
      seq: 0,
      catchUp: "reload",
      access: "full",
      changes: CONTRACT_CHANGES.names,
    });
    expect(welcome).toMatchObject({ changes: CONTRACT_CHANGES.names });
  });

  it("adds a minor change's name and moves no version", () => {
    const files = contractChangeFiles();
    const added = readContractChanges([...files, "plan-label-limits.md"]);
    expect(added.names).toEqual([...CONTRACT_CHANGES.names, "plan-label-limits"]);
    expect(protocolVersionOf(added)).toBe(PROTOCOL_VERSION);
  });

  it("makes the next major's file the version's major, at its first minor", () => {
    // A major removes the major file before it and every minor file.
    const next = readContractChanges([`major-${CONTRACT_CHANGES.major + 1}.md`]);
    expect(next).toEqual({ major: CONTRACT_CHANGES.major + 1, names: [] });
    expect(protocolVersionOf(next)).toBe(`${CONTRACT_CHANGES.major + 1}.0.0`);
  });

  it("refuses a folder with no major file, two at once, or a file not named for a change", () => {
    const files = contractChangeFiles();
    const minors = files.filter((file) => !file.startsWith("major-"));
    expect(() => readContractChanges(minors)).toThrow("no major file");
    // Two majors merged at once, each with its own number.
    expect(() => readContractChanges([...files, `major-${CONTRACT_CHANGES.major + 1}.md`])).toThrow(
      "2 major files",
    );
    expect(() => readContractChanges([...files, "10-2.md"])).toThrow("10-2.md");
    expect(() => readContractChanges([...files, "Story_Around.md"])).toThrow("Story_Around.md");
  });

  it("refuses a wait for a change no file has", () => {
    // A folder at the next minor change, as a pull request would leave it.
    const folder = readContractChanges([
      `major-${CONTRACT_CHANGES.major}.md`,
      "plan-label-limits.md",
    ]);
    expect(contractChange("plan-label-limits", folder)).toBe("plan-label-limits");
    expect(() => contractChange("story-around", folder)).toThrow(
      "No contract change is named story-around",
    );
    for (const name of CONTRACT_CHANGES.names) expect(contractChange(name)).toBe(name);
  });

  it("gives a side that listed nothing no change", () => {
    const folder = readContractChanges([
      `major-${CONTRACT_CHANGES.major}.md`,
      "plan-label-limits.md",
      "story-around.md",
    ]);
    const limits = contractChange("plan-label-limits", folder);
    expect(listsChange(["plan-label-limits", "story-around"], limits)).toBe(true);
    expect(listsChange(["story-around"], limits)).toBe(false);
    expect(listsChange([], limits)).toBe(false);
    expect(listsChange(undefined, limits)).toBe(false);
    expect(listsChange(null, limits)).toBe(false);
  });

  // INF-1649 (the captain's direction A): a floor for every view, moved only by a major that breaks views.
  it("holds the view floor to what the current major's file says it did to views", () => {
    const text = readFileSync(
      join(contractChangesDir(), `major-${CONTRACT_CHANGES.major}.md`),
      "utf8",
    );
    const views = viewsDeclaration(text);
    expect(
      viewFloorAgrees(CONTRACT_CHANGES.major, views, VIEW_FLOOR),
      `major-${CONTRACT_CHANGES.major}.md says "Views: ${views}.", so VIEW_FLOOR (src/shared/ipc.ts) is ${views === "break" ? "that major" : "below it"}`,
    ).toBe(true);
  });

  it("refuses a major's file that does not say once whether views break", () => {
    expect(viewsDeclaration("# Major 13\n\nA field went.\nViews: break.\n")).toBe("break");
    expect(() => viewsDeclaration("# Major 13\n\nA field went.\n")).toThrow("Views: keep.");
    expect(() => viewsDeclaration("Views: keep.\nViews: break.\n")).toThrow("Views: keep.");
    // A major that breaks views is the floor; one that keeps them leaves it below.
    expect(viewFloorAgrees(13, "break", 13)).toBe(true);
    expect(viewFloorAgrees(13, "break", 11)).toBe(false);
    expect(viewFloorAgrees(13, "keep", 11)).toBe(true);
    expect(viewFloorAgrees(13, "keep", 13)).toBe(false);
  });
});
