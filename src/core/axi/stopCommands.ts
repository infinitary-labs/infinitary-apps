import { type LeftBehind, STOPS_COMMAND } from "@shared/leftoverPrograms";
import { encode } from "@toon-format/toon";
import { AxiError } from "axi-sdk-js";
import type { TaskStopsAnswer } from "../tasks/taskStops";
import type { AxiArguments, TaskAxiCli } from "./cli";
import type { ChannelReply } from "./protocol";

/**
 * `infinitary-stops-axi`, the stops command (docs/axi-commands.md, "The
 * stops command"; docs/leftover-programs.md): a crewmate registers how to stop
 * each thing it starts that outlives the command that started it, lists
 * them, and drops one it ran itself. The app runs what is left, newest
 * first, when the task closes.
 */

export type StopsOp =
  | "stops.list"
  | "stops.add"
  | "stops.keep"
  | "stops.drop"
  | "stops.left"
  | "stops.rerun"
  | "stops.end"
  | "stops.dropKept";

export type StopsOpInput = {
  "stops.list": Record<string, never>;
  "stops.add": { label: string; command: string };
  "stops.keep": { label: string; check: string; remove: string };
  "stops.drop": { id: string };
  "stops.left": Record<string, never>;
  "stops.rerun": { task: string; id: string };
  "stops.end": { task: string; pid: number };
  "stops.dropKept": { task: string; id: string };
};

export type StopsReply = ChannelReply<TaskStopsAnswer>;

export type StopsConnection = {
  call: <Op extends StopsOp>(
    command: string,
    op: Op,
    input: StopsOpInput[Op],
  ) => Promise<StopsReply>;
};

const DESCRIPTION =
  "This task's stops: how to stop each machine, simulator, container or server you started that outlives the command that started it. The app runs them, newest first, when the task closes. And its keeps: each job the captain asked to keep running after the task closes.";

const HELP = [
  `Run \`${STOPS_COMMAND} add --label "<what it stops>" '<command that stops it>'\` in the same command that starts it; quote the command so the shell keeps it whole`,
  "A stop deletes what this task created and only stops what it borrowed",
  `Run \`${STOPS_COMMAND} drop <id>\` after you stopped it yourself`,
  `For a job the captain asked to keep running, run \`${STOPS_COMMAND} keep --label "<the job>" --check '<command that checks it runs>' '<command that removes it>'\` before you set it up, and keep its files in the kept folder it answers`,
];

const KEEP_HELP = [
  "Keep the job's files in this kept folder, never in your working copy or temporary folder, and point the job at them",
  "A merge or an answer leaves the job running; a discard, cancel or failure runs its remove once",
  "Name the job, the computer, how to check it and how to remove it on your outcome card",
  `Run \`${STOPS_COMMAND} drop <id>\` if you removed the job yourself`,
];

function output(reply: StopsReply): string {
  if (reply.kind !== "answer")
    throw new AxiError(
      "The stops answer did not come back in time. Run the bare command to read them.",
      "BUSY",
    );
  const answer = reply.answer;
  if (answer.refused)
    throw new AxiError(
      answer.text ?? "Refused.",
      answer.refused === "invalid" ? "VALIDATION_ERROR" : "REFUSED",
    );
  const body: Record<string, unknown> = {};
  if (answer.kept)
    return `${encode({ kept: answer.kept.id, label: answer.kept.label, folder: answer.kept.folder })}\n${encode({ help: KEEP_HELP })}\n`;
  if (answer.left) return `${encode(leftBody(answer.left))}\n${encode({ help: LEFT_HELP })}\n`;
  if (answer.reran) return `${encode({ reran: answer.reran })}\n`;
  if (answer.ended) return `${encode({ ended: answer.ended })}\n`;
  if (answer.droppedKept) return `${encode({ dropped: answer.droppedKept })}\n`;
  if (answer.added) body.added = answer.added.id;
  if (answer.dropped) body.dropped = answer.dropped;
  const stops = answer.stops ?? [];
  body.stops =
    stops.length === 0
      ? "0 stops"
      : stops.map((stop) => ({ id: stop.id, label: stop.label, command: stop.command }));
  const keeps = answer.keeps ?? [];
  if (keeps.length > 0)
    body.keeps = keeps.map((keep) => ({ id: keep.id, label: keep.label, folder: keep.folder }));
  return `${encode(body)}\n${encode({ help: HELP })}\n`;
}

const LEFT_HELP = [
  "This is a record of what finished tasks left on this computer, not a reading of memory use",
  "Each kept stop's command is for you to judge what it deletes and whether its target is gone; never show it on a card",
  `Run \`${STOPS_COMMAND} drop <task> <stop id>\` for a kept stop whose target you found already gone`,
  `Only after the captain picks an item: run \`${STOPS_COMMAND} rerun <task> <stop id>\` to run a kept stop again, or \`${STOPS_COMMAND} end <task> <pid>\` to end a kept program; the app checks its start time first`,
];

function leftBody(left: LeftBehind): Record<string, unknown> {
  return {
    stops: left.stops.length === 0 ? "0 kept stops" : left.stops,
    programs: left.programs.length === 0 ? "0 kept programs still running" : left.programs,
    runs:
      left.runs.length === 0
        ? "0 finished tasks' runs in the line"
        : left.runs.map((run) => ({
            task: run.task,
            id: run.id,
            state: run.state,
            processors: run.demand.cpu,
            memoryMiB: Math.round(run.demand.memoryBytes / 1024 ** 2),
          })),
  };
}

const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

function commandOf(args: AxiArguments): string {
  const command = args.positional.join(" ").trim();
  if (!command)
    throw new AxiError("Give the command that stops it.", "VALIDATION_ERROR", HELP.slice(0, 1));
  return command;
}

export function stopsAxi(
  version: string,
  connect: () => Promise<StopsConnection>,
): TaskAxiCli<StopsConnection> {
  return {
    name: STOPS_COMMAND,
    description: DESCRIPTION,
    version,
    connect,
    home: async (connection) => output(await connection.call("stops", "stops.list", {})),
    commands: {
      add: {
        usage: `add --label "<what it stops>" '<command that stops it>'`,
        description:
          "Register a stop. It runs once, in the folder you ran this in, after your session ends and before your working copy and temporary folder go.",
        flags: { "--label": "value" },
        run: async (args, connection) => {
          const label = args.flags["--label"];
          if (typeof label !== "string" || !label.trim())
            throw new AxiError("Name what the stop stops with --label.", "VALIDATION_ERROR", HELP);
          const command = commandOf(args);
          return output(await connection.call("add", "stops.add", { label, command }));
        },
      },
      keep: {
        usage: `keep --label "<the job>" --check '<command that checks it runs>' '<command that removes it>'`,
        description:
          "Record a job the captain asked to keep running after the task closes, and get a kept folder for its files outside your task's folders. A merge or an answer leaves it running; a discard, cancel or failure runs its remove once, after the stops.",
        flags: { "--label": "value", "--check": "value" },
        run: async (args, connection) => {
          const label = args.flags["--label"];
          const check = args.flags["--check"];
          if (typeof label !== "string" || !label.trim())
            throw new AxiError("Name the job with --label.", "VALIDATION_ERROR", HELP.slice(3));
          if (typeof check !== "string" || !check.trim())
            throw new AxiError(
              "Give the command that checks the job runs with --check.",
              "VALIDATION_ERROR",
              HELP.slice(3),
            );
          const remove = args.positional.join(" ").trim();
          if (!remove)
            throw new AxiError(
              "Give the command that removes the job.",
              "VALIDATION_ERROR",
              HELP.slice(3),
            );
          return output(await connection.call("keep", "stops.keep", { label, check, remove }));
        },
      },
      drop: {
        usage: "drop <id> | drop <task> <stop id>",
        description:
          "Drop a stop you ran yourself, so the close does not run it again, or a keep whose job you removed yourself; or, with a finished task's id, drop its kept stop whose target is already gone, without running it.",
        run: async (args, connection) => {
          if (args.positional.length === 2) {
            const [task, id] = args.positional;
            if (!task || !TASK_ID.test(task) || !id || !/^s[1-9][0-9]*$/.test(id))
              throw new AxiError(
                "Name the task by its id and the stop by its id, such as s1.",
                "VALIDATION_ERROR",
                LEFT_HELP,
              );
            return output(await connection.call("drop", "stops.dropKept", { task, id }));
          }
          const [id, extra] = args.positional;
          if (!id || extra !== undefined || !/^s[1-9][0-9]*$/.test(id))
            throw new AxiError("Name one stop by its id, such as s1.", "VALIDATION_ERROR", [
              `Run \`${STOPS_COMMAND}\` for the ids`,
            ]);
          return output(await connection.call("drop", "stops.drop", { id }));
        },
      },
      left: {
        usage: "left",
        description:
          "List what finished tasks left on this computer: the stops their closes could not finish, the programs that survived a close and still run, and their runs still in the heavy-run line.",
        run: async (args, connection) => {
          if (args.positional.length > 0)
            throw new AxiError("left takes no arguments.", "VALIDATION_ERROR", LEFT_HELP);
          return output(await connection.call("left", "stops.left", {}));
        },
      },
      rerun: {
        usage: "rerun <task> <stop id>",
        description:
          "Run a finished task's kept stop again, once, as its close did; only for an item the captain picked.",
        run: async (args, connection) => {
          const [task, id, extra] = args.positional;
          if (!task || !TASK_ID.test(task) || !id || !/^s[1-9][0-9]*$/.test(id) || extra)
            throw new AxiError(
              "Name the task by its id and the stop by its id, such as s1.",
              "VALIDATION_ERROR",
              LEFT_HELP,
            );
          return output(await connection.call("rerun", "stops.rerun", { task, id }));
        },
      },
      end: {
        usage: "end <task> <pid>",
        description:
          "End a finished task's kept program: an end request, then a kill, each only while it still has the start time its close kept; only for an item the captain picked.",
        run: async (args, connection) => {
          const [task, pid, extra] = args.positional;
          if (!task || !TASK_ID.test(task) || !pid || !/^[1-9][0-9]*$/.test(pid) || extra)
            throw new AxiError(
              "Name the task by its id and the program by its number.",
              "VALIDATION_ERROR",
              LEFT_HELP,
            );
          return output(await connection.call("end", "stops.end", { task, pid: Number(pid) }));
        },
      },
    },
  };
}
