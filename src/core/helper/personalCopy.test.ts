import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { type PersonalFile, personalFingerprint } from "../session/personalSet";
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
    ]) {
      const dir = scratchDir("infinitary-personal-copy-");
      const files = [{ path, data: Buffer.from("x"), exec: false }];
      expect(() => new PersonalCopy(dir).keep(set(files)), path).toThrow(/outside its folders/);
      expect(new PersonalCopy(dir).held(), path).toBeUndefined();
    }
  });
});
