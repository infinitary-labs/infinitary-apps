/**
 * Report plausibility (interaction P0, WI-1): a crewmate's report reaches
 * supervision and the Firstmate only when it reads like words a person
 * could act on. A model can end a turn emitting garbage - on Sep 14 a
 * crewmate "reported" `RGCTXDataിക്ഷassistant to=functions.bash 新天天彩票?`
 * and the record called it delivered work. Such text is a failed turn,
 * never an outcome; the crewmate stays steerable.
 *
 * Backend-neutral on purpose: it runs where every backend's turn ends (the
 * supervisor) and at the report tool, not in piEvents - that mapper also
 * serves the Firstmate and supervision sessions, whose short closing text
 * is legitimate, and the Claude client never passes through it. Deliberately conservative: text inside code spans is ignored
 * (a report may quote a fragment it investigated), CJK next to Latin inside
 * one word is ordinary writing, and so is a Greek letter in a unit. Only a
 * single word is judged: a report about translations quotes words in several
 * writing systems side by side, each word whole, and that is ordinary prose.
 *
 * A ceiling (docs/principles.md, "Build the agent's reach, never its
 * verdicts"): the tool-call and writing-system checks below cover a model
 * whose decoding can break down at a turn's end, leaking its chat template
 * or tool-call syntax into prose and running unrelated scripts together in
 * one word, as on Sep 14. Remove them once no model the crew is served
 * still ends a turn that way. Where it shows: the task record's failed
 * events reading "its report was set aside because ...", and the report
 * tool's "Report refused:" answers in the crewmate's own conversation.
 */

/**
 * Fewer words than this is not a report anyone can act on. A ceiling, as
 * above: it covers a model that closes a turn with one word ("Done."), in
 * its report or its final text, as if that told the first mate what
 * happened. Remove it once no model the crew is served closes that way; it
 * shows in the same two places.
 */
export const MIN_REPORT_WORDS = 2;

/**
 * Chat-template and tool-call syntax leaking into prose: a harmony-style
 * recipient (`assistant to=functions.bash`), special tokens (`<|call|>`), or
 * a raw tool-call wrapper.
 */
const TOOL_CALL_FRAGMENTS = [/\bto=functions\.[\w.-]+/i, /<\|[a-z_]+\|>/i, /<\/?tool_call>/i];

/** Scripts that read as one family beside Latin (CJK prose mixes freely). */
const SCRIPTS: Array<{ name: string; pattern: RegExp }> = [
  { name: "latin", pattern: /\p{Script=Latin}/u },
  { name: "greek", pattern: /\p{Script=Greek}/u },
  { name: "cyrillic", pattern: /\p{Script=Cyrillic}/u },
  {
    name: "cjk",
    pattern: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u,
  },
  { name: "arabic", pattern: /\p{Script=Arabic}/u },
  { name: "hebrew", pattern: /\p{Script=Hebrew}/u },
  { name: "devanagari", pattern: /\p{Script=Devanagari}/u },
  { name: "thai", pattern: /\p{Script=Thai}/u },
];

const SHARED_WORD_SCRIPTS = new Set(["latin+cjk", "cjk+latin", "latin+greek", "greek+latin"]);

/**
 * A letter Unicode files under no script of its own (Script=Common) - the
 * katakana long-vowel mark ー, the halfwidth ｰ and ﾟ, the Arabic tatweel,
 * the modifier apostrophe ʼ, the micro sign µ - belongs to whatever writing
 * system surrounds it, so it never counts as one. Counted as "other", it
 * would refuse nearly every katakana word, such as コンピューター.
 */
function scriptOf(char: string): string | undefined {
  if (!/\p{L}/u.test(char) || /\p{Script=Common}/u.test(char)) return undefined;
  return SCRIPTS.find((script) => script.pattern.test(char))?.name ?? "other";
}

/** Drop fenced and inline code: quoted fragments are evidence, not output. */
function proseOf(text: string): string {
  return text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
}

function wordCount(text: string): number {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  let count = 0;
  for (const segment of segmenter.segment(text)) {
    if (segment.isWordLike) count += 1;
  }
  return count;
}

/**
 * Why a report is implausible, phrased to follow "the report was set
 * aside because"; undefined when it reads as a report.
 */
export function implausibleReport(text: string): string | undefined {
  const trimmed = text.trim();
  if (wordCount(trimmed) < MIN_REPORT_WORDS) {
    return `it has fewer than ${MIN_REPORT_WORDS} words`;
  }
  const prose = proseOf(trimmed);
  if (TOOL_CALL_FRAGMENTS.some((pattern) => pattern.test(prose))) {
    return "it contains tool-call syntax instead of prose";
  }
  for (const word of prose.split(/\s+/)) {
    const scripts = new Set<string>();
    for (const char of word) {
      const script = scriptOf(char);
      if (script) scripts.add(script);
    }
    if (scripts.size > 2) return "it mixes writing systems inside one word";
    if (scripts.size === 2 && !SHARED_WORD_SCRIPTS.has([...scripts].join("+"))) {
      return "it mixes writing systems inside one word";
    }
  }
  return undefined;
}
