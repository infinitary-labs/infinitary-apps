import {
  ANSWER_MISSING_ENDED_OPENING,
  ANSWER_MISSING_OPENING,
} from "../../../src/core/orchestrator/captainWakes";
import {
  REQUESTED_RESPONSE_OPENING,
  RESPONSE_MISSING_OPENING,
} from "../../../src/core/orchestrator/reportWakes";
import type { ScriptedCall } from "../../helpers/scriptedCalls";
import {
  MOCK_CLOSING_SENTENCES,
  type Scenario,
  type ScenarioAnswer,
  type ScenarioRequest,
} from "../mockProvider";
import { calledTool, latestServedTurn, spawnedTaskOf } from "../providerRequest";

/**
 * A question the first mate asks a crewmate for a captain's message ties
 * the message to that question (docs/task-capture.md, "Tied, not its
 * work" and "Waiting for an answer"). Hermetic replay, not a claim that a
 * live model obeys: the captain's words have the stand-in first mate start
 * a reader, ask it questions and try changes on it; the stand-in reader
 * answers each question it is asked to, saving its answer to the request.
 * Each question carries how the first mate treats its answer, in brackets:
 *
 * - `quiet`: the turn that reads the answer ends with closing words only;
 * - `card`: that turn shows an answer card;
 * - `follow`: that turn asks one follow-up question, answered `quiet`;
 * - `carry`: the asking turn's last step and the answer's turn, which
 *   steers the reader to carry on asking no answer, are each held until
 *   the spec lets them go (`releaseThreadAnswer`);
 * - `hold`: the reader reports without answering it.
 *
 * The scenario answers the first mate's own wakes (`answersFirst`): its
 * one retry shows a card, and every request's answer is read as above.
 */
export const ASKED_ANSWER_MARKER = "meter journey";
export const START_READER = `${ASKED_ANSWER_MARKER}: start the reader`;
/** The reader starts by putting its answer card up, held until the spec lets it go. */
export const START_READER_WITH_CARD = `${ASKED_ANSWER_MARKER}: start the reader with its card held`;
export const CLOSE_READER = `${ASKED_ANSWER_MARKER}: close the reader`;
/** A change the app refuses on the open reader: it has no merge approval to take back. */
export const REFUSED_CHANGE = `${ASKED_ANSWER_MARKER}: take back the reader's merge`;
/** The same refused change, its first step held until the spec lets it go. */
export const REFUSED_CHANGE_HELD = `${ASKED_ANSWER_MARKER}: take back the reader's merge, held`;
export const SHOW_THE_METER = `${ASKED_ANSWER_MARKER}: show me the meter`;
export type AnswerMode = "quiet" | "card" | "follow" | "carry" | "hold";
/** A captain's message whose turn asks the reader `question`, its answer read as `mode` says. */
export const askWords = (mode: AnswerMode, question: string) =>
  `${ASKED_ANSWER_MARKER} ask [${mode}]: ${question}`;
export const READER_TITLE = "Read the gas meter";
const READER_GOAL = "Read the gas meter for the asked answer journey.";
const READER_CARD_GOAL = "Read the gas meter and show its card, for the asked answer journey.";
export const READER_CARD_TITLE = "The gas meter reads 4,210 units";
export const ANSWER_CARD_TITLE = "Updating now installs the new alpha";
export const RETRY_CARD_TITLE = "The reader's answer";
export const METER_CARD_TITLE = "The meter reads 4,210 units";
export const FOLLOW_UP = "Which channel does it install from?";
/** What the reader answers every question it answers with. */
export const READER_ANSWER = "Yes: the reading is saved and the alpha installs on update.";
const QUESTION = "Question";

const said = (text: string): ScenarioAnswer => ({ text });
const card = (title: string): ScenarioAnswer => ({
  calls: [
    {
      name: "emit_card",
      args: { title, body: `<p>${title}.</p>`, answering: true },
    },
  ],
});

export const askedAnswer: Scenario = Object.assign(
  (): ((request: ScenarioRequest) => ScenarioAnswer | undefined) => {
    /** The reader's task, from its spawn. */
    let reader = "missing";
    return ({ body, isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
      if (!wantsStream) return undefined;
      if (!isFirstmate) return readerStep(body, latestUserTail, hasToolResults);
      const turn = latestServedTurn(body);
      if (!turn) return undefined;
      const words = turn.segments
        .filter((segment) => segment.kind !== "context")
        .map((segment) => segment.body)
        .join("\n");
      const results = turn.toolResults;
      // The one retry: it shows the answer.
      if (
        words.includes(ASKED_ANSWER_MARKER) &&
        (words.includes(ANSWER_MISSING_OPENING) || words.includes(ANSWER_MISSING_ENDED_OPENING))
      )
        return results.length === 0 ? card(RETRY_CARD_TITLE) : said("Shown.");
      // A saved answer to a request: read as its question's mode says.
      if (words.startsWith(REQUESTED_RESPONSE_OPENING) && words.includes(`${QUESTION} [`)) {
        const mode = words.match(/Question \[(\w+)\]/)?.[1] as AnswerMode | undefined;
        const task = words.match(/ for task ([\w-]+), submitted/)?.[1] ?? reader;
        if (results.length > 0) return said("Read the reader's answer.");
        if (mode === "card") return card(ANSWER_CARD_TITLE);
        if (mode === "follow")
          return {
            calls: [
              {
                name: "steer_crewmate",
                args: { task_id: task, message: `${QUESTION} [quiet]: ${FOLLOW_UP}` },
              },
            ],
          };
        if (mode === "carry")
          return {
            threadHeld: [
              {
                name: "steer_crewmate",
                args: {
                  task_id: task,
                  message: "Carry on with the reading.",
                  response: { mode: "guidance-only" },
                },
              },
            ],
          };
        return said("Read the reader's answer.");
      }
      if (words.startsWith(RESPONSE_MISSING_OPENING) && words.includes(`${QUESTION} [`))
        return said("Waiting for the reader's answer.");
      if (!words.includes(ASKED_ANSWER_MARKER)) return undefined;
      // The captain's own words, newest first where one names another.
      if (words.includes(START_READER_WITH_CARD) || words.includes(START_READER)) {
        if (results.length > 0) {
          reader = spawnedTaskOf(results[0]) ?? reader;
          return said("Started the reader.");
        }
        return {
          calls: [
            {
              name: "spawn_crewmate",
              args: {
                title: READER_TITLE,
                goal: words.includes(START_READER_WITH_CARD) ? READER_CARD_GOAL : READER_GOAL,
                user_words: words.includes(START_READER_WITH_CARD)
                  ? START_READER_WITH_CARD
                  : START_READER,
                shape: { rigor_ask: "quick" },
              },
            },
          ],
        };
      }
      if (words.includes(REFUSED_CHANGE_HELD) || words.includes(REFUSED_CHANGE)) {
        if (results.length > 0) return said("That could not be done.");
        const change: ScriptedCall = {
          name: "update_task",
          args: { task: reader, withdraw_merge: true },
        };
        return words.includes(REFUSED_CHANGE_HELD) ? { threadHeld: [change] } : { calls: [change] };
      }
      if (words.includes(CLOSE_READER)) {
        if (results.length > 0) return said("Closed the reader.");
        return {
          calls: [
            {
              name: "settle_task",
              args: {
                task_id: reader,
                mode: "discard",
                closing_sentence: MOCK_CLOSING_SENTENCES.discard,
              },
            },
          ],
        };
      }
      if (words.includes(SHOW_THE_METER))
        return results.length === 0 ? card(METER_CARD_TITLE) : said("Shown.");
      const asked = words.match(/meter journey ask \[(\w+)\]: ([^\n"]+)/);
      if (asked) {
        // A `carry` question's asking turn looks at the crew once more, that
        // step held until the spec lets it go: the reader's answer and its
        // report then both wait on the lane when the turn ends.
        if (asked[1] === "carry" && results.length === 1)
          return { threadHeld: [{ name: "crew_status", args: {} }] };
        if (results.length > 0) return said("Asked the reader.");
        return {
          calls: [
            {
              name: "steer_crewmate",
              args: { task_id: reader, message: `${QUESTION} [${asked[1]}]: ${asked[2]}` },
            },
          ],
        };
      }
      return undefined;
    };
  },
  { answersFirst: true as const },
);

/** The stand-in reader: it starts, then answers each question it is asked to. */
function readerStep(
  body: string,
  latestUserTail: string,
  hasToolResults: boolean,
): ScenarioAnswer | undefined {
  const withCard = body.includes(READER_CARD_GOAL);
  if (!withCard && !body.includes(READER_GOAL)) return undefined;
  if (hasToolResults)
    return calledTool(latestUserTail, "report")
      ? said("Reported.")
      : { calls: [{ name: "report", args: { text: "The gas meter's card is up." } }] };
  const request = latestUserTail.match(/Response requested: ([\w-]+)\./)?.[1];
  if (!request) {
    if (!withCard || calledTool(body, "emit_card"))
      return { calls: [{ name: "report", args: { text: "Reading the gas meter." } }] };
    return {
      threadHeld: [
        {
          name: "emit_card",
          args: {
            title: READER_CARD_TITLE,
            body: "<p>The gas meter reads 4,210 units.</p>",
            answering: true,
          },
        },
      ],
    };
  }
  if (latestUserTail.includes(`${QUESTION} [hold]`))
    return { calls: [{ name: "report", args: { text: "Still reading the gas meter." } }] };
  return {
    calls: [
      {
        name: "report",
        args: {
          text: READER_ANSWER,
          responses: [
            { request_id: request, response_id: `answer-${request}`, status: "answered" },
          ],
        },
      },
    ],
  };
}
