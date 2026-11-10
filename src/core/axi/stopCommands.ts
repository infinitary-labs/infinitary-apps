import { STOPS_COMMAND } from "@shared/leftoverPrograms";
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

export type StopsOp = "stops.list" | "stops.add" | "stops.drop";

export type StopsOpInput = {
  "stops.list": Record<string, never>;
  "stops.add": { label: string; command: string };
  "stops.drop": { id: string };
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
  "This task's stops: how to stop each machine, simulator, container or server you started that outlives the command that started it. The app runs them, newest first, when the task closes.";

const HELP = [
  `Run \`${STOPS_COMMAND} add --label "<what it stops>" '<command that stops it>'\` in the same command that starts it; quote the command so the shell keeps it whole`,
  "A stop deletes what this task created and only stops what it borrowed",
  `Run \`${STOPS_COMMAND} drop <id>\` after you stopped it yourself`,
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
  if (answer.added) body.added = answer.added.id;
  if (answer.dropped) body.dropped = answer.dropped;
  const stops = answer.stops ?? [];
  body.stops =
    stops.length === 0
      ? "0 stops"
      : stops.map((stop) => ({ id: stop.id, label: stop.label, command: stop.command }));
  return `${encode(body)}\n${encode({ help: HELP })}\n`;
}

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
      drop: {
        usage: "drop <id>",
        description: "Drop a stop you ran yourself, so the close does not run it again.",
        run: async (args, connection) => {
          const [id, extra] = args.positional;
          if (!id || extra !== undefined || !/^s[1-9][0-9]*$/.test(id))
            throw new AxiError("Name one stop by its id, such as s1.", "VALIDATION_ERROR", [
              `Run \`${STOPS_COMMAND}\` for the ids`,
            ]);
          return output(await connection.call("drop", "stops.drop", { id }));
        },
      },
    },
  };
}
