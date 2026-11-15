/**
 * The message compiler (docs/i18n.md, "The catalog"): reads every language's
 * catalog under src/shared/i18n/messages/, one folder per language of area
 * files (`messages/<tag>/<area>.json`), checks each against the English
 * source, and writes src/shared/i18n/messages.generated.ts, one typed
 * function per message that answers in the process's current language.
 * The compiled file imports only its siblings, so it runs in every process
 * with no package at run time. It is built, never committed: install, the
 * typecheck, the tests and the build each write it first
 * (`writeCompiledMessages`).
 *
 * Each area file keeps its messages in name order, and each glossary its
 * terms, so two changes that add different messages write different lines
 * and merge without a clash; the compiler lays the catalogs and glossaries
 * out that way when it writes, and `--check` refuses any other layout.
 *
 * An app panel's own messages, named with its prefix (`APP_PANEL_PREFIXES`),
 * compile instead into `messages.generated.ts` in the panel's folder: a panel
 * reaches only React, the design library and its own files (docs/i18n.md,
 * "The app's own panels"), so that module imports nothing and reads the
 * language its frame's document speaks.
 *
 * It also writes the phone's side (docs/i18n.md, "On the phone"): Apple's
 * string files for each language the phone ships, typed Swift functions that
 * word them, and the parity fixture the phone's tests replay against the
 * desktop's own wording of saved facts.
 *
 *   node scripts/generate-messages.ts             lays out the catalogs and glossaries, writes the compiled files
 *   node scripts/generate-messages.ts --check     exits 1 naming each catalog problem, or a phone file out of step
 *   node scripts/generate-messages.ts --compiled  writes only the desktop's compiled modules
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isPseudoLanguage,
  languageFormatTag,
  PSEUDO_LANGUAGES,
  SOURCE_LANGUAGE,
} from "../src/shared/i18n/languages.ts";
import { printErrors } from "./github-errors.ts";

export const CATALOG_DIR = "src/shared/i18n/messages";
export const COMPILED_PATH = "src/shared/i18n/messages.generated.ts";
/** The design skill's glossaries, one per translation (docs/i18n.md, "Translating"). */
export const GLOSSARY_DIR = ".claude/skills/infinitary-design/copy/glossary";

/** Names in order: by UTF-16 code unit, the same on every computer. */
export const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A message's area: its name's first word, `file` for `fileCancel`. Each
 * language keeps one file per area, `messages/<tag>/<area>.json`, with its
 * messages in name order (docs/i18n.md, "The catalog").
 */
export function areaOf(id: string): string {
  return /^[a-z0-9]+/.exec(id)?.[0] ?? id;
}

/** The file a language's message lives in. */
export const catalogFile = (tag: string, id: string): string =>
  `${CATALOG_DIR}/${tag}/${areaOf(id)}.json`;

const PHONE_KIT = "ios/Infinitary/InfinitaryKit";
/** The typed Swift functions that word the phone's Apple string files. */
export const PHONE_MESSAGES_PATH = `${PHONE_KIT}/Sources/InfinitaryKit/PhoneMessages.generated.swift`;
/** The fixture the phone's tests replay: saved facts and the desktop's English for each. */
export const PHONE_WORDS_FIXTURE = `${PHONE_KIT}/Tests/InfinitaryKitTests/Fixtures/PhoneWords.generated.json`;
const phoneStringsDir = (tag: string) => `${PHONE_KIT}/Sources/InfinitaryKit/Resources/${tag}.lproj`;

/**
 * A message named with this prefix is the phone's own: it compiles into the
 * phone's Apple string files alone, never the desktop's compiled file, and no
 * saved fact names it (docs/i18n.md, "On the phone").
 */
export const PHONE_PREFIX = "phone";
const isPhoneOwn = (id: string) => new RegExp(`^${PHONE_PREFIX}[A-Z0-9]`).test(id);

/** The phone app's Info.plist, whose English permission prompts the catalog words in every language. */
export const PHONE_INFO_PLIST = "ios/Infinitary/Info.plist";
/** Each permission prompt's Info.plist key and the phone message that words it. */
export const PHONE_INFO_PLIST_MESSAGES: Readonly<Record<string, string>> = {
  NSCameraUsageDescription: "phonePromptCamera",
  NSFaceIDUsageDescription: "phonePromptFaceId",
  NSLocalNetworkUsageDescription: "phonePromptLocalNetwork",
};
const phoneInfoPlistStrings = (tag: string) => `ios/Infinitary/InfinitaryApp/${tag}.lproj/InfoPlist.strings`;

/**
 * Each app panel folder's message prefix: a message named with it belongs to
 * that panel alone and compiles into the panel's own module, never the
 * shared one (docs/i18n.md, "The app's own panels").
 */
export const APP_PANEL_PREFIXES: Readonly<Record<string, string>> = {
  activity: "activityPanel",
  automation: "automationPanel",
  knowledge: "knowledgePanel",
  now: "nowPanel",
};

/** Where an app panel's messages compile to. */
export function panelMessagesPath(panel: string): string {
  return `src/panels/${panel}/messages.generated.ts`;
}

/** The app panel a message belongs to, by its name's prefix; none for a shared message. */
function panelOf(id: string): string | undefined {
  return Object.entries(APP_PANEL_PREFIXES).find(([, prefix]) =>
    new RegExp(`^${prefix}[A-Z0-9]`).test(id),
  )?.[0];
}

/** One run of a message: words, or a placeholder the caller fills in. */
type Part = { text: string } | { placeholder: string };

/** A message: one form, or one form per plural category of its selector. */
type Message = { kind: "text"; parts: Part[] } | { kind: "plural"; selector: string; forms: Map<string, Part[]> };

const IDENTIFIER = /^[a-z][A-Za-z0-9]*$/;
const PLURAL_CATEGORIES = new Set(["zero", "one", "two", "few", "many", "other"]);

/** A message's words split into runs; `{{` and `}}` write a brace. */
export function parseParts(source: string, where: string, problems: string[]): Part[] {
  const parts: Part[] = [];
  let text = "";
  for (let at = 0; at < source.length; at++) {
    const char = source[at];
    const next = source[at + 1];
    if ((char === "{" && next === "{") || (char === "}" && next === "}")) {
      text += char;
      at++;
      continue;
    }
    if (char === "}") {
      problems.push(`${where}: a lone } must be written }}`);
      continue;
    }
    if (char !== "{") {
      text += char;
      continue;
    }
    const end = source.indexOf("}", at);
    const name = end === -1 ? "" : source.slice(at + 1, end);
    if (!IDENTIFIER.test(name) || name === "input") {
      problems.push(`${where}: {${name}} is not a placeholder; name it in camelCase, or write a brace as {{`);
      at = end === -1 ? source.length : end;
      continue;
    }
    if (text) parts.push({ text });
    text = "";
    parts.push({ placeholder: name });
    at = end;
  }
  if (text) parts.push({ text });
  return parts;
}

function parseMessage(value: unknown, where: string, problems: string[]): Message | undefined {
  if (typeof value === "string") return { kind: "text", parts: parseParts(value, where, problems) };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    problems.push(`${where}: a message is a string, or an object with "plural" and one string per plural form`);
    return undefined;
  }
  const { plural: selector, ...rest } = value as Record<string, unknown>;
  if (typeof selector !== "string" || !IDENTIFIER.test(selector)) {
    problems.push(`${where}: "plural" names the count that picks the form, in camelCase`);
    return undefined;
  }
  const forms = new Map<string, Part[]>();
  for (const [category, form] of Object.entries(rest)) {
    if (!PLURAL_CATEGORIES.has(category) || typeof form !== "string") {
      problems.push(`${where}: "${category}" is not a plural form; use zero, one, two, few, many or other, each a string`);
      continue;
    }
    forms.set(category, parseParts(form, `${where}.${category}`, problems));
  }
  return { kind: "plural", selector, forms };
}

/** The placeholders a message fills, its plural count included. */
function placeholdersOf(message: Message): string[] {
  const parts = message.kind === "text" ? message.parts : [...message.forms.values()].flat();
  const names = new Set(parts.flatMap((part) => ("placeholder" in part ? [part.placeholder] : [])));
  if (message.kind === "plural") names.add(message.selector);
  return [...names].sort();
}

/** The plural forms a language's messages must each give, from the runtime's own plural rules. */
function categoriesOf(tag: string): string[] {
  return [...new Intl.PluralRules(tag).resolvedOptions().pluralCategories].sort();
}

function checkPluralForms(message: Message, tag: string, where: string, problems: string[]): void {
  if (message.kind !== "plural") return;
  const wanted = categoriesOf(tag);
  const given = [...message.forms.keys()].sort();
  const missing = wanted.filter((category) => !given.includes(category));
  const unused = given.filter((category) => !wanted.includes(category));
  if (missing.length) problems.push(`${where}: ${tag} needs the plural forms ${missing.join(", ")}`);
  if (unused.length) problems.push(`${where}: ${tag} never uses the plural forms ${unused.join(", ")}; remove them`);
}

type Catalog = Map<string, Message>;

function parseCatalog(tag: string, source: string, problems: string[]): Catalog {
  const catalog: Catalog = new Map();
  let entries: unknown;
  try {
    entries = JSON.parse(source);
  } catch (error) {
    problems.push(`${CATALOG_DIR}/${tag}: not JSON (${(error as Error).message})`);
    return catalog;
  }
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    problems.push(`${CATALOG_DIR}/${tag}: a catalog is one object of messages by name`);
    return catalog;
  }
  for (const [id, value] of Object.entries(entries)) {
    const where = `${catalogFile(tag, id)}: ${id}`;
    if (!IDENTIFIER.test(id)) {
      problems.push(`${where}: a message's name is camelCase, starting with a lowercase letter`);
      continue;
    }
    const message = parseMessage(value, where, problems);
    if (message) catalog.set(id, message);
  }
  return catalog;
}

/** Each translation against the source: the same names, the same placeholders, and its language's plural forms. */
function checkTranslation(tag: string, catalog: Catalog, source: Catalog, problems: string[]): void {
  for (const id of source.keys()) {
    if (!catalog.has(id))
      problems.push(`${catalogFile(tag, id)}: ${id} is missing; translate it in the change that wrote the English`);
  }
  for (const [id, message] of catalog) {
    const english = source.get(id);
    const where = `${catalogFile(tag, id)}: ${id}`;
    if (!english) {
      problems.push(`${where} is not in the English catalog; remove it`);
      continue;
    }
    const want = placeholdersOf(english).join(", ");
    const have = placeholdersOf(message).join(", ");
    if (want !== have) problems.push(`${where}: fills {${have}} where English fills {${want}}`);
    if (message.kind === "plural" && english.kind === "plural" && message.selector !== english.selector) {
      problems.push(`${where}: counts "${message.selector}" where English counts "${english.selector}"`);
    }
    checkPluralForms(message, tag, where, problems);
  }
}

const ACCENTED: Record<string, string> = Object.fromEntries(
  [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"].map((letter, index) => [
    letter,
    [..."áƀçðéƒĝĥîĵķļɱñöþǫŕšţûṽŵẋýžÅƁÇÐÉƑĜĤÎĴĶĻṀÑÖÞǪŔŠŢÛṼŴẊÝŽ"][index] as string,
  ]),
);

/**
 * The pseudo-languages' forms of an English message (docs/i18n.md, "The
 * pseudo-languages"): `en-XA` accents every letter, lengthens the words by
 * about a third and brackets the whole, so text that skipped the catalog
 * and text that would be cut off both show; `ar-XB` writes each run of
 * words right to left. Placeholders stay as the caller fills them.
 */
export function pseudoParts(tag: (typeof PSEUDO_LANGUAGES)[number], parts: Part[]): Part[] {
  if (tag === "ar-XB") return parts.map((part) => ("text" in part ? { text: `‮${part.text}‬` } : part));
  const letters = parts.reduce((sum, part) => sum + ("text" in part ? part.text.length : 0), 0);
  const accented = parts.map((part) =>
    "text" in part ? { text: [...part.text].map((char) => ACCENTED[char] ?? char).join("") } : part,
  );
  return [{ text: "[" }, ...accented, { text: ` ${"~".repeat(Math.ceil(letters / 3))}]` }];
}

function pseudoMessage(tag: (typeof PSEUDO_LANGUAGES)[number], message: Message): Message {
  if (message.kind === "text") return { kind: "text", parts: pseudoParts(tag, message.parts) };
  return {
    kind: "plural",
    selector: message.selector,
    forms: new Map([...message.forms].map(([category, parts]) => [category, pseudoParts(tag, parts)])),
  };
}

function templateOf(parts: Part[]): string {
  const body = parts
    .map((part) =>
      "text" in part
        ? part.text
            .replace(/[\\`]/g, (char) => `\\${char}`)
            .replace(/\$\{/g, "\\${")
            // Direction marks stay readable in the compiled file.
            .replace(/[‎‏‪-‮⁦-⁩]/g, (char) => `\\u${char.charCodeAt(0).toString(16)}`)
        : `\${${part.placeholder}}`,
    )
    .join("");
  return `\`${body}\``;
}

/** The return statement of one language's form of a message. */
function answerOf(message: Message, pluralLocale: string | undefined): string {
  if (message.kind === "text") return `return ${templateOf(message.parts)};`;
  const locale = pluralLocale ? `, ${JSON.stringify(pluralLocale)}` : "";
  const cases = [...message.forms]
    .filter(([category]) => category !== "other")
    .map(([category, parts]) => `case ${JSON.stringify(category)}: return ${templateOf(parts)};`);
  const other = message.forms.get("other") ?? [];
  return [
    `switch (pluralCategory(input.${message.selector}${locale})) {`,
    ...cases.map((line) => `      ${line}`),
    `      default: return ${templateOf(other)};`,
    "    }",
  ].join("\n");
}

function compiledFunction(id: string, english: Message, languages: [string, Catalog][]): string {
  const names = placeholdersOf(english);
  const selector = english.kind === "plural" ? english.selector : undefined;
  const params = names.map((name) => `${name}: ${name === selector ? "number" : "string"}`).join("; ");
  const signature = names.length ? `input: { ${params} }` : "";
  const fills = names.map((name) =>
    name === selector ? `  const ${name} = formatNumber(input.${name});` : `  const ${name} = input.${name};`,
  );
  const branches = languages.flatMap(([tag, catalog]) => {
    const message = catalog.get(id);
    if (!message) return [];
    const pluralLocale = isPseudoLanguage(tag) ? SOURCE_LANGUAGE : undefined;
    return [`    case ${JSON.stringify(tag)}:`, `      ${answerOf(message, pluralLocale).replace(/\n/g, "\n  ")}`];
  });
  return [
    `export function ${id}(${signature}): string {`,
    ...fills,
    ...(branches.length ? ["  switch (currentLanguage()) {", ...branches, "  }"] : []),
    `  ${answerOf(english, undefined)}`,
    "}",
  ].join("\n");
}

/** A run of words as Apple's format strings write it: `%` doubled, each placeholder by its place among English's blanks. */
function appleFormatOf(parts: Part[], blanks: string[], selector: string | undefined): string {
  return parts
    .map((part) => {
      if ("text" in part) return part.text.replace(/%/g, "%%");
      const place = blanks.indexOf(part.placeholder) + 1;
      return part.placeholder === selector ? `%${place}$ld` : `%${place}$@`;
    })
    .join("");
}

const stringsQuoted = (text: string) =>
  `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;
const xmlEscaped = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * One language's Apple string files: each plain message in
 * `Localizable.strings`, each plural one in `Localizable.stringsdict`, its
 * count picking the form by the language's own plural rules. Blanks are
 * numbered by their place in English's sorted list, as `MESSAGE_FILLS` lists
 * them, so a translation that reorders its words keeps its fills.
 */
function appleStringFiles(catalog: Catalog, english: Catalog): { strings: string; stringsdict: string } {
  const strings: string[] = [];
  const plurals: string[] = [];
  for (const [id, source] of english) {
    const message = catalog.get(id) ?? source;
    const blanks = placeholdersOf(source);
    if (message.kind === "text") {
      strings.push(`${stringsQuoted(id)} = ${stringsQuoted(appleFormatOf(message.parts, blanks, undefined))};`);
      continue;
    }
    const place = blanks.indexOf(message.selector) + 1;
    const forms = [...message.forms].map(
      ([category, parts]) =>
        `      <key>${category}</key>\n      <string>${xmlEscaped(appleFormatOf(parts, blanks, message.selector))}</string>`,
    );
    plurals.push(
      [
        `  <key>${id}</key>`,
        "  <dict>",
        "    <key>NSStringLocalizedFormatKey</key>",
        `    <string>%${place}$#@${message.selector}@</string>`,
        `    <key>${message.selector}</key>`,
        "    <dict>",
        "      <key>NSStringFormatSpecTypeKey</key>",
        "      <string>NSStringPluralRuleType</string>",
        "      <key>NSStringFormatValueTypeKey</key>",
        "      <string>ld</string>",
        ...forms,
        "    </dict>",
        "  </dict>",
      ].join("\n"),
    );
  }
  const header = "Generated by scripts/generate-messages.ts from src/shared/i18n/messages/; never edit by hand.";
  return {
    strings: [`/* ${header} */`, ...strings, ""].join("\n"),
    stringsdict: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      `<!-- ${header} -->`,
      '<plist version="1.0">',
      "<dict>",
      ...plurals,
      "</dict>",
      "</plist>",
      "",
    ].join("\n"),
  };
}

const swiftName = (name: string) => `\`${name}\``;

/**
 * The phone's typed messages: one Swift function per message, as the
 * desktop's compiled file has, worded from the Apple string files; and the
 * table `PhoneWords.word` fills a saved fact from.
 */
function phoneMessagesSwift(english: Catalog): string {
  const functions = [...english].map(([id, message]) => {
    const blanks = placeholdersOf(message);
    const selector = message.kind === "plural" ? message.selector : undefined;
    const params = blanks.map((name) => `${swiftName(name)}: ${name === selector ? "Int" : "String"}`).join(", ");
    return `    public static func ${swiftName(id)}(${params}) -> String { PhoneWords.format(${JSON.stringify(id)}, [${blanks.map(swiftName).join(", ")}]) }`;
  });
  const fills = [...english].map(([id, message]) => `        ${JSON.stringify(id)}: [${placeholdersOf(message).map((name) => JSON.stringify(name)).join(", ")}],`);
  const counts = [...english].flatMap(([id, message]) =>
    message.kind === "plural" ? [`        ${JSON.stringify(id)}: ${JSON.stringify(message.selector)},`] : [],
  );
  return [
    "// Generated by scripts/generate-messages.ts from src/shared/i18n/messages/; never edit by hand.",
    "// Run `node scripts/generate-messages.ts` after changing a catalog (docs/i18n.md, \"On the phone\").",
    "import Foundation",
    "",
    "/// The catalog's messages on the phone: one function per message, in the phone's language.",
    "public enum PhoneMessages {",
    ...functions,
    "}",
    "",
    "extension PhoneWords {",
    "    /// What each message fills, its count included, in the order its Apple format numbers them: the Mac's `MESSAGE_FILLS`.",
    "    static let fills: [String: [String]] = [",
    ...fills,
    "    ]",
    "",
    "    /// The fill whose count picks each plural message's form.",
    "    static let counts: [String: String] = [",
    ...counts,
    "    ]",
    "}",
    "",
  ].join("\n");
}

/** Every catalog checked and compiled: the compiled file's text, the panels' and the phone's files by path, and each problem found. */
export function compileCatalogs(sources: Record<string, string>, infoPlist?: string): {
  output: string;
  problems: string[];
  panels: Record<string, string>;
  phone: Record<string, string>;
  facts: Fact[];
} {
  const problems: string[] = [];
  const englishSource = sources[SOURCE_LANGUAGE];
  if (englishSource === undefined)
    return { output: "", problems: [`${CATALOG_DIR}/${SOURCE_LANGUAGE} is missing`], panels: {}, phone: {}, facts: [] };
  // Every compiled file lists the messages in name order, so a change adding one writes its own lines.
  const english: Catalog = new Map(
    [...parseCatalog(SOURCE_LANGUAGE, englishSource, problems)].sort(([a], [b]) => byName(a, b)),
  );
  for (const [id, message] of english) checkPluralForms(message, SOURCE_LANGUAGE, `${catalogFile(SOURCE_LANGUAGE, id)}: ${id}`, problems);
  const translations: [string, Catalog][] = [];
  for (const [tag, source] of Object.entries(sources).sort(([a], [b]) => a.localeCompare(b, "en"))) {
    if (tag === SOURCE_LANGUAGE) continue;
    if (isPseudoLanguage(tag)) {
      problems.push(`${CATALOG_DIR}/${tag}: ${tag} is compiled from English; remove the folder`);
      continue;
    }
    try {
      new Intl.Locale(tag);
    } catch {
      problems.push(`${CATALOG_DIR}/${tag}: ${tag} is not a language tag`);
      continue;
    }
    const catalog = parseCatalog(tag, source, problems);
    checkTranslation(tag, catalog, english, problems);
    translations.push([tag, catalog]);
  }
  const pseudo: [string, Catalog][] = PSEUDO_LANGUAGES.map((tag) => [
    tag,
    new Map([...english].map(([id, message]) => [id, pseudoMessage(tag, message)])),
  ]);
  const languages = [...translations, ...pseudo];
  const shared = [...english].filter(([id]) => panelOf(id) === undefined && !isPhoneOwn(id));
  const output = [
    "// Generated by scripts/generate-messages.ts from src/shared/i18n/messages/; never edit by hand.",
    "// Run `node scripts/generate-messages.ts` after changing a catalog (docs/i18n.md).",
    'import { currentLanguage } from "./current.ts";',
    'import { formatNumber, pluralCategory } from "./format.ts";',
    "",
    "/** The languages the catalog has: English, each translation, then the pseudo-languages. */",
    `export const CATALOG_LANGUAGES = ${JSON.stringify([SOURCE_LANGUAGE, ...languages.map(([tag]) => tag)])} as const;`,
    "",
    ...shared.map(([id, message]) => `${compiledFunction(id, message, languages)}\n`),
    "/** Every message by its name, for words saved as a fact and worded when shown (docs/i18n.md, \"Saved facts\"). */",
    `export const MESSAGES = { ${shared.map(([id]) => id).join(", ")} } as const;`,
    "",
    "/** The name of a message in the catalog. */",
    "export type MessageName = keyof typeof MESSAGES;",
    "",
    "/** What each message fills, its plural count included: a saved fact missing one is shown as saved. */",
    `export const MESSAGE_FILLS: Record<MessageName, readonly string[]> = ${JSON.stringify(Object.fromEntries(shared.map(([id, message]) => [id, placeholdersOf(message)])))};`,
    "",
  ].join("\n");
  const panels: Record<string, string> = {};
  for (const panel of Object.keys(APP_PANEL_PREFIXES)) {
    const own = [...english].filter(([id]) => panelOf(id) === panel);
    if (!own.length) continue;
    panels[panelMessagesPath(panel)] = panelModule(panel, own, languages);
  }
  // The phone takes every message: the shared ones a saved fact may name, its own, and a panel's own that the
  // phone's generated words call, such as the Tasks panel's row words. Its parity fixture replays the shared ones.
  const sharedCatalog: Catalog = new Map(shared);
  const phone: Record<string, string> = { [PHONE_MESSAGES_PATH]: phoneMessagesSwift(english) };
  // The phone ships every language the catalog has, the pseudo-languages aside, as the desktop does.
  const catalogs = new Map<string, Catalog>([[SOURCE_LANGUAGE, english], ...translations]);
  checkInfoPlist(english, [...catalogs.keys()], infoPlist, problems);
  for (const [tag, catalog] of catalogs) {
    const files = appleStringFiles(catalog, english);
    phone[`${phoneStringsDir(tag)}/Localizable.strings`] = files.strings;
    phone[`${phoneStringsDir(tag)}/Localizable.stringsdict`] = files.stringsdict;
    phone[phoneInfoPlistStrings(tag)] = infoPlistStrings(catalog, english);
  }
  return { output, problems, panels, phone, facts: phoneWordsFacts(sharedCatalog) };
}

/**
 * The permission prompts in one language, as `InfoPlist.strings` writes them:
 * each Info.plist key with its message's words. iOS shows them in the phone's
 * language when it asks.
 */
function infoPlistStrings(catalog: Catalog, english: Catalog): string {
  const lines = Object.entries(PHONE_INFO_PLIST_MESSAGES).map(([key, id]) => {
    const message = catalog.get(id) ?? english.get(id);
    const words = message?.kind === "text" ? message.parts.map((part) => ("text" in part ? part.text : "")).join("") : "";
    return `${stringsQuoted(key)} = ${stringsQuoted(words)};`;
  });
  return [
    "/* Generated by scripts/generate-messages.ts from src/shared/i18n/messages/; never edit by hand. */",
    ...lines,
    "",
  ].join("\n");
}

/**
 * Each permission prompt's message is plain words, and Info.plist's English is that message's, so the two never drift
 * apart; and Info.plist's `CFBundleLocalizations` names exactly the languages the phone ships, in the catalog's order,
 * so iOS offers each on the app's page in its Settings.
 */
function checkInfoPlist(english: Catalog, tags: readonly string[], plist: string | undefined, problems: string[]): void {
  if (plist === undefined) return;
  const listed = plist.match(/<key>CFBundleLocalizations<\/key>\s*<array>((?:\s*<string>[^<]*<\/string>)*)\s*<\/array>/)?.[1];
  const named = [...(listed ?? "").matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1]);
  if (named.join(",") !== tags.join(","))
    problems.push(`${PHONE_INFO_PLIST}: CFBundleLocalizations must list ${tags.join(", ")}, the languages the phone ships`);
  for (const [key, id] of Object.entries(PHONE_INFO_PLIST_MESSAGES)) {
    const message = english.get(id);
    if (!message || message.kind !== "text" || message.parts.some((part) => !("text" in part))) {
      problems.push(`${catalogFile(SOURCE_LANGUAGE, id)}: ${id} must be plain words with no blank, for ${key} in ${PHONE_INFO_PLIST}`);
      continue;
    }
    const words = message.parts.map((part) => ("text" in part ? part.text : "")).join("");
    const xml = xmlEscaped(words).replace(/"/g, "&quot;");
    const found = plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))?.[1];
    if (found !== xmlEscaped(words) && found !== xml)
      problems.push(`${PHONE_INFO_PLIST}: ${key} must read as ${catalogFile(SOURCE_LANGUAGE, id)}'s ${id}`);
  }
}

/**
 * An app panel's own messages as a module that imports nothing: the language
 * is the one its frame's document is born with (`lang`), English where there
 * is no document, as when a journey reads the words in Node; numbers and
 * plural forms follow that language as `src/shared/i18n/format.ts` writes them.
 */
function panelModule(panel: string, own: [string, Message][], languages: [string, Catalog][]): string {
  const formatTags = Object.fromEntries(
    [SOURCE_LANGUAGE, ...languages.map(([tag]) => tag)].map((tag) => [tag, languageFormatTag(tag)]),
  );
  const functions = own.map(([id, message]) => `${compiledFunction(id, message, languages)}\n`);
  // Only the helpers the panel's messages call, so a panel with no number or plural keeps none unused.
  const uses = (helper: string) => functions.some((text) => text.includes(`${helper}(`));
  const numbers = uses("formatNumber");
  const plurals = uses("pluralCategory");
  return [
    "// Generated by scripts/generate-messages.ts from src/shared/i18n/messages/; never edit by hand.",
    `// The ${panel} panel's own messages, named \`${APP_PANEL_PREFIXES[panel]}…\` (docs/i18n.md, "The app's own panels").`,
    "",
    ...(numbers || plurals
      ? [
          "/** Each catalog language's locale for numbers and plural forms (`languageFormatTag`). */",
          `const FORMAT_TAGS: Readonly<Record<string, string>> = ${JSON.stringify(formatTags)};`,
          "",
        ]
      : []),
    "/** The language the panel's frame document speaks, English with no document. */",
    "function currentLanguage(): string {",
    '  return (typeof document === "undefined" ? "" : document.documentElement.lang) || "en";',
    "}",
    "",
    ...(numbers
      ? [
          "function formatNumber(value: number): string {",
          '  return value.toLocaleString(FORMAT_TAGS[currentLanguage()] ?? "en-US");',
          "}",
          "",
        ]
      : []),
    ...(plurals
      ? [
          "function pluralCategory(count: number, locale = FORMAT_TAGS[currentLanguage()] ?? \"en-US\"): Intl.LDMLPluralRule {",
          "  return new Intl.PluralRules(locale).select(count);",
          "}",
          "",
        ]
      : []),
    ...functions,
  ].join("\n");
}

/** Each language's catalog files: its area files' text by area, by language. */
export type CatalogFiles = Record<string, Record<string, string>>;

/**
 * Every language's area files, and any file left from before the catalogs
 * were folders (`messages/<tag>.json`), which `scripts/move-catalogs.ts`
 * folds into its language's folder.
 */
export function readCatalogFiles(root = "."): { files: CatalogFiles; strays: string[] } {
  const dir = join(root, CATALOG_DIR);
  const files: CatalogFiles = {};
  const strays: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => byName(a.name, b.name))) {
    if (entry.isDirectory()) {
      files[entry.name] = Object.fromEntries(
        readdirSync(join(dir, entry.name))
          .filter((name) => name.endsWith(".json"))
          .sort(byName)
          .map((name) => [name.slice(0, -".json".length), readFileSync(join(dir, entry.name, name), "utf8")]),
      );
    } else if (entry.name.endsWith(".json")) strays.push(`${CATALOG_DIR}/${entry.name}`);
  }
  return { files, strays };
}

/** Each language's messages, its area files read into one object; a file that is not one JSON object of messages is a problem. */
export function joinCatalogFiles(files: CatalogFiles): {
  catalogs: Record<string, Record<string, unknown>>;
  problems: string[];
} {
  const catalogs: Record<string, Record<string, unknown>> = {};
  const problems: string[] = [];
  for (const [tag, areas] of Object.entries(files)) {
    const messages: Record<string, unknown> = {};
    for (const [area, text] of Object.entries(areas)) {
      const file = `${CATALOG_DIR}/${tag}/${area}.json`;
      let entries: unknown;
      try {
        entries = JSON.parse(text);
      } catch (error) {
        problems.push(`${file}: not JSON (${(error as Error).message})`);
        continue;
      }
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
        problems.push(`${file}: an area file is one object of messages by name`);
        continue;
      }
      for (const [id, value] of Object.entries(entries)) {
        if (id in messages) problems.push(`${file}: ${id} is in another file too; keep it once, in ${catalogFile(tag, id)}`);
        messages[id] = value;
      }
    }
    catalogs[tag] = messages;
  }
  return { catalogs, problems };
}

/** Each language's catalog as the one JSON text `compileCatalogs` reads. */
export function readCatalogs(root = "."): Record<string, string> {
  const { catalogs } = joinCatalogFiles(readCatalogFiles(root).files);
  return Object.fromEntries(Object.entries(catalogs).map(([tag, messages]) => [tag, JSON.stringify(messages)]));
}

/**
 * A language's messages as the compiler lays them out: one file per area,
 * each one JSON object with its messages in name order, so two changes that
 * add different messages write different lines (docs/i18n.md, "The catalog").
 */
export function catalogLayout(messages: Record<string, unknown>): Record<string, string> {
  const areas: Record<string, Record<string, unknown>> = {};
  for (const id of Object.keys(messages).sort(byName)) {
    const area = areaOf(id);
    areas[area] ??= {};
    areas[area][id] = messages[id];
  }
  return Object.fromEntries(
    Object.entries(areas)
      .sort(([a], [b]) => byName(a, b))
      .map(([area, entries]) => [area, `${JSON.stringify(entries, null, 2)}\n`]),
  );
}

/** Each place the catalog files differ from the compiler's layout. */
export function layoutProblems(files: CatalogFiles, strays: string[] = []): string[] {
  const problems = strays.map(
    (path) => `${path}: each language's catalog is a folder of area files now; run node scripts/move-catalogs.ts`,
  );
  const joined = joinCatalogFiles(files);
  problems.push(...joined.problems);
  for (const [tag, areas] of Object.entries(files)) {
    const wanted = catalogLayout(joined.catalogs[tag] ?? {});
    for (const [area, text] of Object.entries(areas)) {
      const file = `${CATALOG_DIR}/${tag}/${area}.json`;
      let entries: Record<string, unknown>;
      try {
        entries = JSON.parse(text) as Record<string, unknown>;
      } catch {
        continue;
      }
      const strangers = Object.keys(entries ?? {}).filter((id) => areaOf(id) !== area);
      for (const id of strangers)
        problems.push(`${file}: ${id} belongs in ${catalogFile(tag, id)}; run node scripts/generate-messages.ts`);
      if (!strangers.length && wanted[area] !== text)
        problems.push(
          `${file}: keep its messages in name order, as the compiler writes them; run node scripts/generate-messages.ts`,
        );
    }
  }
  return problems;
}

/** Writes a language's area files as `catalogLayout` lays them out, and removes one left with no message. */
export function writeCatalogLayout(root: string, tag: string, messages: Record<string, unknown>): void {
  const dir = join(root, CATALOG_DIR, tag);
  mkdirSync(dir, { recursive: true });
  const wanted = catalogLayout(messages);
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".json") && !(name.slice(0, -".json".length) in wanted)) rmSync(join(dir, name));
  }
  for (const [area, text] of Object.entries(wanted)) writeIfChanged(join(dir, `${area}.json`), text);
}

/** A glossary's Terms row's English term, the name it is kept in order by. */
function termOf(row: string): string {
  return (row.split(/(?<!\\)\|/)[1] ?? "").trim().toLowerCase();
}

/**
 * A glossary with its Terms rows in name order by their English term, so two
 * changes that add different terms write different lines.
 */
export function sortedGlossary(text: string): string {
  const lines = text.split("\n");
  const header = lines.findIndex((line, at) => line.startsWith("|") && /^\|\s*-/.test(lines[at + 1] ?? ""));
  if (header === -1) return text;
  const start = header + 2;
  let end = start;
  while (end < lines.length && lines[end]?.startsWith("|")) end++;
  const rows = lines
    .slice(start, end)
    .sort((a, b) => byName(termOf(a), termOf(b)) || byName(a, b));
  return [...lines.slice(0, start), ...rows, ...lines.slice(end)].join("\n");
}

/** Each glossary, one per language, by its path. */
export function readGlossaries(root = "."): Record<string, string> {
  const dir = join(root, GLOSSARY_DIR);
  if (!existsSync(dir)) return {};
  return Object.fromEntries(
    readdirSync(dir)
      .filter((name) => name.endsWith(".md") && name !== "README.md")
      .sort(byName)
      .map((name) => [`${GLOSSARY_DIR}/${name}`, readFileSync(join(dir, name), "utf8")]),
  );
}

/** Each glossary whose terms are out of name order. */
export function glossaryProblems(glossaries: Record<string, string>): string[] {
  return Object.entries(glossaries)
    .filter(([, text]) => sortedGlossary(text) !== text)
    .map(
      ([path]) =>
        `${path}: keep the Terms rows in name order by their English term; run node scripts/generate-messages.ts`,
    );
}

/**
 * Writes a file only when its text changed, through a file of its own
 * renamed into place, so two runs side by side, as the typecheck and the
 * tests can be, never read a half-written file.
 */
function writeIfChanged(path: string, text: string): void {
  try {
    if (readFileSync(path, "utf8") === text) return;
  } catch {}
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}.partial`;
  writeFileSync(partial, text);
  renameSync(partial, path);
}

/**
 * Writes the desktop's compiled modules, the shared one and each app
 * panel's, and removes a panel's once it has no messages. They are built,
 * never committed, so every entry that reads them writes them first:
 * install, the typecheck, the tests' and the build's configurations
 * (docs/i18n.md, "The catalog").
 */
export function writeCompiledMessages(root = "."): void {
  writeCompiled(root, compileCatalogs(readCatalogs(root)));
}

function writeCompiled(root: string, compiled: { output: string; panels: Record<string, string> }): void {
  if (!compiled.output) return;
  writeIfChanged(join(root, COMPILED_PATH), compiled.output);
  for (const [path, text] of Object.entries(compiled.panels)) writeIfChanged(join(root, path), text);
  for (const panel of Object.keys(APP_PANEL_PREFIXES)) {
    const path = panelMessagesPath(panel);
    if (!(path in compiled.panels)) rmSync(join(root, path), { force: true });
  }
}

/** A saved fact, as `src/shared/i18n/said.ts` shapes it. */
type Fact = { m: string; a?: Record<string, string | number | Fact> };

/**
 * The saved facts the phone's parity test words (docs/i18n.md, "On the
 * phone"): every message with a distinct fill in each blank, each plural one
 * at counts that pick different forms and group digits, one message filling
 * a blank with another, and two facts no catalog can word.
 */
function phoneWordsFacts(english: Catalog): Fact[] {
  const facts: Fact[] = [];
  for (const [id, message] of english) {
    const blanks = placeholdersOf(message);
    const selector = message.kind === "plural" ? message.selector : undefined;
    for (const count of selector ? [0, 1, 2, 1234] : [0]) {
      const a = Object.fromEntries(blanks.map((blank) => [blank, blank === selector ? count : `‹${blank}›`]));
      facts.push(blanks.length ? { m: id, a } : { m: id });
    }
  }
  const lone = [...english].find(([, message]) => message.kind === "text" && placeholdersOf(message).length === 1);
  const bare = [...english].find(([, message]) => placeholdersOf(message).length === 0);
  if (lone && bare) {
    const [blank] = placeholdersOf(lone[1]);
    facts.push({ m: lone[0], a: { [blank as string]: { m: bare[0] } } }, { m: lone[0] });
  }
  facts.push({ m: "notInTheCatalog" });
  return facts;
}

/** The parity fixture: each fact with the desktop's own English for it, or null where the desktop words nothing. */
async function phoneWordsFixture(facts: Fact[]): Promise<string> {
  // A computed path, so the build's and the tests' configurations, which bundle this module to call
  // `writeCompiledMessages`, never bundle said.ts and the compiled module it reads before it is written.
  const said = new URL("../src/shared/i18n/said.ts", import.meta.url).href;
  const { wordSaid } = (await import(/* @vite-ignore */ said)) as typeof import("../src/shared/i18n/said.ts");
  const cases = facts.map((said) => ({ said, words: wordSaid(said as Parameters<typeof wordSaid>[0]) ?? null }));
  return `[\n${cases.map((entry) => `  ${JSON.stringify(entry)}`).join(",\n")}\n]\n`;
}

/** The command: lays out, checks and compiles, as its flags say. */
async function main(): Promise<void> {
  if (process.argv.includes("--compiled")) {
    writeCompiledMessages();
  } else {
    const checking = process.argv.includes("--check");
    let { files, strays } = readCatalogFiles();
    if (!checking) {
      // Lay each language's messages out in name order, each in its area's file, and each glossary's terms in order.
      const joined = joinCatalogFiles(files);
      if (!joined.problems.length)
        for (const [tag, messages] of Object.entries(joined.catalogs)) writeCatalogLayout(".", tag, messages);
      for (const [path, text] of Object.entries(readGlossaries())) writeIfChanged(path, sortedGlossary(text));
      ({ files, strays } = readCatalogFiles());
    }
    const compiled = compileCatalogs(readCatalogs(), readFileSync(PHONE_INFO_PLIST, "utf8"));
    const problems = [...layoutProblems(files, strays), ...glossaryProblems(readGlossaries()), ...compiled.problems];
    // The desktop's modules are built, never committed: written in every mode, before the fixture words facts with them.
    writeCompiled(".", compiled);
    const phone: Record<string, string> = compiled.output ? compiled.phone : {};
    if (compiled.output) phone[PHONE_WORDS_FIXTURE] = await phoneWordsFixture(compiled.facts);
    for (const [path, text] of Object.entries(phone)) {
      if (checking) {
        let current = "";
        try {
          current = readFileSync(path, "utf8");
        } catch {}
        if (current !== text) problems.push(`${path} is out of step; run node scripts/generate-messages.ts`);
      } else if (!problems.length) {
        writeIfChanged(path, text);
      }
    }
    if (problems.length) {
      printErrors(problems, { title: "Message catalogs" });
      process.exitCode = 1;
    }
  }
}

// Called, not awaited at the top level: the build's and the tests' configurations import this module.
if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
