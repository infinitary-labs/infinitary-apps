import { chmodSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { git } from "../workspace/git";
import {
  packagedPlanStepLines,
  planStepAttached,
  SEQUENCES_MAX_BYTES,
  SEQUENCES_SEED,
  SEQUENCES_SKILL_HEADER,
  SEQUENCES_SKILL_RELATIVE_PATH,
  SequencesSource,
  sequencesSha,
} from "./sequencesSkill";
import { seedPersonalWorkspace } from "./workspace";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

const fresh = () => join(scratchDir("infinitary-sequences-"), "personal");

describe("packaged plan steps", () => {
  it("recognizes only a packaged plan line, whitespace-normalized", () => {
    const lines = packagedPlanStepLines();
    expect(lines.some((line) => line.startsWith("plan: a read-only step."))).toBe(true);
    // The one packaged plan line carries the whole plan instruction, split rule included.
    expect(
      lines.filter((line) => line.includes("record whether the build is one change")),
    ).toHaveLength(1);
    const line = lines[0];
    expect(line).toBeDefined();
    expect(planStepAttached([{ kind: "free", text: line ?? "" }])).toBe(true);
    expect(
      planStepAttached([{ kind: "free", text: "plan: a read-only step. Research the code" }]),
    ).toBe(false);
    expect(planStepAttached([{ kind: "read-only" }])).toBe(false);
  });

  it("recognizes the whole ideation plan paragraph, relayed on one line as the Firstmate does", () => {
    // The bullet as written: its first line and every indented line under it.
    const from = SEQUENCES_SEED.indexOf("- plan: a read-only step.") + "- ".length;
    const written = SEQUENCES_SEED.slice(from, SEQUENCES_SEED.indexOf("\n- ", from));
    expect(written.split("\n").length).toBeGreaterThan(1);
    const relayed = written.replace(/\s+/g, " ").trim();
    expect(planStepAttached([{ kind: "read-only" }, { kind: "free", text: relayed }])).toBe(true);
    expect(planStepAttached([{ kind: "free", text: written }])).toBe(true);
    expect(planStepAttached([{ kind: "free", text: written.split("\n")[0] ?? "" }])).toBe(false);
  });
});

describe("the sequences skill in the personal workspace (docs/sequences.md)", () => {
  it("is seeded once into a fresh workspace, in its seed commit", async () => {
    const dir = fresh();
    await seedPersonalWorkspace({ dir });
    const path = join(dir, SEQUENCES_SKILL_RELATIVE_PATH);
    const served = readFileSync(path, "utf8");
    expect(served).toBe(`${SEQUENCES_SKILL_HEADER}${SEQUENCES_SEED}`);
    expect(served).toContain("one place the change touches, no rule, state transition");
    expect(served).toContain("shape.skipped_plan_because");
    expect(served).not.toContain("clear and small");
    expect(await git(dir, ["log", "--format=%s", "--", SEQUENCES_SKILL_RELATIVE_PATH])).toBe(
      "chore: seed the personal workspace",
    );
    expect(await git(dir, ["status", "--porcelain"])).toBe("");
  });

  it("overwrites local edits on refresh and commits the app-managed guide", async () => {
    const dir = fresh();
    await seedPersonalWorkspace({ dir });
    const path = join(dir, SEQUENCES_SKILL_RELATIVE_PATH);
    const mine = `${SEQUENCES_SKILL_HEADER}# Sequences\n\nAlways reproduce first, even for features.\n`;
    writeFileSync(path, mine);
    await git(dir, ["add", "--", SEQUENCES_SKILL_RELATIVE_PATH]);
    await git(dir, [
      "-c",
      "user.name=Previous Firstmate",
      "-c",
      "user.email=previous@localhost",
      "commit",
      "-m",
      "Previous app guide",
    ]);
    // The next refresh restores the packaged content and records the app's update.
    const source = new SequencesSource(dir);
    expect(source.current().text).toContain("Always reproduce first");
    const logs: string[] = [];
    const result = await seedPersonalWorkspace({ dir, log: (message) => logs.push(message) });
    expect(result.healed).toContain(SEQUENCES_SKILL_RELATIVE_PATH);
    expect(readFileSync(path, "utf8")).toBe(`${SEQUENCES_SKILL_HEADER}${SEQUENCES_SEED}`);
    expect(source.current().text).toBe(SEQUENCES_SEED.trim());
    expect(logs).not.toEqual(expect.arrayContaining([expect.stringContaining("could not commit")]));
    expect((await git(dir, ["log", "--format=%s"])).split("\n")[0]).toBe(
      "chore: refresh managed files",
    );
    expect(await git(dir, ["status", "--porcelain"])).toBe("");

    // A deleted file is likewise restored from the packaged seed.
    rmSync(path);
    await seedPersonalWorkspace({ dir });
    expect(readFileSync(path, "utf8")).toBe(`${SEQUENCES_SKILL_HEADER}${SEQUENCES_SEED}`);
  });
});

describe("SequencesSource: what the Firstmate is served", () => {
  const seed = SEQUENCES_SEED.trim();

  it("serves the file's body without its front matter, re-reading only when it changed", async () => {
    const dir = fresh();
    await seedPersonalWorkspace({ dir });
    const path = join(dir, SEQUENCES_SKILL_RELATIVE_PATH);
    const source = new SequencesSource(dir);
    expect(source.current()).toEqual({ text: seed, sha: sequencesSha(seed) });

    writeFileSync(path, `${SEQUENCES_SKILL_HEADER}# Sequences\n\nJust do it, always.\n`);
    utimesSync(path, new Date(), new Date(Date.now() + 5_000));
    expect(source.current()).toEqual({
      text: "# Sequences\n\nJust do it, always.",
      sha: sequencesSha("# Sequences\n\nJust do it, always."),
    });
  });

  it("serves the built-in text quietly when there is no file, and says why when the file is unusable", async () => {
    expect(new SequencesSource(undefined).current()).toEqual({
      text: seed,
      sha: sequencesSha(seed),
    });
    const dir = fresh();
    expect(new SequencesSource(dir).current()).toEqual({ text: seed, sha: sequencesSha(seed) });

    await seedPersonalWorkspace({ dir });
    const path = join(dir, SEQUENCES_SKILL_RELATIVE_PATH);
    const source = new SequencesSource(dir);
    const bump = (seconds: number) =>
      utimesSync(path, new Date(), new Date(Date.now() + seconds * 1_000));

    writeFileSync(path, SEQUENCES_SKILL_HEADER);
    bump(10);
    expect(source.current()).toEqual({ text: seed, sha: sequencesSha(seed), fallback: "empty" });

    writeFileSync(path, `${SEQUENCES_SKILL_HEADER}${"x".repeat(SEQUENCES_MAX_BYTES)}`);
    bump(20);
    expect(source.current()).toEqual({
      text: seed,
      sha: sequencesSha(seed),
      fallback: "oversized",
    });

    if (process.getuid?.() !== 0) {
      writeFileSync(path, `${SEQUENCES_SKILL_HEADER}# Sequences\n\nMine.\n`);
      chmodSync(path, 0o000);
      bump(30);
      expect(source.current()).toEqual({
        text: seed,
        sha: sequencesSha(seed),
        fallback: "unreadable",
      });
      chmodSync(path, 0o644);
    }
  });
});
