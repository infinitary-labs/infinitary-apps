import { availableParallelism } from "node:os";
import { type IntelligenceBucket, intelligenceBucketSchema } from "@shared/modelSlots";
import type { HostChildProcess, HostChildSpawner } from "../host";
import type { TaskRecord } from "../storage/taskStore";
import type { TaskService } from "../tasks/taskService";
import type { ProgramChildMessage, ProgramParentMessage } from "./programProtocol";
import { callDigest } from "./programScript";

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
 * captain's consent: the first mate proposes it with the program, and a
 * call past it is held - nothing filed - until the first mate raises it on
 * the captain's words or the program is dropped (the `program-bound` hold).
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
  /** The program ended: the host records it, drops what is still open and tells the first mate. */
  finish(program: TaskRecord, end: ProgramEnd): Promise<void>;
  /** A call reached the program's bound and is held; the first mate hears it once per bound. */
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
    this.recorded = tasks
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
      const parts = tasks.children(this.programId).filter((child) => child.shape?.program_part);
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
   * own rule: a result when it declared a shape, else a report that hands
   * the turn to no one.
   */
  private answered(part: TaskRecord): boolean {
    const last = this.host.tasks
      .timeline(part.id)
      .filter((event) => event.kind === "report")
      .at(-1)?.data;
    if (!last) return false;
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
    this.host.tasks.markProgramStarted(programId);
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
