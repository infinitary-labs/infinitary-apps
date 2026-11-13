import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileCatalogs, readCatalogs } from "../scripts/generate-messages";
import * as knowledgeWords from "../src/panels/knowledge/messages.generated";

// The approved plan (INF-3674, question 5 and "What done looks like"): the
// crewmate that changes the English writes every language's version in the
// same pull request, and `pnpm check` refuses a missing translation or one
// whose placeholders differ from English.
const english = readFileSync("src/shared/i18n/messages/en.json", "utf8");
const catalog = JSON.parse(english) as Record<string, unknown>;

/** A German catalog translated from the real English one, then changed by `edit`. */
function german(edit: (messages: Record<string, unknown>) => void): string {
  const messages: Record<string, unknown> = {
    ...catalog,
    composerLines: { plural: "count", one: "{count} Zeile", other: "{count} Zeilen" },
    fileAdd: "Dateien hinzufügen",
    fileCancel: "Vorbereitung von {name} abbrechen",
  };
  edit(messages);
  return JSON.stringify(messages);
}

describe("the message compiler", () => {
  it("compiles the project's own catalogs with no problem", () => {
    expect(compileCatalogs(readCatalogs()).problems).toEqual([]);
  });

  it("compiles a whole translation into a branch of each message", () => {
    const { output, problems } = compileCatalogs({ en: english, de: german(() => {}) });
    expect(problems).toEqual([]);
    expect(output).toContain('["en","de","en-XA","ar-XB"]');
    expect(output).toContain("`Vorbereitung von ${name} abbrechen`");
  });

  it("refuses a translation missing a message, or holding one English does not", () => {
    const { problems } = compileCatalogs({
      en: english,
      de: german((messages) => {
        delete messages.fileAdd;
        messages.fileRemoved = "Entfernt";
      }),
    });
    expect(problems).toEqual([
      expect.stringContaining("de.json: fileAdd is missing"),
      expect.stringContaining("de.json: fileRemoved is not in the English catalog"),
    ]);
  });

  it("refuses a translation whose placeholders or count differ from English", () => {
    const { problems } = compileCatalogs({
      en: english,
      de: german((messages) => {
        messages.fileCancel = "Vorbereitung von {datei} abbrechen";
        messages.composerLines = { plural: "lines", one: "{lines} Zeile", other: "{lines} Zeilen" };
      }),
    });
    expect(problems).toEqual([
      expect.stringContaining("composerLines: fills {lines} where English fills {count}"),
      expect.stringContaining('composerLines: counts "lines" where English counts "count"'),
      expect.stringContaining("fileCancel: fills {datei} where English fills {name}"),
    ]);
  });

  it("asks each language for its own plural forms: Arabic's six, Japanese's one", () => {
    const { problems } = compileCatalogs({
      en: english,
      ar: JSON.stringify({
        ...catalog,
        composerLines: { plural: "count", one: "سطر {count}", other: "{count} سطر" },
      }),
      ja: JSON.stringify({
        ...catalog,
        composerLines: { plural: "count", one: "{count} 行", other: "{count} 行" },
      }),
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "ar.json: composerLines: ar needs the plural forms few, many, two, zero",
        ),
        expect.stringContaining("ja.json: composerLines: ja never uses the plural forms one"),
      ]),
    );
  });

  it("refuses a hand-written pseudo-language and a placeholder that is not one", () => {
    const { problems } = compileCatalogs({
      en: JSON.stringify({ ...catalog, fileAdd: "Add {file name}" }),
      "en-XA": english,
    });
    expect(problems).toEqual([
      expect.stringContaining("en.json: fileAdd: {file name} is not a placeholder"),
      expect.stringContaining("en-XA.json: en-XA is compiled from English; remove the file"),
    ]);
  });
});

// This task's ask: the app's own panels show their words in the chosen
// language. A panel's frame cannot import the shared catalog, so its words
// are compiled into its own folder and follow the frame's `<html lang>`.
describe("an app panel's own messages", () => {
  afterEach(() => vi.unstubAllGlobals());

  const japanese = JSON.parse(readFileSync("src/shared/i18n/messages/ja.json", "utf8")) as Record<
    string,
    unknown
  >;

  it("speak the language the panel's frame opened in", () => {
    vi.stubGlobal("document", { documentElement: { lang: "ja" } });
    expect(knowledgeWords.knowledgePanelTabConcepts()).toBe(japanese.knowledgePanelTabConcepts);
  });

  it("speak English in a frame that names no language", () => {
    vi.stubGlobal("document", { documentElement: { lang: "" } });
    expect(knowledgeWords.knowledgePanelTabConcepts()).toBe(catalog.knowledgePanelTabConcepts);
  });
});
