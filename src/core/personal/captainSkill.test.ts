import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  appendCaptainInstruction,
  CAPTAIN_INSTRUCTION_MAX_CHARS,
  CAPTAIN_SKILL_HEADER,
  CAPTAIN_SKILL_RELATIVE_PATH,
  normaliseInstruction,
  readCaptainInstructions,
} from "./captainSkill";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/**
 * The captain's standing instructions (talk-to-personalize Step 1): one
 * skill file in the personal workspace, appended one line at a time and
 * committed under the app's identity, never rewritten.
 */
const dirs: string[] = [];

function workspace(git: boolean): string {
  const dir = scratchDir("infinitary-captain-skill-");
  dirs.push(dir);
  if (git) execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("appendCaptainInstruction", () => {
  it("creates the skill with its header on the first line and commits it", async () => {
    const dir = workspace(true);
    const result = await appendCaptainInstruction(dir, "always use compact rows in my panels");
    expect(result).toEqual({
      status: "appended",
      line: "Always use compact rows in my panels.",
      path: join(dir, CAPTAIN_SKILL_RELATIVE_PATH),
      committed: true,
    });
    const text = readFileSync(join(dir, CAPTAIN_SKILL_RELATIVE_PATH), "utf8");
    expect(text.startsWith(CAPTAIN_SKILL_HEADER)).toBe(true);
    expect(text.endsWith("- Always use compact rows in my panels.\n")).toBe(true);
    expect(text).toContain("name: captain");
    const log = execFileSync("git", ["-C", dir, "log", "--format=%s|%an", "-1"], {
      encoding: "utf8",
    }).trim();
    expect(log).toBe(
      "chore: add captain instruction Always use compact rows in my panels.|Infinitary",
    );
    expect(await readCaptainInstructions(dir)).toEqual(["Always use compact rows in my panels."]);
  });

  it("appends to an existing file without touching what the captain wrote, and refuses a duplicate", async () => {
    const dir = workspace(true);
    const path = join(dir, CAPTAIN_SKILL_RELATIVE_PATH);
    await appendCaptainInstruction(dir, "Prefer mono for numbers");
    // The captain edits the file by hand: the header changes, a note is added.
    const edited = readFileSync(path, "utf8").replace(
      "# Captain's standing instructions",
      "# My rules\n\nA note I wrote myself.",
    );
    writeFileSync(path, edited);
    const second = await appendCaptainInstruction(dir, "Never use emoji in a panel.");
    expect(second.status).toBe("appended");
    const text = readFileSync(path, "utf8");
    expect(text).toContain("# My rules\n\nA note I wrote myself.");
    expect(text).toContain("- Prefer mono for numbers.\n- Never use emoji in a panel.\n");
    const duplicate = await appendCaptainInstruction(dir, "  prefer mono for numbers ");
    expect(duplicate).toEqual({ status: "duplicate", line: "Prefer mono for numbers.", path });
    expect(await readCaptainInstructions(dir)).toEqual([
      "Prefer mono for numbers.",
      "Never use emoji in a panel.",
    ]);
  });

  it("writes the file even when the workspace is not a repo yet, and says it did not commit", async () => {
    const dir = workspace(false);
    const result = await appendCaptainInstruction(dir, "Keep panels short.");
    expect(result).toMatchObject({ status: "appended", committed: false });
    expect(existsSync(join(dir, CAPTAIN_SKILL_RELATIVE_PATH))).toBe(true);
  });

  it("refuses empty and overlong instructions", async () => {
    const dir = workspace(false);
    expect(await appendCaptainInstruction(dir, "   ")).toEqual({
      status: "refused",
      reason: "an instruction needs some words",
    });
    const long = "x".repeat(CAPTAIN_INSTRUCTION_MAX_CHARS + 1);
    expect((await appendCaptainInstruction(dir, long)).status).toBe("refused");
    expect(existsSync(join(dir, CAPTAIN_SKILL_RELATIVE_PATH))).toBe(false);
  });

  it("normalises to one sentence-cased line with a period", () => {
    expect(normaliseInstruction("always   use\ncompact rows")).toBe("Always use compact rows.");
    expect(normaliseInstruction("- Never shout!")).toBe("Never shout.");
    expect(normaliseInstruction("Ask first?")).toBe("Ask first?");
    expect(normaliseInstruction("")).toBe("");
  });
});
