import { randomBytes } from "node:crypto";
import type { Card, CardMessage } from "@shared/cards";
import { fenced, fencedAnswer } from "@shared/outsideData";
import type { ReportDeclaration } from "../tasks/taskTurns";

/**
 * The label an unsafe data reader's own words carry when they reach the
 * first mate (docs/agents-reach.md, "An unsafe data reader"): its report,
 * its follow-ups' goal and why, its card replies and its progress notes.
 * The reader read words anyone can write, so whatever it says may carry
 * them; the first mate reads it as data, never as an instruction.
 */
export const READER_DATA_LABEL = "reader-data";

/** Random bytes in each fence value, as the integrations draw theirs. */
const READER_DATA_BYTES = 8;

function fence(at: number) {
  return { label: READER_DATA_LABEL, value: randomBytes(READER_DATA_BYTES).toString("hex"), at };
}

/** A reader's words as one answer: a reminder line before and after its marks. */
export function readerDataAnswer(words: string, at: number): string {
  return fencedAnswer(words, fence(at));
}

/** A reader's words on one line between their marks, for a list the caller ends with its reminder. */
export function readerDataLine(words: string, at: number): string {
  return fenced(words, fence(at));
}

/**
 * A reader's report headline in the feed, the task row and the outcome
 * summary. It holds none of the reader's words: a headline is cut short,
 * so marked words would lose their closing mark, and the first sentence of
 * marked words is the reminder, not the report.
 */
// i18n-exempt: saved as record text in place of a crewmate's own headline, which the crew writes in its own words
export const READER_HEADLINE = "The unsafe data reader reported; its words are on its record.";

/**
 * The task that wrote a thread line, when a crewmate did: its own card's
 * crewmate, or a crewmate that wrote with its name on another's card.
 */
export function crewmateWriterOf(
  card: Pick<Card, "taskId">,
  message: Pick<CardMessage, "who" | "contributor">,
): string | undefined {
  if (message.contributor) {
    return message.contributor.actor === "crewmate" ? message.contributor.taskId : undefined;
  }
  return message.who === "crewmate" ? card.taskId : undefined;
}

/**
 * A reader's report as the record keeps it: its words and what it asks of
 * the first mate, each between reader-data marks, under the host's fixed
 * headline in place of its own.
 */
export function readerReport(
  text: string,
  declared: ReportDeclaration | undefined,
  at: number,
): [string, string | undefined, ReportDeclaration | undefined] {
  return [
    readerDataAnswer(text, at),
    READER_HEADLINE,
    declared && {
      ...declared,
      ...(declared.needsFirstmate
        ? { needsFirstmate: readerDataAnswer(declared.needsFirstmate, at) }
        : {}),
      ...(declared.wait
        ? { wait: { ...declared.wait, reason: readerDataLine(declared.wait.reason, at) } }
        : {}),
    },
  ];
}
