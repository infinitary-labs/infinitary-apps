import { chmodSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  installClaudePlugin,
  linkOutsidePlugin,
  OUTSIDE_THE_PLUGIN,
  pluginSettings,
} from "../../../tests/helpers/claudePluginHome";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { readEnabledClaudePlugins, turnedOnClaudePlugins } from "../claude/claudePlugins";
import { ownFile, stagePluginTrees } from "./stagedPlugins";

/**
 * A plugin as a crewmate reads it: a copy of its own files alone, staged
 * for one session (docs/personal-resources.md). The review of the plugin
 * skills change asked that the copy hold nothing a link leads to outside the
 * plugin even while the plugin changes, share no file with it, and cost only
 * the plugin it could not copy.
 */
describe("a plugin staged for a session", () => {
  it("is a copy of its own files that writes never carry back, and one plugin that cannot be copied costs only itself", async () => {
    const home = scratchDir("infinitary-staged-plugins-home-");
    const kept = installClaudePlugin(home, { name: "claude-security" });
    const broken = installClaudePlugin(home, { name: "hookify" });
    chmodSync(join(broken.root, "scripts", "render_report.py"), 0o000);
    const setting = await readEnabledClaudePlugins(
      pluginSettings({ [kept.id]: true, [broken.id]: true }),
    );
    const notes: string[] = [];
    const staged = await stagePluginTrees(
      turnedOnClaudePlugins(home, setting ?? { plugins: {}, skillsDir: false }),
      scratchDir("infinitary-staged-plugins-"),
      (line) => notes.push(line),
    );
    chmodSync(join(broken.root, "scripts", "render_report.py"), 0o644);
    expect(staged.map((plugin) => plugin.id)).toEqual([kept.id]);
    expect(notes).toEqual([expect.stringContaining(`the plugin ${broken.id} was not staged`)]);
    const [plugin] = staged;
    const script = join(plugin?.root ?? "", "scripts", "render_report.py");
    const source = join(kept.root, "scripts", "render_report.py");
    expect(statSync(script).ino).not.toBe(statSync(source).ino);
    expect(statSync(script).mode & 0o111).not.toBe(0);
    writeFileSync(script, "print('changed')\n");
    expect(readFileSync(source, "utf8")).toBe("print('report')\n");
  });

  it("refuses a file a link turned to lead outside the plugin after it was listed", () => {
    const home = scratchDir("infinitary-staged-plugin-moved-");
    const plugin = installClaudePlugin(home, { name: "claude-security" });
    linkOutsidePlugin(home, plugin.root);
    const listed = join(plugin.root, "scripts", "render_report.py");
    expect(ownFile(plugin.root, listed).data.toString()).toBe("print('report')\n");
    // An update swaps the listed file for a link outside before it is copied.
    rmSync(listed);
    symlinkSync(join(home, "elsewhere", "keys.txt"), listed);
    expect(() => ownFile(plugin.root, listed)).toThrow("leads outside the plugin");
    expect(readFileSync(listed, "utf8")).toContain(OUTSIDE_THE_PLUGIN);
  });
});
