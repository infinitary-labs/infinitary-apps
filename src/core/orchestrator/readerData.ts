import { createHmac, randomBytes } from "node:crypto";
import type { Card, CardAnswer, CardMessage } from "@shared/cards";
import * as m from "@shared/i18n/messages.generated";
import { fenced, fencedAnswer, fencedListReminder } from "@shared/outsideData";
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
 * Words a reader saved once, such as a card's title, body and labels or a
 * follow-up's title, are marked the same way each time they are served:
 * the fence is a keyed digest of where they live and what they say, under
 * a secret this process draws once. The same words then read the same, so
 * a context that sends only what changed leaves them out, and a read can
 * tell a card's body from the same body under its resolution; changed
 * words draw a new fence. A fence depends on the words it closes, so
 * words cannot carry their own closing mark, and knowing one fence helps
 * forge no other; the secret never leaves the process.
 */
const SAVED_WORDS_SECRET = randomBytes(32);
/** When this process started serving saved words: their marks' read time. */
const SAVED_WORDS_READ = Date.now();

function savedFence(key: string, words: string) {
  const value = createHmac("sha256", SAVED_WORDS_SECRET)
    .update(key)
    .update("\0")
    .update(words)
    .digest("hex")
    .slice(0, READER_DATA_BYTES * 2);
  return { label: READER_DATA_LABEL, value, at: SAVED_WORDS_READ };
}

/** Saved reader words as one answer, marked the same each time (`savedFence`). */
export function readerSavedAnswer(key: string, words: string): string {
  return fencedAnswer(words, savedFence(key, words));
}

/** Saved reader words on one line, marked the same each time, for a list the caller ends with its reminder. */
export function readerSavedLine(key: string, words: string): string {
  return fenced(words, savedFence(key, words));
}

type Origin = { shape?: { unsafe_data_reader?: boolean } | null };

/**
 * A task's title as an agent reads it: one an unsafe data reader filed as
 * a follow-up is the reader's words, so it is marked the same on every
 * read; any other task's title is as written. `origins` are the tasks it
 * was found in (`TaskGraph.discoveredOrigins`).
 */
export function servedTaskTitle(
  task: { id: string; title: string },
  origins: readonly Origin[],
  form: "answer" | "line",
): string {
  if (!origins.some((origin) => origin.shape?.unsafe_data_reader === true)) return task.title;
  const key = `task:${task.id}`;
  return form === "answer" ? readerSavedAnswer(key, task.title) : readerSavedLine(key, task.title);
}

/**
 * The captain's answers to a card's questions with only its author's words
 * passed through `mark`: each option label and the value it labels. What
 * the captain wrote in, typed into a field or staged as settings has no
 * label and stays as written, so their own words are never served as data
 * (`cardAnswerLines` prints the result). `mark` must give the same words
 * the same marks, so a label equal to its value still reads once.
 */
export function answersWithAuthorWordsMarked(
  answers: readonly CardAnswer[],
  mark: (words: string) => string,
): CardAnswer[] {
  return answers.map((answer) => {
    if (answer.json || !answer.labels) return answer;
    const labels = answer.labels;
    return {
      ...answer,
      values: answer.values.map((value, index) => (labels[index] ? mark(value) : value)),
      labels: labels.map((label) => (label ? mark(label) : label)),
    };
  });
}

/**
 * Text the first mate reads, with the one reminder after it that covers every
 * reader-data span written inline by `readerDataLine`, when it holds any.
 */
export function withReaderDataReminder(text: string): string {
  return holdsReaderData(text) ? `${text}\n${fencedListReminder(READER_DATA_LABEL)}` : text;
}

/** Whether text holds a reader-data span. */
export function holdsReaderData(text: string): boolean {
  return text.includes(`[[${READER_DATA_LABEL} fence=`);
}

/**
 * Why an unsafe data reader's report is refused when it declares free text
 * the host would pass on unmarked: its recovery ways, work wait, typed
 * result or check-back. What they would say goes in the report's own words.
 */
export function readerReportRefusal(declared: ReportDeclaration | undefined): string | undefined {
  const named = [
    declared?.recoveryWays?.length ? "recovery_ways" : undefined,
    declared?.workWait ? "work_wait" : undefined,
    declared?.result ? "result" : undefined,
    declared?.checkBack ? "check_back" : undefined,
  ].filter((name) => name !== undefined);
  return named.length > 0
    ? // i18n-exempt: a refusal served to the crewmate, never shown to a person
      `Nothing was reported. An unsafe data reader's report takes no ${named.join(", ")}: put what it would say in the report's text, which reaches the first mate marked as data.`
    : undefined;
}

/**
 * A reader's report headline in the feed, the task row and the outcome
 * summary, worded in the app's language as it is saved, as a crewmate's own
 * headline is. It holds none of the reader's words: a headline is cut
 * short, so marked words would lose their closing mark, and the first
 * sentence of marked words is the reminder, not the report.
 */
export function readerHeadline(): string {
  return m.feedUnsafeDataReaderReported();
}

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
    readerHeadline(),
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
