import {
  createExtensionRuntime,
  type LoadExtensionsResult,
  loadSkillsFromDir,
  type ResourceDiagnostic,
  type ResourceLoader,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import {
  PERSONAL_RESOURCE_RULES,
  type PersonalResources,
  personalInstructionsText,
} from "../session/personalResources";
import { projectInstructions, projectSkillRoots } from "../session/projectResources";
import { buildCrewmateSystemPrompt } from "./piResources";

/**
 * Hand-built resource loader: our system prompt, no user
 * extensions, prompts or themes, and no context file or skill but a working
 * copy's own, plus explicitly opted-in personal resources; Pi never discovers other user configuration
 * (docs/architecture.md section 5).
 *
 * `appended` is the one section served after the prompt: the Firstmate's
 * captain-owned sequences (docs/sequences.md), read at each call so a
 * re-serve at an idle boundary only has to ask Pi to rebuild. Pi keeps it as
 * its own prompt section and patches the transcript only when it changed,
 * so the provider's prefix cache holds it across turns.
 *
 * `project` is the working copy a crewmate works in (FI3-789): at each
 * reload the loader hands Pi that copy's AGENTS.md (or CLAUDE.md) and the
 * skills in its `.claude/skills` and `.agents/skills`, read from its root
 * alone (`projectResources.ts`), and Pi writes its own project-instructions
 * section and skills list into the prompt.
 */
export function createCrewmateResourceLoader(
  systemPrompt: string = buildCrewmateSystemPrompt(),
  appended: () => string | undefined = () => undefined,
  project?: {
    cwd: string;
    personal?: PersonalResources;
    runbookSkills?: { name: string; dir: string }[];
  },
): ResourceLoader {
  const extensionsResult: LoadExtensionsResult = {
    extensions: [],
    errors: [],
    runtime: createExtensionRuntime(),
  };
  let agentsFiles: { path: string; content: string }[] = [];
  let skills: { skills: Skill[]; diagnostics: ResourceDiagnostic[] } = {
    skills: [],
    diagnostics: [],
  };
  return {
    getExtensions: () => extensionsResult,
    getSkills: () => skills,
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => {
      const text = appended();
      const personal = project?.personal;
      return [
        ...(text ? [text] : []),
        ...(personal
          ? [
              personal.instructions
                ? personalInstructionsText(personal.instructions)
                : PERSONAL_RESOURCE_RULES,
            ]
          : []),
      ];
    },
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {
      if (!project) return;
      const instructions = projectInstructions(project.cwd);
      agentsFiles = instructions ? [instructions] : [];
      skills = projectSkills(project.cwd);
      const names = new Set(skills.skills.map((skill) => skill.name));
      for (const folder of [
        ...(project.personal?.skills ?? []),
        ...(project.runbookSkills ?? []),
      ]) {
        const loaded = loadSkillsFromDir({ dir: folder.dir, source: "user" });
        skills.diagnostics.push(...loaded.diagnostics);
        for (const skill of loaded.skills) {
          if (names.has(skill.name)) continue;
          skills.skills.push(skill);
          names.add(skill.name);
        }
      }
    },
  };
}

/** The working copy's skills, Pi's way, the first folder holding a name winning. */
function projectSkills(cwd: string): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
  const byName = new Map<string, Skill>();
  const diagnostics: ResourceDiagnostic[] = [];
  for (const dir of projectSkillRoots(cwd)) {
    const loaded = loadSkillsFromDir({ dir, source: "project" });
    diagnostics.push(...loaded.diagnostics);
    for (const skill of loaded.skills) {
      const winner = byName.get(skill.name);
      if (!winner) {
        byName.set(skill.name, skill);
        continue;
      }
      diagnostics.push({
        type: "collision",
        message: `name "${skill.name}" collision`,
        path: skill.filePath,
        collision: {
          resourceType: "skill",
          name: skill.name,
          winnerPath: winner.filePath,
          loserPath: skill.filePath,
        },
      });
    }
  }
  return { skills: [...byName.values()], diagnostics };
}
