import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { installClaudePlugin, pluginSettings } from "../../../tests/helpers/claudePluginHome";
import { api, model, placedWorldHooks, world } from "../../../tests/helpers/placedWorld";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { readEnabledClaudePlugins } from "../claude/claudePlugins";
import {
  personalFingerprint,
  personalFingerprintOf,
  personalSetFiles,
} from "../session/personalSet";

/**
 * The home's personal instructions and skills kept on a computer that runs
 * work by the app's own triggers (docs/personal-resources.md, "One set, kept
 * on each computer"): the home's contact with the computer, a conversation
 * opening there, and an edit on the home, composed as `createServices`
 * composes them (`tests/helpers/placedWorld.ts`).
 */

// Integration budget (docs/test-cohorts.md): real git on the computer and
// here, as the other placed files; a poll waits for work that crosses the
// connection, so it waits for the rest of the test's budget, never
// Vitest's 1 s (tests/helpers/waitWindow.ts).
vi.setConfig({ testTimeout: 10_000 });

// This file is about the personal set, not the clamp below the UI
// (utilityQos.test.ts holds it), so its git runs at this run's own priority.
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

placedWorldHooks({ now: () => Date.now(), reset: () => {} });

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** The newest model request's system prompt, as the computer's crewmate was served it. */
function served(): string {
  return JSON.stringify(api.requests.at(-1)?.body?.system ?? "");
}

describe("the home's personal set on a computer that runs work", () => {
  it("is sent once per version by the home's own triggers, never with a task, and its crew reads it and none of the computer's own", async () => {
    // The computer's own home folder, which the home's crew must never read.
    const own = scratchDir("infinitary-personal-computer-");
    put(join(own, "AGENTS.md"), "The computer's own rule.\n");
    vi.stubEnv("HOME", own);
    const home = scratchDir("infinitary-personal-home-");
    put(join(home, "AGENTS.md"), "The home's first rule.\n");
    put(
      join(home, ".agents", "skills", "home-rivets", "SKILL.md"),
      "---\nname: home-rivets\ndescription: The home's skill.\n---\nFollow home-rivets.\n",
    );

    const at = await world(undefined, { personal: { home } });
    const sends = () => at.ordered.filter((channel) => channel === "inf:session:personal").length;
    const kept = () => personalFingerprintOf(join(at.dataDir, "personal", "current"));
    const home_ = () => personalFingerprint(personalSetFiles(home, undefined).files);

    // Its contact brings it the home's set: one send, the same fingerprint on both.
    await expect.poll(sends).toBe(1);
    expect(kept()).toBe(home_());

    // Two tasks open there with the set unchanged: nothing more is sent.
    model([{ text: "Done." }, { text: "Done." }]);
    await at.start("t-one");
    await at.start("t-two");
    await expect.poll(() => api.requests.length).toBe(2);
    expect(sends()).toBe(1);
    expect(served()).toContain("The home's first rule.");
    expect(served()).toContain("<name>home-rivets</name>");
    expect(served()).not.toContain("The computer's own rule.");

    // An edit on the home is sent once, before the next conversation there opens.
    put(join(home, "AGENTS.md"), "The home's edited rule.\n");
    model([{ text: "Done." }]);
    await at.start("t-three");
    await expect.poll(() => api.requests.length).toBe(3);
    expect(sends()).toBe(2);
    expect(kept()).toBe(home_());
    expect(served()).toContain("The home's edited rule.");
    for (const absent of ["The home's first rule.", "The computer's own rule."])
      expect(served(), absent).not.toContain(absent);

    // The computer starts again: its roster names the version it keeps, and nothing is sent.
    await at.restartComputer();
    await at.inReach();
    expect(sends()).toBe(2);
    expect(kept()).toBe(home_());
  });

  // The captain's feature request: the skills of turned-on Claude Code
  // plugins reach every computer, follow plugin updates, need no links.
  it("carries the home's turned-on plugin skills there, and a plugin update once", async () => {
    const own = scratchDir("infinitary-personal-computer-");
    vi.stubEnv("HOME", own);
    const home = scratchDir("infinitary-personal-home-");
    const plugin = installClaudePlugin(home, { name: "claude-security", version: "0.12.0" });
    const plugins = () => readEnabledClaudePlugins(pluginSettings({ [plugin.id]: true }));

    const at = await world(undefined, { personal: { home, plugins } });
    const sends = () => at.ordered.filter((channel) => channel === "inf:session:personal").length;
    const keptPlugin = join(at.dataDir, "personal", "current", ".claude", "plugins", plugin.id);
    await expect.poll(sends).toBe(1);

    const asked = api.requests.length;
    model([{ text: "Done." }]);
    await at.start("t-one");
    await expect.poll(() => api.requests.length).toBe(asked + 1);
    expect(served()).toContain("<name>claude-security</name>");
    expect(served()).toContain(`- claude-security: ${keptPlugin}`);
    expect(served()).not.toContain(plugin.root);

    // Claude Code installs an update in a new folder; the next conversation reads it after one send.
    installClaudePlugin(home, {
      name: "claude-security",
      version: "0.13.0",
      skillText: "---\nname: claude-security\ndescription: Scan, updated.\n---\nScan.\n",
    });
    model([{ text: "Done." }, { text: "Done." }]);
    await at.start("t-two");
    await at.start("t-three");
    await expect.poll(() => api.requests.length).toBe(asked + 3);
    expect(sends()).toBe(2);
    expect(served()).toContain("Scan, updated.");
  });
});
