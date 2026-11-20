import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { folderLinkType } from "../platform";
import { stageRunbookSkills } from "../runbooks/runbooks";
import {
  PERSONAL_RESOURCE_RULES,
  type PersonalResourceDigests,
  personalInstructionsText,
  personalResources,
} from "../session/personalResources";
import {
  type ProjectInstructions,
  projectInstructions,
  projectSkillFolders,
} from "../session/projectResources";
import type { SessionSpec } from "../session/session";

/**
 * A Claude crewmate's share of its working copy's own instructions and
 * skills (FI3-789, `projectResources.ts`). The client loads a project's
 * CLAUDE.md, AGENTS.md and `.claude/skills` only through its project
 * settings source, and that source also brings the project's
 * `.claude/settings.json` - its hooks, permission rules, environment,
 * credential helpers and output style - and every instruction file in the
 * folders above the working copy, the person's own Claude folder among them
 * when the working copy sits under their home. So a coding session keeps
 * every settings source off (`settingSources: []`) and is handed the two
 * parts itself: the instruction file as a section of its prompt, framed the
 * way Pi frames its own, and the skills as a local plugin the client lists
 * natively and loads with its Skill tool, under `project:<skill>`.
 */

/** The plugin name the client lists a working copy's skills under. */
export const CLAUDE_PROJECT_PLUGIN = "project";

/** What a coding session is handed of its working copy at an attach. */
export type ClaudeProjectResources = {
  instructions?: ProjectInstructions;
  personalInstructions?: string;
  personalSkillsPlugin?: string;
  runbookSkillsPlugin?: string;
  /** The staged plugin's folder, when the working copy has a skill. */
  skillsPlugin?: string;
};

/** The working copy's instruction file as the crewmate's prompt carries it. */
export function claudeProjectInstructionsText(instructions: ProjectInstructions): string {
  return [
    "Project-specific instructions and guidelines:",
    `<project_instructions path="${instructions.path}">\n${instructions.content}\n</project_instructions>`,
  ].join("\n\n");
}

/**
 * Stage the working copy's skills as a local plugin in `dir`, a folder the
 * app owns outside the working copy: a manifest and one link per skill
 * folder, and nothing else, so no hook, agent or command comes with them.
 * Rebuilt from nothing at each attach, so the client lists the skills the
 * working copy has now. Undefined when it has none.
 */
export async function stageClaudeProjectSkills(
  cwd: string,
  dir: string,
): Promise<string | undefined> {
  return stageClaudeSkills(projectSkillFolders(cwd), dir, CLAUDE_PROJECT_PLUGIN);
}

/** Stage explicit skill folders only; never copy configuration or load hooks. */
export async function stageClaudeSkills(
  skills: { name: string; dir: string }[],
  dir: string,
  name: string,
): Promise<string | undefined> {
  // The links are removed, never followed: the skills stay where they are.
  await rm(dir, { recursive: true, force: true });
  if (skills.length === 0) return undefined;
  await mkdir(join(dir, ".claude-plugin"), { recursive: true });
  await mkdir(join(dir, "skills"));
  await writeFile(
    join(dir, ".claude-plugin", "plugin.json"),
    JSON.stringify({
      name,
      description: "Explicitly supplied skills for this crewmate.",
    }),
  );
  // A junction on Windows, which a standard account may make (`folderLinkType`).
  await Promise.all(
    skills.map((skill) => symlink(skill.dir, join(dir, "skills", skill.name), folderLinkType())),
  );
  return dir;
}

/** Where a coding session stages its working copy's skills, inside its staging folder. */
export const CLAUDE_PROJECT_SKILLS_DIR = "project-skills";

/**
 * A coding session's working copy as one attach hands it to the client: its
 * instruction file, read now, and its skills, staged in the session's own
 * folder `staged` beside its record (INF-2054); with the personal opt-in, the
 * person's instructions and skills too, whose digests the served stamp keeps;
 * and the runbook skills no other skill already names. A stage that fails
 * costs those skills, never the attach.
 */
export async function claudeProjectResources(
  spec: Pick<SessionSpec, "cwd" | "personalResources" | "runbookSkills">,
  home: string | undefined,
  staged: string,
  note: (line: string) => void,
): Promise<{ project: ClaudeProjectResources; personalDigests?: PersonalResourceDigests }> {
  let project: ClaudeProjectResources;
  try {
    const instructions = projectInstructions(spec.cwd);
    const skillsPlugin = await stageClaudeProjectSkills(
      spec.cwd,
      join(staged, CLAUDE_PROJECT_SKILLS_DIR),
    );
    project = {
      ...(instructions ? { instructions } : {}),
      ...(skillsPlugin ? { skillsPlugin } : {}),
    };
  } catch (error) {
    note(`the working copy's skills were not staged: ${String(error)}`);
    const instructions = projectInstructions(spec.cwd);
    project = instructions ? { instructions } : {};
  }
  const names = new Set(projectSkillFolders(spec.cwd).map((skill) => skill.name));
  const personal = spec.personalResources ? personalResources(home, names) : undefined;
  if (personal) {
    project.personalInstructions = personal.instructions
      ? personalInstructionsText(personal.instructions)
      : PERSONAL_RESOURCE_RULES;
    try {
      project.personalSkillsPlugin = await stageClaudeSkills(
        personal.skills,
        join(staged, "personal-skills"),
        "personal",
      );
    } catch (error) {
      note(`the personal skills were not staged: ${String(error)}`);
    }
  }
  if (spec.runbookSkills) {
    const taken = new Set([...names, ...(personal?.skills ?? []).map((skill) => skill.name)]);
    try {
      const folders = await stageRunbookSkills(
        spec.runbookSkills.filter((skill) => !taken.has(skill.name)),
        join(staged, "runbook-files"),
      );
      project.runbookSkillsPlugin = await stageClaudeSkills(
        folders,
        join(staged, "runbook-skills"),
        "runbooks",
      );
    } catch (error) {
      note(`the runbook skills were not staged: ${String(error)}`);
    }
  }
  return { project, ...(personal ? { personalDigests: personal.digests } : {}) };
}
