import { HomeRefusalError } from "@core/devices/homeLink";
import type { Card, PastCard } from "@shared/cards";
import { HERE, hereAs, placesAs } from "@shared/deviceNames";
import type { FeedLine } from "@shared/feed";
import { englishOf } from "@shared/i18n/said";
import type { CoreInvokeChannel } from "@shared/ipc";
import {
  speaksAsFirstMatesComputer,
  type TaskActivityLine,
  type TaskActivityRow,
  type TaskDetail,
} from "@shared/tasks";
import type { TimelineContentKind, TimelineReading } from "@shared/timeline";

/**
 * The first mate's own words, as a computer that controls it shows them
 * (docs/view.md, "The first mate's own words"). The first mate's core
 * writes its computer as this computer (`HERE`), and some lines say here,
 * which there names the computer the captain is at. Here each such sentence
 * names the first mate's computer by `name` instead (`hereAs`, and
 * `placesAs` for a fact that says this computer or here as a place), read
 * only when one does:
 *
 * - each feed line it marks as its own words (`saidHere`), never one of the
 *   captain's or a crewmate's words;
 * - in a task's record, each Activity line it marks the same way, each
 *   reading of its timeline the host, its own steering or the first mate
 *   wrote, and its newest problem;
 * - each card it wrote itself (`author: "host"`): its title and body, in
 *   every answer and push a card rides;
 * - a refusal it answers, in the shapes the contract's refusals take: the
 *   answer's `refusal`, its `text` beside `ok: false`, and the `warning`
 *   beside `ok: true`;
 * - a request it refused with an error (`HomeRefusalError`).
 *
 * The first mate's own window never comes here, so it shows each sentence
 * as written.
 */
export function namedHere(
  channel: CoreInvokeChannel,
  answer: unknown,
  name: () => string,
): unknown {
  if (channel === "inf:feed:recent" && Array.isArray(answer))
    return answer.map((line: FeedLine) => namedLine(line, name));
  if (channel === "inf:cards:list") return namedCards(answer, name);
  if (
    channel === "inf:cards:show" ||
    channel === "inf:cards:past" ||
    channel === "inf:cards:show-past"
  )
    return namedCard(answer, name);
  if (channel === "inf:tasks:detail") return namedDetail(answer, name);
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return answer;
  const fields = answer as Record<string, unknown>;
  const field =
    typeof fields.refusal === "string"
      ? "refusal"
      : fields.ok === false && typeof fields.text === "string"
        ? "text"
        : fields.ok === true && typeof fields.warning === "string"
          ? "warning"
          : null;
  return field ? { ...fields, [field]: hereAs(fields[field] as string, name()) } : answer;
}

export function namedHereError(caught: unknown, name: () => string): unknown {
  return caught instanceof HomeRefusalError ? new Error(hereAs(caught.message, name())) : caught;
}

/** The cards a snapshot holds (`inf:cards:list`, the `inf:cards` push), each named as `namedCard`. */
export function namedCards(cards: unknown, name: () => string): unknown {
  return Array.isArray(cards) ? cards.map((card) => namedCard(card, name)) : cards;
}

/**
 * A feed line in the first mate's computer's own words: its fact's places
 * named (`placesAs`) and worded again, then each this computer left in its
 * words. A line whose words still said this computer after its places were
 * named keeps the named English and drops its fact, which would word this
 * computer again (docs/i18n.md, "Saved facts").
 */
function namedLine(line: FeedLine, name: () => string): FeedLine {
  if (line?.saidHere !== true) return line;
  const placed = line.said ? placesAs(line.said, name()) : undefined;
  const worded = placed && placed !== line.said ? englishOf(placed) || line.text : line.text;
  const text = hereAs(worded, name());
  if (text !== worded) {
    const { said: _said, ...named } = line;
    return { ...named, text };
  }
  return placed && placed !== line.said ? { ...line, text, said: placed } : line;
}

/**
 * A text with each this computer named (`hereAs`), and where each offset of
 * the text moved to, for the spans and marks that point into it.
 */
function hereAt(text: string, name: string): { text: string; at: (offset: number) => number } {
  const moves: { end: number; by: number }[] = [];
  const named = text.replace(new RegExp(`${HERE.This}|${HERE.this}`, "g"), (phrase, offset) => {
    moves.push({ end: offset + phrase.length, by: name.length - phrase.length });
    return name;
  });
  return {
    text: named,
    at: (offset) => moves.reduce((at, move) => (move.end <= offset ? at + move.by : at), offset),
  };
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * A card the first mate's computer wrote itself, named: its title and body.
 * The body is markup, so the name goes in escaped, and the change bars'
 * marks (`changes.marks`) move with the words before them. A card someone
 * else wrote, and anything that is not a card, stays.
 */
function namedCard(card: unknown, name: () => string): unknown {
  if (!card || typeof card !== "object" || (card as { author?: unknown }).author !== "host")
    return card;
  const shown = card as Card | PastCard;
  const words = name();
  const body = hereAt(
    shown.body,
    words.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char),
  );
  const changes = "changes" in shown ? shown.changes : undefined;
  return {
    ...shown,
    title: hereAs(shown.title, words),
    body: body.text,
    ...(changes ? { changes: { ...changes, marks: changes.marks.map(body.at) } } : {}),
  };
}

/**
 * A task's record, named where the first mate's computer speaks for itself:
 * each Activity line it marks (`saidHere`), folded ones included, with the
 * pull request a line links moved with its words; each timeline reading
 * that writer wrote, which the record's Activity draws in place of its line
 * (`namedReading`); and its newest problem (`plainProblem`). The brief, the
 * crewmate's words and the captain's stay as written.
 */
function namedDetail(answer: unknown, name: () => string): unknown {
  if (!answer || typeof answer !== "object" || !Array.isArray((answer as TaskDetail).activityLog))
    return answer;
  const detail = answer as TaskDetail;
  const words = name();
  return {
    ...detail,
    activityLog: detail.activityLog.map(
      (row): TaskActivityRow => ({
        ...namedActivity(row, words),
        ...(row.folded ? { folded: row.folded.map((line) => namedActivity(line, words)) } : {}),
      }),
    ),
    ...(detail.timeline
      ? { timeline: detail.timeline.map((reading) => namedReading(reading, words)) }
      : {}),
    problem: detail.problem === null ? null : hereAs(detail.problem, words),
  };
}

/**
 * The evidence a timeline keeps exactly as it was served or decided: the
 * brief, which quotes the captain and was the crewmate's instructions, and
 * a turn's decision.
 */
const AS_SERVED: ReadonlySet<TimelineContentKind> = new Set(["brief", "decision"]);

/**
 * A timeline reading in the first mate's computer's own words, named as its
 * Activity line is: its summary, its whole text and its retained details.
 */
function namedReading(reading: TimelineReading, name: string): TimelineReading {
  if (
    !speaksAsFirstMatesComputer(reading.entry.actor?.kind) ||
    AS_SERVED.has(reading.entry.content.kind)
  )
    return reading;
  const summary = hereAs(reading.entry.summary, name);
  const text = reading.text === null ? null : hereAs(reading.text, name);
  const details = reading.details === undefined ? undefined : hereAs(reading.details, name);
  if (summary === reading.entry.summary && text === reading.text && details === reading.details)
    return reading;
  return {
    ...reading,
    entry: { ...reading.entry, summary },
    text,
    ...(details === undefined ? {} : { details }),
  };
}

function namedActivity<L extends TaskActivityLine>(line: L, name: string): L {
  if (line.saidHere !== true) return line;
  const named = hereAt(line.text, name);
  if (named.text === line.text) return line;
  return {
    ...line,
    text: named.text,
    ...(line.change
      ? {
          change: {
            ...line.change,
            from: named.at(line.change.from),
            to: named.at(line.change.to),
          },
        }
      : {}),
  };
}
