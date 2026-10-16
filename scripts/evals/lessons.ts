import type { ApprovalCase, EvalRun, EvalTask } from "./approvalHandoff.ts";
import { approvalHost } from "./host.ts";

/**
 * The lesson routing evaluation (FI3-1474): does a live Firstmate send a request
 * to learn a subject to one teacher on the personal workspace, steer an open
 * subject instead of starting a second, and leave an ordinary research ask alone.
 * It judges the Firstmate's chosen calls and their closed arguments. The isolated
 * host binds no personal workspace, so a personal-workspace start is refused there
 * and never runs; the call itself is the evidence. It opens no teacher session and
 * says nothing about how a model follows the lessons guide.
 */
export type LessonCase = ApprovalCase & {
  lesson: "start" | "steer" | "leave";
  /** The captain's words, which the start must carry verbatim. */
  words: string;
};
const record = (key: string, title: string, status: EvalTask["status"]): EvalTask => ({
  task_id: key,
  key,
  title,
  status,
  autonomy: false,
  blocked_by: [],
});
const say = (words: string) =>
  `The captain says: "${words}" Act on this message. No merge, discard or model change is authorized. Use the isolated records only.`;
const chessTask: Record<string, EvalTask> = {
  TEACH: { ...record("TEACH", "Teach chess", "active"), availableOwner: true },
};

export const lessonCases: LessonCase[] = [
  {
    id: "lesson-new-subject",
    role: "firstmate",
    expected: "start",
    lesson: "start",
    words: "Teach me how the rook moves in chess.",
    context: say("Teach me how the rook moves in chess."),
    tasks: {},
  },
  {
    id: "lesson-open-subject",
    role: "firstmate",
    expected: "wait",
    lesson: "steer",
    words: "Let's do some more chess today.",
    context: say("Let's do some more chess today."),
    tasks: chessTask,
  },
  {
    id: "lesson-second-subject",
    role: "firstmate",
    expected: "start",
    lesson: "start",
    words: "Teach me fractions on a number line.",
    context: say("Teach me fractions on a number line."),
    tasks: chessTask,
  },
  {
    id: "lesson-research-is-not-a-lesson",
    role: "firstmate",
    expected: "start",
    lesson: "leave",
    words: "Research which methods help children learn fractions best and report what you find.",
    context: say(
      "Research which methods help children learn fractions best and report what you find.",
    ),
    tasks: {},
  },
];
export const evaluation = { name: "lessons", cases: lessonCases, host: approvalHost };

export function scoreLessonRun(test: LessonCase, run: EvalRun): string[] {
  const failures: string[] = [];
  if (!run?.endedNormally) failures.push("The turn did not end normally");
  const calls = run?.calls ?? [];
  const spawns = calls.filter((call) => call.name === "spawn_crewmate");
  const steers = calls.filter((call) => call.name === "steer_crewmate");
  if (calls.some((call) => ["settle_task", "interrupt_crewmate", "emit_card"].includes(call.name)))
    failures.push("Nothing here authorizes settling, interrupting or showing a card");
  if (test.lesson === "start") {
    const spawn = spawns[0];
    if (spawns.length !== 1) failures.push("Start exactly one teacher");
    if (spawn && spawn.args.personal_ui !== true)
      failures.push("A teacher builds in place: personal_ui must be true");
    if (spawn && spawn.args.repo_id !== undefined)
      failures.push("The host binds the personal workspace: pass no repo_id");
    if (spawn && !String(spawn.args.user_words ?? "").includes(test.words))
      failures.push("Pass the captain's words verbatim as user_words");
    if (
      spawn &&
      Array.isArray(spawn.args.constraints) &&
      spawn.args.constraints.some((constraint) => constraint?.kind === "read-only")
    )
      failures.push("A lesson is not read-only");
    if (steers.length) failures.push("A new subject steers no existing teacher");
  } else if (test.lesson === "steer") {
    if (spawns.length) failures.push("An open subject has its teacher: start no second");
    if (!steers.some((call) => call.args.task_id === "TEACH"))
      failures.push("Steer the open subject's teacher");
  } else {
    const personal = spawns.filter((call) => call.args.personal_ui === true);
    if (personal.length) failures.push("An ordinary research ask is not a lesson");
    if (spawns.length !== 1) failures.push("Start the research once");
  }
  return failures;
}
