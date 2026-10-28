import { LOAD_COMMAND, loadDemandSchema } from "@shared/load";
import { RESOURCE_REFRESH_MS } from "@shared/resources";
import { encode } from "@toon-format/toon";
import { AxiError } from "axi-sdk-js";
import type { LoadClaim } from "../placed/loadLine";
import type { TaskAxiCli } from "./cli";
import type { ChannelReply, IntegrationChannelAnswer } from "./protocol";

export type LoadOp = "load.claim" | "load.read";
export type LoadConnection = {
  call: (
    command: string,
    op: LoadOp,
    input: LoadClaim | Record<string, never>,
  ) => Promise<ChannelReply<IntegrationChannelAnswer>>;
};

function output(reply: ChannelReply<IntegrationChannelAnswer>): string {
  if (reply.kind !== "answer")
    throw new AxiError("The load request has not answered. No wrapped command started.", "BUSY");
  if (reply.answer.refused)
    throw new AxiError(reply.answer.text ?? "The load request was refused.", "REFUSED");
  return `${encode(reply.answer.data ?? {})}\n`;
}

export function loadAxi(
  version: string,
  connect: () => Promise<LoadConnection>,
): TaskAxiCli<LoadConnection> {
  return {
    name: LOAD_COMMAND,
    description:
      "This task's declared heavy runs, in this computer's line. Running work is never stopped or slowed.",
    version,
    connect,
    home: async (connection) =>
      `${output(await connection.call("load", "load.read", {}))}${encode({ help: [`Use ${LOAD_COMMAND} run --processors <number> --memory-mib <number> -- <program> [arguments]`, "The caller declares the whole run's needs, including processes it starts outside its tree."] })}\n`,
    commands: {
      run: {
        usage: "run --processors <number> --memory-mib <number> -- <program> [arguments]",
        description:
          "Wait in this computer's line, then run the program with its original input, output, environment and exit status. The whole process group holds its declared capacity until it exits.",
        flags: { "--processors": "value", "--memory-mib": "value" },
        run: async () => {
          throw new AxiError(
            "Run this through the supplied infinitary-load-axi launcher.",
            "REFUSED",
          );
        },
      },
      claim: {
        usage: "claim --pid <group> --processors <number> --memory-mib <number> [--parent <hold>]",
        description:
          "The run wrapper's admission request. It registers only its live process group; it cannot release a running hold.",
        flags: {
          "--pid": "value",
          "--processors": "value",
          "--memory-mib": "value",
          "--parent": "value",
        },
        run: async (args, connection) => {
          const pid = Number(args.flags["--pid"]);
          const parsed = loadDemandSchema.safeParse({
            cpu: Number(args.flags["--processors"]),
            memoryBytes: Number(args.flags["--memory-mib"]) * 1024 ** 2,
          });
          if (args.positional.length || !Number.isSafeInteger(pid) || pid <= 0 || !parsed.success)
            throw new AxiError(
              "Name a positive processor count and memory amount in MiB for this run.",
              "VALIDATION_ERROR",
            );
          const parent = args.flags["--parent"];
          const reply = await connection.call("claim", "load.claim", {
            pid,
            demand: parsed.data,
            ...(typeof parent === "string" ? { parent } : {}),
          });
          return `${output(reply)}retrySeconds: ${RESOURCE_REFRESH_MS / 1000}\n`;
        },
      },
    },
  };
}
