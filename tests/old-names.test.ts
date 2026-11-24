import { describe, expect, it } from "vitest";
import { classify, oldNamesIn } from "../scripts/old-names";

/**
 * The old-name ledger (step 8 of the Infinitary rename, FI3-1780's plan:
 * "a ledger that classifies every remaining old name"; docs/infinitary-rename.md).
 * `pnpm check` runs it over the tree; here, what it says of one line.
 */
describe("the old-name ledger", () => {
  const classOf = (path: string, line: string) =>
    oldNamesIn(line).map((name) => [name.name, classify(path, line, name)?.class ?? null]);

  it("refuses an old name new code writes, whatever its family", () => {
    for (const line of [
      "const dir = process.env.FM3000_NEW_SETTING;",
      'const ref = "refs/fm3000/kept/x";',
      "window.firstmate.cards.list();",
      'await invoke("fm:cards:list");',
      '<button data-fm-action="go">Go</button>',
      'import { Button } from "@firstmate/ui";',
      'const tmp = mkdtempSync(join(tmpdir(), "fm3000-new-"));',
      'run("fm-browser-axi snapshot");',
      'const TOOL = "mcp__firstmate__report";',
      // The product's name with a space, as the token files' headers had it
      // (INF-540: the ledger missed the spaced spelling).
      '/* Firstmate 3000 — color system. Dark ("deep space") is the default theme. */',
      'const title = "Firstmate 3000";',
    ]) {
      const found = classOf("src/core/new.ts", line);
      expect(found, line).not.toEqual([]);
      for (const [name, rule] of found) expect(rule, `${name} in ${line}`).toBeNull();
    }
  });

  it("finds Firstmate 3000 however it is spelled, a space included (INF-540)", () => {
    for (const name of ["Firstmate 3000", "firstmate-3000", "firstmate3000", "FM3000", "fm-3000"])
      expect(oldNamesIn(`the ${name} folder`), name).toEqual([{ family: "3000", name }]);
  });

  it("keeps a reader, an outside identity and history, each for what it is", () => {
    expect(
      classOf(
        "src/shared/envSettings.ts",
        'export const SETTING_PREFIXES = ["INFINITARY_", "FM3000_"] as const;',
      ),
    ).toEqual([["FM3000_", "reader"]]);
    expect(
      classOf(
        "src/shared/workUpdate.ts",
        'export const WORK_UPDATE_ORDER = "fm:firstmate:update";',
      ),
    ).toEqual([["fm:firstmate:update", "reader"]]);
    expect(classOf("electron-builder.yml", "appId: com.kunchenguid.firstmate3000")).toEqual([
      ["firstmate3000", "identity"],
    ]);
    expect(classOf("src/core/telemetry.ts", 'const DEFAULT_APP = "firstmate-3000";')).toEqual([
      ["firstmate-3000", "identity"],
    ]);
    expect(classOf("CHANGELOG.md", "* fetch quota with FM3000-managed keys")).toEqual([
      ["FM3000", "history"],
    ]);
    expect(classOf("src/core/telemetry.ts", 'const DEFAULT_TITLE = "Firstmate 3000";')).toEqual([
      ["Firstmate 3000", "identity"],
    ]);
    expect(
      classOf(
        "src/main/handOverPage.ts",
        "/** The two apps by the names a person knows them: `from` Firstmate 3000, `to` Infinitary. */",
      ),
    ).toEqual([["Firstmate 3000", "identity"]]);
    expect(
      classOf(
        ".claude/skills/infinitary-design/copy/Vocabulary.prompt.md",
        "| Firstmate 3000, FM3000, Firstmate, for the app | Infinitary, the app's name |",
      ),
    ).toEqual([
      ["Firstmate 3000", "words"],
      ["FM3000", "words"],
    ]);
  });
});
