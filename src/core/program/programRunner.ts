import { randomUUID } from "node:crypto";
import { availableParallelism } from "node:os";
import { type IntelligenceBucket, intelligenceBucketSchema } from "@shared/modelSlots";
import type { WorkShape, WorkShapeAsk } from "@shared/routingPolicy";
import type { HostChildProcess, HostChildSpawner } from "../host";
import type { CrewSupervisorOptions, FirstmateHooks } from "../orchestrator/crewSupervisorOptions";
import type { TaskIntake } from "../orchestrator/intake";
import { parseSpawnIntent, renderIntentBrief, type SpawnIntent } from "../orchestrator/intentBrief";
import type { SettleOwners } from "../orchestrator/settleOwners";
import type { TypedWake } from "../orchestrator/wakes";
import { handOffShape, withDeliverable, workShape } from "../orchestrator/workShape";
import { tierFor } from "../routing/policy";
import type { TaskRecord } from "../storage/taskRecords";
import { resultRefusal } from "../tasks/taskResult";
import { TaskService } from "../tasks/taskService";
import { askJson } from "./programAsk";
import type { ProgramChildMessage, ProgramParentMessage } from "./programProtocol";
import { callDigest, programRefusal } from "./programScript";

/**
 * The program runner (INF-799 piece 2, docs/programs.md). A program is a
 * task whose shape carries a script; the host runs it here, never through
 * a model. Each running program has one process of its own
 * (./programProcess.ts) that evaluates the script; every host function the
 * script calls arrives as one call:
 *
 * - task(prompt, options) files a part, a child task of the program, and
 *   answers with the part's checked result once its crewmate reports it,
 *   its report text when it declared no shape, or null when it was dropped;
 * - ask(prompt, schema) answers through the one-question session with JSON
 *   the host checks against the schema, or null;
 * - log(text) and phase(name) write a line and the plan dots on the
 *   program's own timeline.
 *
 * The record is the journal. A part carries which call filed it and the
 * call's digest (`program_part`), an ask's answer rides a note on the
 * program's timeline, and so do the counts of its log and phase lines.
 * After a quit the sweep runs the program again: the script replays from
 * the top, and each call equal to a recorded one takes that call's answer
 * instead of running again, which is Claude's own resume rule.
 *
 * Two bounds, neither a number the host made up. The parts open at once
 * follow this Mac's processors, Claude's own rule. The total rests on the
 * captain's consent: the crewmate that starts the program proposes it, and a
 * call past it is held - nothing filed - until it is raised on the
 * captain's words, by that crewmate while its task is active or else by the
 * first mate, or the program is dropped (the `program-bound` hold).
 *
 * The crew's side lives here too: `programShape` checks the program a new
 * task declares, and `CrewPrograms` is the host this runner calls - it
 * files and closes parts, answers ask(), holds a call at the bound and
 * records how a program ended. The crew supervisor composes both.
 */

function errorText(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/** Parts one program keeps open at once: one per processor, as Claude's runtime does. */
export const PROGRAM_PARTS_CAP = Math.max(1, availableParallelism());

/** A part the runner asks the host to file. */
export type ProgramPartAsk = {
  prompt: string;
  label: string;
  /** The result shape its report must carry, when the script declared one. */
  schema?: Record<string, unknown>;
  /** The script's requested slot; absent keeps ordinary kind-based routing. */
  intelligence?: IntelligenceBucket;
  /** The part, by id, whose last commit its working copy starts at. */
  from?: string;
  /** The parts, by id, whose results it builds on: each a `blocks` link to it. */
  after: string[];
  call: number;
  hash: string;
};

/** What a program ended with: its script's return value, or why it stopped. */
export type ProgramEnd = { value: unknown } | { error: string };

export type ProgramHost = {
  tasks: TaskService;
  /** Absent: the host has no program process, and a program cannot run. */
  spawner: HostChildSpawner | undefined;
  /** Files a part under the program, or says in words why it cannot. */
  filePart(program: TaskRecord, part: ProgramPartAsk): TaskRecord | { refused: string };
  /** Closes a part whose result the program has read, done, its work kept. */
  closePart(partId: string): Promise<void>;
  /** One tool-less typed read; null when no answer fit the schema. */
  ask(
    program: TaskRecord,
    prompt: string,
    schema: Record<string, unknown> | null,
  ): Promise<unknown>;
  /** The program ended: the host records it, drops what is still open and tells its starter, else the first mate. */
  finish(program: TaskRecord, end: ProgramEnd): Promise<void>;
  /** A call reached the program's bound and is held; its starter, else the first mate, hears it once per bound. */
  bounded(program: TaskRecord, calls: number): void;
  /** Parts one program keeps open at once, when not this computer's processors (`PROGRAM_PARTS_CAP`). */
  partsAtOnce?: number;
};

/** A recorded ask's answer, on a note of the program's timeline. */
type AskNote = { programAsk: { hash: string; value: unknown }; journal?: true };
/** Which log or phase line of the script a timeline line is, on its own facts. */
type LineNote = { programLine: { op: "log" | "phase"; n: number } };

type Call = { id: number; input: unknown[] };

class RunningProgram {
  readonly child: HostChildProcess;
  /** Parts recorded before this run, not yet taken by an equal call. */
  private readonly recorded: TaskRecord[];
  /** Asks recorded before this run, not yet taken by an equal call. */
  private readonly asks: { hash: string; value: unknown }[];
  private readonly lines: { log: number; phase: number };
  private readonly written = { log: 0, phase: 0 };
  /** Every phase this run named, in order, for the plan dots. */
  private readonly phases: string[] = [];
  /** The part each label names, for options.from and options.after. */
  private readonly labels = new Map<string, string>();
  /** Every label an accepted call carries, filed or still queued. */
  private readonly named = new Set<string>();
  /** The calls each open part answers when it closes. */
  private readonly waiters = new Map<string, Call[]>();
  /** Calls not yet filed: past the bound, or waiting for a part to close. */
  private readonly queue: {
    call: Call;
    part: Omit<ProgramPartAsk, "call" | "from" | "after">;
    /** The labels it names, resolved to parts when it is filed. */
    from?: string;
    after: string[];
  }[] = [];
  private calls = 0;
  private ended = false;

  constructor(
    private readonly host: ProgramHost,
    private readonly programId: string,
    spawner: HostChildSpawner,
    private readonly onEnd: () => void,
  ) {
    const tasks = host.tasks;
    const program = this.program();
    this.recorded = tasks.graph
      .children(programId)
      .filter((child) => child.shape?.program_part)
      .sort((a, b) => (a.shape?.program_part?.call ?? 0) - (b.shape?.program_part?.call ?? 0));
    const notes = tasks.timeline(programId).map((event) => event.data ?? {});
    this.asks = notes
      .filter((data): data is AskNote => typeof data.programAsk === "object")
      .map((data) => ({ ...data.programAsk }));
    // The highest line number written, not a count: compaction folds the
    // oldest lines and keeps the highest it folded on its row.
    const linesOf = (op: "log" | "phase") =>
      Math.max(
        0,
        ...notes.map((data) => {
          const line = (data as Partial<LineNote>).programLine;
          const folded = (data as { programLines?: Partial<Record<string, number>> }).programLines;
          return line?.op === op ? line.n : (folded?.[op] ?? 0);
        }),
      );
    this.lines = { log: linesOf("log"), phase: linesOf("phase") };
    this.child = spawner.spawn();
    this.child.onMessage((message) => this.onMessage(message as ProgramChildMessage));
    this.child.onExit(() => {
      if (!this.ended)
        void this.end({ error: "the program's process ended before its script did" });
    });
    this.send({
      type: "run",
      script: program.shape?.program?.script ?? "",
      args: program.shape?.program?.args ?? null,
    });
  }

  private program(): TaskRecord {
    const record = this.host.tasks.get(this.programId);
    if (!record) throw new Error(`program ${this.programId} is not on record`);
    return record;
  }

  private send(message: ProgramParentMessage): void {
    if (!this.ended) this.child.postMessage(message);
  }

  private answer(call: Call, value: unknown): void {
    this.send({ type: "answer", id: call.id, value: value ?? null });
  }

  private refuse(call: Call, message: string): void {
    this.send({ type: "refuse", id: call.id, message });
  }

  private onMessage(message: ProgramChildMessage): void {
    if (this.ended) return;
    if (message.type === "done") {
      void this.end({ value: message.value });
      return;
    }
    if (message.type === "failed") {
      void this.end({ error: message.message });
      return;
    }
    const call = { id: message.id, input: message.input };
    switch (message.op) {
      case "task":
        this.task(call);
        return;
      case "ask":
        void this.ask(call);
        return;
      case "log":
      case "phase":
        this.line(call, message.op);
        return;
    }
  }

  /** task(prompt, options): a recorded part's answer, or a part filed now. */
  private task(call: Call): void {
    const [prompt, options] = call.input as [unknown, Record<string, unknown> | undefined];
    if (typeof prompt !== "string" || !prompt.trim()) {
      this.refuse(call, "task() takes the part's prompt as a string first.");
      return;
    }
    // A chain's first call often says from: null (no earlier part yet): null is no from.
    const opts: Record<string, unknown> = { ...options, from: options?.from ?? undefined };
    const number = this.calls++;
    const explicit =
      typeof opts.label === "string" && opts.label.trim() ? opts.label.trim() : undefined;
    const label = explicit ?? `part ${number + 1}`;
    const schema = opts.schema;
    if (
      schema !== undefined &&
      (typeof schema !== "object" || schema === null || Array.isArray(schema))
    ) {
      this.refuse(call, "task()'s schema must be a JSON Schema object.");
      return;
    }
    const intelligence = intelligenceBucketSchema.optional().safeParse(opts.intelligence);
    if (!intelligence.success) {
      this.refuse(call, "task()'s intelligence must be low, medium, high, or premium.");
      return;
    }
    const afterRefs: unknown[] = Array.isArray(opts.after)
      ? opts.after
      : opts.after === undefined
        ? []
        : [opts.after];
    const refs = [...(opts.from === undefined ? [] : [opts.from]), ...afterRefs];
    // A label is known once its call is accepted, filed or still queued.
    const unknown = refs.find((ref) => typeof ref !== "string" || !this.named.has(ref));
    if (unknown !== undefined) {
      this.refuse(
        call,
        `task() names "${String(unknown)}", which no earlier task() call of this program is labelled.`,
      );
      return;
    }
    // Only what the script wrote keys the call: a default label counts calls
    // in the order they arrive, which a replay of parallel work may change.
    const hash = callDigest("task", [
      prompt,
      {
        label: explicit,
        schema,
        from: opts.from,
        after: opts.after,
        intelligence: intelligence.data,
      },
    ]);
    this.named.add(label);
    const at = this.recorded.findIndex((part) => part.shape?.program_part?.hash === hash);
    const recorded = at >= 0 ? this.recorded.splice(at, 1)[0] : undefined;
    if (recorded) {
      this.labels.set(label, recorded.id);
      this.await(recorded, call);
      return;
    }
    this.queue.push({
      call,
      part: {
        prompt,
        label,
        ...(intelligence.data ? { intelligence: intelligence.data } : {}),
        ...(schema ? { schema: schema as Record<string, unknown> } : {}),
        hash,
      },
      ...(typeof opts.from === "string" ? { from: opts.from } : {}),
      after: afterRefs as string[],
    });
    this.pump();
  }

  /** Files queued calls while the bound and the open parts allow. */
  pump(): void {
    if (this.ended) return;
    const tasks = this.host.tasks;
    while (this.queue.length > 0) {
      const program = this.program();
      const parts = tasks.graph
        .children(this.programId)
        .filter((child) => child.shape?.program_part);
      const bound = program.shape?.program?.bound ?? 0;
      if (parts.length >= bound) {
        this.host.bounded(program, parts.length);
        return;
      }
      const open = parts.filter((part) => part.status === "open" || part.status === "active");
      if (open.length >= (this.host.partsAtOnce ?? PROGRAM_PARTS_CAP)) return;
      const next = this.queue.shift();
      if (!next) return;
      // Queued in call order, so a part it names was filed before it, unless refused.
      const missing = [...(next.from ? [next.from] : []), ...next.after].find(
        (ref) => !this.labels.has(ref),
      );
      if (missing !== undefined) {
        this.refuse(next.call, `task() names "${missing}", whose own task() call was refused.`);
        continue;
      }
      const from = next.from ? this.labels.get(next.from) : undefined;
      const after = next.after.map((ref) => this.labels.get(ref) ?? ref);
      let filed: TaskRecord | { refused: string };
      try {
        filed = this.host.filePart(program, {
          ...next.part,
          ...(from ? { from } : {}),
          after,
          call: parts.length,
        });
      } catch (caught) {
        filed = { refused: `the part could not be filed: ${errorText(caught)}` };
      }
      if ("refused" in filed) {
        this.refuse(next.call, filed.refused);
        continue;
      }
      this.labels.set(next.part.label, filed.id);
      this.await(filed, next.call);
    }
  }

  /** The call answers with the part's result once it closes; a closed part answers now. */
  private await(recorded: TaskRecord, call: Call): void {
    // The record as it stands now: a recorded part may have closed since the run began.
    const part = this.host.tasks.get(recorded.id) ?? recorded;
    const settled = this.settledValue(part);
    if (settled !== undefined) {
      this.answer(call, settled.value);
      return;
    }
    this.waiters.set(part.id, [...(this.waiters.get(part.id) ?? []), call]);
    // A part that reported its answer before a quit is closed on replay.
    if (part.status === "active" && this.answered(part)) void this.host.closePart(part.id);
  }

  /**
   * Whether the part's last report answers its call, by the report sort's
   * own rule: none that names a check-back, whose work still runs; a result
   * when it declared a shape, else a report that hands the turn to no one.
   */
  private answered(part: TaskRecord): boolean {
    const last = this.host.tasks
      .timeline(part.id)
      .filter((event) => event.kind === "report")
      .at(-1)?.data;
    if (!last || last.checkBack !== undefined) return false;
    if (part.shape?.result_schema) return last.result !== undefined;
    return last.waitingOnCaptain === undefined && last.needsFirstmate === undefined;
  }

  /** What a closed part answers: its checked result, its report, or null. */
  private settledValue(part: TaskRecord): { value: unknown } | undefined {
    if (part.status === "dropped") return { value: null };
    if (part.status !== "done") return undefined;
    if (part.shape?.result_schema)
      return { value: this.host.tasks.latestResult(part.id)?.value ?? null };
    return { value: part.outcome ?? null };
  }

  /** A part changed: a closed one answers its calls, and frees room for the queue. */
  partsChanged(ids: readonly string[]): void {
    if (this.ended) return;
    let freed = false;
    for (const id of ids) {
      const calls = this.waiters.get(id);
      if (!calls) continue;
      const part = this.host.tasks.get(id);
      const settled = part ? this.settledValue(part) : { value: null };
      if (!settled) continue;
      this.waiters.delete(id);
      freed = true;
      for (const call of calls) this.answer(call, settled.value);
    }
    if (freed || this.queue.length > 0) this.pump();
  }

  /** A part reported its answer: the program reads it and closes the part. */
  hasPart(id: string): boolean {
    return this.waiters.has(id);
  }

  private async ask(call: Call): Promise<void> {
    const [prompt, schema] = call.input as [unknown, unknown];
    if (typeof prompt !== "string" || !prompt.trim()) {
      this.refuse(call, "ask() takes its question as a string first.");
      return;
    }
    if (schema !== null && (typeof schema !== "object" || Array.isArray(schema))) {
      this.refuse(call, "ask()'s schema must be a JSON Schema object.");
      return;
    }
    const hash = callDigest("ask", [prompt, schema]);
    const at = this.asks.findIndex((recorded) => recorded.hash === hash);
    const recorded = at >= 0 ? this.asks.splice(at, 1)[0] : undefined;
    if (recorded) {
      this.answer(call, recorded.value);
      return;
    }
    let value: unknown;
    try {
      value = await this.host.ask(this.program(), prompt, schema as Record<string, unknown> | null);
    } catch (caught) {
      if (!this.ended) this.refuse(call, `ask() could not be answered: ${errorText(caught)}`);
      return;
    }
    if (this.ended) return;
    this.host.tasks.note(this.programId, `asked: ${prompt.slice(0, 200)}`, {
      news: false,
      actor: "host",
      // A journal event: compaction never folds an answer a replay takes back.
      data: { programAsk: { hash, value: value ?? null }, journal: true } satisfies AskNote,
    });
    this.answer(call, value);
  }

  /**
   * log(text) and phase(name): a line on the program's timeline. A replay
   * writes again only the lines past those the record already holds.
   */
  private line(call: Call, op: "log" | "phase"): void {
    const text = String(call.input[0] ?? "").slice(0, 500);
    if (op === "phase") this.phases.push(text);
    this.written[op] += 1;
    if (this.written[op] > this.lines[op]) {
      const plan =
        op === "phase"
          ? this.phases.map((label, at) => ({
              label,
              short: label.slice(0, 16),
              state: at === this.phases.length - 1 ? ("current" as const) : ("done" as const),
            }))
          : undefined;
      this.host.tasks.noteProgress(
        this.programId,
        op === "phase" ? `Phase: ${text}` : text,
        "host",
        plan,
        {
          programLine: { op, n: this.written[op] },
        } satisfies LineNote,
      );
    }
    this.answer(call, null);
  }

  private async end(end: ProgramEnd): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.child.kill();
    try {
      // Still running while it finishes: the sweep a part's close runs must not start it again.
      const program = this.host.tasks.get(this.programId);
      if (program && program.status === "open") await this.host.finish(program, end);
    } finally {
      this.onEnd();
    }
  }

  /** The program was dropped or the app is quitting: its process goes, its record stays. */
  stop(): void {
    if (this.ended) return;
    this.ended = true;
    this.child.kill();
    this.onEnd();
  }
}

/**
 * Every running program, by its task's id. The sweep calls `run` for each
 * ready program task, at boot as on every tick, so a program a quit
 * stopped starts again from its record; a running one is left alone.
 */
export class ProgramRunner {
  private readonly running = new Map<string, RunningProgram>();
  /** Programs being dropped: they never run again, whatever the sweep finds. */
  private readonly halted = new Set<string>();
  private readonly unsubscribe: () => void;

  constructor(private readonly host: ProgramHost) {
    // The listener must not write tasks, so what it hears is handled after the write.
    this.unsubscribe = host.tasks.onChange((change) => {
      if (this.running.size === 0) return;
      const ids = change.taskIds;
      queueMicrotask(() => this.changed(ids));
    });
  }

  /** Runs the program task, unless it already runs. Refuses in words when it cannot. */
  run(programId: string): string | undefined {
    if (this.running.has(programId) || this.halted.has(programId)) return undefined;
    const spawner = this.host.spawner;
    if (!spawner) return "this app has no program process, so a program cannot run here.";
    const program = this.host.tasks.get(programId);
    if (!program?.shape?.program || program.status !== "open") return undefined;
    const running = new RunningProgram(this.host, programId, spawner, () =>
      this.running.delete(programId),
    );
    this.running.set(programId, running);
    this.host.tasks.starts.markProgramStarted(programId);
    return undefined;
  }

  /** The program is being dropped: its process goes and it never runs again. */
  halt(programId: string): void {
    this.halted.add(programId);
    this.running.get(programId)?.stop();
  }

  isRunning(programId: string): boolean {
    return this.running.has(programId);
  }

  /**
   * Whether a report on this task is a running program's part answering
   * one of its calls: the report sort's program row reads it.
   */
  awaits(partId: string): boolean {
    const parentId = this.host.tasks.get(partId)?.parentId;
    return parentId ? (this.running.get(parentId)?.hasPart(partId) ?? false) : false;
  }

  private changed(ids: readonly string[]): void {
    for (const id of ids) {
      const running = this.running.get(id);
      const record = this.host.tasks.get(id);
      // A program dropped or closed by anyone stops; its open parts go with it.
      if (running && record && record.status !== "open") running.stop();
    }
    for (const running of this.running.values()) running.partsChanged(ids);
  }

  /** The app is quitting: every program process goes; each runs again from its record at boot. */
  dispose(): void {
    this.unsubscribe();
    for (const running of [...this.running.values()]) running.stop();
  }
}

/**
 * The program a new task declares (INF-799 piece 2, docs/programs.md):
 * its script checked for imports and that it compiles, its bound a
 * positive whole number, and a program process to run it on. A refusal
 * is words, nothing filed. A program runs in a project's working copies,
 * so it needs a project that is not the personal workspace, and it has
 * none of its own to branch.
 */
export function programShape(
  ask: WorkShapeAsk,
  repoId: string | null,
  personal: boolean,
  spawner: HostChildSpawner | undefined,
): NonNullable<WorkShape["program"]> | string {
  const program = ask.program;
  if (!program) return "No program was given.";
  if (!spawner) return "This app cannot run a program.";
  if (!repoId || personal)
    return "A program runs its parts in a project: give it a repo_id or a parent in one, not the personal workspace.";
  if (ask.branch_from)
    return "A program has no working copy of its own; give branch_from to its parts.";
  const refused = programRefusal(program);
  if (refused) return refused;
  return {
    script: program.script,
    bound: program.bound,
    ...(program.args !== undefined ? { args: program.args } : {}),
  };
}

/**
 * The branches of the finished programs this task's crewmate started
 * (docs/programs.md, "Starting a program"): each program by key and title,
 * and the part whose saved work a shipping task branches from. Its
 * starter's report wake names them, so shipping one rests on this typed
 * fact rather than the report's words.
 */
export function startedProgramBranches(
  tasks: TaskService,
  taskId: string,
): { key: string; title: string; branch: string }[] {
  return tasks.graph.linksTo(taskId).flatMap((link) => {
    if (link.type !== "discovered-from" || link.actor !== "crewmate") return [];
    const program = tasks.get(link.fromId);
    if (program?.status !== "done" || !program.shape?.program) return [];
    const label = tasks.latestResult(program.id)?.value.branch;
    if (typeof label !== "string" || !label.trim()) return [];
    const part = tasks.graph
      .children(program.id)
      .find((child) => child.status === "done" && child.shape?.program_part?.label === label);
    return part
      ? [{ key: program.key || program.id, title: program.title, branch: part.key || part.id }]
      : [];
  });
}

/** A finished program's report: how many parts ran, its result and the branch it leaves. */
function programReportText(
  parts: number,
  result: Record<string, unknown> | undefined,
  branch: TaskRecord | undefined,
): string {
  return [
    `The program finished after ${parts} ${parts === 1 ? "part" : "parts"}.`,
    ...(result ? [`Its result: ${JSON.stringify(result)}`] : []),
    branch
      ? `Its branch: the last commit of ${branch.key || branch.id} "${branch.title}".`
      : "Its script returned no branch, so there is nothing to ship.",
  ].join(" ");
}

/** What the crew's program side reaches of the crew supervisor beyond its options. */
export type CrewProgramsHost = {
  now(): number;
  /** Settling and closing: a part's close and a dropped part's teardown. */
  readonly settling: SettleOwners;
  /** Where a filed part runs and how it delivers (`TaskIntake.resolveGraphPlacement`). */
  resolveGraphPlacement: TaskIntake["resolveGraphPlacement"];
  /** Tell the first mate an operation happened. */
  notifyOp: FirstmateHooks["notifyOp"];
  /** Tell the window the crew's counts changed. */
  broadcastCrewCounts(): void;
  /** Run the ready sweep now. */
  sweepGates(now: number): Promise<void>;
  /** Steer a task's crewmate: the one that started a program hears it first. */
  steer(taskId: string, wake: TypedWake): Promise<unknown>;
};

/**
 * The crew's side of a running program (INF-799 piece 2, docs/programs.md):
 * the `ProgramHost` callbacks the runner calls. The crew supervisor
 * composes it and wires the runner to it.
 */
export class CrewPrograms {
  /** The bound each program last told of reaching, so it is heard once per bound. */
  private readonly boundTold = new Map<string, number>();

  constructor(
    private readonly options: CrewSupervisorOptions,
    private readonly host: CrewProgramsHost,
  ) {}

  /**
   * One task() call of a program, filed as a part (INF-799 piece 2): a
   * child of the program, when-ready, an internal step that delivers its
   * branch and its result (local-only, never a pull request), with the
   * script's schema as its result shape, the part it starts from as its
   * branch_from, and a `blocks` link from each part whose result it builds
   * on. It carries the captain's words the program was filed with.
   */
  fileProgramPart(program: TaskRecord, part: ProgramPartAsk): TaskRecord | { refused: string } {
    if (part.intelligence === "premium" && !program.shape?.premium_ask) {
      return {
        refused:
          "This part asks for premium; the captain must request premium for the program first.",
      };
    }
    const from = part.from ? this.options.tasks.get(part.from) : undefined;
    const ask: WorkShapeAsk = {
      internal_step: true,
      delivery_ask: "local-only",
      ...(part.intelligence === "premium" ? { premium_ask: true } : {}),
      ...(part.schema ? { result_schema: part.schema } : {}),
      ...(from ? { branch_from: from.key || from.id } : {}),
    };
    const handOff = handOffShape(this.options.tasks, ask, program.repoId);
    if ("refused" in handOff) return { refused: handOff.refused };
    let intent: SpawnIntent;
    try {
      intent = parseSpawnIntent({
        goal: part.prompt,
        user_words: program.intent?.userWords || program.title,
        ...(program.intent?.constraints ? { constraints: program.intent.constraints } : {}),
      });
    } catch (caught) {
      return { refused: caught instanceof Error ? caught.message : String(caught) };
    }
    const placement = this.host.resolveGraphPlacement({
      parent: program.id,
      blockedBy: part.after,
      intent,
      shape: ask,
    });
    const shape = withDeliverable(
      {
        ...workShape(this.options.tasks, ask),
        ...handOff,
        program_part: {
          call: part.call,
          hash: part.hash,
          label: part.label,
          ...(part.intelligence ? { intelligence: part.intelligence } : {}),
        },
      },
      intent,
    );
    const title = (part.prompt.trim().split("\n")[0] ?? part.label).slice(0, 64);
    const record = this.options.tasks.create({
      id: randomUUID().slice(0, 8),
      kind: "work",
      title,
      prompt: renderIntentBrief(intent, placement.delivery),
      intent,
      repoId: placement.repoId,
      difficulty: tierFor(shape).bucket ?? null,
      shape,
      parentId: program.id,
      ...(placement.blockedBy.length > 0 ? { blockedBy: placement.blockedBy } : {}),
      startPolicy: "when-ready",
      status: "open",
    });
    this.options.broadcastEvent({
      type: "firstmate_note",
      text: `The program "${program.title}" (${program.key}) filed part ${record.key}: "${title}".`,
    });
    this.host.broadcastCrewCounts();
    void this.host.sweepGates(this.host.now());
    return record;
  }

  /**
   * A part reported the answer its program waits for: it closes done,
   * answered, its working copy retired with its work saved on its kept ref
   * so a later part or the shipping task can branch from it. After the
   * turn's own idle boundary, never inside it.
   */
  closeProgramPart(partId: string): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(() => {
        const part = this.options.tasks.get(partId);
        if (!part || TaskService.isClosed(part)) return resolve();
        void this.host.settling.closing
          .closeTask(partId, {
            status: "done",
            reason: "answered",
            actor: "host",
            text: "answered - its program read its result",
          })
          .catch((caught: unknown) => console.warn("[program] a part did not close:", caught))
          .finally(resolve);
      }, 0);
    });
  }

  /** A program's ask(): the question session's JSON answer, checked, or null. */
  async programAsk(
    program: TaskRecord,
    prompt: string,
    schema: Record<string, unknown> | null,
  ): Promise<unknown> {
    const answer = this.options.answerJson;
    if (!answer) return null;
    return askJson(
      (instruction, text) =>
        answer(
          { purpose: "program-ask", taskId: program.id },
          instruction,
          text,
          new AbortController().signal,
        ),
      prompt,
      schema,
    );
  }

  /**
   * The crewmate that started a program, while its task is active, hears
   * the program's bound and end first (INF-3022, the captain's answer
   * "crewmate-then-first-mate"). A started task back in the backlog, or a
   * closed one, leaves them to the first mate.
   */
  private starter(program: TaskRecord): TaskRecord | undefined {
    const origin = this.options.tasks.crewFilingOrigin(program.id);
    return origin?.status === "active" && origin.backlogSince == null ? origin : undefined;
  }

  /**
   * A program's call reached its bound (the `program-bound` hold, resting
   * on the captain's consent): nothing more is filed, and it is heard once
   * per bound, to ask the captain - by the crewmate that started it while
   * its task is active, else by the first mate.
   */
  programBounded(program: TaskRecord, calls: number): void {
    const bound = program.shape?.program?.bound ?? 0;
    if (this.boundTold.get(program.id) === bound) return;
    this.boundTold.set(program.id, bound);
    this.options.tasks.note(program.id, `held at its bound of ${bound} parts`, {
      news: true,
      actor: "host",
      feed: true,
    });
    const facts = {
      kind: "program-bound" as const,
      task: { id: program.id, title: program.title },
      key: program.key || program.id,
      bound,
      calls,
    };
    const toFirstmate = () => {
      this.host.notifyOp({ facts }, "agent", program.id);
    };
    const starter = this.starter(program);
    if (!starter) {
      toFirstmate();
      return;
    }
    this.host
      .steer(starter.id, { facts: { ...facts, to: "crewmate" } })
      .catch((caught: unknown) => {
        console.warn("[program] its starter did not hear the bound:", caught);
        toFirstmate();
      });
  }

  /**
   * A program's script ended (INF-799 piece 2). Parts it never waited for
   * are dropped; a task filed under it that is not one of its parts is not
   * the script's, and keeps running (INF-2037). A returned value is its
   * typed result - checked against the program's own result shape when it
   * declared one - recorded as its
   * report, and the program closes done. Its branch is only the part its
   * script names by label in the returned object's `branch`, whose saved
   * work a shipping task branches from; a script that names none - or an
   * empty one, null or "" - leaves nothing to ship. A thrown error, a result that does not fit, or a
   * `branch` naming no part that finished done closes it dropped as failed.
   * Either way it is heard once: by the active crewmate whose task waits on
   * it, as that wait's end, else by the first mate.
   */
  async finishProgram(program: TaskRecord, end: ProgramEnd): Promise<void> {
    const tasks = this.options.tasks;
    for (const part of tasks.graph.children(program.id)) {
      if (TaskService.isClosed(part) || !part.shape?.program_part) continue;
      await this.host.settling.closing.closeTask(part.id, {
        status: "dropped",
        reason: "superseded",
        actor: "host",
        text: "superseded - its program ended without waiting for it",
        feed: false,
      });
    }
    const parts = tasks.graph
      .children(program.id)
      .filter((part) => part.shape?.program_part)
      .sort((a, b) => (a.shape?.program_part?.call ?? 0) - (b.shape?.program_part?.call ?? 0));
    const task = { id: program.id, title: program.title };
    const schema = program.shape?.result_schema;
    const value = "value" in end ? end.value : undefined;
    const misfit = schema && "value" in end ? resultRefusal(schema, value) : undefined;
    const returned =
      value && typeof value === "object" ? (value as { branch?: unknown }).branch : undefined;
    // An empty branch is no branch: nothing to ship (the captain's N2 answer).
    const named =
      returned === null || (typeof returned === "string" && !returned.trim())
        ? undefined
        : returned;
    const branch =
      typeof named === "string"
        ? parts.find((part) => part.status === "done" && part.shape?.program_part?.label === named)
        : undefined;
    const error =
      "error" in end
        ? end.error
        : misfit
          ? `its script returned a result that does not fit its result shape: ${misfit}`
          : named !== undefined && !branch
            ? `its script returned branch ${JSON.stringify(named)}, which names no part's label that finished done`
            : undefined;
    const current = tasks.get(program.id);
    if (!current || TaskService.isClosed(current)) return;
    if (error) {
      tasks.close(program.id, {
        status: "dropped",
        reason: "failed",
        actor: "host",
        text: `its script stopped: ${error}`,
        error,
      });
    } else {
      const result =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : value === null
            ? undefined
            : { value };
      tasks.turns.recordReport(program.id, {
        text: programReportText(parts.length, result, branch),
        actor: "host",
        ...(result ? { declared: { result } } : {}),
      });
      tasks.close(program.id, {
        status: "done",
        reason: "finished",
        actor: "host",
        text: "its script finished",
      });
    }
    this.boundTold.delete(program.id);
    this.host.broadcastCrewCounts();
    // The crewmate whose task waits on it hears its close as that wait's end (always-wait).
    const starter = this.starter(program);
    if (
      starter &&
      tasks.graph
        .linksFrom(program.id)
        .some((link) => link.type === "blocks" && link.toId === starter.id)
    ) {
      // The sweep ends that wait now, not at the next minute pass.
      void this.host.sweepGates(this.host.now());
      return;
    }
    this.host.notifyOp(
      {
        facts: {
          kind: "program-ended",
          task,
          key: program.key || program.id,
          parts: parts.length,
          ...(error ? { error } : {}),
          ...(!error && value !== undefined && value !== null ? { result: value } : {}),
          ...(!error && branch ? { branch: branch.key || branch.id } : {}),
        },
      },
      "agent",
      program.id,
    );
  }
}
