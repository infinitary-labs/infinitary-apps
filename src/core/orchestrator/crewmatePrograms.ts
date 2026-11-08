import type { StartProgramInput } from "../session/tools";
import type { TaskRecord } from "../storage/taskStore";
import { TaskGraphRefusal } from "../tasks/taskGraph";
import { TaskService } from "../tasks/taskService";
import type { CrewCore } from "./crewCore";
import type { TaskRuntime } from "./crewRuntime";

/** The built-in runbook whose switch serves programs, to the crewmate as to the first mate. */
export const PROGRAMS_RUNBOOK_ID = "programs";

/**
 * A crewmate starts the programs its task needs (INF-3022's plan, the
 * captain's Approve and build; docs/programs.md, "Starting a program"): the
 * only way a program starts. The program is filed through the same intake
 * the host has always checked programs with, found on the crewmate's task
 * as a follow-up is, never its child, and the crewmate's task always waits
 * on it, holding no merge (the captain's answer "always-wait"): its close
 * steers the crewmate once. The crewmate may also stop a program it
 * started, or raise its bound on the captain's words delivered into its
 * turn (`CrewSteer.carriesCaptainWords`).
 */
export class CrewmatePrograms {
  constructor(private readonly core: CrewCore) {}

  /**
   * Whether this task's crewmate may start a program: its task is in a
   * project that is not the personal workspace, it is not a program's part,
   * the app has a program process, and the Programs runbook is on. Elsewhere
   * the tool is not served at all.
   */
  servedTo(taskId: string): boolean {
    const { tasks, repos, programProcess, runbooks } = this.core.options;
    const record = tasks.get(taskId);
    if (!record?.repoId || !programProcess || record.shape?.program_part) return false;
    if (repos.get(record.repoId)?.kind === "personal") return false;
    return runbooks?.list().find((book) => book.id === PROGRAMS_RUNBOOK_ID)?.enabled !== false;
  }

  /** start_program: a new program, or with `program` a change to one this task started. */
  start(task: TaskRuntime, input: StartProgramInput): string {
    try {
      return input.program !== undefined ? this.change(task, input) : this.file(task, input);
    } catch (caught) {
      if (caught instanceof TaskGraphRefusal) return caught.message;
      throw caught;
    }
  }

  private file(task: TaskRuntime, input: StartProgramInput): string {
    const tasks = this.core.options.tasks;
    const origin = tasks.get(task.id);
    if (!origin) throw new Error(`Task ${task.id} no longer exists.`);
    const title = input.title?.trim().slice(0, 64) ?? "";
    const goal = input.goal?.trim() ?? "";
    if (!title || !goal)
      return "Nothing was filed. Give the program a title and a goal, one sentence saying what it finds or does.";
    if (input.stop)
      return "Nothing was filed. stop needs program, the key of a program you started.";
    const program = this.core.intake.plan({
      title,
      intent: { goal, userWords: origin.intent?.userWords || origin.title },
      ...(origin.repoId ? { repoId: origin.repoId } : {}),
      startPolicy: "when-ready",
      blockedBy: [],
      shape: {
        program: {
          script: input.script as string,
          bound: input.bound as number,
          ...(input.args !== undefined ? { args: input.args } : {}),
        },
        // The captain's premium consent on this task is the program's (INF-3022, answer "inherit").
        ...(origin.shape?.premium_ask ? { premium_ask: true } : {}),
      },
    });
    tasks.graph.link(program.id, origin.id, "discovered-from", "crewmate");
    tasks.graph.linkWaits(origin.id, [program.id], "crewmate");
    tasks.note(program.id, `started while working on "${origin.title}" (${keyOf(origin)})`, {
      news: true,
      actor: "crewmate",
      feed: false,
      about: [origin.id],
    });
    task.filedThisTurn.push({ key: keyOf(program), title, blocks: false, program: true });
    // The sweep starts it now, as it starts any when-ready task whose gates are clear.
    this.core.intake.graphChanged();
    return `Started program ${keyOf(program)} "${title}", found on your task, which now waits on it with no merge held. End your turn: its end steers you once, and then read its result with tasks key ${keyOf(program)}. If it reaches its bound you hear that instead.`;
  }

  private change(task: TaskRuntime, input: StartProgramInput): string {
    const tasks = this.core.options.tasks;
    const program = tasks.resolve(input.program?.trim() ?? "");
    const origin = program ? tasks.crewFilingOrigin(program.id) : undefined;
    if (!program?.shape?.program || origin?.id !== task.id)
      return `Nothing was changed. "${input.program}" is no program your task started; search with tasks.`;
    if (TaskService.isClosed(program)) return `${keyOf(program)} has already ended.`;
    if (input.stop)
      return this.core.intake.dropTask(program.id, {
        reason: "stopped by the crewmate that started it",
        confirm: true,
        actor: "crewmate",
      });
    if (input.bound === undefined)
      return "Nothing was changed. Give program with a larger bound, or with stop true.";
    if (!Number.isInteger(input.bound) || input.bound <= program.shape.program.bound)
      return `Nothing was changed. The bound is ${program.shape.program.bound}; give a larger whole number.`;
    // A bound is raised only on the captain's words, as update_task
    // program_bound is on the first mate's turn: a steer of his, or the
    // first mate's on his turn, delivered into this turn.
    if (!this.core.steer.carriesCaptainWords(task))
      return "Nothing was changed. A bound is raised only on the captain's words: ask the captain on a card first, and raise it in the turn his answer starts.";
    tasks.updateFields(program.id, { programBound: input.bound }, "crewmate");
    return `${keyOf(program)}'s bound is now ${input.bound}; its held call is filed.`;
  }
}

function keyOf(record: Pick<TaskRecord, "key" | "id">): string {
  return record.key || record.id;
}
