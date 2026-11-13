/**
 * The message compiler (docs/i18n.md, "The catalog"): reads every language's
 * catalog under src/shared/i18n/messages/, checks each against the English
 * source, and writes src/shared/i18n/messages.generated.ts, one typed
 * function per message that answers in the process's current language.
 * The compiled file imports only its siblings, so it runs in every process
 * with no package at run time.
 *
 * An app panel's own messages, named with its prefix (`APP_PANEL_PREFIXES`),
 * compile instead into `messages.generated.ts` in the panel's folder: a panel
 * reaches only React, the design library and its own files (docs/i18n.md,
 * "The app's own panels"), so that module imports nothing and reads the
 * language its frame's document speaks.
 *
 *   node scripts/generate-messages.ts           writes the compiled file
 *   node scripts/generate-messages.ts --check   exits 1 naming each catalog problem, or a compiled file out of step
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isPseudoLanguage,
  languageFormatTag,
  PSEUDO_LANGUAGES,
  SOURCE_LANGUAGE,
} from "../src/shared/i18n/languages.ts";

export const CATALOG_DIR = "src/shared/i18n/messages";
export const COMPILED_PATH = "src/shared/i18n/messages.generated.ts";

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
    problems.push(`${CATALOG_DIR}/${tag}.json: not JSON (${(error as Error).message})`);
    return catalog;
  }
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    problems.push(`${CATALOG_DIR}/${tag}.json: a catalog is one object of messages by name`);
    return catalog;
  }
  for (const [id, value] of Object.entries(entries)) {
    const where = `${CATALOG_DIR}/${tag}.json: ${id}`;
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
  const file = `${CATALOG_DIR}/${tag}.json`;
  for (const id of source.keys()) {
    if (!catalog.has(id)) problems.push(`${file}: ${id} is missing; translate it in the change that wrote the English`);
  }
  for (const [id, message] of catalog) {
    const english = source.get(id);
    if (!english) {
      problems.push(`${file}: ${id} is not in the English catalog; remove it`);
      continue;
    }
    const where = `${file}: ${id}`;
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

/** Every catalog checked and compiled: the compiled file's text, and each problem found. */
export function compileCatalogs(sources: Record<string, string>): {
  output: string;
  problems: string[];
  panels: Record<string, string>;
} {
  const problems: string[] = [];
  const englishSource = sources[SOURCE_LANGUAGE];
  if (englishSource === undefined)
    return { output: "", problems: [`${CATALOG_DIR}/${SOURCE_LANGUAGE}.json is missing`], panels: {} };
  const english = parseCatalog(SOURCE_LANGUAGE, englishSource, problems);
  for (const [id, message] of english) checkPluralForms(message, SOURCE_LANGUAGE, `${CATALOG_DIR}/en.json: ${id}`, problems);
  const translations: [string, Catalog][] = [];
  for (const [tag, source] of Object.entries(sources).sort(([a], [b]) => a.localeCompare(b, "en"))) {
    if (tag === SOURCE_LANGUAGE) continue;
    if (isPseudoLanguage(tag)) {
      problems.push(`${CATALOG_DIR}/${tag}.json: ${tag} is compiled from English; remove the file`);
      continue;
    }
    try {
      new Intl.Locale(tag);
    } catch {
      problems.push(`${CATALOG_DIR}/${tag}.json: ${tag} is not a language tag`);
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
  const shared = [...english].filter(([id]) => panelOf(id) === undefined);
  const output = [
    "// Generated by scripts/generate-messages.ts from src/shared/i18n/messages/*.json; never edit by hand.",
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
  return { output, problems, panels };
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
    "// Generated by scripts/generate-messages.ts from src/shared/i18n/messages/*.json; never edit by hand.",
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

export function readCatalogs(dir = CATALOG_DIR): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => [name.slice(0, -".json".length), readFileSync(join(dir, name), "utf8")]),
  );
}

/** The compiled file as the project's formatter writes it, so `pnpm check`'s Biome passes it unchanged. */
function formatted(text: string, path: string): string {
  return execFileSync("node_modules/.bin/biome", ["format", `--stdin-file-path=${path}`], {
    input: text,
    encoding: "utf8",
    // The compiled file outgrows the default 1 MiB output buffer.
    maxBuffer: 64 * 1024 * 1024,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const compiled = compileCatalogs(readCatalogs());
  const { problems } = compiled;
  const files: Record<string, string> = compiled.output
    ? {
        [COMPILED_PATH]: formatted(compiled.output, COMPILED_PATH),
        ...Object.fromEntries(
          Object.entries(compiled.panels).map(([path, text]) => [path, formatted(text, path)]),
        ),
      }
    : {};
  // A panel folder whose prefix names no message keeps no module.
  const stale = Object.keys(APP_PANEL_PREFIXES)
    .map(panelMessagesPath)
    .filter((path) => existsSync(path) && !(path in files));
  if (process.argv.includes("--check")) {
    for (const [path, output] of Object.entries(files)) {
      let current = "";
      try {
        current = readFileSync(path, "utf8");
      } catch {}
      if (current !== output) problems.push(`${path} is out of step; run node scripts/generate-messages.ts`);
    }
    for (const path of stale) problems.push(`${path} compiles no message; run node scripts/generate-messages.ts`);
  } else if (!problems.length) {
    for (const [path, output] of Object.entries(files)) writeFileSync(path, output);
    for (const path of stale) rmSync(path);
  }
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exitCode = 1;
  }
}
