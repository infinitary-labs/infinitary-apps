import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { KnowledgeService } from "../knowledge/knowledgeService";
import { APP_GIT_IDENTITY, git } from "../workspace/git";
import { carryPanelInstructions, OLD_PANEL_INSTRUCTIONS_PATH } from "./panelInstructions";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/**
 * INF-1054, option A ("One store, one way in: panel instructions are
 * ordinary directions"), from INF-1051's checks: existing instructions
 * survive, a repeat carry adds nothing, and no second store remains.
 */

const PERSONAL = { id: "p3rs0nal", name: "personal", path: "/personal" };
const CREWMATE = { kind: "crewmate", taskId: "t-panel", repoId: PERSONAL.id } as const;

/** The captain skill exactly as the older build's `personalize instruction` wrote it, then one hand edit. */
const OLD_FILE = `---
name: captain
description: Standing instructions from the captain for every panel built in this workspace. Follow them before any other preference.
---

# Captain's standing instructions

Each line below is something the captain asked for once and wants every time.
Apply them to every panel you build or revise here; when one conflicts with a
skill's default, the captain's line wins.

- Always use compact rows in my panels.
- Prefer mono for numbers.

Weather panels show Celsius first.
`;

function knowledgeAt(dir?: string) {
  return new KnowledgeService({
    ...(dir ? { dir } : {}),
    projects: { get: (id) => (id === PERSONAL.id ? PERSONAL : undefined), list: () => [PERSONAL] },
  });
}

async function workspaceWithOldFile(): Promise<string> {
  const dir = scratchDir("infinitary-panel-instructions-");
  await git(dir, ["init", "-q"]);
  writeOld(dir);
  await git(dir, ["add", "--", OLD_PANEL_INSTRUCTIONS_PATH]);
  await git(dir, [...APP_GIT_IDENTITY, "commit", "-q", "-m", "chore: add captain instruction"]);
  return dir;
}

function writeOld(dir: string): void {
  const path = join(dir, OLD_PANEL_INSTRUCTIONS_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, OLD_FILE);
}

const texts = (knowledge: KnowledgeService) =>
  knowledge.directions
    .standing(CREWMATE)
    .map((row) => row.text)
    .sort();

describe("carryPanelInstructions", () => {
  it("carries each line word for word, the other words as one, and removes the file in one commit", async () => {
    const dir = await workspaceWithOldFile();
    const knowledge = knowledgeAt();
    const carried = await carryPanelInstructions({
      workspaceDir: dir,
      scope: PERSONAL.id,
      knowledge,
    });
    expect(carried).toEqual({ state: "carried", added: 3, kept: 0, committed: true });
    expect(texts(knowledge)).toEqual([
      "Always use compact rows in my panels.",
      "Prefer mono for numbers.",
      "Weather panels show Celsius first.",
    ]);
    // The captain's own words, so the captain's authority, in the personal workspace's scope.
    const rows = knowledge.directions.standing(CREWMATE);
    expect(rows.every((row) => row.authority === "instruction" && row.scope === PERSONAL.id)).toBe(
      true,
    );
    expect(existsSync(join(dir, OLD_PANEL_INSTRUCTIONS_PATH))).toBe(false);
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
    expect((await git(dir, ["rev-list", "--count", "HEAD"])).trim()).toBe("2");
  });

  it("adds nothing on a second start or after a quit before the file left, retired ones included", async () => {
    const dir = await workspaceWithOldFile();
    const knowledge = knowledgeAt();
    await carryPanelInstructions({ workspaceDir: dir, scope: PERSONAL.id, knowledge });
    expect(
      await carryPanelInstructions({ workspaceDir: dir, scope: PERSONAL.id, knowledge }),
    ).toEqual({ state: "absent" });
    const compact = knowledge.directions
      .standing(CREWMATE)
      .find((row) => row.text.startsWith("Always"));
    knowledge.directions.change({
      op: "retire",
      id: compact?.id ?? "",
      reason: "The captain retired it.",
    });
    // The file is back, as if the app quit between the carry and the removal.
    writeOld(dir);
    expect(
      await carryPanelInstructions({ workspaceDir: dir, scope: PERSONAL.id, knowledge }),
    ).toMatchObject({ state: "carried", added: 0, kept: 3 });
    expect(texts(knowledge)).toEqual([
      "Prefer mono for numbers.",
      "Weather panels show Celsius first.",
    ]);
    expect(existsSync(join(dir, OLD_PANEL_INSTRUCTIONS_PATH))).toBe(false);
  });

  it("leaves the file untouched when Knowledge cannot be read", async () => {
    const dir = await workspaceWithOldFile();
    // A collection whose folder is a file cannot be opened.
    const blocked = join(scratchDir("infinitary-panel-knowledge-"), "knowledge");
    writeFileSync(blocked, "not a folder");
    const carried = await carryPanelInstructions({
      workspaceDir: dir,
      scope: PERSONAL.id,
      knowledge: knowledgeAt(blocked),
    });
    expect(carried.state).toBe("left");
    expect(existsSync(join(dir, OLD_PANEL_INSTRUCTIONS_PATH))).toBe(true);
    expect((await git(dir, ["rev-list", "--count", "HEAD"])).trim()).toBe("1");
  });
});
