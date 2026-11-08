import type { ScriptedCall } from "../../helpers/scriptedCalls";
import { toolAnswers } from "../browserScript";
import {
  chessItems,
  LESSON_CHESS_ASK,
  LESSON_CHESS_GOAL,
  LESSON_CHESS_TITLE,
  LESSON_CHOICES,
  LESSON_FRACTIONS_ASK,
  LESSON_FRACTIONS_GOAL,
  LESSON_FRACTIONS_GOAL_BODY,
  LESSON_FRACTIONS_GOAL_TITLE,
  LESSON_FRACTIONS_TITLE,
  LESSON_GOAL_BODY,
  LESSON_GOAL_TITLE,
  LESSON_LEARNER_LINE,
  LESSON_NEXT_GOAL,
  LESSON_PROGRESS_STOP,
  LESSON_REPLY_ANSWER,
  LESSON_REPLY_WORDS,
  LESSON_ROUND_ONE_TITLE,
  LESSON_ROUND_REVIEW_TITLE,
  LESSON_ROUND_TWO_TITLE,
  LESSON_WELCOME_BODY,
  LESSON_WELCOME_TITLE,
  lessonRoundBody,
} from "../lessonFixtures";
import type { Scenario } from "../mockProvider";
import { answering, calledTool, providerMessages } from "../providerRequest";

const LESSONS_STOPPED_REPORT = "Lessons stopped; records kept.";

/**
 * The lessons (FI3-1474): the mock Firstmate spawns each subject's teacher
 * on the personal workspace, and the mock teacher plays scripted rounds from
 * the shipped lesson parts, one batch of calls per captain event, never a
 * model's teaching. The first mate declares ongoing work and requested
 * intelligence from the Lessons runbook, without a special task kind.
 */
export const lessons: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!wantsStream) return undefined;
    if (isFirstmate) {
      if (hasToolResults) return undefined;
      for (const lesson of [
        { ask: LESSON_CHESS_ASK, title: LESSON_CHESS_TITLE, goal: LESSON_CHESS_GOAL },
        { ask: LESSON_FRACTIONS_ASK, title: LESSON_FRACTIONS_TITLE, goal: LESSON_FRACTIONS_GOAL },
      ]) {
        if (latestUserTail.includes(lesson.ask)) {
          return {
            calls: [
              {
                name: "spawn_crewmate",
                args: {
                  title: lesson.title,
                  goal: lesson.goal,
                  user_words: lesson.ask,
                  personal_ui: true,
                  shape: { ongoing: true, intelligence: "high" },
                },
              },
            ],
          };
        }
      }
      // Stopping the lessons ends the subject the ordinary way (INF-1677):
      // its finished report reaches the first mate, which closes it.
      const reported = latestUserTail.match(/reported on task ([\w-]+)/)?.[1];
      if (reported && latestUserTail.includes(LESSONS_STOPPED_REPORT)) {
        return {
          calls: [
            {
              name: "settle_task",
              args: {
                task_id: reported,
                mode: "finished",
                completion_evidence: "the lessons stopped and their records are saved",
                closing_sentence: "The lessons are stopped; their records are kept.",
              },
            },
          ],
        };
      }
      return undefined;
    }
    if (!body.includes(LESSON_CHESS_ASK) && !body.includes(LESSON_FRACTIONS_ASK)) return undefined;
    const lessonCard = (
      id: string,
      title: string,
      cardBody: string,
      actions: { id: string; label: string; default?: boolean }[],
    ): ScriptedCall => ({
      name: "emit_card",
      args: { id, title, body: cardBody, holds_place: true, actions },
    });
    // The guide's id for a subject's next card, one past the highest the
    // conversation holds: a card the learner answered never comes back with
    // buttons, so every card counts up (docs/lessons.md).
    const nextCard = (subject: string) => {
      const used = [...body.matchAll(new RegExp(`lessons-${subject}-(\\d+)`, "g"))];
      return `lessons-${subject}-${Math.max(0, ...used.map((match) => Number(match[1]))) + 1}`;
    };
    const roundActions = [
      { id: "next-round", label: LESSON_CHOICES.nextRound, default: true },
      { id: "stop-today", label: LESSON_CHOICES.stopToday },
    ];
    // The served body is JSON, so the choice's quotes arrive escaped.
    const choseOnCard = (label: string) => latestUserTail.includes(`chose \\"${label}\\"`);
    const ready: ScriptedCall = { name: "report", args: { text: "Round ready." } };
    if (body.includes(LESSON_FRACTIONS_ASK)) {
      const results = toolAnswers(providerMessages(body)).join("\n");
      if (!hasToolResults) {
        return { calls: [{ name: "read", args: { path: "lessons/learner.md" } }] };
      }
      if (!calledTool(body, "emit_card")) {
        if (!results.includes(LESSON_LEARNER_LINE))
          throw new Error("The second subject did not read the shared learner file");
        return {
          calls: [
            {
              name: "write",
              args: {
                path: "lessons/fractions/progress.md",
                content: "# Fractions\nGoal: not yet asked\n## Skills\n- halves | next\n",
              },
            },
            lessonCard(
              nextCard("fractions"),
              LESSON_FRACTIONS_GOAL_TITLE,
              LESSON_FRACTIONS_GOAL_BODY,
              [
                { id: "start", label: LESSON_CHOICES.start, default: true },
                { id: "stop-today", label: LESSON_CHOICES.stopToday },
              ],
            ),
            ready,
          ],
        };
      }
      return { text: "Round ready." };
    }
    if (hasToolResults) return { text: "Round ready." };
    if (choseOnCard(LESSON_CHOICES.stopLessons)) {
      return {
        calls: [{ name: "report", args: { text: LESSONS_STOPPED_REPORT, finished: true } }],
      };
    }
    if (choseOnCard(LESSON_CHOICES.startToday)) {
      return {
        calls: [
          lessonCard(
            nextCard("chess"),
            LESSON_ROUND_REVIEW_TITLE,
            lessonRoundBody(
              chessItems(1),
              "the rook with a piece in the way",
              "A little review before new work.",
            ),
            roundActions,
          ),
          ready,
        ],
      };
    }
    if (choseOnCard(LESSON_CHOICES.stopToday)) {
      return {
        calls: [
          {
            name: "write",
            args: { path: "lessons/chess/progress.md", content: LESSON_PROGRESS_STOP },
          },
          lessonCard(nextCard("chess"), LESSON_WELCOME_TITLE, LESSON_WELCOME_BODY, [
            { id: "start-lesson", label: LESSON_CHOICES.startToday, default: true },
            { id: "stop-lessons", label: LESSON_CHOICES.stopLessons },
          ]),
          ready,
        ],
      };
    }
    if (choseOnCard(LESSON_CHOICES.nextRound)) {
      return {
        calls: [
          lessonCard(
            nextCard("chess"),
            LESSON_ROUND_TWO_TITLE,
            lessonRoundBody(
              chessItems(2),
              "the rook with a piece in the way",
              "Ranks and files, together.",
            ),
            roundActions,
          ),
          ready,
        ],
      };
    }
    if (choseOnCard(LESSON_CHOICES.start)) {
      return {
        calls: [
          {
            name: "write",
            args: {
              path: "lessons/learner.md",
              content: `# Learner\n${LESSON_LEARNER_LINE}\n`,
            },
          },
          {
            name: "write",
            args: {
              path: "lessons/chess/progress.md",
              content:
                "# Chess\nGoal: beat my dad at chess\n## Skills\n- rook slides | practising | first seen 2026-10-10\n",
            },
          },
          lessonCard(
            nextCard("chess"),
            LESSON_ROUND_ONE_TITLE,
            lessonRoundBody(
              chessItems(1),
              LESSON_NEXT_GOAL,
              "Today: how the rook slides along a file.",
            ),
            roundActions,
          ),
          ready,
        ],
      };
    }
    if (latestUserTail.includes(LESSON_REPLY_WORDS)) {
      const shown = latestUserTail.match(/Card \\+"[^"]*\\+" \(([^)]+)\)/)?.[1];
      if (!shown) throw new Error("The learner's reply named no card");
      return {
        calls: [
          {
            name: "reply",
            args: { card_id: shown, text: LESSON_REPLY_ANSWER, ...answering(latestUserTail) },
          },
        ],
      };
    }
    // The first turn: the goal comes first.
    return {
      calls: [
        lessonCard(nextCard("chess"), LESSON_GOAL_TITLE, LESSON_GOAL_BODY, [
          { id: "start", label: LESSON_CHOICES.start, default: true },
          { id: "stop-today", label: LESSON_CHOICES.stopToday },
        ]),
        ready,
      ],
    };
  };
