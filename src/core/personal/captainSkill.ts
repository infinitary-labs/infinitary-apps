import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { APP_GIT_IDENTITY, git, isGitRepo } from "../workspace/git";
import { WORKSPACE_SKILLS_DIR } from "./workspaceSkills";

/**
 * The captain's standing instructions (talk-to-personalize Step 1, plan
 * section 5.4): a skill in the personal workspace that the crewmate
 * building a panel discovers like any other - `.claude/skills/captain/
 * SKILL.md` under `userData/fleet/personal/`. "Always use compact rows in
 * my panels" appends one line here through `personalize instruction`.
 *
 * INTEGRATION POINT with the workspace seeder (Step 2, ../workspace.ts) and
 * the app-owned skills (Step 3, ./workspaceSkills.ts): this file is
 * CAPTAIN-OWNED content, never a managed file or a managed skill tree. The
 * seeder must not list it in `MANAGED_FILES` - a force-copy would erase the
 * captain's instructions - and the skill seeder heals only the trees it
 * owns beside it under `.claude/skills/<name>/`, never `captain/`
 * (workspaceSkills.test.ts pins that). The header is
 * written only when the file does not yet exist, so an edit the captain
 * makes by hand stands. The seeded `AGENTS.md` already tells the crewmate
 * to follow a `captain` skill when present.
 */
export const CAPTAIN_SKILL_RELATIVE_PATH = join(WORKSPACE_SKILLS_DIR, "captain", "SKILL.md");

export const CAPTAIN_SKILL_HEADER = `---
name: captain
description: Standing instructions from the captain for every panel built in this workspace. Follow them before any other preference.
---

# Captain's standing instructions

Each line below is something the captain asked for once and wants every time.
Apply them to every panel you build or revise here; when one conflicts with a
skill's default, the captain's line wins.

`;

/** Instruction text past this is refused: a standing instruction is one line. */
export const CAPTAIN_INSTRUCTION_MAX_CHARS = 300;

export type AppendInstructionResult =
  | { status: "appended"; line: string; path: string; committed: boolean }
  | { status: "duplicate"; line: string; path: string }
  | { status: "refused"; reason: string };

/**
 * Appends one instruction as a list item and commits the file under the
 * app's identity, so the workspace's history shows when the captain said
 * it. The text is normalised to one sentence-cased line ending in a period;
 * a line already present is reported as a duplicate, never written twice.
 * The commit is best-effort: the line is on disk either way, and a
 * workspace that is not a repo yet (the seeder has not run) just gets the
 * file.
 */
export async function appendCaptainInstruction(
  workspaceDir: string,
  text: string,
): Promise<AppendInstructionResult> {
  const line = normaliseInstruction(text);
  if (!line) return { status: "refused", reason: "an instruction needs some words" };
  if (line.length > CAPTAIN_INSTRUCTION_MAX_CHARS) {
    return {
      status: "refused",
      reason: `an instruction is one line, at most ${CAPTAIN_INSTRUCTION_MAX_CHARS} characters`,
    };
  }
  const path = join(workspaceDir, CAPTAIN_SKILL_RELATIVE_PATH);
  let current: string | null = null;
  try {
    current = await readFile(path, "utf8");
  } catch {
    current = null;
  }
  if (current !== null && listedInstructions(current).some((existing) => existing === line)) {
    return { status: "duplicate", line, path };
  }
  const body = current === null ? CAPTAIN_SKILL_HEADER : current;
  const separator = body.endsWith("\n") ? "" : "\n";
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${body}${separator}- ${line}\n`, "utf8");
  const committed = await commitInstruction(workspaceDir, line);
  return { status: "appended", line, path, committed };
}

/** The instructions the skill lists today, in order; empty when the file is absent. */
export async function readCaptainInstructions(workspaceDir: string): Promise<string[]> {
  try {
    return listedInstructions(
      await readFile(join(workspaceDir, CAPTAIN_SKILL_RELATIVE_PATH), "utf8"),
    );
  } catch {
    return [];
  }
}

function listedInstructions(markdown: string): string[] {
  return markdown
    .split("\n")
    .map((row) => row.match(/^-\s+(.*\S)\s*$/)?.[1])
    .filter((row): row is string => row !== undefined);
}

/** One line, one sentence, sentence case, a closing period. */
export function normaliseInstruction(text: string): string {
  const collapsed = text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-*]\s+/, "");
  if (!collapsed) return "";
  const cased = collapsed[0]?.toUpperCase() + collapsed.slice(1);
  return /[.!?]$/.test(cased) ? cased.replace(/!$/, ".") : `${cased}.`;
}

async function commitInstruction(workspaceDir: string, line: string): Promise<boolean> {
  if (!(await isGitRepo(workspaceDir))) return false;
  try {
    await git(workspaceDir, ["add", "--", CAPTAIN_SKILL_RELATIVE_PATH]);
    await git(workspaceDir, [
      ...APP_GIT_IDENTITY,
      "commit",
      "-m",
      `chore: add captain instruction ${line.slice(0, 45)}`,
      "--only",
      "--",
      CAPTAIN_SKILL_RELATIVE_PATH,
    ]);
    return true;
  } catch {
    return false;
  }
}
