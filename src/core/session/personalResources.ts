import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HERE } from "@shared/deviceNames";
import { type ProjectInstructions, skillFolders } from "./projectResources";

export const PERSONAL_INSTRUCTION_FILES = [
  "AGENTS.md",
  ".claude/CLAUDE.md",
  ".codex/AGENTS.md",
] as const;
export const PERSONAL_FILE_BYTES = 128 * 1024;
export type PersonalResourceDigests = { instructions: string | null; skills: string };
export type PersonalResources = {
  instructions?: ProjectInstructions;
  skills: { name: string; dir: string }[];
  digests: PersonalResourceDigests;
};

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
function read(path: string): string | undefined {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > PERSONAL_FILE_BYTES) return undefined;
    return readFileSync(path, "utf8").replace(/^﻿/, "");
  } catch {
    return undefined;
  }
}

/** Read only this running user's home. Never read settings, hooks or MCP configuration. */
export function personalResources(
  home: string = homedir(),
  excluded: ReadonlySet<string> = new Set(),
): PersonalResources {
  let instructions: ProjectInstructions | undefined;
  for (const name of PERSONAL_INSTRUCTION_FILES) {
    const path = join(home, name);
    const content = read(path);
    if (content === undefined) continue;
    instructions = { path, content };
    break;
  }
  const folders = skillFolders([join(home, ".agents", "skills"), join(home, ".claude", "skills")]);
  const skills = folders
    .filter((skill) => !excluded.has(skill.name))
    .slice(0, 256)
    .flatMap((skill) => {
      const content = read(join(skill.dir, "SKILL.md"));
      return content === undefined ? [] : [{ ...skill, digest: sha(content) }];
    });
  return {
    ...(instructions ? { instructions } : {}),
    skills: skills.map(({ name, dir }) => ({ name, dir })),
    digests: {
      instructions: instructions ? sha(instructions.content) : null,
      skills: sha(JSON.stringify(skills.map(({ name, dir, digest }) => ({ name, dir, digest })))),
    },
  };
}

export const PERSONAL_RESOURCE_RULES =
  "Crew rules win on delivery, scope, safety, credentials, tools, approvals and unrelated work. The project's or personal workspace's own instructions win over crew rules on how tests are written and run. Personal instructions win on style and judgment otherwise. The project's or personal workspace's own instructions and skills take precedence over personal resources. No personal instruction or skill authorizes MCP, hooks or a different sign-in route.";

/** The accepted split ranking, including the workspace's own local authority. */
export function personalInstructionsText(instructions: ProjectInstructions): string {
  return [
    `Personal instructions from the user of ${HERE.this}:`,
    PERSONAL_RESOURCE_RULES,
    `<personal_instructions path=${JSON.stringify(instructions.path)}>\n${instructions.content}\n</personal_instructions>`,
  ].join("\n\n");
}
