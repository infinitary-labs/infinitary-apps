import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { type ClaudePlugin, insidePlugin } from "../claude/claudePlugins";
import { pluginFiles } from "./personalSet";

/**
 * Each plugin as a crewmate reads it, in its own folder under `dir`: only
 * the files the personal set would carry, at the same paths, each copied
 * from the plugin's own regular file as it is read, so a link that leads
 * outside the plugin reaches no crewmate on any provider, even one an update
 * puts there while it is staged, and nothing written to the copy reaches the
 * plugin (docs/personal-resources.md). Answers the plugins with their folders
 * and skills moved there; a skill whose SKILL.md did not come along is left
 * out, and a plugin that cannot be staged is left out alone, with a `note`.
 */
export async function stagePluginTrees(
  plugins: readonly ClaudePlugin[],
  dir: string,
  note: (line: string) => void,
): Promise<ClaudePlugin[]> {
  await rm(dir, { recursive: true, force: true });
  const staged: ClaudePlugin[] = [];
  for (const plugin of plugins) {
    const into = join(dir, plugin.id);
    try {
      await mkdir(into, { recursive: true });
      for (const file of pluginFiles(plugin)) {
        const { data, mode } = ownFile(plugin.root, file.abs);
        const at = join(into, ...file.path.split("/"));
        await mkdir(dirname(at), { recursive: true });
        await writeFile(at, data, { mode });
      }
    } catch (error) {
      await rm(into, { recursive: true, force: true });
      // i18n-exempt: a line in the session's own log, for a developer.
      note(
        `the plugin ${plugin.id} was not staged: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    const skills = plugin.skills
      .map((skill) => ({ name: skill.name, dir: join(into, relative(plugin.root, skill.dir)) }))
      .filter((skill) => existsSync(join(skill.dir, "SKILL.md")));
    if (skills.length > 0) staged.push({ ...plugin, root: into, skills });
  }
  return staged;
}

/**
 * The bytes and permissions of a plugin's file, read through a handle on
 * the regular file its links lead to, once that file is checked to be
 * inside the plugin and still the one the check named.
 */
export function ownFile(root: string, path: string): { data: Buffer; mode: number } {
  const own = realpathSync(path);
  if (!insidePlugin(root, own)) throw new Error(`${path} leads outside the plugin`);
  const handle = openSync(own, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(handle);
    const named = statSync(own);
    if (
      !opened.isFile() ||
      opened.ino !== named.ino ||
      opened.dev !== named.dev ||
      realpathSync(own) !== own ||
      !insidePlugin(root, own)
    )
      throw new Error(`${path} changed while it was staged`);
    return { data: readFileSync(handle), mode: opened.mode & 0o777 };
  } finally {
    closeSync(handle);
  }
}
