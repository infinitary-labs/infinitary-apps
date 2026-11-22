import type {
  DecisionAnswer,
  DecisionCaller,
  DecisionQuestion,
  DecisionState,
} from "@shared/decisions";
import type { DecisionUseId } from "@shared/decisionUses";
import type { RepoView } from "@shared/repos";
import type { Deliverable, WorkShape } from "@shared/routingPolicy";
import type { StandingDirections } from "../knowledge/directions";
import { deliverableFor } from "../orchestrator/intentBrief";
import type { TaskRecord } from "../storage/taskRecords";

/**
 * The computer question (INF-1729, direction A; docs/helper.md, "Which
 * computer a new task starts on"): when two or more computers can run a new
 * Automatic task, the decision model reads the person's standing directions
 * beside the task and each computer's facts, and picks where it starts. The
 * app keeps every hard fact - a named computer, whether a computer can run
 * the task, its reach and fresh room - and the ordinary rules choose
 * whenever the model is unsure, gives no answer or picks a computer that can
 * no longer take the task.
 */

/** One computer the task could start on, as the question describes it. */
export type ComputerChoiceComputer = {
  /** Null is this computer. */
  computerId: string | null;
  name: string;
  /** This computer: the one Infinitary's window runs on. */
  here: boolean;
  /** Room to start now, busy, or out of reach. */
  status: "room" | "busy" | "away";
  /** How many more tasks like this one it has room for now; absent when unread. */
  roomFor?: number;
  /** The best model it serves for this task, as `provider/model`. */
  model?: string;
  /** The plan or task this one continues ran here. */
  continued: boolean;
};

export type ComputerChoiceTask = {
  title: string;
  goal: string;
  delivers: Deliverable;
  /** The kind of work task classification sorted it into. */
  kind?: string;
  project: string;
};

export type ComputerChoiceInput = {
  task: ComputerChoiceTask;
  /** The standing directions that apply to the task's project, everywhere ones included, each whole. */
  directions: readonly string[];
  computers: readonly ComputerChoiceComputer[];
};

export type ComputerPick = {
  computerId: string | null;
  mode: "start" | "wait";
  /** Who answered, for the record. */
  source?: string;
};

/**
 * What the question may send of the directions: each goes whole or not at
 * all, so the model never reads half of one. Jev's request body is capped
 * at 64 KB; this leaves the rest of the question ample room.
 */
const DIRECTIONS_BUDGET_CHARS = 24_000;

const UNSURE = "unsure";

/**
 * The answer that no direction decides, as an option of its own: a native
 * decision model never sees the abstention, so without it a model with
 * nothing to follow still names a computer.
 */
export const NO_DIRECTION = "usual";

const DELIVERS: Record<Deliverable, string> = {
  change:
    "a change to the project's code or files (a build, fix, chore or review headed for a pull request)",
  answer: "an answer or plan only; it changes no code",
  operation:
    "an operation such as merging, releasing or setting something up; it writes no new code",
};

function words(name: string): string[] {
  return (
    name
      .normalize("NFKD")
      .toLowerCase()
      .replace(/['’]s\b/g, "")
      .match(/[a-z]+/g) ?? []
  );
}

/** 0 is a, 25 is z, 26 is aa: a number as letters, which an answer keeps. */
function letters(n: number): string {
  return (n >= 26 ? letters(Math.floor(n / 26) - 1) : "") + String.fromCharCode(97 + (n % 26));
}

/**
 * A short id for each computer: the longest word of its name no other
 * computer's name has, so an answer reads `startmini` or `waitmacbook`.
 * Letters only, because a chat model's one-word answer is parsed as letters
 * (`parseOption`, docs/decision-models.md).
 */
function shortNames(computers: readonly ComputerChoiceComputer[]): string[] {
  const used = new Set<string>();
  return computers.map((computer, index) => {
    const others = new Set(
      computers.flatMap((other, at) => (at === index ? [] : words(other.name))),
    );
    const base = words(computer.name)
      .filter((word) => !others.has(word) && !used.has(word))
      .reduce<string | undefined>(
        (best, word) => (word.length > (best?.length ?? 0) ? word : best),
        undefined,
      );
    let id = base ?? "computer";
    for (let n = 0; used.has(id); n += 1) id = `computer${letters(n)}`;
    used.add(id);
    return id;
  });
}

type Option = { id: string; computerId: string | null; meaning: string };

/**
 * The computers the first question may name: each one, whatever its room,
 * since it asks where the task belongs, not where it can start now.
 */
export function computerChoiceOptions(computers: readonly ComputerChoiceComputer[]): Option[] {
  const names = shortNames(computers);
  return computers.map((computer, index) => ({
    id: `on${names[index] as string}`,
    computerId: computer.computerId,
    meaning: `This task belongs on ${computer.name}: its own words need ${computer.name}, or the standing directions send this kind of work to ${computer.name} first.`,
  }));
}

export const COMPUTER_QUESTION_VERSION = "cc13";

const WHICH_KIND =
  "Read task_delivers and task_title to tell what kind of work this task is; reviewing code headed for a pull request is code work.";
const OWN_WORDS =
  'A task whose task_title or task_goal says it must run on one particular computer, because it works with files, settings, logs or programs on that computer or says "on this MacBook" or "on the Mac mini", belongs on that computer whatever the directions say. "This computer", "this Mac", "my Downloads" or "my desktop" mean the computer Infinitary\'s window runs on. A name may be shortened.';

/** What the second question's answers do once the first named a computer. */
const IF_NOT_NOW = { anyway: "anyway", wait: "wait", other: "other" } as const;

/**
 * The questions, asked together: which computer the task belongs on, and,
 * when any computer cannot start it now, what the directions say for that
 * case. Two narrow questions, because a native decision model judged both at
 * once leaned to whichever computer had room.
 */
export function computerChoiceQuestions(
  computers: readonly ComputerChoiceComputer[],
): Record<string, DecisionQuestion> {
  const where: DecisionQuestion = {
    type: "choice",
    version: COMPUTER_QUESTION_VERSION,
    instructions: [
      "An app runs a person's AI tasks on one of their computers. A new task is about to start. Name the computer this task belongs on, whether or not that computer is busy or out of reach right now.",
      `1. ${OWN_WORDS}`,
      `2. Otherwise find the standing direction that says which computer runs this kind of work, and name the computer it sends this kind of work to first. ${WHICH_KIND}`,
      "3. Answer usual only when no direction says which computer runs this kind of work. A computer being busy or out of reach right now never makes the answer usual: this question asks where the task belongs, and another question handles a computer that cannot start it now. Directions about anything other than which computer runs work do not decide this.",
    ].join("\n"),
    criteria: {
      ...Object.fromEntries(
        computerChoiceOptions(computers).map((option) => [option.id, option.meaning]),
      ),
      [NO_DIRECTION]:
        "No standing direction says which computer runs this kind of task, and the task's own words need no particular computer, so the app's usual rules choose.",
      [UNSURE]: "The facts given do not make the answer clear.",
    },
    abstain: UNSURE,
  };
  if (computers.every((computer) => computer.status === "room")) return { computer: where };
  const notNow: DecisionQuestion = {
    type: "choice",
    version: COMPUTER_QUESTION_VERSION,
    instructions: [
      "An app runs a person's AI tasks on one of their computers. A new task is about to start.",
      `First find the computer this task belongs on. ${OWN_WORDS} Otherwise it is the computer the standing directions send this kind of work to first. ${WHICH_KIND}`,
      "Then answer what should happen to this task when that computer is busy or out of reach.",
      "A direction that says to use a computer for this kind of work even when it is busy, or never to use another computer for it, means keep it on that computer, also while it is out of reach. A direction that allows another computer when the first is busy or cannot take the work also allows it while the first is out of reach. Directions about anything other than which computer runs work do not decide this.",
    ].join("\n"),
    criteria: {
      [IF_NOT_NOW.anyway]:
        "Keep it on that computer: the task's own words need that computer, or the directions say to use it for this kind of work even when it is busy, or never to use another computer for it.",
      [IF_NOT_NOW.wait]: "Wait for that computer: the directions say to wait until it has room.",
      [IF_NOT_NOW.other]:
        "Use another computer: the directions allow another computer for this kind of work when the first is busy or cannot take it.",
      [NO_DIRECTION]:
        "No standing direction says which computer runs this kind of task, and the task's own words need no particular computer.",
      [UNSURE]: "The facts given do not make the answer clear.",
    },
    abstain: UNSURE,
  };
  return { computer: where, ifNotNow: notNow };
}

function computerLine(computer: ComputerChoiceComputer): string {
  const where = computer.here
    ? "this computer, the one Infinitary's window runs on"
    : "another computer of the person's";
  const status =
    computer.status === "away"
      ? "out of reach now"
      : computer.status === "busy"
        ? "busy: no room for this task now"
        : `has room${computer.roomFor !== undefined ? ` for about ${computer.roomFor} more task${computer.roomFor === 1 ? "" : "s"} like this` : ""}`;
  return [
    `${computer.name} (${where})`,
    status,
    ...(computer.model ? [`best model here ${computer.model}`] : []),
    ...(computer.continued ? ["the work this task continues ran here"] : []),
  ].join("; ");
}

export function directionsThatFit(directions: readonly string[]): {
  kept: string[];
  leftOut: number;
} {
  const kept: string[] = [];
  let used = 0;
  for (const direction of directions) {
    if (used + direction.length > DIRECTIONS_BUDGET_CHARS) continue;
    kept.push(direction);
    used += direction.length;
  }
  return { kept, leftOut: directions.length - kept.length };
}

export function computerChoiceState(input: ComputerChoiceInput): DecisionState {
  const { kept, leftOut } = directionsThatFit(input.directions);
  return {
    facts: {
      task_title: input.task.title,
      task_goal: input.task.goal,
      task_delivers: DELIVERS[input.task.delivers],
      ...(input.task.kind ? { task_kind: input.task.kind } : {}),
      project: input.task.project,
      standing_directions: kept.length ? kept.map((text) => `- ${text}`).join("\n") : "None.",
      ...(leftOut ? { directions_left_out: leftOut } : {}),
      ...Object.fromEntries(
        input.computers.map((computer, index) => [`computer_${index + 1}`, computerLine(computer)]),
      ),
    },
  };
}

/**
 * The pick the answers name, or undefined where the usual rules choose: the
 * first answer names the computer the task belongs on; one with room starts
 * it there, and one that cannot start it now follows the second answer -
 * start there anyway while busy, wait for it, or leave another computer to
 * the usual rules. Usual, unsure, a failure or an unknown option picks
 * nothing.
 */
export function readComputerPick(
  computers: readonly ComputerChoiceComputer[],
  answers: Record<string, DecisionAnswer | undefined>,
): ComputerPick | undefined {
  const where = answers.computer;
  if (where?.outcome !== "answered") return undefined;
  const at = computerChoiceOptions(computers).findIndex((each) => each.id === where.value);
  const computer = computers[at];
  if (!computer) return undefined;
  const source = where.source ? { source: where.source } : {};
  if (computer.status === "room")
    return { computerId: computer.computerId, mode: "start", ...source };
  const notNow = answers.ifNotNow;
  if (notNow?.outcome !== "answered") return undefined;
  if (
    notNow.value === IF_NOT_NOW.wait ||
    (notNow.value === IF_NOT_NOW.anyway && computer.status === "away")
  )
    return { computerId: computer.computerId, mode: "wait", ...source };
  if (notNow.value === IF_NOT_NOW.anyway)
    return { computerId: computer.computerId, mode: "start", ...source };
  return undefined;
}

/** The decision service as the computer question reaches it. */
export type ComputerChoiceModels = {
  decide(
    caller: DecisionCaller & { use: DecisionUseId },
    state: DecisionState,
    questions: Record<string, DecisionQuestion>,
    signal: AbortSignal,
  ): Promise<Record<string, DecisionAnswer>>;
  allowsUse(id: DecisionUseId): boolean;
};

/**
 * Asks the question once. The service bounds the call and never throws, so
 * any failure is no pick, and the ordinary rules choose.
 */
export async function askComputerChoice(
  models: ComputerChoiceModels,
  taskId: string,
  input: ComputerChoiceInput,
  signal: AbortSignal,
): Promise<ComputerPick | undefined> {
  if (input.computers.length < 2 || !models.allowsUse("computer")) return undefined;
  const answers = await models.decide(
    { purpose: "computer", use: "computer", taskId },
    computerChoiceState(input),
    computerChoiceQuestions(input.computers),
    signal,
  );
  return readComputerPick(input.computers, answers);
}

/**
 * The computer question as Automatic placement reaches it: whether its use
 * is on, and the pick for one task among the computers that can run it.
 */
export function computerChooser(
  models: ComputerChoiceModels,
  /** The standing directions that apply to a project's work, each whole. */
  directions: Pick<StandingDirections, "applying">,
) {
  return {
    allowed: () => models.allowsUse("computer"),
    pick: (
      record: TaskRecord,
      repo: RepoView,
      shape: WorkShape,
      computers: ComputerChoiceComputer[],
    ): Promise<ComputerPick | undefined> =>
      askComputerChoice(
        models,
        record.id,
        {
          task: {
            title: record.title,
            goal: record.intent?.goal ?? record.prompt,
            delivers: shape.deliverable ?? deliverableFor(record.intent ?? undefined, shape.kind),
            ...(shape.kind && shape.kind !== "unclear" ? { kind: shape.kind } : {}),
            project: repo.name,
          },
          directions: directions.applying(repo.id).map((row) => row.text),
          computers,
        },
        new AbortController().signal,
      ),
  };
}
