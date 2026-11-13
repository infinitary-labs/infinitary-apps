import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CATALOG_DIR,
  catalogLayout,
  compileCatalogs,
  glossaryProblems,
  layoutProblems,
  PHONE_INFO_PLIST,
  PHONE_MESSAGES_PATH,
  readCatalogs,
  readGlossaries,
  sortedGlossary,
} from "../scripts/generate-messages";
import * as knowledgeWords from "../src/panels/knowledge/messages.generated";

// The approved plan (INF-3674, question 5 and "What done looks like"): the
// crewmate that changes the English writes every language's version in the
// same pull request, and `pnpm check` refuses a missing translation or one
// whose placeholders differ from English.
const english = readCatalogs().en ?? "";
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
    expect(
      compileCatalogs(readCatalogs(), readFileSync(PHONE_INFO_PLIST, "utf8")).problems,
    ).toEqual([]);
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
      expect.stringContaining("de/file.json: fileAdd is missing"),
      expect.stringContaining("de/file.json: fileRemoved is not in the English catalog"),
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
          "ar/composer.json: composerLines: ar needs the plural forms few, many, two, zero",
        ),
        expect.stringContaining(
          "ja/composer.json: composerLines: ja never uses the plural forms one",
        ),
      ]),
    );
  });

  it("refuses a hand-written pseudo-language and a placeholder that is not one", () => {
    const { problems } = compileCatalogs({
      en: JSON.stringify({ ...catalog, fileAdd: "Add {file name}" }),
      "en-XA": english,
    });
    expect(problems).toEqual([
      expect.stringContaining("en/file.json: fileAdd: {file name} is not a placeholder"),
      expect.stringContaining("messages/en-XA: en-XA is compiled from English; remove the folder"),
    ]);
  });
});

// INF-4066's direction 1, which the captain started: messages kept in name
// order, one file per area, so two changes adding different messages merge
// without a clash (tests/catalog-merges.test.ts merges two). The check
// refuses any other layout, so every change keeps the order a merge needs.
describe("the catalogs' layout", () => {
  const files = { en: catalogLayout(catalog) };

  it("holds the project's own catalogs and glossaries as the compiler lays them out", () => {
    const real = Object.fromEntries(
      Object.entries(readCatalogs()).map(([tag, text]) => [tag, catalogLayout(JSON.parse(text))]),
    );
    expect(layoutProblems(real)).toEqual([]);
    expect(glossaryProblems(readGlossaries())).toEqual([]);
  });

  it("refuses an area file out of name order, a message in another area's file and a file from before the move", () => {
    const { fileAdd, fileCancel, ...rest } = JSON.parse(files.en.file ?? "{}") as Record<
      string,
      unknown
    >;
    const reordered = `${JSON.stringify({ fileCancel, fileAdd, ...rest }, null, 2)}\n`;
    const crowded = `${JSON.stringify({ ...JSON.parse(files.en.composer ?? "{}"), fileAdd }, null, 2)}\n`;
    expect(
      layoutProblems({ en: { ...files.en, file: reordered, composer: crowded } }, [
        `${CATALOG_DIR}/de.json`,
      ]),
    ).toEqual([
      `${CATALOG_DIR}/de.json: each language's catalog is a folder of area files now; run node scripts/move-catalogs.ts`,
      `${CATALOG_DIR}/en/file.json: fileAdd is in another file too; keep it once, in ${CATALOG_DIR}/en/file.json`,
      `${CATALOG_DIR}/en/composer.json: fileAdd belongs in ${CATALOG_DIR}/en/file.json; run node scripts/generate-messages.ts`,
      `${CATALOG_DIR}/en/file.json: keep its messages in name order, as the compiler writes them; run node scripts/generate-messages.ts`,
    ]);
  });

  it("refuses a glossary whose terms are out of name order, and puts them in order", () => {
    const [path, text] = Object.entries(readGlossaries())[0] ?? ["", ""];
    // The Terms rows: every table line after the header and its separator.
    const lines = text.split("\n");
    const rows = lines
      .slice(lines.findIndex((line) => line.startsWith("| ---")) + 1)
      .filter((line) => line.startsWith("|"));
    const appended = `${text.replace(`${rows[0]}\n`, "")}`.replace(
      `${rows.at(-1)}\n`,
      `${rows.at(-1)}\n${rows[0]}\n`,
    );
    expect(glossaryProblems({ [path]: appended })).toEqual([
      `${path}: keep the Terms rows in name order by their English term; run node scripts/generate-messages.ts`,
    ]);
    expect(sortedGlossary(appended)).toBe(text);
  });
});

// This task's ask: the app's own panels show their words in the chosen
// language. A panel's frame cannot import the shared catalog, so its words
// are compiled into its own folder and follow the frame's `<html lang>`.
describe("an app panel's own messages", () => {
  afterEach(() => vi.unstubAllGlobals());

  const japanese = JSON.parse(readCatalogs().ja ?? "{}") as Record<string, unknown>;

  it("speak the language the panel's frame opened in", () => {
    vi.stubGlobal("document", { documentElement: { lang: "ja" } });
    expect(knowledgeWords.knowledgePanelTabConcepts()).toBe(japanese.knowledgePanelTabConcepts);
  });

  it("speak English in a frame that names no language", () => {
    vi.stubGlobal("document", { documentElement: { lang: "" } });
    expect(knowledgeWords.knowledgePanelTabConcepts()).toBe(catalog.knowledgePanelTabConcepts);
  });
});

// The approved plan for the phone's languages (INF-3675, piece 2): the phone's
// own words and its three permission prompts move into the catalog. The
// phone's own words compile into the phone alone, and iOS reads the prompts
// in the phone's language from InfoPlist.strings.
describe("the phone's own messages", () => {
  const infoPlist = readFileSync(PHONE_INFO_PLIST, "utf8");

  it("compile into the phone's typed messages and stay out of the desktop's file", () => {
    const { output, phone } = compileCatalogs({ en: english }, infoPlist);
    expect(phone[PHONE_MESSAGES_PATH]).toContain("func `phoneCommonCancel`()");
    expect(output).not.toContain("phoneCommonCancel");
  });

  it("word each permission prompt in InfoPlist.strings, and refuse an Info.plist that drifted from the catalog", () => {
    const { phone, problems } = compileCatalogs({ en: english }, infoPlist);
    expect(problems).toEqual([]);
    expect(phone["ios/Infinitary/InfinitaryApp/en.lproj/InfoPlist.strings"]).toContain(
      `"NSCameraUsageDescription" = ${JSON.stringify(catalog.phonePromptCamera)};`,
    );
    const drifted = infoPlist.replace(
      String(catalog.phonePromptFaceId),
      "Infinitary uses Face ID.",
    );
    expect(compileCatalogs({ en: english }, drifted).problems).toEqual([
      expect.stringContaining("NSFaceIDUsageDescription must read as"),
    ]);
  });
});
