import { createHash } from "node:crypto";
import { readFile, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { KnowledgeService } from "../knowledge/knowledgeService";
import { APP_GIT_IDENTITY, git, isGitRepo } from "../workspace/git";
import { WORKSPACE_SKILLS_DIR } from "./workspaceSkills";

/**
 * The captain's panel instructions are ordinary standing directions scoped
 * to the personal workspace (primitives/standing-directions.md; INF-1054,
 * option A). Before that, `personalize instruction` appended each one as a
 * `- ` line to a `captain` skill in the workspace. This module only carries
 * what an older build left there, once, at startup: each listed line
 * becomes one direction word for word, any other words in the file become
 * one more, and the file leaves the workspace in one commit.
 *
 * The carry is idempotent through the direction ids: each is derived from
 * its words, a direction that already exists (retired included) is not
 * added again, and the file goes only after every direction is in. A quit
 * between the two, or a second start, adds nothing. Knowledge that cannot
 * be read leaves the file untouched for a later start.
 */
export const OLD_PANEL_INSTRUCTIONS_PATH = join(WORKSPACE_SKILLS_DIR, "captain", "SKILL.md");

/** The frontmatter and heading the older build wrote above the lines; never an instruction. */
const OLD_HEADER = `---
name: captain
description: Standing instructions from the captain for every panel built in this workspace. Follow them before any other preference.
---

# Captain's standing instructions

Each line below is something the captain asked for once and wants every time.
Apply them to every panel you build or revise here; when one conflicts with a
skill's default, the captain's line wins.
`;

const REASON =
  "Carried from the captain's panel instructions in the personal workspace's captain skill.";

export type PanelInstructionsCarry =
  | { state: "absent" }
  | { state: "carried"; added: number; kept: number; committed: boolean }
  | { state: "left"; reason: string };

/** The texts the file holds, in order: each listed line, then any other words as one. */
export function oldPanelInstructions(markdown: string): string[] {
  const body = markdown.startsWith(OLD_HEADER) ? markdown.slice(OLD_HEADER.length) : markdown;
  const lines: string[] = [];
  const rest: string[] = [];
  for (const row of body.split("\n")) {
    const listed = row.match(/^-\s+(.*\S)\s*$/)?.[1];
    if (listed === undefined) rest.push(row);
    else lines.push(listed);
  }
  const other = rest.join("\n").trim();
  return other ? [...lines, other] : lines;
}

export async function carryPanelInstructions(options: {
  workspaceDir: string;
  /** The personal workspace's project id, the directions' scope. */
  scope: string;
  knowledge: Pick<KnowledgeService, "directions">;
  log?: (message: string) => void;
}): Promise<PanelInstructionsCarry> {
  const path = join(options.workspaceDir, OLD_PANEL_INSTRUCTIONS_PATH);
  let markdown: string;
  try {
    markdown = await readFile(path, "utf8");
  } catch {
    return { state: "absent" };
  }
  let added = 0;
  let kept = 0;
  try {
    for (const text of oldPanelInstructions(markdown)) {
      const id = `panel-${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
      const read = options.knowledge.directions.read({ id });
      if (read.state === "unavailable") throw new Error(read.reason);
      if (read.state === "ready") {
        kept += 1;
        continue;
      }
      options.knowledge.directions.change({
        op: "add",
        id,
        text,
        scope: options.scope,
        reason: REASON,
      });
      added += 1;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    options.log?.(`panel instructions stay in ${OLD_PANEL_INSTRUCTIONS_PATH}: ${reason}`);
    return { state: "left", reason };
  }
  const committed = await removeOldFile(options.workspaceDir, path);
  return { state: "carried", added, kept, committed };
}

async function removeOldFile(workspaceDir: string, path: string): Promise<boolean> {
  let committed = false;
  if (await isGitRepo(workspaceDir)) {
    try {
      await git(workspaceDir, ["rm", "-q", "--ignore-unmatch", "--", OLD_PANEL_INSTRUCTIONS_PATH]);
      await rm(path, { force: true });
      await git(workspaceDir, [
        ...APP_GIT_IDENTITY,
        "commit",
        "-q",
        "-m",
        "chore: carry the captain's panel instructions to standing directions",
        "--only",
        "--",
        OLD_PANEL_INSTRUCTIONS_PATH,
      ]);
      committed = true;
    } catch {
      // The file was never committed: it goes from the disk alone.
    }
  }
  await rm(path, { force: true });
  await rmdir(dirname(path)).catch(() => {});
  return committed;
}
