import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import ts from "typescript";

export const TYPED_WORDS_RULE = "e2e-typed-words";

export type TypedWordsDiagnostic = { file: string; line: number; column: number; message: string };

/**
 * Facts from their owner (docs/e2e-contracts.md, "Words come from their
 * owner"). Words a person reads are the product's to change: a spec that
 * re-types them breaks the day they move, and the alpha's Mac check, not the
 * change's own pull request, finds it. So a spec reads every multi-word text
 * it expects from the module that owns it - the product's exported words or
 * composer, the mock's constant, or the spec's own named constant for words
 * it put there itself - and never types them where it asserts.
 *
 * The rule is lexical and recognizes three shapes:
 * - a text assertion, `toContainText` or `toHaveText`, whose expected value
 *   carries a typed literal of three or more words (a string, the typed part
 *   of a template, a regular expression, or an item of an array of them);
 * - a fixture constant, a variable bound to a literal, whose words the
 *   product also types: a run of three or more words found in a string,
 *   template or JSX text under src/;
 * - a contract or protocol version typed as a number (`protocolVersion`,
 *   `INFINITARY_CONTRACT_VERSION`), which moves with the contract's own constants;
 * - in a spec, any literal that copies a stand-in's words: the text of a
 *   string constant of three or more words that a mock, scenario, stub or
 *   helper under tests/e2e/ exports (`standInWords`), typed again where the
 *   spec fills, sends or expects them instead of imported from that owner.
 *   The owner is one the spec runs: a module it imports, or the mock
 *   provider every launch starts; a test's or step's own title is its name,
 *   not a copy.
 * A word is a whitespace-separated run holding a letter; `${…}` holes and a
 * regular expression's escapes are not words.
 */
const TEXT_ASSERTIONS = new Set(["toContainText", "toHaveText"]);
const MIN_WORDS = 3;
/** A product phrase found inside a fixture's longer words: three common words ("on the page") are not yet a copy. */
const MIN_PRODUCT_WORDS = 4;
const VERSION = /^v?\d+\.\d+\.\d+/;
const VERSION_NAME = /protocol|contract/i;
/**
 * Words that are not a copy say why: a check whose subject is the build
 * itself, such as the policy a card's frame runs under (docs/testing.md,
 * "Independent oracles"), or a fixture's own words that only share a phrase
 * with the product's. The reason sits in the statement, or on the line above it.
 */
const WAIVER = /e2e-typed-words:\s*\S/;
/**
 * A frame program's focused spec, whose subject is the program's own words:
 * it runs the real script, which is served as text into a sandboxed frame
 * and exports nothing a spec could import (observe.frame.js), so the spec is
 * where those words are pinned, as record.frame.test.ts pins the record's.
 */
const FRAME_PROGRAM_SPECS = /tests\/e2e\/observe-frame\.spec\.ts$/;

/**
 * The product's typed words: every multi-word string, template part and JSX
 * text under src/, and every English message of the catalog
 * (src/shared/i18n/messages/en/, docs/i18n.md), where the window's words
 * now live.
 */
export function productWords(src: string): string[] {
  const words = new Set<string>();
  if (!existsSync(src)) return [];
  for (const phrase of catalogWords(join(src, "shared/i18n/messages/en")))
    if (wordCount(phrase) >= MIN_WORDS) words.add(phrase);
  const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter(
    (file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file),
  );
  for (const file of files) {
    const path = join(src, file);
    const text = ts.sys.readFile(path);
    if (text === undefined) continue;
    const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.ESNext, false, kind);
    const visit = (node: ts.Node): void => {
      for (const part of typedParts(node) ?? []) {
        const phrase = trimPhrase(part);
        if (wordCount(phrase) >= MIN_WORDS) words.add(phrase);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...words];
}

/** Each English message's typed runs, split at its placeholders: `Cancel preparing {name}` gives `Cancel preparing`. */
function catalogWords(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const messages = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) =>
      Object.values(
        JSON.parse(ts.sys.readFile(join(dir, name)) ?? "{}") as Record<
          string,
          string | Record<string, string>
        >,
      ),
    );
  const forms = messages.flatMap((message) =>
    typeof message === "string"
      ? [message]
      : Object.entries(message)
          .filter(([key]) => key !== "plural")
          .map(([, form]) => form),
  );
  return forms.flatMap((form) => form.split(/\{[A-Za-z0-9]+\}/).map(trimPhrase));
}

/** A stand-in's exported words: the phrase, the constant that owns it and its file. */
export type StandInWords = ReadonlyMap<string, { name: string; file: string }>;
/** The stand-in every launch starts, whether or not a spec imports it (tests/e2e/launch.ts). */
const ALWAYS_RUNNING = /\/mockProvider\.ts$/;
/** `test(…)`, `test.step(…)`, `test.describe(…)`: their first argument is the test's name. */
const TITLED = /^(test|describe|it)(\.\w+)*$/;

/**
 * Every exported string constant of three words or more in the stand-ins
 * under tests/e2e/ - a mock, a scenario, a stub or a helper, any file that is
 * not a spec or a unit test - keyed by its words and naming its owner.
 */
export function standInWords(files: readonly string[]): StandInWords {
  const words = new Map<string, { name: string; file: string }>();
  for (const file of files) {
    if (/\.(spec|test)\.ts$/.test(file)) continue;
    const text = ts.sys.readFile(file);
    if (text === undefined) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      if (!statement.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!declaration.initializer || !ts.isIdentifier(declaration.name)) continue;
        const literal = unwrap(declaration.initializer);
        if (!ts.isStringLiteral(literal) && !ts.isNoSubstitutionTemplateLiteral(literal)) continue;
        const phrase = literal.text.trim();
        if (wordCount(phrase) >= MIN_WORDS && !words.has(phrase))
          words.set(phrase, { name: declaration.name.text, file: resolve(file) });
      }
    }
  }
  return words;
}

export function lintTypedWords(
  files: string[],
  product: readonly string[],
  standIns: StandInWords = new Map(),
): TypedWordsDiagnostic[] {
  const corpus = `\n${product.join("\n")}\n`;
  const longer = product.filter((words) => wordCount(words) >= MIN_PRODUCT_WORDS);
  const diagnostics: TypedWordsDiagnostic[] = [];
  for (const file of files) {
    const text = ts.sys.readFile(file);
    if (text === undefined) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);
    const lines = text.split("\n");
    const running = file.endsWith(".spec.ts") ? ranOwners(source, file) : undefined;
    const report = (node: ts.Node, message: string) => {
      const at = source.getLineAndCharacterOfPosition(node.getStart(source));
      const from = source.getLineAndCharacterOfPosition(statementOf(node).getStart(source)).line;
      if (lines.slice(Math.max(0, from - 1), at.line + 1).some((line) => WAIVER.test(line))) return;
      diagnostics.push({ file, line: at.line + 1, column: at.character + 1, message });
    };
    const visit = (node: ts.Node): void => {
      if (isTextAssertion(node) && !FRAME_PROGRAM_SPECS.test(file)) {
        for (const expected of items(node.arguments[0])) {
          const typed = typedParts(expected);
          if (typed && wordCount(typed.join(" ")) >= MIN_WORDS)
            report(
              expected,
              "A text assertion with typed words breaks the day the product rewords them. Read the words from the module that owns them - the product's exported words or composer, the mock's constant, or this spec's own named constant for words it put there itself (docs/e2e-contracts.md, \"Words come from their owner\").",
            );
        }
      }
      if (running) {
        const copied = standInCopy(node, standIns, running);
        if (copied)
          report(
            node,
            `A spec types the words a stand-in owns ("${copied[0]}", ${copied[1]}). Import that constant where the spec fills, sends or expects them, so the stand-in's next wording moves the spec with it (docs/e2e-contracts.md, "Words come from their owner").`,
          );
      }
      const bound = boundLiteral(node);
      if (bound) {
        const copied = copiedPhrase(bound.literal, longer, corpus);
        if (copied)
          report(
            bound.literal,
            `A fixture constant copies words the product types ("${copied}"). Import them, or the composer that makes them, from the module that owns them, so a rewording moves the spec with it (docs/e2e-contracts.md, "Words come from their owner").`,
          );
        const version = typedText(bound.literal);
        if (version !== undefined && VERSION.test(version) && VERSION_NAME.test(bound.name))
          report(
            bound.literal,
            'A contract version typed as a number goes stale when the contract moves. Derive it from the contract\'s own constants - PROTOCOL_VERSION or PROTOCOL_MAJORS_BEHIND in src/shared/ipc.ts, or the first version a feature needs in src/shared/contractFeatures.ts, such as WORK_UPDATE_SINCE (docs/e2e-contracts.md, "Words come from their owner").',
          );
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return diagnostics;
}

/** The stand-ins a spec runs: the modules it imports by a relative path, at its top or inline, as files. */
function ranOwners(source: ts.SourceFile, file: string): (owner: string) => boolean {
  const imported = new Set<string>();
  const add = (path: string) => {
    if (!path.startsWith(".")) return;
    const target = resolve(dirname(file), path);
    imported.add(target.endsWith(".ts") ? target : `${target}.ts`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier))
      add(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      add(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return (owner) => imported.has(owner) || ALWAYS_RUNNING.test(owner);
}

/** The stand-in phrase a string or template part copies, with the constant that owns it. */
function standInCopy(
  node: ts.Node,
  standIns: StandInWords,
  running: (owner: string) => boolean,
): [string, string] | undefined {
  if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) {
    if (!ts.isTemplateHead(node) && !ts.isTemplateMiddle(node) && !ts.isTemplateTail(node))
      return undefined;
  }
  let literal: ts.Node = node;
  while (
    !ts.isStringLiteral(literal) &&
    !ts.isNoSubstitutionTemplateLiteral(literal) &&
    !ts.isTemplateExpression(literal)
  )
    literal = literal.parent;
  if (isTitle(literal)) return undefined;
  for (const [phrase, owner] of standIns)
    if (running(owner.file) && containsPhrase(node.text, phrase))
      return [phrase, `${owner.name} in ${basename(owner.file)}`];
  return undefined;
}

/** A test's, step's or group's own name: the first argument of `test(…)` and its kin. */
function isTitle(node: ts.Node): boolean {
  const call = node.parent;
  return (
    ts.isCallExpression(call) &&
    call.arguments[0] === node &&
    TITLED.test(call.expression.getText())
  );
}

/** The statement, or the object's property, a node sits in: where its reason may stand. */
function statementOf(node: ts.Node): ts.Node {
  let at = node;
  while (at.parent && !ts.isStatement(at) && !ts.isPropertyAssignment(at)) at = at.parent;
  return at;
}

/** `….toContainText(x)` or `….toHaveText(x)`, `.not` or not. */
function isTextAssertion(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    TEXT_ASSERTIONS.has(node.expression.name.text) &&
    node.arguments.length > 0
  );
}

function items(node: ts.Expression | undefined): readonly ts.Expression[] {
  if (!node) return [];
  const inner = unwrap(node);
  return ts.isArrayLiteralExpression(inner) ? inner.elements.map(unwrap) : [inner];
}

function unwrap(node: ts.Expression): ts.Expression {
  let inner = node;
  while (
    ts.isParenthesizedExpression(inner) ||
    ts.isAsExpression(inner) ||
    ts.isSatisfiesExpression(inner)
  )
    inner = inner.expression;
  return inner;
}

/** A literal bound to a name: `const NAME = "…"` or `{ name: "…" }`. */
function boundLiteral(node: ts.Node): { name: string; literal: ts.Expression } | undefined {
  if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
    const literal = unwrap(node.initializer);
    if (typedParts(literal)) return { name: node.name.text, literal };
  }
  if (ts.isPropertyAssignment(node)) {
    const literal = unwrap(node.initializer);
    const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : "";
    // Only a version is checked on a property; a property's words are its object's own.
    if (VERSION_NAME.test(name) && typedParts(literal)) return { name, literal };
  }
  return undefined;
}

/** A literal's typed text, in pieces: a template's parts around its holes, a regex's words. */
function typedParts(node: ts.Node): string[] | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node))
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
  if (ts.isRegularExpressionLiteral(node)) return [regexWords(node.text)];
  if (ts.isJsxText(node)) return [node.text];
  return undefined;
}

function typedText(node: ts.Node): string | undefined {
  return typedParts(node)?.join("");
}

/**
 * A regex's longest alternative, with its escapes, classes and quantifiers
 * read as spaces: `/GitHub|sign in/` is two short choices, not three words.
 */
function regexWords(literal: string): string {
  const source = literal.slice(1, literal.lastIndexOf("/"));
  const choices: string[] = [];
  let depth = 0;
  let start = 0;
  for (let at = 0; at < source.length; at++) {
    const char = source[at];
    if (char === "\\") {
      at++;
    } else if (char === "[") {
      for (at++; at < source.length && source[at] !== "]"; at++) if (source[at] === "\\") at++;
    } else if (char === "(") {
      depth++;
    } else if (char === ")") {
      depth--;
    } else if (char === "|" && depth === 0) {
      choices.push(source.slice(start, at));
      start = at + 1;
    }
  }
  choices.push(source.slice(start));
  const words = choices.map((choice) =>
    choice
      .replace(/\\[a-zA-Z]/g, " ")
      .replace(/\\(.)/g, "$1")
      .replace(/\[[^\]]*\]|[()|^$*+?{}]/g, " ")
      .replace(/(^|\s)\.(?=\s|$)/g, " "),
  );
  return words.reduce((longest, choice) =>
    wordCount(choice) > wordCount(longest) ? choice : longest,
  );
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => /\p{L}/u.test(word)).length;
}

/** Whitespace collapsed and the punctuation at either end dropped. */
function trimPhrase(text: string): string {
  return text.replace(/\s+/g, " ").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/**
 * The run of product words a fixture literal copies, on word boundaries: the
 * literal's own phrase found inside the product's words, or a longer product
 * phrase (`longer`, four words or more) found inside the literal.
 */
function copiedPhrase(
  literal: ts.Expression,
  longer: readonly string[],
  corpus: string,
): string | undefined {
  for (const part of typedParts(literal) ?? []) {
    const phrase = trimPhrase(part);
    if (wordCount(phrase) < MIN_WORDS) continue;
    if (containsPhrase(corpus, phrase)) return phrase;
    for (const words of longer) if (containsPhrase(phrase, words)) return words;
  }
  return undefined;
}

function containsPhrase(text: string, phrase: string): boolean {
  for (let at = text.indexOf(phrase); at !== -1; at = text.indexOf(phrase, at + 1)) {
    const before = text[at - 1];
    const after = text[at + phrase.length];
    if (!isWordChar(before) && !isWordChar(after)) return true;
  }
  return false;
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}_'’-]/u.test(char);
}
