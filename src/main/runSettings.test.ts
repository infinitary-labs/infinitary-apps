import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import { readRunSettings } from "./runSettings";

/**
 * The settings file a run names (docs/run.md, "A settings file"; INF-1228's
 * approved plan, piece 4: "`--settings <file>` names a file of settings.
 * With it, the app finds programs where the file says and asks no login
 * shell"). The folders below are the ones a Mac with Homebrew and nvm, or a
 * Linux account, would list.
 */

const HOMEBREW_AND_NVM = [
  "/opt/homebrew/bin",
  "/Users/fm/.nvm/versions/node/v22.11.0/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

function settingsFile(text: string, name = "infinitary.json"): { dir: string; file: string } {
  const dir = scratchDir("infinitary-run-settings-");
  const file = join(dir, name);
  writeFileSync(file, text);
  return { dir, file };
}

describe("a run's settings file", () => {
  it("lists the folders where programs are, in the file's order", () => {
    const { file } = settingsFile(`${JSON.stringify({ path: HOMEBREW_AND_NVM }, null, 2)}\n`);
    expect(readRunSettings(file)).toEqual({
      ok: true,
      file,
      settings: { path: HOMEBREW_AND_NVM },
    });
  });

  it("finds a file named from where the command ran, and names it in full", () => {
    const { dir, file } = settingsFile(JSON.stringify({ path: ["/home/fm/.local/bin"] }));
    expect(readRunSettings("infinitary.json", dir)).toMatchObject({ ok: true, file });
    expect(readRunSettings("missing.json", dir)).toEqual({
      ok: false,
      file: join(dir, "missing.json"),
      reason: "there is no file there",
    });
  });

  it("says why it cannot use a file, so a mistake never starts a run that guesses", () => {
    const reasons = Object.fromEntries(
      Object.entries({
        "not JSON": '{ "path": ["/usr/bin", ] }',
        "a list": '["/usr/bin", "/bin"]',
        "a misspelled setting": '{ "paths": ["/usr/bin"] }',
        "no path": "{}",
        "one string": '{ "path": "/opt/homebrew/bin:/usr/bin" }',
        "a folder from home": '{ "path": ["~/bin", "/usr/bin"] }',
        "two folders in one": '{ "path": ["/opt/homebrew/bin:/usr/bin"] }',
      }).map(([label, text]) => {
        const reading = readRunSettings(settingsFile(text).file);
        return [label, reading.ok ? "used" : reading.reason];
      }),
    );
    expect(reasons).toEqual({
      "not JSON": expect.stringMatching(/^it is not JSON \(.+\)$/),
      "a list": 'it must hold one object, such as { "path": ["/usr/bin", "/bin"] }',
      "a misspelled setting": 'it holds a setting Infinitary does not know, "paths"',
      "no path": 'it names no "path"',
      "one string": '"path" must be a list of folders',
      "a folder from home":
        '"~/bin" in "path" is not a full folder path, such as /opt/homebrew/bin',
      "two folders in one":
        '"/opt/homebrew/bin:/usr/bin" in "path" holds ":", so it names more than one folder',
    });
  });

  it("says a folder is not a file", () => {
    const dir = scratchDir("infinitary-run-settings-");
    mkdirSync(join(dir, "infinitary.json"));
    expect(readRunSettings(join(dir, "infinitary.json"))).toMatchObject({
      ok: false,
      reason: "it is a folder, not a file",
    });
  });
});
