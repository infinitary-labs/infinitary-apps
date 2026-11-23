import { KEY_FORMATS } from "../keyFormats";

/**
 * The feedback guard (docs/feedback.md, "The guard"): before a draft is
 * kept, the host refuses any text holding an identifier it knows about the
 * person, or one of a closed set of personal patterns. It refuses rather
 * than replaces, so what the captain reviews is exactly what goes, and the
 * crewmate rewrites the sentence. It finds only what it holds and what the
 * patterns name; anything else rests on the crewmate and the captain's
 * review.
 */

/** The kinds of identifier the host holds about the person. */
export type HeldIdentifierKind =
  | "account name"
  | "home folder"
  | "computer name"
  | "device name"
  | "sign-in"
  | "project"
  | "project folder"
  | "repository"
  | "secret name"
  | "connection name";

export type HeldIdentifier = { kind: HeldIdentifierKind; value: string };

/** One thing the guard found: its kind and the text it matched. */
export type GuardMatch = { kind: HeldIdentifierKind | PatternKind; text: string };

type PatternKind = "email address" | "home-folder path" | "network address" | "key";

/**
 * Words that name Infinitary itself or a kind of device, never the person:
 * a project called "infinitary" is the person's clone of the app's own
 * public source, and a phone left with its maker's name is called "iPhone",
 * so refusing them would refuse ordinary reports.
 */
// i18n-exempt: lowercase names compared against held identifiers, never shown
const PUBLIC_WORDS = new Set([
  "infinitary",
  "infinitary-apps",
  "infinitary-labs",
  "github",
  "iphone",
  "ipad",
  "mac",
  "mac mini",
  "mac studio",
  "mac pro",
  "macbook",
  "macbook air",
  "macbook pro",
  "imac",
]);

// i18n-exempt: the guard's refusal is read by a crewmate, in English
const PATTERNS: ReadonlyArray<{ kind: PatternKind; pattern: RegExp }> = [
  { kind: "email address", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  {
    kind: "home-folder path",
    pattern: /(?:\/Users\/|\/home\/|[A-Za-z]:[\\/]Users[\\/])[^\s/\\'"`)<>]+/g,
  },
  { kind: "home-folder path", pattern: /~\/[^\s'"`)<>]+/g },
  {
    kind: "network address",
    pattern: /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g,
  },
  { kind: "network address", pattern: /\b(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}\b/g },
  {
    kind: "network address",
    pattern: /\b(?:[0-9A-Fa-f]{1,4}:){1,6}:(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4}){0,5})?\b/g,
  },
  ...Object.values(KEY_FORMATS).map((pattern) => ({ kind: "key" as const, pattern })),
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The held value as the guard looks for it: whole, case-insensitive, not inside a longer word. */
function heldPattern(value: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(value)}(?![\\p{L}\\p{N}_])`, "iu");
}

/** Held values worth looking for: not empty, not a public name, each once. */
export function usableIdentifiers(held: readonly HeldIdentifier[]): HeldIdentifier[] {
  const seen = new Set<string>();
  const out: HeldIdentifier[] = [];
  for (const entry of held) {
    const value = entry.value.trim();
    const key = value.toLowerCase();
    if (!value || PUBLIC_WORDS.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: entry.kind, value });
  }
  // A longer value first, so a folder is named before the account inside it.
  return out.sort((a, b) => b.value.length - a.value.length);
}

/**
 * Everything personal the guard finds in the text: each held identifier and
 * each pattern match, once per kind and text, in the order checked.
 */
export function guardMatches(text: string, held: readonly HeldIdentifier[]): GuardMatch[] {
  const found: GuardMatch[] = [];
  const seen = new Set<string>();
  const add = (match: GuardMatch) => {
    const key = `${match.kind}\u0000${match.text.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(match);
  };
  // A longer value is looked for first and blanked once found, so the
  // account inside a folder or a sign-in is not named a second time.
  let rest = text;
  for (const entry of usableIdentifiers(held)) {
    const pattern = heldPattern(entry.value);
    const hit = pattern.exec(rest);
    if (!hit) continue;
    add({ kind: entry.kind, text: hit[0] });
    rest = rest.replace(new RegExp(pattern.source, "giu"), (found) => " ".repeat(found.length));
  }
  for (const { kind, pattern } of PATTERNS) {
    for (const hit of text.matchAll(new RegExp(pattern.source, pattern.flags)))
      add({ kind, text: hit[0] });
  }
  return found;
}

/** The refusal the crewmate reads: each match and its kind, and what to do. */
export function guardRefusal(matches: readonly GuardMatch[]): string {
  const lines = matches.map((match) => `- ${match.kind}: ${JSON.stringify(match.text)}`);
  // i18n-exempt: the guard's refusal is read by a crewmate, in English
  return [
    `Not kept: the draft holds ${matches.length === 1 ? "a personal detail" : `${matches.length} personal details`} the app knows about the captain.`,
    ...lines,
    "Rewrite those sentences in your own words, naming the kind of thing instead (a GitHub project, a Mac), then draft again.",
  ].join("\n");
}
