import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The scripted lesson loop (FI3-1474): the words the mock Firstmate and the
 * mock teacher use, and the round cards the teacher puts up. A round is
 * built from the SHIPPED lesson parts (`resources/personal-workspace/skills/
 * lessons/parts`), so a journey plays the very markup a teacher copies into
 * its cards. Scripted replies exercise the host and the card's own script,
 * never a model's teaching.
 */
const PARTS = join(process.cwd(), "resources", "runbooks", "lessons", "skills", "lessons", "parts");

export const LESSON_CHESS_ASK = "teach me chess: how the rook moves";
export const LESSON_CHESS_TITLE = "Teach chess";
export const LESSON_CHESS_GOAL = "Teach the learner chess, one lesson card at a time.";
export const LESSON_FRACTIONS_ASK = "teach me fractions on a number line";
export const LESSON_FRACTIONS_TITLE = "Teach fractions";
export const LESSON_FRACTIONS_GOAL = "Teach the learner fractions, one lesson card at a time.";
export const LESSON_REPLY_WORDS = "can the rook jump over a piece?";
export const LESSON_REPLY_ANSWER = "No. The rook slides, and a piece in the way stops it.";

export const LESSON_GOAL_TITLE = "Chess: what do you want to be able to do?";
export const LESSON_ROUND_ONE_TITLE = "Rook moves: sliding along a file";
export const LESSON_ROUND_TWO_TITLE = "Rook moves: ranks and files together";
export const LESSON_ROUND_REVIEW_TITLE = "Review: rook moves";
export const LESSON_WELCOME_TITLE = "Welcome back to chess";
export const LESSON_FRACTIONS_GOAL_TITLE = "Fractions: what do you want to be able to do?";
export const LESSON_FRACTIONS_ROUND_TITLE = "Halves and quarters on a number line";
export const LESSON_LEARNER_LINE = "Likes short steps and pictures.";
export const LESSON_GOAL_ANSWER = "beat my dad at chess";
export const LESSON_NEXT_GOAL = "the rook along a rank";

export type LessonItem = {
  id: string;
  q: string;
  draw?: Record<string, unknown>;
  kind: "choice" | "square";
  correct: string;
  wrong: string[];
  hints: string[];
  worked: string;
};

const BOARD = { pieces: [["R", "a1"]], label: "A rook on a1" };

/** Eight chess items, each choice about as long as the others. */
export function chessItems(round: 1 | 2): LessonItem[] {
  const squares =
    round === 1
      ? ["a5", "a7", "a3", "a8", "a2", "a6", "a4", "a7"]
      : ["h1", "d1", "g1", "c1", "e1", "b1", "f1", "h1"];
  return squares.map((square, index) => ({
    id: `rook-${round}-${index + 1}`,
    q: `The rook is on a1. Which square can it reach in one move?`,
    draw: { board: { ...BOARD, mark: [] } },
    kind: "choice",
    correct: square,
    wrong: [`b${(index % 6) + 2}`, `c${(index % 6) + 2}`],
    hints: ["A rook slides in a straight line.", "Look along the same file or rank as a1."],
    worked: `The rook slides along its file or rank, so ${square} is on its path.`,
  }));
}

export const FRACTION_ITEMS: LessonItem[] = Array.from({ length: 8 }, (_, index) => ({
  id: `half-${index + 1}`,
  q: "Where does one half sit on this number line?",
  draw: { line: { min: 0, max: 1, step: 0.25, marks: [{ at: 0.5, label: "?" }] } },
  kind: "choice",
  correct: "0.5",
  wrong: ["0.2", "0.8"],
  hints: ["Half is the middle.", "Count the steps from 0 to 1."],
  worked: "Half of the way from 0 to 1 is 0.5.",
}));

/** The round card body: the shipped parts in order, with the teacher's items filled in. */
export function lessonRoundBody(items: LessonItem[], nextGoal: string, aim: string): string {
  const part = (name: string) => readFileSync(join(PARTS, name), "utf8");
  const quiz = part("quiz.html").replace(
    'var CONFIG = { items: [], nextGoal: "" };',
    `var CONFIG = ${JSON.stringify({ items, nextGoal })};`,
  );
  return [
    `<p>${aim}</p>`,
    part("board.html"),
    part("progress.html"),
    part("finish.html"),
    quiz,
  ].join("\n");
}

/** The goal card: a text field named goal, and the warm voice a lesson card may use. */
export const LESSON_GOAL_BODY =
  '<p>Let\'s find out what you want to do with chess! ♟</p><p>Tell me in your own words, and I will point every round at it.</p><label for="goal">What do you want to be able to do?</label><input id="goal" name="goal" type="text">';

export const LESSON_FRACTIONS_GOAL_BODY =
  '<p>Let\'s find out what you want to do with fractions!</p><p>Tell me in your own words.</p><label for="goal">What do you want to be able to do?</label><input id="goal" name="goal" type="text">';

/** The welcome-back card: the goal, then each skill as practising, learned or next. */
export const LESSON_WELCOME_BODY =
  "<p>Your goal: beat my dad at chess.</p><ul><li>Rook slides: practising</li><li>Pawn captures: next</li></ul>";

export const LESSON_PROGRESS_STOP = [
  "# Chess",
  "Goal: beat my dad at chess",
  "## Skills",
  "- rook slides | practising | first seen 2026-10-10 | right first try 7 of 8",
  "- pawn captures | next",
  "## Next",
  "- the rook with a piece in the way",
  "",
].join("\n");
