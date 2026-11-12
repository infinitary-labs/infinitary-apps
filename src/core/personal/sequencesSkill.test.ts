import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { Runbooks } from "../runbooks/runbooks";
import { openInMemoryDatabase } from "../storage/db";
import { SettingsStore } from "../storage/settingsStore";
import { git } from "../workspace/git";
import {
  packagedPlanStepLines,
  planStepAttached,
  SEQUENCES_MAX_BYTES,
  SEQUENCES_SEED,
  SEQUENCES_SKILL_HEADER,
  SEQUENCES_SKILL_RELATIVE_PATH,
  SequencesSource,
  seedSequencesSkill,
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

// INF-1177 intentionally moves the boot-owned guide to a switchable runbook.
// Preserve seed/refresh/git assertions at that owner, and prove the old skill cannot leak back in.
describe("Common workflows replaces the workspace's second guide", () => {
  const books = () =>
    new Runbooks(
      join(process.cwd(), "resources/runbooks"),
      new SettingsStore(openInMemoryDatabase()),
    );
  it("seeds the workspace once while serving guidance from the runbook, not a second skill", async () => {
    const dir = fresh();
    const namingRule = () => books().naming();
    await seedPersonalWorkspace({ dir, skillsSourceDir: process.cwd(), namingRule });
    expect(existsSync(join(dir, SEQUENCES_SKILL_RELATIVE_PATH))).toBe(false);
    const served = books().firstmate().text;
    expect(served).toContain("one place the change touches, no rule, state transition");
    expect(served).toContain("shape.skipped_plan_because");
    expect(served).not.toContain("clear and small");
    expect(await git(dir, ["log", "--format=%s"])).toBe("chore: seed the personal workspace");
    expect(await git(dir, ["status", "--porcelain"])).toBe("");
  });
  it("retires an earlier app-managed guide on refresh without overwriting the runbook or personal records", async () => {
    const dir = fresh();
    await seedPersonalWorkspace({ dir, skillsSourceDir: process.cwd() });
    const path = join(dir, SEQUENCES_SKILL_RELATIVE_PATH);
    mkdirSync(join(dir, ".claude/skills/sequences"), { recursive: true });
    writeFileSync(
      path,
      `${SEQUENCES_SKILL_HEADER}# Sequences\n\nAlways reproduce first, even for features.\n`,
    );
    writeFileSync(join(dir, "notes.md"), "My project notes.\n");
    await git(dir, ["add", "--", SEQUENCES_SKILL_RELATIVE_PATH, "notes.md"]);
    await git(dir, [
      "-c",
      "user.name=Previous Firstmate",
      "-c",
      "user.email=previous@localhost",
      "commit",
      "-m",
      "Previous app guide",
    ]);
    const before = books().firstmate();
    const logs: string[] = [];
    const result = await seedPersonalWorkspace({
      dir,
      skillsSourceDir: process.cwd(),
      namingRule: () => books().naming(),
      log: (message) => logs.push(message),
    });
    expect(result.healed).toContain(join(".claude", "skills", "sequences"));
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("My project notes.\n");
    expect(books().firstmate()).toEqual(before);
    expect(logs).not.toEqual(expect.arrayContaining([expect.stringContaining("could not commit")]));
    expect((await git(dir, ["log", "--format=%s"])).split("\n")[0]).toBe(
      "chore: refresh managed files",
    );
    expect(await git(dir, ["status", "--porcelain"])).toBe("");
    await seedPersonalWorkspace({ dir, skillsSourceDir: process.cwd() });
    expect(existsSync(path)).toBe(false);
    expect(books().firstmate()).toEqual(before);
  });
});

describe("SequencesSource: the standalone legacy reader", () => {
  const seed = SEQUENCES_SEED.trim();

  it("serves the file's body without its front matter, re-reading only when it changed", async () => {
    const dir = fresh();
    await seedPersonalWorkspace({ dir });
    await seedSequencesSkill(dir);
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
    await seedSequencesSkill(dir);
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
