import type { Plugin } from "vite";
import { openModuleRunner } from "./moduleRunner.ts";

/**
 * The Mac's words as the phone's generated Swift calls them (docs/i18n.md, "On the phone"). The phone's generators
 * load the Mac's word owners with every catalog message answering a mark of itself - its name and what filled its
 * blanks - instead of its English, so a word the owner takes from the catalog becomes a call into `PhoneMessages`,
 * worded in the phone's language, and a word still typed into the owner stays a Swift string.
 */

const OPEN = "\u{E000}";
const CLOSE = "\u{E001}";

/** A catalog message's mark: its name and its fills, as the owner passed them. */
type Mark = { name: string; input: Record<string, unknown> };

/** Rewrites a compiled messages module so each message answers its mark; the words it would have written go unused. */
const marking: Plugin = {
  name: "phone-word-marks",
  enforce: "pre",
  transform(code, id) {
    if (!/\/messages\.generated\.ts$/.test(id.split("?")[0] ?? "")) return undefined;
    const marked = code.replace(
      /^export function (\w+)\(/gm,
      (_, name: string) =>
        `export function ${name}(input?: unknown): string { return markOf(${JSON.stringify(name)}, input); }\nfunction unmarked_${name}(`,
    );
    return `${marked}\nfunction markOf(name: string, input: unknown): string { return ${JSON.stringify(OPEN)} + JSON.stringify([name, input ?? {}]) + ${JSON.stringify(CLOSE)}; }\n`;
  },
};

export function openMarkingRunner() {
  return openModuleRunner([marking]);
}

/** Splits words into runs of plain text and catalog marks, a mark's fills holding marks of their own. */
function runsOf(words: string): Array<string | Mark> {
  const runs: Array<string | Mark> = [];
  let text = "";
  for (let at = 0; at < words.length; at++) {
    if (words[at] !== OPEN) {
      text += words[at];
      continue;
    }
    let depth = 0;
    let end = at;
    for (; end < words.length; end++) {
      if (words[end] === OPEN) depth++;
      else if (words[end] === CLOSE && --depth === 0) break;
    }
    if (text) runs.push(text);
    text = "";
    const [name, input] = JSON.parse(words.slice(at + 1, end)) as [string, Record<string, unknown>];
    runs.push({ name, input });
    at = end;
  }
  if (text) runs.push(text);
  return runs;
}

/** Whether words came from the catalog, wholly or in part. */
export function isMarked(words: string): boolean {
  return words.includes(OPEN);
}

/**
 * Swift's words for what an owner answered: a `PhoneMessages` call for a catalog message, a string literal for words
 * typed into the owner, or a literal interpolating both. `samples` maps a sample value the generator passed the owner,
 * such as `INF-7` or a count of 7, to the Swift value it stands for; each sample must appear exactly once.
 */
export function swiftWords(words: string, samples: Readonly<Record<string, string>> = {}): string {
  const used = new Map<string, number>();
  const result = expression(words, samples, used);
  for (const sample of Object.keys(samples)) {
    if (used.get(sample) !== 1) throw new Error(`The sample ${sample} is not once in ${words}`);
  }
  return result;
}

function expression(words: string, samples: Readonly<Record<string, string>>, used: Map<string, number>): string {
  const runs = runsOf(words);
  const [only] = runs;
  if (runs.length === 1 && typeof only === "object") return call(only, samples, used);
  if (runs.length === 1 && typeof only === "string" && Object.hasOwn(samples, only)) {
    used.set(only, (used.get(only) ?? 0) + 1);
    return samples[only] as string;
  }
  return `"${runs.map((run) => (typeof run === "string" ? literalText(run, samples, used) : `\\(${call(run, samples, used)})`)).join("")}"`;
}

function call(mark: Mark, samples: Readonly<Record<string, string>>, used: Map<string, number>): string {
  const fills = Object.keys(mark.input)
    .sort()
    .map((blank) => {
      const value = mark.input[blank];
      if (typeof value === "number") {
        const sample = String(value);
        if (!Object.hasOwn(samples, sample)) return `${blank}: ${value}`;
        used.set(sample, (used.get(sample) ?? 0) + 1);
        return `${blank}: ${samples[sample]}`;
      }
      if (typeof value !== "string") throw new Error(`${mark.name} fills ${blank} with something that is not words`);
      // A count the owner wrote as words fills a blank that takes words: the Swift count, interpolated.
      if (/^\d+$/.test(value) && Object.hasOwn(samples, value)) return `${blank}: "${literalText(value, samples, used)}"`;
      return `${blank}: ${expression(value, samples, used)}`;
    });
  return `PhoneMessages.\`${mark.name}\`(${fills.join(", ")})`;
}

/** Plain words as the inside of a Swift string literal, each sample in them interpolated. */
function literalText(text: string, samples: Readonly<Record<string, string>>, used: Map<string, number>): string {
  let literal = JSON.stringify(text).slice(1, -1);
  for (const [sample, swift] of Object.entries(samples)) {
    const escaped = JSON.stringify(sample).slice(1, -1);
    const count = literal.split(escaped).length - 1;
    if (!count) continue;
    used.set(sample, (used.get(sample) ?? 0) + count);
    literal = literal.replaceAll(escaped, `\\(${swift})`);
  }
  return literal;
}
