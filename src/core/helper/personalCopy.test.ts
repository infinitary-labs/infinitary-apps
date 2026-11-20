import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installClaudePlugin, pluginSettings } from "../../../tests/helpers/claudePluginHome";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { readEnabledClaudePlugins } from "../claude/claudePlugins";
import { personalResources } from "../session/personalResources";
import {
  type PersonalFile,
  personalFingerprint,
  personalFingerprintOf,
  personalSetFiles,
} from "../session/personalSet";
import { PersonalCopy, type PersonalKeep } from "./personalCopy";

/**
 * The home's set as a computer that runs work keeps it
 * (docs/personal-resources.md, "One set, kept on each computer"): what it
 * keeps matches the fingerprint the home named, stays inside the reader's
 * folders, and replaces the version before it whole.
 */

function set(files: PersonalFile[], since = 1): PersonalKeep {
  return {
    version: personalFingerprint(files),
    since,
    files: files.map((file) => ({
      path: file.path,
      data: file.data.toString("base64"),
      ...(file.exec ? { exec: true } : {}),
    })),
  };
}

const skill = (text: string): PersonalFile[] => [
  { path: "AGENTS.md", data: Buffer.from(text), exec: false },
  {
    path: ".claude/skills/rivets/SKILL.md",
    data: Buffer.from("---\nname: rivets\ndescription: Rivets.\n---\n"),
    exec: false,
  },
  { path: ".claude/skills/rivets/count.sh", data: Buffer.from("echo 2\n"), exec: true },
];

describe("the personal set a computer keeps", () => {
  it("keeps the home's files under its current folder, executable where the home's were", () => {
    const dir = scratchDir("infinitary-personal-copy-");
    const copy = new PersonalCopy(dir);
    expect(copy.held()).toBeUndefined();
    const sent = set(skill("Rule one.\n"), 42);
    expect(copy.keep(sent)).toEqual({ version: sent.version, since: 42, files: 3 });
    expect(copy.held()).toEqual({ version: sent.version, since: 42, files: 3 });
    expect(readFileSync(join(copy.root(), "AGENTS.md"), "utf8")).toBe("Rule one.\n");
    expect(statSync(join(copy.root(), ".claude/skills/rivets/count.sh")).mode & 0o111).not.toBe(0);
    expect(statSync(join(copy.root(), ".claude/skills/rivets/SKILL.md")).mode & 0o111).toBe(0);
  });

  it("replaces the version before it whole and keeps nothing else", () => {
    const dir = scratchDir("infinitary-personal-copy-");
    const copy = new PersonalCopy(dir);
    const first = set(skill("Rule one.\n"));
    copy.keep(first);
    const second = set([{ path: "AGENTS.md", data: Buffer.from("Rule two.\n"), exec: false }], 2);
    copy.keep(second);
    expect(copy.held()?.version).toBe(second.version);
    expect(readFileSync(join(copy.root(), "AGENTS.md"), "utf8")).toBe("Rule two.\n");
    expect(existsSync(join(copy.root(), ".claude"))).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(
      ["current", `v-${second.version}`, `v-${second.version}.json`].sort(),
    );
  });

  it("refuses a set whose files do not have the fingerprint the home named, and keeps the one before", () => {
    const dir = scratchDir("infinitary-personal-copy-");
    const copy = new PersonalCopy(dir);
    const first = set(skill("Rule one.\n"));
    copy.keep(first);
    const torn = {
      ...set(skill("Rule two.\n")),
      version: personalFingerprint(skill("Rule three.\n")),
    };
    expect(() => copy.keep(torn)).toThrow(/another fingerprint/);
    expect(copy.held()?.version).toBe(first.version);
    expect(readFileSync(join(copy.root(), "AGENTS.md"), "utf8")).toBe("Rule one.\n");
    expect(readdirSync(dir).filter((name) => name.startsWith(".incoming-"))).toEqual([]);
  });

  it("refuses a file outside the instruction files and the skill folders", () => {
    for (const path of [
      "../AGENTS.md",
      "/etc/AGENTS.md",
      ".ssh/config",
      ".claude/settings.json",
      ".claude/skills/README.md",
      ".claude/skills/rivets/../../settings.json",
      ".agents/skills/./rivets/SKILL.md",
      ".claude/plugins/README.md",
      ".claude/plugins/../settings.json",
      ".claude/plugins/.hidden/SKILL.md",
      ".claude/plugin/tools@market/SKILL.md",
    ]) {
      const dir = scratchDir("infinitary-personal-copy-");
      const files = [{ path, data: Buffer.from("x"), exec: false }];
      expect(() => new PersonalCopy(dir).keep(set(files)), path).toThrow(/outside its folders/);
      expect(new PersonalCopy(dir).held(), path).toBeUndefined();
    }
  });

  // The captain's feature request: plugin skills reach every computer without
  // manual links, and follow plugin updates.
  it("keeps a turned-on plugin's skills and own files under its id, never its other parts", async () => {
    const home = scratchDir("infinitary-personal-plugin-home-");
    const plugin = installClaudePlugin(home, { name: "claude-security", version: "0.12.0" });
    const setting = await readEnabledClaudePlugins(pluginSettings({ [plugin.id]: true }));
    const sent = personalSetFiles(home, setting);
    const inside = `.claude/plugins/${plugin.id}`;
    expect(sent.files.map((file) => file.path).sort()).toEqual(
      [
        `${inside}/.claude-plugin/plugin.json`,
        `${inside}/README.md`,
        `${inside}/scripts/lib/finding.py`,
        `${inside}/scripts/render_report.py`,
        `${inside}/skills/claude-security/SKILL.md`,
      ].sort(),
    );
    // A computer without the plugins change is sent the set without them.
    expect(personalSetFiles(home, undefined).files).toEqual([]);
    const copy = new PersonalCopy(scratchDir("infinitary-personal-copy-"));
    copy.keep(set(sent.files));
    expect(personalFingerprintOf(copy.root())).toBe(personalFingerprint(sent.files));
    expect(statSync(join(copy.root(), inside, "scripts/render_report.py")).mode & 0o111).not.toBe(
      0,
    );
    const kept = personalResources(copy.root(), new Set(), { kept: true });
    expect(kept.plugins).toEqual([
      {
        id: plugin.id,
        name: "claude-security",
        root: join(copy.root(), inside),
        skills: [
          { name: "claude-security", dir: join(copy.root(), inside, "skills/claude-security") },
        ],
      },
    ]);
    const home2 = personalResources(home, new Set(), { enabled: setting });
    expect(kept.digests).toEqual(home2.digests);
    // An update is a new version of the set, under the same paths: one send, nothing to relink.
    installClaudePlugin(home, { name: "claude-security", version: "0.13.0" });
    const updated = personalSetFiles(home, setting).files;
    expect(updated.map((file) => file.path)).toEqual(sent.files.map((file) => file.path));
    expect(personalFingerprint(updated)).not.toBe(personalFingerprint(sent.files));
  });

  // A plugin's links reach only its own files: nothing outside it reaches another computer.
  it("leaves out a plugin's links that lead outside it, and keeps its links to its own files", async () => {
    const home = scratchDir("infinitary-personal-plugin-links-");
    const plugin = installClaudePlugin(home, { name: "claude-security" });
    const elsewhere = join(home, "elsewhere");
    mkdirSync(join(elsewhere, "leaked"), { recursive: true });
    writeFileSync(join(elsewhere, "keys.txt"), "not the plugin's\n");
    writeFileSync(
      join(elsewhere, "leaked", "SKILL.md"),
      "---\nname: leaked\ndescription: Leaked.\n---\n",
    );
    symlinkSync(join(elsewhere, "keys.txt"), join(plugin.root, "keys.txt"));
    symlinkSync(elsewhere, join(plugin.root, "references"));
    symlinkSync(join(elsewhere, "keys.txt"), join(plugin.root, "scripts", "keys.txt"));
    symlinkSync(join(elsewhere, "leaked"), join(plugin.root, "skills", "leaked"));
    symlinkSync(join(plugin.root, "scripts", "render_report.py"), join(plugin.root, "report.py"));
    const setting = await readEnabledClaudePlugins(pluginSettings({ [plugin.id]: true }));
    const inside = `.claude/plugins/${plugin.id}`;
    const paths = personalSetFiles(home, setting).files.map((file) => file.path);
    expect(paths).toContain(`${inside}/report.py`);
    expect(paths).toContain(`${inside}/scripts/render_report.py`);
    for (const path of paths) expect(path).not.toMatch(/keys\.txt|references|leaked/);
    const listed = personalResources(home, new Set(), { enabled: setting }).plugins;
    expect(listed.flatMap((each) => each.skills.map((skill) => skill.name))).toEqual([
      "claude-security",
    ]);
  });
});
