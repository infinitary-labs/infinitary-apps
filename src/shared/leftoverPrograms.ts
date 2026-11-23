import { z } from "zod";
import { loadDemandSchema } from "./load";

/**
 * What a task leaves running after it closes, and how its close stops it
 * (docs/leftover-programs.md): the stops a crewmate registers with
 * `infinitary-stops-axi`, and the report the close keeps on the task's
 * timeline once it ran them and ended the programs still holding the task's
 * folders. The report is a typed fact other work reads (`leftoversOf`),
 * never words to parse.
 */

/**
 * The closes that keep a task's keeps running: the captain took the work,
 * by a merge, a release, an answer or the captain's word. A discard, cancel
 * or failure removes them (the captain's answer on INF-4381), and a task
 * carried on by another hands them on, as it hands its stops.
 */
export const KEEPING_CLOSES = [
  "landed",
  "merged",
  "released",
  "answered",
  "settled",
  "finished",
] as const;

export function keepsAtClose(reason: string | null | undefined): "keep" | "remove" {
  return (KEEPING_CLOSES as readonly string[]).includes(reason ?? "") ? "keep" : "remove";
}

/** The command in a crewmate's shell (docs/axi-commands.md, "The stops command"). */
export const STOPS_COMMAND = "infinitary-stops-axi";

/** A stop's label: what it stops, in the crewmate's words, as the timeline names it. */
export const stopLabelSchema = z.string().trim().min(1).max(120);
/** The shell command a stop runs, as the crewmate wrote it. */
export const stopCommandSchema = z.string().trim().min(1).max(4000);

export const taskStopSchema = z.object({
  id: z.string().regex(/^s[1-9][0-9]*$/),
  label: stopLabelSchema,
  command: stopCommandSchema,
  /** The folder the crewmate's shell was in when it registered the stop. */
  cwd: z.string().max(4096).optional(),
  /** When it was registered, in ms since the epoch. */
  at: z.number().int().nonnegative(),
});
export type TaskStop = z.infer<typeof taskStopSchema>;

/**
 * One job the captain asked to keep running past the task's close
 * (docs/leftover-programs.md, "A job the captain asked to keep"; INF-4381's
 * approved plan, direction A): what it is, the command that checks it runs
 * and the one that removes it, as the crewmate declared them - the app never
 * reads the job's own files - and the kept folder its files live in, outside
 * the task's folders, which no close removes. Its id shares the stops' count.
 */
export const taskKeepSchema = z.object({
  id: z.string().regex(/^s[1-9][0-9]*$/),
  label: stopLabelSchema,
  check: stopCommandSchema,
  remove: stopCommandSchema,
  folder: z.string().min(1).max(4096),
  /** The system account the job runs as: the one the crewmate's shell runs as there. */
  account: z.string().max(256),
  cwd: z.string().max(4096).optional(),
  at: z.number().int().nonnegative(),
});
export type TaskKeep = z.infer<typeof taskKeepSchema>;

/** The stops a task keeps, oldest first, its keeps, and the next id to give either. */
export const taskStopsFileSchema = z.object({
  next: z.number().int().positive(),
  stops: z.array(taskStopSchema),
  keeps: z.array(taskKeepSchema).optional(),
});
export type TaskStopsFile = z.infer<typeof taskStopsFileSchema>;

export const stopOutcomeSchema = z.object({
  label: stopLabelSchema,
  outcome: z.enum(["ran", "failed", "timed-out"]),
  exitCode: z.number().int().optional(),
});
export type StopOutcome = z.infer<typeof stopOutcomeSchema>;

/**
 * How one program still holding the task's folders went: it ended on the
 * end request, ended on the kill after the grace period, was gone before
 * either reached it, or survived both.
 */
export const programOutcomeSchema = z.object({
  pid: z.number().int().positive(),
  /** The program's own short name, as the system lists it. */
  name: z.string().max(64),
  outcome: z.enum(["ended", "killed", "gone", "survived"]),
  /**
   * Its birth as the system listed it at the close, so a later end can tell
   * it from a new program given the same number.
   */
  started: z.string().max(64).optional(),
});
export type ProgramOutcome = z.infer<typeof programOutcomeSchema>;

/**
 * What a close did about a task's leftovers. `handedTo` names the task that
 * carries the work on and took the stops instead of running them (by key); `holders` says
 * whether the folders could be read for programs holding them.
 */
export const leftoversReportSchema = z.object({
  stops: z.array(stopOutcomeSchema),
  programs: z.array(programOutcomeSchema),
  handedTo: z.string().min(1).max(64).optional(),
  handed: z.number().int().nonnegative().optional(),
  holders: z.enum(["checked", "unsupported", "unreadable"]),
  /**
   * The close kept what it could not finish in the task's folder there
   * (`leftBehindSchema`), so the computer's list says when it is cleared.
   */
  keptInFile: z.literal(true).optional(),
  /** The keeps a merged or answered close left running, which the home records (`KeptJobs`). */
  kept: z.array(taskKeepSchema.omit({ cwd: true, at: true })).optional(),
  /** How each keep's remove went at a discard, cancel or failure close, after the stops. */
  removed: z.array(stopOutcomeSchema).optional(),
  /** How many keeps went to `handedTo` with the stops. */
  handedKeeps: z.number().int().nonnegative().optional(),
});
export type LeftoversReport = z.infer<typeof leftoversReportSchema>;

/** The timeline event data key the report rides on. */
export const LEFTOVERS_DATA_KEY = "leftoverPrograms";

export function reportsAnything(report: LeftoversReport): boolean {
  return (
    report.stops.length > 0 ||
    report.programs.length > 0 ||
    (report.handed ?? 0) > 0 ||
    (report.handedKeeps ?? 0) > 0 ||
    (report.kept?.length ?? 0) > 0 ||
    (report.removed?.length ?? 0) > 0 ||
    report.holders === "unreadable"
  );
}

/**
 * What the close left behind: a stop or a keep's remove that did not run
 * cleanly, or a program that survived. A job kept on purpose is not a leftover.
 */
export function leftoversKept(report: LeftoversReport): {
  stops: StopOutcome[];
  programs: ProgramOutcome[];
} {
  return {
    stops: [...report.stops, ...(report.removed ?? [])].filter((stop) => stop.outcome !== "ran"),
    programs: report.programs.filter((program) => program.outcome === "survived"),
  };
}

export function leftoversOf(
  data: Record<string, unknown> | null | undefined,
): LeftoversReport | undefined {
  const parsed = leftoversReportSchema.safeParse(data?.[LEFTOVERS_DATA_KEY]);
  return parsed.success ? parsed.data : undefined;
}

const STOP_WORDS: Record<StopOutcome["outcome"], string> = {
  ran: "ran",
  failed: "failed",
  "timed-out": "did not finish in time",
};

const PROGRAM_WORDS: Record<ProgramOutcome["outcome"], string> = {
  ended: "ended",
  killed: "ended after a kill",
  gone: "had already ended",
  survived: "is still running",
};

const REMOVE_WORDS: Record<StopOutcome["outcome"], string> = {
  ran: "was removed",
  failed: "could not be removed",
  "timed-out": "was not removed in time",
};

function exitOf(stop: StopOutcome): string {
  return stop.outcome === "failed" && stop.exitCode !== undefined ? ` (exit ${stop.exitCode})` : "";
}

/** The one timeline line a close writes: each kept job, stop and program, and how it went. */
export function leftoversLine(report: LeftoversReport): string {
  const parts: string[] = [];
  const kept = report.kept ?? [];
  for (const job of kept) parts.push(`job "${job.label}" keeps running`);
  const handed = report.handed ?? 0;
  const handedKeeps = report.handedKeeps ?? 0;
  if (report.handedTo && handed > 0)
    parts.push(`${handed === 1 ? "its stop" : `its ${handed} stops`} went to ${report.handedTo}`);
  if (report.handedTo && handedKeeps > 0)
    parts.push(
      `${handedKeeps === 1 ? "its kept job" : `its ${handedKeeps} kept jobs`} went to ${report.handedTo}`,
    );
  for (const stop of report.stops)
    parts.push(`stop "${stop.label}" ${STOP_WORDS[stop.outcome]}${exitOf(stop)}`);
  for (const job of report.removed ?? [])
    parts.push(`job "${job.label}" ${REMOVE_WORDS[job.outcome]}${exitOf(job)}`);
  for (const program of report.programs) {
    parts.push(`${program.name || "a program"} (${program.pid}) ${PROGRAM_WORDS[program.outcome]}`);
  }
  if (report.holders === "unreadable") parts.push("its folders could not be checked for programs");
  // A close that only kept jobs left nothing over: its line says what keeps running.
  const onlyKept = kept.length > 0 && parts.length === kept.length;
  return `${onlyKept ? "At close" : "Leftovers at close"}: ${parts.join("; ")}.`;
}

/**
 * What `inf:session:close` carries for a task's leftovers
 * (docs/leftover-programs.md): the task on the same computer that carries
 * its work on and takes its stops (`carriedTo`), and the report of what
 * the close did there (`leftovers`), which the home writes on the task's
 * timeline. A computer on an older major ignores `carriedTo` and answers
 * no report.
 */
export const closeOrder = {
  request: {
    carriedTo: z
      .object({ task: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), key: z.string().min(1).max(64) })
      .optional(),
    /** When the task started, in ms since the epoch: a program running before it is not its leftover. */
    startedAt: z.number().int().nonnegative().optional(),
    /**
     * What the close does with the task's keeps (`kept-jobs.md`): a merged or
     * answered close keeps them running, any other runs their removes.
     * Absent, as from a home without the change, they are removed.
     */
    keeps: z.enum(["keep", "remove"]).optional(),
  },
  response: z.object({ ok: z.literal(true), leftovers: leftoversReportSchema.optional() }),
};

/**
 * What a close could not finish, kept in the task's own folder on the
 * computer that ran it, readable only by the user (docs/leftover-programs.md,
 * "What a close leaves"): each stop that failed or did not finish, with its
 * command, and each program that survived, with its birth.
 */
export const keptLeftoversSchema = z.object({
  stops: z.array(
    taskStopSchema.extend({
      outcome: z.enum(["failed", "timed-out"]),
      exitCode: z.number().int().optional(),
    }),
  ),
  programs: z.array(
    z.object({
      pid: z.number().int().positive(),
      name: z.string().max(64),
      started: z.string().min(1).max(64),
    }),
  ),
});
export type KeptLeftovers = z.infer<typeof keptLeftoversSchema>;

const taskIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/**
 * What finished tasks left on one computer (docs/leftover-programs.md,
 * "What a close leaves"): the stops their closes kept, without their
 * commands except to a cleanup look on that computer; the programs that
 * survived a close and still run with the same birth; their runs still in
 * that computer's heavy-run line; and every task whose close still keeps
 * something there (`kept`), so the home can mark a cleared close report
 * resolved. A record, never a reading of memory use.
 */
export const leftBehindSchema = z.object({
  stops: z.array(
    z.object({
      task: taskIdSchema,
      id: z.string().regex(/^s[1-9][0-9]*$/),
      label: stopLabelSchema,
      outcome: z.enum(["failed", "timed-out"]),
      exitCode: z.number().int().optional(),
      /** Only in the stops command's own answer to a look on that computer, never in the order. */
      command: stopCommandSchema.optional(),
      cwd: z.string().max(4096).optional(),
    }),
  ),
  programs: z.array(
    z.object({
      task: taskIdSchema,
      pid: z.number().int().positive(),
      name: z.string().max(64),
      started: z.string().min(1).max(64),
    }),
  ),
  runs: z.array(
    z.object({
      task: taskIdSchema,
      id: z.string().uuid(),
      state: z.enum(["waiting", "running"]),
      demand: loadDemandSchema,
    }),
  ),
  kept: z.array(taskIdSchema),
});
export type LeftBehind = z.infer<typeof leftBehindSchema>;

export function leftAnything(left: LeftBehind): boolean {
  return left.stops.length + left.programs.length + left.runs.length > 0;
}

/** The order the home asks a computer that runs work for its list (`leftBehindSchema`). */
export const LEFT_BEHIND_ORDER = "inf:computer:left-behind";
export const leftBehindOrders = {
  [LEFT_BEHIND_ORDER]: {
    effect: "read",
    request: z.tuple([]),
    response: leftBehindSchema,
  },
} as const;
