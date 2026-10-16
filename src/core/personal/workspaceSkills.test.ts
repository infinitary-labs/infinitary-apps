import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  AUTHORING_SKILL_IDS,
  DESIGN_SKILL_ID,
  managedSkillIds,
  RETIRED_SKILL_IDS,
  seedWorkspaceSkills,
  WORKSPACE_SKILLS_DIR,
} from "./workspaceSkills";

/**
 * The seeder runs against the REAL repository tree (the checkout is the
 * dev self-source), so these tests fail if a skill is renamed, moved or
 * deleted - which is exactly what would silently leave the personalizing
 * crewmate without its rules.
 */

const REPO_ROOT = join(__dirname, "../../..");
const made: string[] = [];

function workspace(): string {
  const dir = scratchDir("infinitary-personal-");
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function skillPath(root: string, id: string, ...rest: string[]): string {
  return join(root, WORKSPACE_SKILLS_DIR, id, ...rest);
}

describe("seeding the workspace skills", () => {
  it("copies the app's own design skill and every authoring skill", async () => {
    const dir = workspace();
    const result = await seedWorkspaceSkills({ sourceDir: REPO_ROOT, workspaceDir: dir });

    expect(result.missing).toEqual([]);
    expect(result.healed).toEqual(managedSkillIds().map((id) => join(WORKSPACE_SKILLS_DIR, id)));
    for (const id of AUTHORING_SKILL_IDS) {
      expect(readFileSync(skillPath(dir, id, "SKILL.md"), "utf8")).toContain(`name: ${id}`);
    }
    // The design skill arrives whole: its rules, its tokens, its components.
    expect(readFileSync(skillPath(dir, DESIGN_SKILL_ID, "readme.md"), "utf8")).toContain(
      "Infinitary — Design System",
    );
    expect(readdirSync(skillPath(dir, DESIGN_SKILL_ID, "tokens")).sort()).toContain("colors.css");
  });

  it("is idempotent: a second seed changes nothing", async () => {
    const dir = workspace();
    await seedWorkspaceSkills({ sourceDir: REPO_ROOT, workspaceDir: dir });
    expect((await seedWorkspaceSkills({ sourceDir: REPO_ROOT, workspaceDir: dir })).healed).toEqual(
      [],
    );
  });

  it("heals an edited, a deleted and an added app-owned file", async () => {
    const dir = workspace();
    await seedWorkspaceSkills({ sourceDir: REPO_ROOT, workspaceDir: dir });

    writeFileSync(skillPath(dir, "personal-panel", "SKILL.md"), "emoji are fine now\n");
    rmSync(skillPath(dir, "quota", "SKILL.md"));
    writeFileSync(skillPath(dir, "github-prs", "NOTES.md"), "scratch\n");

    const result = await seedWorkspaceSkills({ sourceDir: REPO_ROOT, workspaceDir: dir });
    expect(result.healed.sort()).toEqual(
      ["github-prs", "personal-panel", "quota"].map((id) => join(WORKSPACE_SKILLS_DIR, id)),
    );
    expect(readFileSync(skillPath(dir, "personal-panel", "SKILL.md"), "utf8")).toContain(
      "No emoji",
    );
    expect(readFileSync(skillPath(dir, "quota", "SKILL.md"), "utf8")).toContain(
      "Unknown is never zero",
    );
    expect(readdirSync(skillPath(dir, "github-prs"))).toEqual(["SKILL.md"]);
  });

  // The Infinitary rename (step 9) moved the design skill's folder: a
  // workspace seeded before it keeps one design skill, the new one.
  it("takes away the design skill's copy under its name before the rename", async () => {
    const dir = workspace();
    const [retired] = RETIRED_SKILL_IDS;
    mkdirSync(skillPath(dir, retired, "tokens"), { recursive: true });
    writeFileSync(skillPath(dir, retired, "readme.md"), "Firstmate 3000 — Design System\n");

    const result = await seedWorkspaceSkills({ sourceDir: REPO_ROOT, workspaceDir: dir });
    expect(result.healed).toContain(join(WORKSPACE_SKILLS_DIR, retired));
    expect(readdirSync(join(dir, WORKSPACE_SKILLS_DIR)).sort()).toEqual(managedSkillIds().sort());
  });

  it("never touches what the workspace owns", async () => {
    const dir = workspace();
    await seedWorkspaceSkills({ sourceDir: REPO_ROOT, workspaceDir: dir });

    const captain = join(dir, WORKSPACE_SKILLS_DIR, "captain");
    mkdirSync(captain, { recursive: true });
    writeFileSync(join(captain, "SKILL.md"), "Always use compact rows.\n");
    mkdirSync(join(dir, "open-prs"), { recursive: true });
    writeFileSync(join(dir, "open-prs", "panel.tsx"), "export default function Panel() {}\n");

    await seedWorkspaceSkills({ sourceDir: REPO_ROOT, workspaceDir: dir });
    expect(readFileSync(join(captain, "SKILL.md"), "utf8")).toContain("compact rows");
    expect(readFileSync(join(dir, "open-prs", "panel.tsx"), "utf8")).toContain("Panel");
  });

  it("reports a missing source instead of writing an empty skill", async () => {
    const dir = workspace();
    const emptySource = workspace();
    const result = await seedWorkspaceSkills({ sourceDir: emptySource, workspaceDir: dir });
    expect(result.missing).toEqual(managedSkillIds());
    expect(result.healed).toEqual([]);
  });
});
