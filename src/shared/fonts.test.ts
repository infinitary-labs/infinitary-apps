import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computerLanguagesArgument,
  computerLanguagesFromArgv,
  fontChoicesSchema,
  fontDeclarations,
  fontStyleRule,
  SCRIPT_FACES,
  scriptOrder,
} from "./fonts";

// The approved font plan (INF-3982): direction B, any installed font for the
// app, reading and code, and text in another script taking its letters in
// the order of the computer's own languages.

describe("scriptOrder", () => {
  it("puts the computer's own languages' scripts after the app's language, most preferred first", () => {
    expect(scriptOrder("en", ["en-US", "ja-JP", "zh-Hans-CN"])).toEqual(["ja", "zh-Hans"]);
    expect(scriptOrder("en", ["zh-TW", "ja"])).toEqual(["zh-Hant", "ja"]);
    expect(scriptOrder("ja", ["en-US", "zh-HK", "ja-JP"])).toEqual(["ja", "zh-Hant"]);
  });

  it("names no script for a computer that reads only Latin letters", () => {
    expect(scriptOrder("en", ["en-GB", "fr-FR", "de"])).toEqual([]);
  });
});

describe("fontDeclarations", () => {
  it("sets each chosen face with Infinitary's own after it, and leaves the rest to the tokens", () => {
    expect(fontDeclarations({ app: "Inter", code: "ui-monospace" }, [])).toEqual({
      "--font-ui-face": '"Inter", "Space Grotesk"',
      "--font-mono-face": 'ui-monospace, "JetBrains Mono"',
    });
    expect(fontDeclarations({ reading: "Iowan Old Style" }, [])).toEqual({
      "--font-text-face": '"Iowan Old Style", "Space Grotesk"',
    });
    expect(fontDeclarations({}, [])).toEqual({});
  });

  it("lists the script faces in order, each face once", () => {
    const declarations = fontDeclarations({}, ["ja", "zh-Hans"]);
    expect(declarations["--font-script-ui"]).toBe(
      [...(SCRIPT_FACES.ja?.ui ?? []), ...(SCRIPT_FACES["zh-Hans"]?.ui ?? [])]
        .map((face) => `"${face}"`)
        .join(", "),
    );
    expect(declarations["--font-script-mono"]?.startsWith('"Hiragino Sans"')).toBe(true);
  });

  it("writes a frame rule that wins over the tokens' own language rules", () => {
    expect(fontStyleRule({ "--font-ui-face": '"Inter", "Space Grotesk"' })).toBe(
      ':root { --font-ui-face: "Inter", "Space Grotesk" !important; }',
    );
    expect(fontStyleRule({})).toBe("");
  });
});

describe("fontChoicesSchema", () => {
  it("takes any family name and refuses one that could leave its CSS string or style element", () => {
    expect(
      fontChoicesSchema.safeParse({ app: "Hiragino Mincho ProN", code: "Fira Code" }).success,
    ).toBe(true);
    for (const family of ['A"; } body { color: red', "x</style><script>", "a\\b", "", "a;b"])
      expect(fontChoicesSchema.safeParse({ app: family }).success).toBe(false);
  });
});

describe("the computer's languages argument", () => {
  it("carries every language the computer prefers to the window, in order", () => {
    const argument = computerLanguagesArgument(["en-US", "ja-JP", "not a tag", "zh-Hans-CN"]);
    expect(computerLanguagesFromArgv(["--other", argument])).toEqual([
      "en-US",
      "ja-JP",
      "zh-Hans-CN",
    ]);
    expect(computerLanguagesFromArgv([])).toEqual([]);
  });
});

it("names the same script faces as the type tokens' language rules", () => {
  const css = readFileSync(
    join(import.meta.dirname, "../renderer/src/design/tokens/typography.css"),
    "utf8",
  );
  const faces = (list: string) => [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  const rules = Object.fromEntries(
    [...css.matchAll(/:root:lang\(([\w-]+)\)\s*\{([^}]*)\}/g)]
      .filter((match) => match[2]?.includes("--font-script-ui"))
      .map((match) => {
        const body = match[2] ?? "";
        return [
          match[1],
          {
            ui: faces(/--font-script-ui:([^;]*);/.exec(body)?.[1] ?? ""),
            mono: faces(/--font-script-mono:([^;]*);/.exec(body)?.[1] ?? ""),
          },
        ];
      }),
  );
  expect(rules).toEqual(SCRIPT_FACES);
});
