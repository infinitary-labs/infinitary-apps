import { createHmac, randomBytes } from "node:crypto";
import {
  ANYTHING_ELSE_ANSWER,
  type Card,
  type CardAnswer,
  type CardMessage,
  type CardObservation,
  type CardQuestion,
  cardAnswersSchema,
} from "@shared/cards";
import * as m from "@shared/i18n/messages.generated";
import { fenced, fencedAnswer, fencedListReminder } from "@shared/outsideData";
import { cutText } from "@shared/textCut";
import type { TimelineEntry } from "@shared/timeline";
import type { TaskEvent } from "../storage/taskEventStore";
import type { TimelineRecord } from "../tasks/taskTimeline";
import type { ReportDeclaration } from "../tasks/taskTurns";
import { cardEmitter } from "./cardIds";

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

/** Whether an unsafe data reader wrote this card. */
export function readerWroteCard(
  tasks: { get(id: string): Origin | undefined },
  card: Pick<Card, "author" | "taskId">,
): boolean {
  if (card.author !== "crewmate" || !card.taskId) return false;
  return tasks.get(card.taskId)?.shape?.unsafe_data_reader === true;
}

/**
 * A card's title or label inside a line, marked the same on every read
 * when a reader wrote the card; the line's text ends with the reminder
 * (`withReaderDataReminder`).
 */
export function servedCardLine(
  tasks: { get(id: string): Origin | undefined },
  card: Pick<Card, "id" | "author" | "taskId">,
  words: string,
): string {
  return readerWroteCard(tasks, card) ? readerSavedLine(`card:${card.id}`, words) : words;
}

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
 * The captain's answers to a card's questions with its author's words
 * passed through `mark`: each question's name, each option label and the
 * value it labels, a value the card proposed and the captain left as it
 * was (a hidden field, a prefilled field unchanged, a skipped Default) and
 * a settings snapshot the card carries. What the captain wrote in and a
 * value they typed themselves stay as written, so their own words are never
 * served as data (`cardAnswerLines` prints the result). The split rests on
 * the frame's own report, which a script in the card could forge, so a
 * reader's card carries none (`CrewmateCards.crewmateCardWrite`). `mark` must give the same words the same marks, so a label
 * equal to its value still reads once.
 */
export function answersWithAuthorWordsMarked(
  answers: readonly CardAnswer[],
  mark: (words: string) => string,
): CardAnswer[] {
  const marked = (words: string) => (words ? mark(words) : words);
  return answers.map((answer) => {
    const proposed = answer.json === true || answer.skipped === true || !answer.changed;
    const labels = answer.labels;
    return {
      ...answer,
      name: answer.name === ANYTHING_ELSE_ANSWER ? answer.name : marked(answer.name),
      values: answer.values.map((value, index) =>
        proposed || labels?.[index] ? marked(value) : value,
      ),
      ...(labels ? { labels: labels.map(marked) } : {}),
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
 * A crewmate's closing words, which stand in for a report it did not make
 * (its turn's report text, or else what it last said): an unsafe data reader's marked and headed as its report is
 * (`readerReport`), every other crewmate's as written with no headline.
 */
export function closingWords(
  task: Origin | undefined,
  turn: { turnReport?: string; currentTurnText: string },
): { text?: string; headline?: string } {
  const spoken =
    turn.turnReport ?? (turn.currentTurnText.trim() ? turn.currentTurnText : undefined);
  if (spoken === undefined || task?.shape?.unsafe_data_reader !== true) return { text: spoken };
  return { text: readerDataAnswer(spoken, Date.now()), headline: readerHeadline() };
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
 * A reader's ask or waiting reason held to the 300 characters the report
 * keeps of any crewmate's (`checkDeclaration`), cut before it is marked:
 * marks and their reminder run past that, so the report keeps a reader's
 * marked words uncut and a cut after them never drops the closing mark.
 */
function readerAskCut(words: string): string {
  return cutText(words.replace(/\s+/g, " ").trim(), 300);
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
        ? { needsFirstmate: readerDataAnswer(readerAskCut(declared.needsFirstmate), at) }
        : {}),
      ...(declared.wait
        ? {
            wait: {
              ...declared.wait,
              reason: readerDataLine(readerAskCut(declared.wait.reason), at),
            },
          }
        : {}),
    },
  ];
}

/**
 * A reader's task history as an agent reads it (the `tasks` read's
 * `decisions` and `timeline` field): its own cards' words - offers, its
 * thread lines, the labels, names and proposals in the captain's answers,
 * their resolution lines and the summaries naming them - between the same
 * saved marks the card read uses, and the captain's own words as written.
 * A card on its task that it did not emit, such as the first mate's, keeps
 * its words.
 */
export function readerTimeline<T extends { entry: TimelineEntry; record: TimelineRecord | null }>(
  taskId: string,
  sources: readonly T[],
): T[] {
  return sources.map((source) => {
    const { entry, record } = source;
    const cardId =
      record?.source === "card-observation"
        ? record.observation.cardId
        : record?.source === "card-message"
          ? record.message.cardId
          : record?.source === "task-event"
            ? resolvedCardOf(record.event)
            : undefined;
    if (!record || !cardId || cardEmitter(cardId, taskId) !== "crewmate") return source;
    const mark = savedCardMark(cardId);
    if (record.source === "card-message") {
      const message = record.message;
      if (crewmateWriterOf({ taskId }, message) !== taskId) {
        return message.answers
          ? {
              ...source,
              record: {
                ...record,
                message: {
                  ...message,
                  answers: answersWithAuthorWordsMarked(message.answers, mark),
                },
              },
            }
          : source;
      }
      return {
        ...source,
        entry: { ...entry, summary: mark(entry.summary) },
        record: { ...record, message: { ...message, text: mark(message.text) } },
      };
    }
    const marked: TimelineRecord =
      record.source === "card-observation"
        ? { ...record, observation: markedObservation(record.observation, mark) }
        : record.source === "task-event"
          ? { ...record, event: readerResolvedEvent(taskId, record.event) }
          : record;
    return { ...source, entry: { ...entry, summary: mark(entry.summary) }, record: marked };
  });
}

/**
 * A task's `card_resolved` event as an agent reads it: on a reader's own
 * card, its line naming the card's title and the captain's answers with the
 * reader's words marked (`answersWithAuthorWordsMarked`); any other event as
 * it is.
 */
export function readerResolvedEvent(taskId: string, event: TaskEvent): TaskEvent {
  const cardId = resolvedCardOf(event);
  if (!cardId || cardEmitter(cardId, taskId) !== "crewmate") return event;
  const mark = savedCardMark(cardId);
  const answers = cardAnswersSchema.safeParse(event.data?.answers);
  return {
    ...event,
    text: mark(event.text),
    data: {
      ...event.data,
      ...(answers.success ? { answers: answersWithAuthorWordsMarked(answers.data, mark) } : {}),
    },
  };
}

function resolvedCardOf(event: TaskEvent): string | undefined {
  const cardId = event.kind === "card_resolved" ? event.data?.cardId : undefined;
  return typeof cardId === "string" ? cardId : undefined;
}

/** A reader card's words in JSON an agent reads, marked as its card read marks them. */
function savedCardMark(cardId: string): (words: string) => string {
  return (words) => readerSavedAnswer(`card:${cardId}`, words);
}

/** A reader card's observation with the words it wrote marked. */
function markedObservation(
  observation: CardObservation,
  mark: (words: string) => string,
): CardObservation {
  const questions = (list: CardQuestion[] | undefined) =>
    list?.map((question) => ({
      ...question,
      name: question.name === ANYTHING_ELSE_ANSWER ? question.name : mark(question.name),
      prompt: question.prompt && mark(question.prompt),
      options: question.options.map((option) => ({
        ...option,
        value: mark(option.value),
        label: option.label && mark(option.label),
      })),
    }));
  switch (observation.kind) {
    case "offer": {
      const payload = observation.payload;
      return {
        ...observation,
        payload: {
          ...payload,
          title: mark(payload.title),
          body: mark(payload.body),
          actions: payload.actions.map((action) => ({ ...action, label: mark(action.label) })),
        },
      };
    }
    case "action": {
      const payload = observation.payload;
      return {
        ...observation,
        payload: {
          ...payload,
          label: payload.label && mark(payload.label),
          ...(payload.frameValue ? { frameValue: mark(payload.frameValue) } : {}),
          ...(payload.answers
            ? { answers: answersWithAuthorWordsMarked(payload.answers, mark) }
            : {}),
          ...(payload.questions ? { questions: questions(payload.questions) } : {}),
        },
      };
    }
    case "message_ref": {
      const payload = observation.payload;
      return {
        ...observation,
        payload: {
          ...payload,
          ...(payload.answers
            ? { answers: answersWithAuthorWordsMarked(payload.answers, mark) }
            : {}),
          ...(payload.questions ? { questions: questions(payload.questions) } : {}),
        },
      };
    }
    default:
      return observation;
  }
}
