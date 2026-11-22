import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type AUTHORING_SKILL_IDS, WORKSPACE_SKILLS_DIR } from "./workspaceSkills";

/**
 * Reading an authoring skill's text, from wherever it is: the source tree
 * (the app's copy) or a seeded workspace (the crewmate's). It exists so the
 * ONE-HOME rule can be tested: the authoring rules live in the skills, and no
 * persona prompt restates a sentence of them - the same structural pin the
 * card contract has (`piResources.test.ts`), for the same reason. A rule
 * repeated in a prompt drifts from the rule in the file, and then the app and
 * its own agents disagree about what a panel should look like.
 */

const AUTHORING_SKILLS_SOURCE = join("resources", "personal-workspace", "skills");

export type AuthoringSkillId = (typeof AUTHORING_SKILL_IDS)[number];

export function readAuthoringSkill(selfSourceDir: string, id: AuthoringSkillId): string {
  return readFileSync(join(selfSourceDir, AUTHORING_SKILLS_SOURCE, id, "SKILL.md"), "utf8");
}

export function readWorkspaceSkill(workspaceDir: string, id: AuthoringSkillId): string {
  return readFileSync(join(workspaceDir, WORKSPACE_SKILLS_DIR, id, "SKILL.md"), "utf8");
}

/**
 * The prose sentences worth pinning: long enough to be a rule rather than a
 * fragment, with the frontmatter, fenced code and tables left out - those are
 * examples and data, not text a prompt could restate.
 */
export function skillSentences(markdown: string): string[] {
  const body = markdown
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/```[\s\S]*?```/g, " ")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("|"))
    .join("\n");
  return body
    .split(/(?<=[.;:])\s+/)
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter((sentence) => sentence.length >= 60);
}
