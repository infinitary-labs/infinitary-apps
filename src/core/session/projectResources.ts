import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A working copy's own instructions and skills, which every crewmate's
 * coding session loads at its start (FI3-789): the project's AGENTS.md, or
 * its CLAUDE.md where it has none, and the skill folders under
 * `.claude/skills` and `.agents/skills`. Each backend serves them its own
 * way - Pi through the crewmate's resource loader, Claude through the
 * prompt it appends and a local plugin, Antigravity in the instructions at
 * the head of its conversation (docs/architecture.md section 5,
 * docs/claude-client.md, docs/antigravity-client.md) - but each reads them
 * here, from the working copy's root alone. Opted-in personal resources are read separately by
 * `personalResources.ts`; configuration and the app's agentDir stay out.
 */

/** The instruction files a working copy may have, the first one present winning. */
export const PROJECT_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

/** The folders a working copy keeps its skills in, the first one holding a name winning. */
export const PROJECT_SKILL_DIRS = [join(".claude", "skills"), join(".agents", "skills")] as const;

export type ProjectInstructions = { path: string; content: string };

/** The working copy's own instruction file and its text, when it has one. */
export function projectInstructions(cwd: string): ProjectInstructions | undefined {
  for (const name of PROJECT_INSTRUCTION_FILES) {
    const path = join(cwd, name);
    try {
      if (!statSync(path).isFile()) continue;
      return { path, content: readFileSync(path, "utf8").replace(/^﻿/, "") };
    } catch {
      // Absent or unreadable: the next name, or none.
    }
  }
  return undefined;
}

/** The working copy's skill folders, in the order a name is decided. */
export function projectSkillRoots(cwd: string): string[] {
  return PROJECT_SKILL_DIRS.map((dir) => join(cwd, dir));
}

/**
 * Every skill folder of the working copy - a folder directly under one of
 * its skill folders that holds a SKILL.md - by its folder name, the first
 * skill folder holding a name winning.
 */
export function projectSkillFolders(cwd: string): { name: string; dir: string }[] {
  return skillFolders(projectSkillRoots(cwd));
}

/** Skills directly beneath explicit roots, the first folder holding a name winning. */
export function skillFolders(roots: string[]): { name: string; dir: string }[] {
  const found = new Map<string, string>();
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries.sort()) {
      if (name.startsWith(".") || found.has(name)) continue;
      const dir = join(root, name);
      try {
        if (statSync(join(dir, "SKILL.md")).isFile()) found.set(name, dir);
      } catch {
        // Not a skill folder.
      }
    }
  }
  return [...found].map(([name, dir]) => ({ name, dir }));
}
