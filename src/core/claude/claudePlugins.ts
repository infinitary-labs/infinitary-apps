import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, posix } from "node:path";
import { skillFolders } from "../session/projectResources";
import { type ResolveClaudeSettings, resolveSettings } from "./claudeAccess";

/**
 * The skills of the Claude Code plugins the person turned on
 * (docs/personal-resources.md, "Claude Code plugins"): which plugins Claude
 * Code loads for them, read through the client library's own settings
 * reader (the organization's tier over the person's settings file, an unset
 * plugin following its own `defaultEnabled`), where Claude Code installed
 * each for the person (`installed_plugins.json`, user scope), and each
 * plugin's skill folders. Nothing else of a plugin - its hooks, MCP servers,
 * agents, commands or any other part - is read for a crewmate.
 */

/** One plugin as the reader serves it: its id, its manifest's name, its folder and its skills. */
export type ClaudePlugin = {
  id: string;
  name: string;
  root: string;
  skills: { name: string; dir: string }[];
};

/** Where the personal set keeps each plugin it carries, by its id, whatever version the home has. */
export const PLUGIN_SET_ROOT = ".claude/plugins";

/**
 * A plugin's top-level entries that never travel or reach a crewmate: every
 * component location Claude Code documents but skills, and how it was
 * fetched. Its manifest travels alone (`PLUGIN_MANIFEST`), for its name.
 */
export const PLUGIN_PARTS_LEFT_OUT: ReadonlySet<string> = new Set([
  ".claude-plugin",
  "commands",
  "agents",
  "hooks",
  ".mcp.json",
  ".lsp.json",
  "output-styles",
  "workflows",
  "themes",
  "monitors",
  "bin",
  "settings.json",
  ".git",
  "node_modules",
]);

/** The manifest, by its path inside the plugin. */
export const PLUGIN_MANIFEST = ".claude-plugin/plugin.json";

/** An id or name the set may hold as a folder name. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,199}$/;
export const safePluginName = (name: string) => SAFE_NAME.test(name) && !name.includes("..");

/** Effective `enabledPlugins`: the person's settings file with the organization's tier over it. */
export type EnabledClaudePlugins = Record<string, unknown>;

/**
 * The setting as last read. Unknown until the reader first answers, and
 * unknown is never on: no plugin is served before that.
 */
let enabled: EnabledClaudePlugins | undefined;

/** The setting as last read, without reading it again. */
export function enabledClaudePlugins(): EnabledClaudePlugins | undefined {
  return enabled;
}

/**
 * Reads the setting again through the client library's reader, asking for
 * the person's settings file alone, and keeps it for the synchronous readers.
 * A failed read keeps what was read before.
 */
export async function readEnabledClaudePlugins(
  resolve: ResolveClaudeSettings = resolveSettings,
): Promise<EnabledClaudePlugins | undefined> {
  try {
    const resolved = await resolve({ settingSources: ["user"] });
    const tier = (source: string) =>
      Object.assign(
        {},
        ...resolved.sources
          .filter((each) => each.source === source)
          .map((each) => each.settings?.enabledPlugins ?? {}),
      ) as EnabledClaudePlugins;
    enabled = { ...tier("user"), ...tier("managed") };
  } catch {}
  return enabled;
}

function json(path: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** A plugin's top-level entries that travel with its skills: everything but its left-out parts. */
export function carriedPluginEntries(root: string): string[] {
  try {
    return readdirSync(root)
      .sort()
      .filter((name) => !PLUGIN_PARTS_LEFT_OUT.has(name));
  } catch {
    return [];
  }
}

/**
 * The plugin in `root`: its manifest's name, and its skills from `skills/`,
 * the manifest's own skill paths inside the plugin, or a SKILL.md at its top.
 * Undefined when it has no skill.
 */
export function claudePluginAt(
  id: string,
  root: string,
): (ClaudePlugin & { defaultEnabled: boolean }) | undefined {
  if (!safePluginName(id)) return undefined;
  const manifest = json(join(root, PLUGIN_MANIFEST)) ?? {};
  const named = typeof manifest.name === "string" ? manifest.name : "";
  const name = safePluginName(named) ? named : (id.split("@")[0] ?? id);
  const declared = typeof manifest.skills === "string" ? [manifest.skills] : manifest.skills;
  const paths = ["skills", ...(Array.isArray(declared) ? declared : [])].flatMap((path) => {
    if (typeof path !== "string") return [];
    const inside = posix.normalize(path.replaceAll("\\", "/"));
    const first = inside.split("/")[0] ?? "";
    // Inside the plugin, and outside every part that never travels.
    if (posix.isAbsolute(inside) || first === ".." || first === "." || !first) return [];
    return PLUGIN_PARTS_LEFT_OUT.has(first) ? [] : [join(root, inside)];
  });
  const found = new Map<string, string>();
  for (const path of paths) {
    const skills = isFile(join(path, "SKILL.md"))
      ? [{ name: basename(path), dir: path }]
      : skillFolders([path]);
    for (const skill of skills) if (!found.has(skill.name)) found.set(skill.name, skill.dir);
  }
  if (found.size === 0 && isFile(join(root, "SKILL.md"))) found.set(name, root);
  if (found.size === 0) return undefined;
  return {
    id,
    name,
    root,
    skills: [...found].map(([skill, dir]) => ({ name: skill, dir })),
    defaultEnabled: manifest.defaultEnabled !== false,
  };
}

/** On, as Claude Code reads the setting: off only when set false, an unset plugin by its own default. */
function turnedOn(value: unknown, byDefault: boolean): boolean {
  if (value === undefined) return byDefault;
  return value !== false;
}

/**
 * The plugins Claude Code loads for the person on this computer, in id order:
 * each user-scope install that the setting turns on, then each plugin folder
 * the person saved under `~/.claude/skills` (one holding a manifest and no
 * SKILL.md of its own), as `<name>@skills-dir`. None while the setting is
 * unknown.
 */
export function turnedOnClaudePlugins(
  home: string,
  setting: EnabledClaudePlugins | undefined,
): ClaudePlugin[] {
  if (!setting) return [];
  const out: ClaudePlugin[] = [];
  const record = json(join(home, ".claude", "plugins", "installed_plugins.json"));
  const installs =
    record?.version === 2 && record.plugins && typeof record.plugins === "object"
      ? (record.plugins as Record<string, unknown>)
      : {};
  for (const id of Object.keys(installs).sort()) {
    const entries = installs[id];
    const user = Array.isArray(entries)
      ? entries.find(
          (entry): entry is { installPath: string } =>
            entry?.scope === "user" && typeof entry.installPath === "string",
        )
      : undefined;
    if (!user) continue;
    const plugin = claudePluginAt(id, user.installPath);
    if (plugin && turnedOn(setting[id], plugin.defaultEnabled)) out.push(strip(plugin));
  }
  const saved = join(home, ".claude", "skills");
  let names: string[] = [];
  try {
    names = readdirSync(saved).sort();
  } catch {}
  for (const folder of names) {
    const root = join(saved, folder);
    if (folder.startsWith(".") || isFile(join(root, "SKILL.md"))) continue;
    if (!isFile(join(root, PLUGIN_MANIFEST))) continue;
    const named = json(join(root, PLUGIN_MANIFEST))?.name;
    const plugin = claudePluginAt(`${typeof named === "string" ? named : folder}@skills-dir`, root);
    if (plugin && turnedOn(setting[plugin.id], true)) out.push(strip(plugin));
  }
  // By id: where two plugins hold one skill name, the earlier id's wins.
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The plugins a kept set carries: every one, since the home sends only those turned on. */
export function keptClaudePlugins(root: string): ClaudePlugin[] {
  const dir = join(root, ...PLUGIN_SET_ROOT.split("/"));
  let ids: string[] = [];
  try {
    ids = readdirSync(dir).sort();
  } catch {}
  return ids.flatMap((id) => {
    const plugin = claudePluginAt(id, join(dir, id));
    return plugin ? [strip(plugin)] : [];
  });
}

function strip({ defaultEnabled: _, ...plugin }: ClaudePlugin & { defaultEnabled: boolean }) {
  return plugin;
}
