import { existsSync, realpathSync } from "node:fs";
import { copyFile, link, mkdir, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { ClaudePlugin } from "../claude/claudePlugins";
import { pluginFiles } from "./personalSet";

/**
 * Each plugin as a crewmate reads it, in its own folder under `dir`: only
 * the files the personal set would carry, at the same paths, each one the
 * plugin's own file (hard-linked, or copied where a link cannot be made), so
 * a link in the plugin that leads outside it reaches no crewmate on any
 * provider (docs/personal-resources.md). Answers the plugins with their
 * folders and skills moved there; a skill whose SKILL.md did not come along
 * is left out.
 */
export async function stagePluginTrees(
  plugins: readonly ClaudePlugin[],
  dir: string,
): Promise<ClaudePlugin[]> {
  await rm(dir, { recursive: true, force: true });
  const staged: ClaudePlugin[] = [];
  for (const plugin of plugins) {
    const into = join(dir, plugin.id);
    await mkdir(into, { recursive: true });
    for (const file of pluginFiles(plugin)) {
      const at = join(into, ...file.path.split("/"));
      await mkdir(dirname(at), { recursive: true });
      const own = realpathSync(file.abs);
      await link(own, at).catch(() => copyFile(own, at));
    }
    const skills = plugin.skills
      .map((skill) => ({ name: skill.name, dir: join(into, relative(plugin.root, skill.dir)) }))
      .filter((skill) => existsSync(join(skill.dir, "SKILL.md")));
    if (skills.length > 0) staged.push({ ...plugin, root: into, skills });
  }
  return staged;
}
