import { describe, expect, it } from "vitest";
import { installClaudePlugin, pluginSettings } from "../../../tests/helpers/claudePluginHome";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { readEnabledClaudePlugins } from "../claude/claudePlugins";
import { PersonalCopy, type PersonalKeep } from "../helper/personalCopy";
import { HomePersonalSet } from "../session/homePersonalSet";
import { PERSONAL_PLUGINS, PERSONAL_SYNC, PersonalSync } from "./personalSync";

/**
 * A computer built before the plugins change refuses a plugin's files, so
 * the home sends it the set without them, under that set's own version, and
 * sends nothing more while neither changes (`personal-plugins.md`).
 */
describe("the personal set sent to a computer that keeps no plugins", () => {
  it("leaves the plugin files out, is kept whole there, and is not sent again", async () => {
    const home = scratchDir("infinitary-personal-sync-home-");
    const plugin = installClaudePlugin(home, { name: "claude-security" });
    let saved: { version: string; since: number } | undefined;
    const personal = new HomePersonalSet({
      enabled: () => true,
      saved: { get: () => saved, set: (seen) => (saved = seen) },
      now: () => 7,
      home,
      plugins: () => readEnabledClaudePlugins(pluginSettings({ [plugin.id]: true })),
    });
    const copies = {
      older: scratchDir("infinitary-sync-older-"),
      newer: scratchDir("infinitary-sync-newer-"),
    };
    const sent: { older: string[][]; newer: string[][] } = { older: [], newer: [] };
    const sync = new PersonalSync({
      devices: {
        inReach: () => true,
        version: (id) => ({
          contract: "16.0.0",
          takesWork: true,
          changes: id === "older" ? [PERSONAL_SYNC] : [PERSONAL_SYNC, PERSONAL_PLUGINS],
        }),
        ask: (async (id: "older" | "newer", _channel: string, [set]: [PersonalKeep]) => {
          sent[id].push(set.files.map((file) => file.path));
          return { personal: new PersonalCopy(copies[id]).keep(set) };
        }) as never,
      },
      personal,
      log: (line) => {
        throw new Error(line);
      },
    });
    for (const id of ["older", "newer"] as const) {
      sync.heard(id, undefined);
      await sync.bring(id);
      await sync.bring(id);
    }
    expect(sent.older).toEqual([[]]);
    expect(sent.newer).toHaveLength(1);
    expect(sent.newer[0]).toContain(`.claude/plugins/${plugin.id}/skills/claude-security/SKILL.md`);
    expect(sync.keptOn("older")?.version).toBe((await personal.current(false)).version.version);
    expect(sync.keptOn("newer")?.version).toBe((await personal.current()).version.version);
    expect(sync.keptOn("older")?.version).not.toBe(sync.keptOn("newer")?.version);
  });
});

// The personal resources switch is the person's opt-in: once it is off, nothing more is sent.
describe("the personal set when the switch turns off while it is read", () => {
  it("sends nothing to the computer", async () => {
    const home = scratchDir("infinitary-personal-sync-off-");
    const plugin = installClaudePlugin(home, { name: "claude-security" });
    let on = true;
    const personal = new HomePersonalSet({
      enabled: () => on,
      saved: { get: () => undefined, set: () => {} },
      now: () => 7,
      home,
      plugins: async () => {
        const setting = await readEnabledClaudePlugins(pluginSettings({ [plugin.id]: true }));
        on = false;
        return setting;
      },
    });
    const sent: unknown[] = [];
    const sync = new PersonalSync({
      devices: {
        inReach: () => true,
        version: () => ({
          contract: "16.0.0",
          takesWork: true,
          changes: [PERSONAL_SYNC, PERSONAL_PLUGINS],
        }),
        ask: (async (_id: string, _channel: string, [set]: [PersonalKeep]) => {
          sent.push(set);
          return { personal: { version: set.version, since: set.since } };
        }) as never,
      },
      personal,
      log: (line) => {
        throw new Error(line);
      },
    });
    sync.heard("computer", undefined);
    await sync.bring("computer");
    expect(sent).toEqual([]);
  });
});
