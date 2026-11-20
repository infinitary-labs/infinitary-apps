import { existsSync } from "node:fs";
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { ClaudePlugin } from "../claude/claudePlugins";
import {
  PERSONAL_SET_BUDGET_BYTES,
  PLUGIN_FILE_OPEN,
  pluginFiles,
  pluginFileTarget,
  stillPluginFile,
  withinListing,
} from "./personalSet";

/**
 * Each plugin as a crewmate reads it, in its own folder under `dir`: only
 * the files the personal set would carry, at the same paths, each copied
 * from the plugin's own regular file as it is read (`readPluginFile`'s
 * checks), one file at a time, so a link that leads outside the plugin
 * reaches no crewmate on any provider, even one an update puts there while
 * it is staged, and nothing written to the copy reaches the plugin
 * (docs/personal-resources.md). A plugin larger than the set may be is
 * left out, as no computer could be sent it. Answers the plugins with their
 * folders and skills moved there; a skill whose SKILL.md did not come along
 * is left out, and a plugin that cannot be staged is left out alone, with a
 * `note`.
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
      const files = pluginFiles(plugin);
      if (!files) throw new Error(`it holds more than ${PERSONAL_SET_BUDGET_BYTES} bytes`);
      await mkdir(into, { recursive: true });
      for (const file of files) {
        const { data, mode } = await ownFile(plugin.root, file.abs, file.size);
        const at = join(into, ...file.path.split("/"));
        await mkdir(dirname(at), { recursive: true });
        await writeFile(at, data, { mode: mode & 0o777 });
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

/** `readPluginFile`, without holding the host while the file is read. */
export async function ownFile(
  root: string,
  path: string,
  size: number,
): Promise<{ data: Buffer; mode: number }> {
  const own = pluginFileTarget(root, path);
  const handle = await open(own, PLUGIN_FILE_OPEN);
  try {
    const opened = await handle.stat();
    stillPluginFile(root, path, own, opened, size);
    // One byte past the listing tells a file that grew while it was read.
    const data = Buffer.alloc(size + 1);
    let read = 0;
    for (let got = 1; got > 0 && read < data.length; read += got)
      ({ bytesRead: got } = await handle.read(data, read, data.length - read, read));
    return { data: withinListing(path, data, read, size), mode: opened.mode };
  } finally {
    await handle.close();
  }
}
