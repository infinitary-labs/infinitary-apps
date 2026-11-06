import { FILES_COMMAND, type FilesAnswer } from "@shared/files";
import { encode } from "@toon-format/toon";
import { AxiError } from "axi-sdk-js";
import type { AxiArguments, AxiCommand, TaskAxiCli } from "./cli";
import type { ChannelReply } from "./protocol";

/**
 * `infinitary-files-axi`, the files command (docs/axi-commands.md, "The
 * files command"; docs/files.md): read a file on another of the captain's
 * computers. The bare command names the computers, `ls` lists a folder on
 * one, and `get` copies one file into the task's hand-over folder. Every
 * decision - which computer, what is refused, where the copy lands - is the
 * home's, reached through the task's channel.
 */

export type FilesOp = "files.computers" | "files.list" | "files.copy";

export type FilesOpInput = {
  "files.computers": Record<string, never>;
  "files.list": { target: string };
  "files.copy": { target: string };
};

export type FilesReply = ChannelReply<FilesAnswer>;

/** The files command as one shell reaches it: each operation, answered for this task alone. */
export type FilesConnection = {
  call: <Op extends FilesOp>(
    command: string,
    op: Op,
    input: FilesOpInput[Op],
  ) => Promise<FilesReply>;
};

const DESCRIPTION =
  "Read a file on another of the captain's computers: name the computers, list a folder on one, and copy one file into this task's hand-over folder.";

const HOME_HELP = [
  `Run \`${FILES_COMMAND} ls <computer>:<folder>\` to list a folder, such as home:~/Documents`,
  `Run \`${FILES_COMMAND} get <computer>:<path>\` to copy one file into your hand-over folder`,
  "A path is absolute, or starts with ~ for that computer's home folder",
];

const COPY_HELP = [
  "Read the copy where it is; it goes when this task closes",
  "A copied file may hold secrets: never print, quote or paste its content in a report, card, note, commit, command line or output, and read only what your work needs",
];

function invalid(message: string, help: string[]): never {
  throw new AxiError(message, "VALIDATION_ERROR", help);
}

function refusal(answer: FilesAnswer, lead = ""): never {
  throw new AxiError(
    `${lead}${answer.text ?? "Refused."}`,
    answer.refused === "invalid" ? "VALIDATION_ERROR" : "REFUSED",
  );
}

function answerOutput(answer: FilesAnswer, help: string[]): string {
  const body = answer.data ? encode(answer.data) : (answer.text ?? "");
  return `${body}\n${encode({ help })}\n`;
}

/** What one command prints for the app's reply: the answer, or how a kept one stands. */
export function renderFilesReply(command: string, reply: FilesReply, help: string[]): string {
  switch (reply.kind) {
    case "answer":
      if (reply.answer.refused) refusal(reply.answer);
      return answerOutput(reply.answer, help);
    case "running":
      return `${encode({
        running: command,
        note: `The ${command} is still running past this shell's time limit; its answer is kept for your next \`${FILES_COMMAND}\` command.`,
        help: [
          `Run \`${FILES_COMMAND}\` to read its answer once it finishes`,
          `Never run ${command} again for it while it runs`,
        ],
      })}\n`;
    case "earlier": {
      const lead = `Your earlier ${reply.command} finished, so this command was not run; run it again if you still need it`;
      if (reply.answer.refused) refusal(reply.answer, `${lead}: `);
      return `${encode({ earlier: lead })}\n${answerOutput(reply.answer, reply.command === "get" ? COPY_HELP : help)}`;
    }
    case "busy":
      throw new AxiError(
        `Your earlier ${reply.command} is still running, so this command was not run`,
        "BUSY",
        [
          `Run \`${FILES_COMMAND}\` to read the earlier answer once it finishes, then run this again`,
        ],
      );
  }
}

/** The one `<computer>:<path>` a command takes. */
function targetOf(args: AxiArguments, usage: string): string {
  const [target, extra] = args.positional;
  if (!target || extra !== undefined)
    invalid(`${usage.split(" ")[0]} takes one <computer>:<path>`, [
      `Usage: ${FILES_COMMAND} ${usage}`,
      `Run \`${FILES_COMMAND}\` for the computers' names`,
    ]);
  if (!target.includes(":"))
    invalid(`Name the computer before the path, as <computer>:<path>`, [
      `Usage: ${FILES_COMMAND} ${usage}`,
      `Run \`${FILES_COMMAND}\` for the computers' names`,
    ]);
  return target;
}

const COMMANDS: Record<string, AxiCommand<FilesConnection>> = {
  ls: {
    usage: "ls <computer>:<folder>",
    description:
      "One folder's names on another computer, with each one's kind, size and when it changed. The app's own sign-ins and keys show as protected.",
    run: async (args, connection) =>
      renderFilesReply(
        "ls",
        await connection.call("ls", "files.list", {
          target: targetOf(args, "ls <computer>:<folder>"),
        }),
        [`Run \`${FILES_COMMAND} get <computer>:<path>\` to copy one of its files`],
      ),
  },
  get: {
    usage: "get <computer>:<path>",
    description:
      "Copy one file from another computer into this task's hand-over folder, checked by its sha256, and print where it is. A database in use is copied through its own backup.",
    run: async (args, connection) =>
      renderFilesReply(
        "get",
        await connection.call("get", "files.copy", {
          target: targetOf(args, "get <computer>:<path>"),
        }),
        COPY_HELP,
      ),
  },
};

async function home(connection: FilesConnection): Promise<string> {
  return renderFilesReply(
    "files",
    await connection.call("files", "files.computers", {}),
    HOME_HELP,
  );
}

export function filesAxi(
  version: string,
  connect: () => Promise<FilesConnection>,
): TaskAxiCli<FilesConnection> {
  return {
    name: FILES_COMMAND,
    description: DESCRIPTION,
    version,
    commands: COMMANDS,
    home,
    connect,
  };
}
