import { z } from "zod";
import { inLanguage } from "./current.ts";
import { formatTime } from "./format.ts";
import { SOURCE_LANGUAGE } from "./languages.ts";
import { MESSAGE_FILLS, MESSAGES, type MessageName } from "./messages.generated.ts";

/**
 * The app's own words saved as a fact (docs/i18n.md, "Saved facts"): a
 * catalog message by name and what it fills, worded in the language of
 * whoever shows it, when it is shown. The English sentence is saved beside
 * the fact, for a reader that words nothing itself, such as the phone, and
 * for a fact a later catalog no longer words.
 *
 * What a fact fills is a string shown as it is (a name, a key, words the
 * captain or the crew wrote), a count, a time of day worded where it is
 * shown, or another message with its own fills: one level deep, so the
 * shape stays plain data any reader can check.
 */

/** A time of day, worded where it is shown ("3:12 PM"). */
export const saidTimeSchema = z.strictObject({ time: z.number() });
export type SaidTime = z.infer<typeof saidTimeSchema>;

const leafFillSchema = z.union([z.string(), z.number(), saidTimeSchema]);

/** A message filled only with strings, counts and times: what a fact may fill a blank with. */
export const saidPartSchema = z.strictObject({
  m: z.string(),
  a: z.record(z.string(), leafFillSchema).optional(),
});
export type SaidPart = z.infer<typeof saidPartSchema>;

export const saidSchema = z.strictObject({
  m: z.string(),
  a: z.record(z.string(), z.union([leafFillSchema, saidPartSchema])).optional(),
});
export type Said = z.infer<typeof saidSchema>;

type InputOf<N extends MessageName> =
  Parameters<(typeof MESSAGES)[N]> extends [infer I] ? I : undefined;

/** A blank's fill: a count stays a number; any other blank takes words, a time or a message. */
type FillsOf<N extends MessageName, Part> = {
  [K in keyof InputOf<N>]: InputOf<N>[K] extends number ? number : string | SaidTime | Part;
};

type Args<N extends MessageName, Part> = InputOf<N> extends undefined ? [] : [FillsOf<N, Part>];

/** A fact naming a catalog message, its fills checked against the message's own blanks. */
export function said<N extends MessageName>(m: N, ...args: Args<N, SaidPart>): Said {
  const [a] = args as [Said["a"]?];
  return a && Object.keys(a).length ? { m, a } : { m };
}

/** A message to fill another fact's blank with: filled only with strings, counts and times. */
export function saidPart<N extends MessageName>(m: N, ...args: Args<N, never>): SaidPart {
  const [a] = args as [SaidPart["a"]?];
  return a && Object.keys(a).length ? { m, a } : { m };
}

function isMessage(name: string): name is MessageName {
  return Object.hasOwn(MESSAGES, name);
}

function fillOf(value: Said["a"] extends Record<string, infer V> | undefined ? V : never) {
  if (typeof value === "string" || typeof value === "number") return value;
  if ("time" in value) return formatTime(value.time, { hour: "numeric", minute: "2-digit" });
  return wordSaid(value);
}

/**
 * A fact in the process's own language, or undefined when this catalog
 * cannot word it - a message it no longer has, or a blank the fact never
 * filled - so the reader shows the English saved beside it.
 */
export function wordSaid(fact: Said | SaidPart): string | undefined {
  if (!isMessage(fact.m)) return undefined;
  const given = fact.a ?? {};
  const input: Record<string, string | number> = {};
  for (const blank of MESSAGE_FILLS[fact.m]) {
    const value = given[blank];
    if (value === undefined) return undefined;
    const filled = fillOf(value);
    if (filled === undefined) return undefined;
    input[blank] = filled;
  }
  const word = MESSAGES[fact.m] as (input: Record<string, string | number>) => string;
  return word(input);
}

/** A fact's English, the sentence saved beside it. */
export function englishOf(fact: Said): string {
  return inLanguage(SOURCE_LANGUAGE, () => wordSaid(fact)) ?? "";
}

export function saidLine(fact: Said): { text: string; said: Said } {
  return { text: englishOf(fact), said: fact };
}

export function wordedLine(line: { text: string; said?: Said | undefined }): string {
  if (!line.said) return line.text;
  return wordSaid(line.said) ?? line.text;
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};
const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (char) => ESCAPES[char] ?? char);
const unescapeHtml = (text: string) =>
  text.replace(/&(amp|lt|gt|quot|#39);/g, (_, name: string) =>
    name === "amp" ? "&" : name === "lt" ? "<" : name === "gt" ? ">" : name === "quot" ? '"' : "'",
  );

/** The attribute that carries a fact on a run of the app's own words in a card's body. */
export const SAID_MARK = "data-inf-said";

/**
 * A run of the app's own words in a card's body: one element whose only
 * content is the fact's English, with the fact on its `data-inf-said`
 * attribute, so whoever draws the card words it in its own language
 * (`wordSaidMarks`) and a reader that does not shows the English.
 */
export function saidMark(fact: Said, tag = "span", attributes = ""): string {
  const extra = attributes ? ` ${attributes}` : "";
  return `<${tag}${extra} ${SAID_MARK}="${escapeHtml(JSON.stringify(fact))}">${escapeHtml(englishOf(fact))}</${tag}>`;
}

const MARKED = new RegExp(
  `<([a-zA-Z][a-zA-Z0-9]*)(\\s[^>]*?)?\\s${SAID_MARK}="([^"]*)"([^>]*)>([^<]*)</\\1>`,
  "g",
);

/**
 * A card's body with each run of the app's own words (`saidMark`) worded in
 * the process's language. A run whose fact this catalog cannot read or
 * word keeps the English it was saved with.
 */
export function wordSaidMarks(body: string): string {
  return wordSaidBody(body).body;
}

/**
 * `wordSaidMarks`, with where each place in the saved body now sits, for
 * the offsets a card keeps into its body (its change bars): a place after
 * a worded run moves by as much as the run grew, and one inside it moves to
 * the run's start.
 */
export function wordSaidBody(saved: string): { body: string; at: (offset: number) => number } {
  if (!saved.includes(SAID_MARK)) return { body: saved, at: (offset) => offset };
  const moves: { from: number; to: number; grew: number }[] = [];
  let grown = 0;
  const body = saved.replace(
    MARKED,
    (
      whole,
      tag: string,
      before: string | undefined,
      raw: string,
      after: string,
      inner: string,
      offset: number,
    ) => {
      let fact: Said;
      try {
        const parsed = saidSchema.safeParse(JSON.parse(unescapeHtml(raw)));
        if (!parsed.success) return whole;
        fact = parsed.data;
      } catch {
        return whole;
      }
      const words = wordSaid(fact);
      if (words === undefined) return whole;
      const worded = escapeHtml(words);
      const from = offset + whole.length - `</${tag}>`.length - inner.length;
      grown += worded.length - inner.length;
      moves.push({ from, to: from + inner.length, grew: grown });
      return `<${tag}${before ?? ""} ${SAID_MARK}="${raw}"${after}>${worded}</${tag}>`;
    },
  );
  const at = (offset: number) => {
    let shift = 0;
    for (const move of moves) {
      if (offset < move.from) break;
      if (offset < move.to) return move.from + shift;
      shift = move.grew;
    }
    return offset + shift;
  };
  return { body, at };
}

/** The attribute on a card body's one empty element that carries the facts its title and buttons were saved from. */
export const CARD_WORDS_MARK = "data-inf-card-words";

/**
 * The facts a card's title and button labels were saved from, each beside
 * the English the card saved (`saidLine`), carried in its body as one empty
 * element, so whoever draws the card words them in its own language
 * (`wordedCardText`, and the phone's `PhoneWords.cardText`); a reader that
 * does not shows the English.
 */
export function cardWordsMark(facts: readonly Said[]): string {
  return `<template ${CARD_WORDS_MARK}="${escapeHtml(JSON.stringify(facts.map(saidLine)))}"></template>`;
}

const CARD_WORDS = new RegExp(`${CARD_WORDS_MARK}="([^"]*)"`);
const cardWordsSchema = z.array(z.strictObject({ text: z.string(), said: saidSchema }));

/**
 * A card's saved title or button label in the process's language, when its
 * body carries the fact it was saved from (`cardWordsMark`); otherwise, or
 * when this catalog cannot word that fact, the words as saved.
 */
export function wordedCardText(text: string, body: string | undefined): string {
  const raw = body?.includes(CARD_WORDS_MARK) ? CARD_WORDS.exec(body)?.[1] : undefined;
  if (raw === undefined) return text;
  try {
    const parsed = cardWordsSchema.safeParse(JSON.parse(unescapeHtml(raw)));
    const line = parsed.success ? parsed.data.find((entry) => entry.text === text) : undefined;
    return line ? wordedLine(line) : text;
  } catch {
    return text;
  }
}
