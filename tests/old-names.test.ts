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
    ])
      for (const [name, found] of classOf("src/core/new.ts", line))
        expect(found, `${name} in ${line}`).toBeNull();
  });

  it("keeps a reader, an outside identity and history, each for what it is", () => {
    expect(
      classOf(
        "src/shared/envSettings.ts",
        'export const SETTING_PREFIXES = ["INFINITARY_", "FM3000_"] as const;',
      ),
    ).toEqual([["FM3000_", "reader"]]);
    expect(
      classOf("src/shared/work.ts", 'export const WORK_UPDATE_ORDER = "fm:firstmate:update";'),
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
  });
});
