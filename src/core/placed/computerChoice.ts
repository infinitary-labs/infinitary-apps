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

/** What the model picked: start or wait on one computer. */
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

/** A name's words, lowercase letters only. */
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

type Option = { id: string; computerId: string | null; mode: "start" | "wait"; meaning: string };

/**
 * The closed set of answers: start on any computer with room or busy, wait
 * on one that is busy or out of reach, usual when no direction decides, or
 * unsure. A wait is offered only
 * where there is something to wait for.
 */
export function computerChoiceOptions(computers: readonly ComputerChoiceComputer[]): Option[] {
  const names = shortNames(computers);
  const options: Option[] = [];
  for (const [index, computer] of computers.entries()) {
    const id = names[index] as string;
    if (computer.status !== "away")
      options.push({
        id: `start${id}`,
        computerId: computer.computerId,
        mode: "start",
        meaning: `The person's standing directions send this task to ${computer.name} now${computer.status === "busy" ? ", even though it is busy" : ""}.`,
      });
    if (computer.status !== "room")
      options.push({
        id: `wait${id}`,
        computerId: computer.computerId,
        mode: "wait",
        meaning:
          computer.status === "busy"
            ? `The person's standing directions send this task to ${computer.name} and say to wait for it while it is busy.`
            : `The person's standing directions send this task to ${computer.name} and allow no other computer for it, so it waits until ${computer.name} is back in reach.`,
      });
  }
  return options;
}

export const COMPUTER_QUESTION_VERSION = "cc6";

/** The question, its options named for these computers. */
export function computerChoiceQuestion(
  computers: readonly ComputerChoiceComputer[],
): DecisionQuestion {
  return {
    type: "choice",
    version: COMPUTER_QUESTION_VERSION,
    instructions: [
      "An app runs a person's AI tasks on one of their computers. A new task is about to start, and more than one of the person's computers can run it. Pick where it starts by following the person's standing directions.",
      "1. Find the directions that say which computer runs work. A direction may shorten a computer's name, and \"this computer\" is the one Infinitary's window runs on. If none says which computer runs work, answer usual.",
      "2. Read task_delivers to tell what kind of work this task is, and find the computer the direction names for that kind of work.",
      "3. If that computer has room, start there. If it is busy or out of reach, do what the direction says for that case: start there anyway, wait for it, or use another computer. A direction that says to use a computer even when it is busy, or never to use another one for this kind of work, means start there while it is busy, and wait for it while it is out of reach: never start this kind of work on a computer the direction rules out. A direction that allows another computer when the first is busy or cannot take the work also allows it when the first is out of reach.",
      "Answer usual only when no direction says which computer runs this kind of work. Directions about anything other than which computer runs work do not decide this.",
    ].join("\n"),
    criteria: {
      ...Object.fromEntries(
        computerChoiceOptions(computers).map((option) => [option.id, option.meaning]),
      ),
      [NO_DIRECTION]:
        "No standing direction says which computer runs this kind of task, so the app's usual rules choose.",
      [UNSURE]: "The facts given do not make the answer clear.",
    },
    abstain: UNSURE,
  };
}

/** One computer's line of facts. */
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

/** The directions that fit, each whole, and how many did not. */
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

/** The facts the model reads: the task, the directions and each computer. */
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

/** The pick an answer names, or undefined for usual, unsure, a failure or an unknown option. */
export function readComputerPick(
  computers: readonly ComputerChoiceComputer[],
  answer: DecisionAnswer | undefined,
): ComputerPick | undefined {
  if (answer?.outcome !== "answered") return undefined;
  const option = computerChoiceOptions(computers).find((each) => each.id === answer.value);
  return option
    ? {
        computerId: option.computerId,
        mode: option.mode,
        ...(answer.source ? { source: answer.source } : {}),
      }
    : undefined;
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
    { computer: computerChoiceQuestion(input.computers) },
    signal,
  );
  return readComputerPick(input.computers, answers.computer);
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
