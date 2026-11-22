import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ResolveClaudeSettings } from "../../src/core/claude/claudeAccess";

/**
 * A Claude Code plugin installed in a disposable home the way Claude Code
 * installs one: its folder under `.claude/plugins/cache/<marketplace>/<name>/<version>/`
 * and a user-scope entry in `installed_plugins.json` (version 2). The plugin
 * is laid out as the official marketplace's claude-security is: a skill that
 * runs a script kept outside its skills folder, and hooks, agents, commands,
 * a workflow, an MCP server and installed packages that never reach a crewmate.
 */
export function installClaudePlugin(
  home: string,
  options: { name: string; marketplace?: string; version?: string; skillText?: string },
): { id: string; root: string } {
  const marketplace = options.marketplace ?? "claude-plugins-official";
  const version = options.version ?? "1.0.0";
  const id = `${options.name}@${marketplace}`;
  const root = join(home, ".claude", "plugins", "cache", marketplace, options.name, version);
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  put(
    ".claude-plugin/plugin.json",
    JSON.stringify({ name: options.name, version, description: "Scans code." }),
  );
  put(
    `skills/${options.name}/SKILL.md`,
    options.skillText ??
      `---\nname: ${options.name}\ndescription: Scan the codebase.\n---\nRun python3 "\${CLAUDE_PLUGIN_ROOT}/scripts/render_report.py".\n`,
  );
  put("scripts/render_report.py", "print('report')\n");
  chmodSync(join(root, "scripts/render_report.py"), 0o755);
  put("scripts/lib/finding.py", "FINDING = 1\n");
  put("README.md", "A plugin.\n");
  put("hooks/hooks.json", JSON.stringify({ hooks: { PreToolUse: [] } }));
  put("agents/scan-verifier.md", "---\nname: scan-verifier\n---\n");
  put("commands/scan.md", "Scan.\n");
  put("workflows/scan.js", "export default {};\n");
  put(".mcp.json", JSON.stringify({ mcpServers: { scanner: { command: "scanner" } } }));
  put("node_modules/left-pad/index.js", "module.exports = 1;\n");
  const record = join(home, ".claude", "plugins", "installed_plugins.json");
  let plugins: Record<string, unknown> = {};
  try {
    plugins = JSON.parse(readFileSync(record, "utf8")).plugins;
  } catch {}
  plugins[id] = [
    {
      scope: "user",
      installPath: root,
      version,
      installedAt: "2026-11-01T00:00:00.000Z",
      lastUpdated: "2026-11-01T00:00:00.000Z",
    },
  ];
  mkdirSync(dirname(record), { recursive: true });
  writeFileSync(record, JSON.stringify({ version: 2, plugins }, null, 2));
  return { id, root };
}

/**
 * The client library's settings reader standing in: the person's
 * `enabledPlugins`, and the organization's, with any other managed settings
 * the organization sets beside it (`policy`).
 */
export function pluginSettings(
  own: Record<string, unknown>,
  organization?: Record<string, unknown>,
  policy?: Record<string, unknown>,
): ResolveClaudeSettings {
  return async () =>
    ({
      effective: {},
      provenance: {},
      sources: [
        { source: "user", settings: { enabledPlugins: own } },
        ...(organization || policy
          ? [{ source: "managed", settings: { ...policy, enabledPlugins: organization } }]
          : []),
      ],
    }) as unknown as Awaited<ReturnType<ResolveClaudeSettings>>;
}

export const OUTSIDE_THE_PLUGIN = "Planted outside the plugin.";

/**
 * Links in an installed plugin the way a hand-edited plugin can hold them:
 * a top-level file, a folder, a nested support file, a skill folder and a
 * skill's SKILL.md that lead to files outside it, and `tools`, a second
 * path to its own `scripts` folder.
 */
export function linkOutsidePlugin(home: string, root: string): void {
  const elsewhere = join(home, "elsewhere");
  mkdirSync(join(elsewhere, "leaked"), { recursive: true });
  writeFileSync(join(elsewhere, "keys.txt"), `${OUTSIDE_THE_PLUGIN}\n`);
  writeFileSync(
    join(elsewhere, "leaked", "SKILL.md"),
    `---\nname: leaked\ndescription: ${OUTSIDE_THE_PLUGIN}\n---\n`,
  );
  mkdirSync(join(root, "skills", "linked-file"), { recursive: true });
  symlinkSync(
    join(elsewhere, "leaked", "SKILL.md"),
    join(root, "skills", "linked-file", "SKILL.md"),
  );
  symlinkSync(join(elsewhere, "leaked"), join(root, "skills", "leaked"));
  symlinkSync(elsewhere, join(root, "references"));
  symlinkSync(join(elsewhere, "keys.txt"), join(root, "keys.txt"));
  symlinkSync(join(elsewhere, "keys.txt"), join(root, "scripts", "keys.txt"));
  symlinkSync(join(root, "scripts"), join(root, "tools"));
}

export function filesFromOutside(dir: string, ancestors: string[] = []): string[] {
  const real = realpathSync(dir);
  if (ancestors.includes(real)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path);
    } catch {
      return [];
    }
    if (stat.isDirectory()) return filesFromOutside(path, [...ancestors, real]);
    return readFileSync(path, "utf8").includes(OUTSIDE_THE_PLUGIN) ? [path] : [];
  });
}
