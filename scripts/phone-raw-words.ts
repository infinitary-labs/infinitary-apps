/**
 * The phone's raw-words check (docs/i18n.md, "On the phone"): the words the
 * phone app shows come from the catalog, through `PhoneMessages`, so a Swift
 * file under the phone's roots holds no words typed in for a person to read.
 * The files that still do are on `PHONE_RAW_WORDS_LEDGER` with how many runs
 * of words each holds, and the ledger only shrinks, as the window's does
 * (`scripts/raw-words.ts`).
 *
 * Swift has no parser here, so the check reads each file's string literals
 * with a small lexer that skips comments, and counts a literal whose text
 * reads as words (`readsAsWords`, the window's own rule), with each
 * interpolation standing for a number. A literal that names code is not
 * counted: one compared with `==`, `!=` or `~=`, a `case` pattern, a
 * dictionary key or subscript, an accessibility identifier, a symbol or
 * resource name, script for a web view, or one handed to a log, an
 * assertion or `fatalError`.
 * Words that must stay typed in say why with `i18n-exempt: <reason>` in a
 * comment on their line or the line above: a product name, or text that is
 * not shown.
 *
 *   node scripts/phone-raw-words.ts          exits 1 naming each file out of step with the ledger
 *   node scripts/phone-raw-words.ts --list   every file holding raw words, with its count
 *   node scripts/phone-raw-words.ts --show <file>   each run of raw words in one file
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ledgerProblems, type RawWords, readsAsWords } from "./raw-words.ts";

/** Where the check reads: the phone app's own code and the package it shares with its tests. */
export const PHONE_RAW_WORDS_ROOTS: readonly string[] = [
  "ios/Infinitary/InfinitaryApp/",
  "ios/Infinitary/InfinitaryKit/Sources/",
  "ios/Infinitary/PhoneLoadClock/",
];

/** Whether the check reads this tracked file: the phone's Swift, never a generated file or a test. */
export function isPhoneCheckedFile(path: string): boolean {
  if (!path.endsWith(".swift") || path.endsWith(".generated.swift")) return false;
  return PHONE_RAW_WORDS_ROOTS.some((root) => path.startsWith(root));
}

const WAIVER = /i18n-exempt:\s*\S/;

/** Code just before a literal that makes it name code: a comparison, a pattern, or a call or label that takes a name. */
const CODE_BEFORE = new RegExp(
  [
    String.raw`(==|!=|~=)\s*$`,
    String.raw`\bcase\s+(let\s+|var\s+)?$`,
    String.raw`\bcase\b[^:]*,\s*$`,
    String.raw`\[\s*$`,
    String.raw`\b(accessibilityIdentifier|print|debugPrint|fatalError|precondition|preconditionFailure|assert|assertionFailure|NSLog|os_log|debug|info|notice|error|fault|trace|warning|log|named|systemName|forKey|forResource|withExtension|subdirectory|forHTTPHeaderField|identifier|domain|suiteName|bundleIdentifier|key|name|custom|format|predicate|NSPredicate|URL|string|path)\s*(\(|:)\s*$`,
  ].join("|"),
);

/** One literal: where it starts, its text with each interpolation as `0`, and what follows it on its line. */
type Literal = { start: number; end: number; text: string };

/** Each string literal in a Swift file, skipping comments; an interpolation's own literals are read too. */
export function swiftLiterals(source: string): Literal[] {
  const found: Literal[] = [];
  let at = 0;
  const readString = (hashes: number, multiline: boolean): string => {
    let text = "";
    const close = (multiline ? '"""' : '"') + "#".repeat(hashes);
    const escape = `\\${"#".repeat(hashes)}`;
    while (at < source.length) {
      if (source.startsWith(close, at)) {
        at += close.length;
        return text;
      }
      if (source.startsWith(escape, at)) {
        at += escape.length;
        if (source[at] === "(") {
          at++;
          scan(1);
          text += "0";
          continue;
        }
        const char = source[at] ?? "";
        text += char === "n" ? "\n" : char === "t" ? "\t" : char;
        at++;
        continue;
      }
      if (!multiline && source[at] === "\n") return text;
      text += source[at];
      at++;
    }
    return text;
  };
  // Reads code until the parentheses opened before it close, or the file ends.
  const scan = (depth: number): void => {
    let open = depth;
    while (at < source.length) {
      const char = source[at];
      if (source.startsWith("//", at)) {
        const end = source.indexOf("\n", at);
        at = end === -1 ? source.length : end;
        continue;
      }
      if (source.startsWith("/*", at)) {
        let nested = 0;
        while (at < source.length) {
          if (source.startsWith("/*", at)) {
            nested++;
            at += 2;
          } else if (source.startsWith("*/", at)) {
            nested--;
            at += 2;
            if (nested === 0) break;
          } else at++;
        }
        continue;
      }
      const raw = /^(#*)"/.exec(source.slice(at, at + 8));
      if (raw && (char === '"' || char === "#")) {
        const start = at;
        const hashes = raw[1]?.length ?? 0;
        const multiline = source.startsWith('"""', at + hashes);
        at += hashes + (multiline ? 3 : 1);
        const text = readString(hashes, multiline);
        found.push({ start, end: at, text });
        continue;
      }
      if (char === "(") open++;
      if (char === ")" && depth > 0 && --open === 0) {
        at++;
        return;
      }
      at++;
    }
  };
  scan(0);
  return found.sort((a, b) => a.start - b.start);
}

/** Script a web view runs, which a literal may carry whole. */
const SCRIPT = /\bwindow\.|=>|\bawait\s+\w+\.|\(\);/;

/** Whether a literal sits where its text names code rather than words a person reads. */
function inCodePosition(source: string, literal: Literal): boolean {
  if (SCRIPT.test(literal.text)) return true;
  const lineStart = source.lastIndexOf("\n", literal.start - 1) + 1;
  const before = source.slice(lineStart, literal.start);
  if (CODE_BEFORE.test(before)) return true;
  const after = source.slice(literal.end, literal.end + 2);
  // A dictionary's key is followed straight by its colon; a ternary's branch by a space first.
  if (after.startsWith(":") && !after.startsWith("::")) return true;
  if (/^\s*(==|!=)/.test(source.slice(literal.end, literal.end + 4))) return true;
  return false;
}

/** Each run of raw words in one Swift file's text. */
export function phoneRawWordsIn(source: string): RawWords[] {
  const lines = source.split("\n");
  const lineOf = (offset: number) => source.slice(0, offset).split("\n").length - 1;
  return swiftLiterals(source).flatMap((literal) => {
    if (!readsAsWords(literal.text) || inCodePosition(source, literal)) return [];
    const line = lineOf(literal.start);
    if (WAIVER.test(lines[line] ?? "") || WAIVER.test(lines[line - 1] ?? "")) return [];
    return [{ line: line + 1, text: literal.text.replace(/\s+/g, " ").trim() }];
  });
}

/**
 * The phone's files that still hold raw words, with how many runs each
 * holds. It is empty: every word the phone's own Swift writes for a person
 * is in the catalog, and a file that gains one fails the check.
 */
export const PHONE_RAW_WORDS_LEDGER: Readonly<Record<string, number>> = {};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const showing = process.argv.indexOf("--show");
  if (showing !== -1) {
    const path = process.argv[showing + 1] ?? "";
    for (const words of phoneRawWordsIn(readFileSync(path, "utf8"))) console.log(`${path}:${words.line}: ${words.text}`);
  } else {
    const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "ios"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(isPhoneCheckedFile);
    const counts: Record<string, number> = {};
    for (const path of new Set(paths)) {
      try {
        counts[path] = phoneRawWordsIn(readFileSync(path, "utf8")).length;
      } catch {}
    }
    if (process.argv.includes("--list")) {
      for (const [path, count] of Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
        if (count) console.log(`  "${path}": ${count},`);
    } else {
      const problems = ledgerProblems(counts, PHONE_RAW_WORDS_LEDGER, "scripts/phone-raw-words.ts");
      if (problems.length) {
        console.error(problems.join("\n"));
        process.exitCode = 1;
      }
    }
  }
}
