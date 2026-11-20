import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { installClaudePlugin, pluginSettings } from "../../../tests/helpers/claudePluginHome";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { SKILL_TEXT } from "../axi/captainCommands";
import { readEnabledClaudePlugins } from "../claude/claudePlugins";
import { INFINITARY_COMMAND } from "../integrations/commandWords";
import { PERSONAL_FILE_BYTES, personalResources } from "./personalResources";

function put(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
it("reads only the chosen local file and skill folders, honoring order, links, caps and project names", () => {
  const home = scratchDir("fm-personal-home-");
  const empty = personalResources(home);
  expect(empty.instructions).toBeUndefined();
  expect(empty.skills).toEqual([]);
  put(join(home, ".codex", "AGENTS.md"), "codex fallback");
  put(join(home, ".claude", "CLAUDE.md"), "claude fallback");
  put(join(home, "shared.md"), "﻿home winner");
  symlinkSync(join(home, "shared.md"), join(home, "AGENTS.md"));
  for (const root of [".agents", ".claude"]) {
    put(join(home, root, "skills", "same", "SKILL.md"), root);
  }
  put(join(home, ".claude", "skills", "unique", "SKILL.md"), "unique body");
  put(join(home, ".agents", "skills", "oversize", "SKILL.md"), "x".repeat(PERSONAL_FILE_BYTES + 1));
  put(join(home, ".claude", "settings.json"), "not JSON, never read");
  const first = personalResources(home);
  expect(first.instructions).toEqual({ path: join(home, "AGENTS.md"), content: "home winner" });
  expect(first.skills).toEqual([
    { name: "same", dir: join(home, ".agents", "skills", "same") },
    { name: "unique", dir: join(home, ".claude", "skills", "unique") },
  ]);
  expect(personalResources(home).digests).toEqual(first.digests);
  put(join(home, ".agents", "skills", "same", "SKILL.md"), "updated body");
  expect(personalResources(home).digests.skills).not.toBe(first.digests.skills);
  expect(personalResources(home, new Set(["same"])).skills.map((skill) => skill.name)).toEqual([
    "unique",
  ]);
  put(join(home, "shared.md"), "x".repeat(PERSONAL_FILE_BYTES + 1));
  expect(personalResources(home).instructions?.content).toBe("claude fallback");
  rmSync(join(home, ".claude", "CLAUDE.md"));
  expect(personalResources(home).instructions?.content).toBe("codex fallback");
  const otherHome = scratchDir("fm-personal-other-user-");
  put(join(otherHome, "AGENTS.md"), "other Mac's rules");
  expect(personalResources(otherHome).instructions?.content).toBe("other Mac's rules");
  expect(personalResources(otherHome).skills).toEqual([]);
});

// The captain's answer on the review of INF-1894: "Keep the skill in your skills
// folder, but never hand it to crewmates".
it("never hands a crewmate the skill infinitary-axi setup writes, in either skills folder", () => {
  const home = scratchDir("infinitary-personal-command-skill-");
  for (const root of [".agents", ".claude"]) {
    put(join(home, root, "skills", INFINITARY_COMMAND, "SKILL.md"), SKILL_TEXT);
  }
  put(join(home, ".claude", "skills", "unique", "SKILL.md"), "unique body");
  expect(personalResources(home).skills.map((skill) => skill.name)).toEqual(["unique"]);
});

// The captain's feature request: crew sessions load the skills of the Claude
// Code plugins turned on in ~/.claude/settings.json, from the folder
// installed_plugins.json names, and follow plugin updates.
describe("the skills of the person's turned-on Claude Code plugins", () => {
  it("serves each turned-on plugin's skills, organization first, an unset plugin by its default", async () => {
    const home = scratchDir("infinitary-personal-plugins-");
    const security = installClaudePlugin(home, { name: "claude-security" });
    const design = installClaudePlugin(home, { name: "frontend-design" });
    const plugins = async (own: Record<string, unknown>, organization?: Record<string, unknown>) =>
      personalResources(home, new Set(), {
        enabled: await readEnabledClaudePlugins(pluginSettings(own, organization)),
      }).plugins.map((plugin) => plugin.id);
    expect(await plugins({ [security.id]: true, [design.id]: false })).toEqual([security.id]);
    expect(await plugins({ [design.id]: false })).toEqual([security.id]);
    expect(await plugins({ [security.id]: true }, { [security.id]: false })).toEqual([design.id]);
    const manifest = join(design.root, ".claude-plugin", "plugin.json");
    put(manifest, JSON.stringify({ name: "frontend-design", defaultEnabled: false }));
    expect(await plugins({ [security.id]: true })).toEqual([security.id]);
    expect(await plugins({ [security.id]: true, [design.id]: true })).toEqual([
      security.id,
      design.id,
    ]);
    const read = personalResources(home, new Set(), { enabled: { [security.id]: true } });
    expect(read.plugins).toEqual([
      {
        id: security.id,
        name: "claude-security",
        root: security.root,
        skills: [
          { name: "claude-security", dir: join(security.root, "skills", "claude-security") },
        ],
      },
    ]);
    // Unknown is never on.
    expect(personalResources(home, new Set(), { enabled: undefined }).plugins).toEqual([]);
  });

  it("follows an update to the new folder, its digest moving only with a skill's text", () => {
    const home = scratchDir("infinitary-personal-plugin-update-");
    const old = installClaudePlugin(home, { name: "claude-security", version: "0.12.0" });
    const on = { enabled: { [old.id]: true } };
    const before = personalResources(home, new Set(), on);
    const moved = installClaudePlugin(home, { name: "claude-security", version: "0.13.0" });
    const after = personalResources(home, new Set(), on);
    expect(after.plugins[0]?.root).toBe(moved.root);
    expect(after.digests).toEqual(before.digests);
    installClaudePlugin(home, { name: "claude-security", version: "0.14.0", skillText: "New." });
    expect(personalResources(home, new Set(), on).digests.skills).not.toBe(before.digests.skills);
    // A plugin turned off leaves the digest a home without plugins has.
    expect(personalResources(home, new Set(), { enabled: { [old.id]: false } }).digests).toEqual(
      personalResources(scratchDir("infinitary-personal-no-plugins-")).digests,
    );
  });

  it("counts a plugin folder saved under ~/.claude/skills and ranks plugin skills below the person's own", () => {
    const home = scratchDir("infinitary-personal-plugin-saved-");
    const saved = join(home, ".claude", "skills", "rivets-plugin");
    put(join(saved, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "rivets" }));
    put(join(saved, "skills", "rivets", "SKILL.md"), "rivets body");
    put(join(saved, "skills", "shared", "SKILL.md"), "plugin's shared");
    put(join(home, ".agents", "skills", "shared", "SKILL.md"), "own shared");
    const plugin = installClaudePlugin(home, { name: "tools" });
    put(join(plugin.root, "skills", "rivets", "SKILL.md"), "a later plugin's rivets");
    const read = personalResources(home, new Set(["tools"]), {
      enabled: { [plugin.id]: true },
    });
    expect(read.skills.map((skill) => skill.name)).toEqual(["shared"]);
    expect(read.plugins).toEqual([
      {
        id: "rivets@skills-dir",
        name: "rivets",
        root: saved,
        skills: [{ name: "rivets", dir: join(saved, "skills", "rivets") }],
      },
    ]);
    expect(
      personalResources(home, new Set(), { enabled: { "rivets@skills-dir": false } }).plugins.map(
        (each) => each.id,
      ),
    ).toEqual([plugin.id]);
  });
});
