/**
 * Which part of the page one answer shows (docs/task-browser.md, "Reading
 * a long page"): a window of the outline's lines, chosen by what the
 * crewmate just did. A read starts at the top, or at a line it names
 * (`from`); a search for words starts just above the first line that holds
 * them (`find`, and a wait for words), or shows a page small enough whole;
 * a scroll shows the lines the page's window shows. Lines keep their
 * number in the whole outline, so a window says where it sits and the
 * next read can name a line.
 *
 * Within one answer a long passage the page repeats folds into a pointer
 * to its first copy. An answer that leaves lines out ends with a map of
 * the page - its landmarks, regions and top headings, each with the line
 * it starts on - and its next lines. Next lines come only from facts the
 * window knows: lines left, more lines that hold the words, a passage cut
 * short. None ever names a control to press.
 *
 * Pure: every line comes from `outlinePage`, so what the outline keeps
 * back stays back, and a search never reads it.
 */

import { browserCommand } from "./commandWords";
import { CUT_SHORT, type OutlineLine, REF_PATTERN } from "./outline";

export type WindowAsk =
  /** From the page's top: an open, a read, an action; `full` asks for every line. */
  | { kind: "top"; full?: true }
  /** From this line on; `full` asks for every line from there. */
  | { kind: "from"; line: number; full?: true }
  /** Around the first line, at or after `from`, that holds these words. */
  | { kind: "find"; words: string; from?: number }
  /** Around the line that names this ref: the passage just read. */
  | { kind: "around"; ref: string }
  /** The lines the page's window shows now. */
  | { kind: "screen" };

/** Characters of outline lines one answer shows from the top, a line or the screen. */
export const WINDOW_CHARS = 20_000;
/** Lines one answer shows at most. */
export const WINDOW_LINES = 400;
/** Characters of outline lines one answer shows around words or a line. */
export const FIND_CHARS = 6_000;
/** A passage this long or longer folds when it repeats within one answer. */
export const FOLD_MIN = 200;
/** Map entries one answer lists before it counts the rest. */
export const MAP_SHOWN = 60;
/** Lines above a found line a window looks for the part that holds it. */
const CONTEXT_MAX = 12;
/** Lines shown above a found line when no part that holds it starts close by. */
const CONTEXT_PLAIN = 3;
/** Line numbers a search names before it counts the rest. */
const FOUND_SHOWN = 12;

/** Landmarks a map always names. */
const MAP_LANDMARKS = new Set([
  "banner",
  "main",
  "navigation",
  "contentinfo",
  "complementary",
  "search",
  "dialog",
  "alertdialog",
  "region",
]);

export type PageWindow = {
  lines: string[];
  /** How to read on, from facts the window knows; never a control to press. */
  next: string[];
  /** For `find`: every line number, at or after `from`, that holds the words. */
  found?: number[];
};

/** Next lines as an answer prints them under its window. */
export function nextBlock(next: readonly string[]): string[] {
  return next.length > 0 ? [`next[${next.length}]:`, ...next.map((line) => `  ${line}`)] : [];
}

function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const REF_IN_LINE = new RegExp(` \\[(${REF_PATTERN})\\]`);

/** A line as the map names it: without its ref or where a link goes. */
function mapName(line: OutlineLine): string {
  return line.text
    .trimStart()
    .replace(REF_IN_LINE, "")
    .replace(/ → \S+/, "");
}

/** Whether a line starts a part of the page the map names. */
function mapped(line: OutlineLine): boolean {
  const body = line.text.trimStart();
  if (MAP_LANDMARKS.has(line.role)) return true;
  // An unnamed form is any form; a named one is a part of the page.
  if (line.role === "form") return body.startsWith('form "');
  return line.role === "heading" && /\(level [12]\b/.test(body);
}

/**
 * The map: each part the page names, with the line it starts on. A
 * heading right under the part it names says nothing new.
 */
export function mapOf(lines: readonly OutlineLine[]): string[] {
  const entries: { line: number; name: string }[] = [];
  lines.forEach((line, index) => {
    if (!mapped(line)) return;
    const previous = entries.at(-1);
    if (line.role === "heading" && previous && index + 1 - previous.line <= 2) return;
    entries.push({ line: index + 1, name: mapName(line) });
  });
  if (entries.length === 0) return [];
  const shown = entries.slice(0, MAP_SHOWN).map((entry) => `  ${entry.line} ${entry.name}`);
  const more =
    entries.length > MAP_SHOWN ? [`  … and ${entries.length - MAP_SHOWN} more parts`] : [];
  return [`map[${entries.length}]:`, ...shown, ...more];
}

/**
 * Where a window around a line starts: the part that holds it, when that
 * starts close above, else a few lines above it.
 */
function contextStart(lines: readonly OutlineLine[], index: number): number {
  const depth = lines[index]?.depth ?? 0;
  for (let above = index - 1; above >= Math.max(0, index - CONTEXT_MAX); above -= 1) {
    if ((lines[above]?.depth ?? 0) < depth) return above;
  }
  return Math.max(0, index - CONTEXT_PLAIN);
}

/** The lines that hold some words, at or after a line, by their place in the outline. */
export function linesHolding(lines: readonly OutlineLine[], words: string, from = 1): number[] {
  const wanted = flat(words).toLowerCase();
  if (!wanted) return [];
  const found: number[] = [];
  for (let index = Math.max(0, from - 1); index < lines.length; index += 1) {
    if (
      flat(lines[index]?.words ?? "")
        .toLowerCase()
        .includes(wanted)
    )
      found.push(index);
  }
  return found;
}

export function foundWords(words: string, found: readonly number[], from?: number): string {
  const quotedWords = JSON.stringify(flat(words));
  const after = from !== undefined && from > 1 ? ` from line ${from} on` : "";
  if (found.length === 0) return `No line${after} holds ${quotedWords}.`;
  const named = found.slice(0, FOUND_SHOWN).join(", ");
  const more = found.length > FOUND_SHOWN ? `, and ${found.length - FOUND_SHOWN} more` : "";
  return found.length === 1
    ? `Found ${quotedWords} on line ${named}.`
    : `Found ${quotedWords} on ${found.length} lines${after}: ${named}${more}.`;
}

/**
 * Pick lines for one answer in order, within its bounds, folding a long
 * passage the answer already showed into a pointer to its first copy.
 */
function pick(
  lines: readonly OutlineLine[],
  order: Iterable<number>,
  maxChars: number,
  maxLines: number = WINDOW_LINES,
): { index: number; text: string }[] {
  const picked: { index: number; text: string }[] = [];
  const firstSeen = new Map<string, number>();
  let chars = 0;
  for (const index of order) {
    const line = lines[index];
    if (!line) break;
    const body = line.text.trimStart();
    let text = line.text;
    if (line.role === "text" && body.length >= FOLD_MIN) {
      const seen = firstSeen.get(body);
      if (seen === undefined) firstSeen.set(body, index + 1);
      else {
        text = `${line.text.slice(0, line.text.length - body.length)}text (same as line ${seen}, ${body.length} characters)`;
      }
    }
    if (picked.length >= maxLines) break;
    if (picked.length > 0 && chars + text.length + 1 > maxChars) break;
    chars += text.length + 1;
    picked.push({ index, text });
  }
  return picked;
}

function* range(start: number, end: number): Iterable<number> {
  for (let index = start; index < end; index += 1) yield index;
}

/** The window one answer shows, with its map and next lines when it leaves lines out. */
export function windowOf(lines: readonly OutlineLine[], ask: WindowAsk): PageWindow {
  const total = lines.length;
  const found = ask.kind === "find" ? linesHolding(lines, ask.words, ask.from) : undefined;
  const withFound = (window: PageWindow): PageWindow =>
    found ? { ...window, found: found.map((index) => index + 1) } : window;
  if (total === 0) {
    return withFound({ lines: ["(The page shows nothing a reader can read.)"], next: [] });
  }

  /**
   * The part around a line, within the smaller bound; a page that fits
   * that bound whole shows whole, so nothing above the line is missed.
   */
  const near = (index: number): { index: number; text: string }[] => {
    const whole = pick(lines, range(0, total), FIND_CHARS);
    if (whole.length === total) return whole;
    return pick(lines, range(contextStart(lines, index), total), FIND_CHARS);
  };
  let picked: { index: number; text: string }[];
  // Whether the page's window could be read: the host said where each line is.
  let screen = false;
  switch (ask.kind) {
    case "from": {
      const start = Math.max(1, Math.floor(ask.line)) - 1;
      if (start >= total) {
        return {
          lines: [
            `outline: line ${start + 1} is past the page's end; it has ${total} lines.`,
            ...mapOf(lines),
          ],
          next: [`${browserCommand("snapshot")} reads from the top`],
        };
      }
      picked = ask.full
        ? pick(lines, range(start, total), Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)
        : pick(lines, range(start, total), WINDOW_CHARS);
      break;
    }
    case "find": {
      const first = found?.[0];
      picked = first === undefined ? pick(lines, range(0, total), WINDOW_CHARS) : near(first);
      break;
    }
    case "around": {
      const named = ` [${ask.ref.trim().toLowerCase()}]`;
      const index = lines.findIndex((line) => line.text.includes(named));
      picked = index < 0 ? pick(lines, range(0, total), WINDOW_CHARS) : near(index);
      break;
    }
    case "screen": {
      const shown = [...range(0, total)].filter((index) => lines[index]?.onScreen === true);
      screen = lines.some((line) => line.onScreen !== undefined) && shown.length > 0;
      picked = pick(lines, screen ? shown : range(0, total), WINDOW_CHARS);
      break;
    }
    default:
      picked = ask.full
        ? pick(lines, range(0, total), Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)
        : pick(lines, range(0, total), WINDOW_CHARS);
  }

  const first = picked[0]?.index ?? 0;
  const last = picked.at(-1)?.index ?? 0;
  const out: string[] = [
    `outline: lines ${first + 1}-${last + 1} of ${total}${screen ? ", those on screen" : ""}`,
  ];
  let previous: number | undefined;
  for (const { index, text } of picked) {
    if (previous !== undefined && index > previous + 1) {
      out.push(
        index === previous + 2
          ? `… line ${previous + 2} is not on screen`
          : `… lines ${previous + 2}-${index} are not on screen`,
      );
    }
    out.push(text);
    previous = index;
  }
  const cut = picked.length < total;
  if (cut) out.push(...mapOf(lines));

  const next: string[] = [];
  if (last < total - 1)
    next.push(`${browserCommand(`snapshot --from ${last + 2}`)} reads on from line ${last + 2}`);
  if (ask.kind === "find") {
    const after = found?.find((index) => index > last);
    if (after !== undefined) {
      next.push(
        `${browserCommand(`snapshot --find ${JSON.stringify(flat(ask.words))} --from ${after + 1}`)} reads the next line that holds them`,
      );
    }
  } else if (cut) {
    next.push(
      `${browserCommand("snapshot --find <words>")} reads the part of the page that holds them`,
    );
  }
  const cutLines = picked.filter(({ text }) => text.includes(`(${CUT_SHORT})`));
  const cutRef = cutLines
    .map(({ index, text }) => ({ index, ref: REF_IN_LINE.exec(text)?.[1] }))
    .find((line) => line.ref !== undefined);
  if (cutRef) {
    const others = cutLines.length - 1;
    next.push(
      `${browserCommand(`snapshot @${cutRef.ref}`)} reads line ${cutRef.index + 1}'s passage in full${others > 0 ? `; ${others} more ${others === 1 ? "line is" : "lines are"} marked ${CUT_SHORT}, each with its ref` : ""}`,
    );
  }
  return withFound({ lines: out, next });
}
