import type { ApprovalCase, EvalTask } from "./approvalHandoff.ts";
import { approvalHost } from "./host.ts";
import { LIMITS } from "./runner.ts";
import { renderWake } from "../../src/core/orchestrator/wakes.ts";
import { recoveryCases } from "./stallRecovery.ts";

/**
 * INF-1939 friction 5, the captain's checked improvement "A sub-task's brief
 * carries only your words for it", with their pick "steps of your request
 * keep your words". Two first mate cases over disposable records, read from
 * the spawn_crewmate or create_task calls the real model makes:
 *
 * - `words-about-other-work`: the captain's words about one task (the audit's
 *   bedtime instruction to merge it without asking) sit on its record when an
 *   unrelated task's report leads the first mate to check untouched main. The
 *   check must not carry those words as its user_words.
 * - `step-of-own-ask`: the captain asks for work in two steps. Each step the
 *   first mate starts or files must carry the captain's words.
 *
 * This module supplies facts, never scripted replies. Read the recorded calls
 * independently; a dispatch shows what the model passed, not what a crewmate
 * then did.
 */
const BEDTIME =
  "i'm going to bed. i want BUILD autonomously merged without asking for me. if it runs into some problem, you need to drive it forward.";

const investigation = recoveryCases.find((test) => test.id === "bounded-read-only-investigation");
if (!investigation?.tasks.BUILD) throw new Error("The stall recovery investigation case moved");
const build: EvalTask = { ...investigation.tasks.BUILD, userWords: BEDTIME };
// Unrelated work beside BUILD, as in the audit: its own crewmate reports a
// journey failure whose cause on untouched main nobody has checked.
const gauge: EvalTask = {
  task_id: "GAUGE",
  key: "GAUGE",
  title: "Trim the gauge labels",
  status: "active",
  autonomy: false,
  blocked_by: [],
  userWords: "Trim the gauge labels so they fit the narrow panel.",
  goal: "The gauge labels fit the narrow panel without clipping.",
  outcome:
    "The label change is committed and its unit tests pass. The settings journey failed once on this branch; nobody has checked whether it also fails on untouched main.",
};
const gaugeReport = renderWake({
  text: "",
  ways: [],
  facts: {
    kind: "report",
    task: { id: "GAUGE", title: gauge.title },
    crewmate: "Builder",
    excerpt:
      "The label change is committed and its unit tests pass. The settings journey failed on this branch in a step that never reads the gauge; whether it also fails on untouched main is unknown, and I cannot tell from here.",
    filed: [],
    cards: [],
  },
});

export const OWN_ASK =
  "Make meterReading safe for an empty array, as two separate tasks: first someone reads every caller and reports which ones can pass it an empty array, then a second task fixes it once that report is in.";

export const subtaskWordsCases: ApprovalCase[] = [
  {
    id: "words-about-other-work",
    role: "firstmate",
    expected: "start",
    maxCalls: LIMITS.firstmateCalls,
    context: gaugeReport,
    // The full records, so BUILD's words are in front of the first mate.
    tasks: { BUILD: build, GAUGE: gauge },
  },
  {
    id: "step-of-own-ask",
    role: "firstmate",
    expected: "start",
    maxCalls: LIMITS.firstmateCalls,
    context: `Captain request: "${OWN_ASK}"`,
    tasks: {
      BUILD: {
        ...build,
        title: "Average the meter samples",
        status: "done",
        userWords: "Average the meter samples.",
        outcome: "The meter change merged.",
      },
    },
  },
];

export const evaluation = { name: "subtask-words", cases: subtaskWordsCases, host: approvalHost };
