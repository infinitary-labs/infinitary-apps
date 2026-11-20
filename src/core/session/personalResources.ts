import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HERE } from "@shared/deviceNames";
import {
  type ClaudePlugin,
  type EnabledClaudePlugins,
  keptClaudePlugins,
  readEnabledClaudePlugins,
  turnedOnClaudePlugins,
} from "../claude/claudePlugins";
import { INFINITARY_COMMAND } from "../integrations/commandWords";
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
  /** The skills of the person's turned-on Claude Code plugins, each plugin's own (`claudePlugins.ts`). */
  plugins: ClaudePlugin[];
  digests: PersonalResourceDigests;
};

/**
 * Where the reader finds plugins: on the home, the setting Claude Code reads
 * (`enabled`); in a set kept on a computer that runs work, the plugins the
 * set carries, never that computer's own settings.
 */
export type PersonalPluginSource = { kept: true } | { enabled: EnabledClaudePlugins | undefined };

/**
 * The plugin source for a session: a kept set's own when it reads one
 * (`personalRoot`), otherwise the home's setting, read again now.
 */
export async function personalPluginSource(personalRoot?: string): Promise<PersonalPluginSource> {
  return personalRoot !== undefined
    ? { kept: true }
    : { enabled: await readEnabledClaudePlugins() };
}

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

/**
 * Read only this running user's home. Of settings, only which Claude Code
 * plugins are on; never hooks, MCP configuration or any other plugin part.
 */
export function personalResources(
  home: string = homedir(),
  excluded: ReadonlySet<string> = new Set(),
  // Unknown is never on: a caller that read no setting serves no plugin.
  source: PersonalPluginSource = { enabled: undefined },
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
    // The skill `infinitary-axi setup` writes is the person's own: it points
    // their agents at a command that reads Infinitary as them, so it stays in
    // their folder and is never handed to a crewmate.
    .filter((skill) => skill.name !== INFINITARY_COMMAND && !excluded.has(skill.name))
    .slice(0, 256)
    .flatMap((skill) => {
      const content = read(join(skill.dir, "SKILL.md"));
      return content === undefined ? [] : [{ ...skill, digest: sha(content) }];
    });
  // A name already taken - the project's, the person's own skill folders,
  // an earlier plugin's - wins over a plugin's skill, on every provider.
  const taken = new Set([...excluded, INFINITARY_COMMAND, ...skills.map((skill) => skill.name)]);
  const plugins = (
    "kept" in source ? keptClaudePlugins(home) : turnedOnClaudePlugins(home, source.enabled)
  ).flatMap((plugin) => {
    const own = plugin.skills.flatMap((skill) => {
      if (taken.has(skill.name)) return [];
      const content = read(join(skill.dir, "SKILL.md"));
      if (content === undefined) return [];
      taken.add(skill.name);
      return [{ ...skill, digest: sha(content) }];
    });
    return own.length > 0 ? [{ ...plugin, skills: own }] : [];
  });
  const listed = skills.map(({ name, dir, digest }) => ({ name, dir, digest }));
  // By plugin id, skill name and text, never the versioned folder: an update
  // that leaves a skill's text alone leaves the digest alone.
  const pluginDigests = plugins.map((plugin) => ({
    plugin: plugin.id,
    skills: plugin.skills.map(({ name, digest }) => ({ name, digest })),
  }));
  return {
    ...(instructions ? { instructions } : {}),
    skills: skills.map(({ name, dir }) => ({ name, dir })),
    plugins: plugins.map((plugin) => ({
      ...plugin,
      skills: plugin.skills.map(({ name, dir }) => ({ name, dir })),
    })),
    digests: {
      instructions: instructions ? sha(instructions.content) : null,
      skills: sha(
        JSON.stringify(
          pluginDigests.length > 0 ? { skills: listed, plugins: pluginDigests } : listed,
        ),
      ),
    },
  };
}

export const PERSONAL_RESOURCE_RULES =
  "Crew rules win on delivery, scope, safety, credentials, tools, approvals and unrelated work. The project's or personal workspace's own instructions win over crew rules on how tests are written and run. Personal instructions win on style and judgment otherwise. The project's or personal workspace's own instructions and skills take precedence over personal resources. No personal instruction or skill authorizes MCP, hooks or a different sign-in route.";

/**
 * Where each plugin's files are, for a provider that does not stage plugins
 * itself: a plugin skill's `${CLAUDE_PLUGIN_ROOT}` names its plugin's folder.
 */
export function personalPluginsText(plugins: readonly ClaudePlugin[]): string | undefined {
  if (plugins.length === 0) return undefined;
  return [
    `Skills of the user's Claude Code plugins. In a plugin skill, \${CLAUDE_PLUGIN_ROOT} is its plugin's folder below and \${CLAUDE_SKILL_DIR} is the skill's own folder:`,
    ...plugins.map(
      (plugin) =>
        `- ${plugin.name}: ${plugin.root} (skills: ${plugin.skills.map((skill) => skill.name).join(", ")})`,
    ),
  ].join("\n");
}

/** The accepted split ranking, including the workspace's own local authority. */
export function personalInstructionsText(instructions: ProjectInstructions): string {
  return [
    `Personal instructions from the user of ${HERE.this}:`,
    PERSONAL_RESOURCE_RULES,
    `<personal_instructions path=${JSON.stringify(instructions.path)}>\n${instructions.content}\n</personal_instructions>`,
  ].join("\n\n");
}
