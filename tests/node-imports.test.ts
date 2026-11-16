import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeEntries, refusedImports } from "../scripts/node-imports.ts";
import { scratchDir } from "./helpers/scratchDirs.ts";

const ROOT = resolve(import.meta.dirname, "..");

/**
 * The lint of imports plain Node can load (INF-4500's weekly audit, addition
 * 5, which the captain chose: "Two more pnpm check lints: contract up to
 * date, imports Node can load"). Three relative imports without their file's
 * extension passed the pull request check and failed later, in scripts that
 * plain Node starts (INF-4131). Here the lint reads the real project, and a
 * copy of the real classifier script with that one import changed.
 */
describe("imports plain Node can load", () => {
  it("finds the scripts plain Node starts, from commands and from tests", () => {
    const entries = nodeEntries(ROOT);
    // Named by a `node` command in package.json's check.
    expect(entries).toContain("scripts/old-names.ts");
    // Started by a test with the running Node, by its path's parts.
    expect(entries).toContain("scripts/score-kind-classifier.ts");
    // Loaded only through the Vite module runner, never by plain Node.
    expect(entries).not.toContain("scripts/account-models.ts");
  });

  it("passes the project as it is", () => {
    expect(refusedImports(ROOT, nodeEntries(ROOT))).toEqual([]);
  });

  it("refuses an import without its extension in a file a started script reaches", () => {
    const root = scratchDir("node-imports-");
    const copy = (file: string, edit: (text: string) => string = (text) => text) => {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), edit(readFileSync(join(ROOT, file), "utf8")));
    };
    // The classifier script reaches the provider catalog, which plain Node loads.
    copy("scripts/score-kind-classifier.ts", (text) =>
      text.replace('"../src/shared/providers.ts"', '"../src/shared/providers"'),
    );
    const refusals = refusedImports(root, ["scripts/score-kind-classifier.ts"]);
    expect(refusals).toEqual([
      expect.objectContaining({
        file: "scripts/score-kind-classifier.ts",
        specifier: "../src/shared/providers",
      }),
    ]);
  });

  it("follows a reached file's own imports, and skips the ones Node erases", () => {
    const root = scratchDir("node-imports-");
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(join(root, "src/shared"), { recursive: true });
    writeFileSync(
      join(root, "scripts/start.ts"),
      'import { word } from "../src/shared/words.ts";\nconsole.log(word);\n',
    );
    writeFileSync(
      join(root, "src/shared/words.ts"),
      [
        'import type { Word } from "./kinds";',
        'export { type Kind } from "./kinds";',
        'import { plain } from "./plain";',
        "export const word: Word = plain;",
        "",
      ].join("\n"),
    );
    // `export { type Kind }` still loads its module under Node; `import type` does not.
    expect(refusedImports(root, ["scripts/start.ts"])).toEqual([
      { file: "src/shared/words.ts", line: 2, specifier: "./kinds" },
      { file: "src/shared/words.ts", line: 3, specifier: "./plain" },
    ]);
  });
});
