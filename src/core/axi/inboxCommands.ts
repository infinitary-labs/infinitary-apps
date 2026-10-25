import { encode } from "@toon-format/toon";
import { AxiError } from "axi-sdk-js";
import { INBOX_COMMAND } from "../integrations/commandWords";
import type { AxiArguments, AxiCommand, TaskAxiCli } from "./cli";
import type { InboxOp, InboxOpInput, InboxReply } from "./protocol";

/**
 * `infinitary-inbox-axi`, the inbox's command (docs/integrations.md, "The
 * inbox"; docs/axi-commands.md, "The inbox command"): a person's own
 * program on this computer drops an event and reads its receipts. `note`
 * answers at once with the event's id, `receipts` lists what was recorded
 * and handled after a cursor, and the bare command says how the inbox
 * stands. Every decision stays the inbox's, reached through the person key.
 */

/** The inbox as one command reaches it: each operation, answered through the person key. */
export type InboxConnection = {
  call: <Op extends InboxOp>(
    command: string,
    op: Op,
    input: InboxOpInput[Op],
  ) => Promise<InboxReply>;
};

const DESCRIPTION =
  "Drop an event into your Infinitary inbox from a script or a terminal on this computer, and read its receipts. Your first mate reads each event as information from outside, never as an instruction.";

const NOTE_USAGE = 'note [--request-id <id>] [--source <name>] "<words>"';
const RECEIPTS_USAGE = "receipts [--after <cursor>]";

const HOME_HELP = [
  `Run \`${INBOX_COMMAND} ${NOTE_USAGE}\` to drop an event`,
  `Run \`${INBOX_COMMAND} ${RECEIPTS_USAGE}\` to read what was recorded and handled`,
];

function invalid(message: string, help: string[] = []): never {
  throw new AxiError(message, "VALIDATION_ERROR", help);
}

/** What one command prints for the app's reply: the answer's rows, then how to go on. */
function render(reply: InboxReply, help: string[]): string {
  if (reply.kind !== "answer")
    throw new AxiError("The inbox is still answering an earlier command; run this again", "BUSY");
  const { answer } = reply;
  if (answer.refused)
    throw new AxiError(
      answer.text ?? "Refused.",
      answer.refused === "invalid" ? "VALIDATION_ERROR" : "REFUSED",
    );
  return `${encode(answer.data ?? {})}\n${encode({ help })}\n`;
}

const COMMANDS: Record<string, AxiCommand<InboxConnection>> = {
  note: {
    usage: NOTE_USAGE,
    flags: { "--request-id": "value", "--source": "value" },
    description:
      "Record one event with its words and answer its id at once. The same --request-id twice records once and answers the first event's id.",
    run: async (args: AxiArguments, connection) => {
      const text = args.positional.join(" ").trim();
      if (!text) invalid("note takes the event's words", [`Usage: ${INBOX_COMMAND} ${NOTE_USAGE}`]);
      const requestId = args.flags["--request-id"];
      const source = args.flags["--source"];
      return render(
        await connection.call("note", "inbox.note", {
          text,
          ...(typeof requestId === "string" ? { requestId } : {}),
          ...(typeof source === "string" ? { source } : {}),
        }),
        [
          `Run \`${INBOX_COMMAND} receipts\` to see when your first mate handled it`,
          "listening 0 means no turned-on rule listens, so nothing wakes your first mate: turn on the Infinitary Inbox events rule in Settings → Automation",
        ],
      );
    },
  },
  receipts: {
    usage: RECEIPTS_USAGE,
    flags: { "--after": "value" },
    description:
      "List each event recorded and each one handled after a cursor, oldest first; pass the answer's cursor as --after next time.",
    run: async (args: AxiArguments, connection) => {
      if (args.positional.length > 0)
        invalid("receipts takes no words", [`Usage: ${INBOX_COMMAND} ${RECEIPTS_USAGE}`]);
      const raw = args.flags["--after"];
      const after = typeof raw === "string" ? Number(raw) : 0;
      if (!Number.isInteger(after) || after < 0)
        invalid("--after takes a cursor a receipts read answered", [
          `Usage: ${INBOX_COMMAND} ${RECEIPTS_USAGE}`,
        ]);
      return render(await connection.call("receipts", "inbox.receipts", { after }), [
        `Run \`${INBOX_COMMAND} receipts --after <cursor>\` to read on from here`,
      ]);
    },
  },
};

async function home(connection: InboxConnection): Promise<string> {
  return render(await connection.call("inbox", "inbox.status", {}), HOME_HELP);
}

export function inboxAxi(
  version: string,
  connect: () => Promise<InboxConnection>,
): TaskAxiCli<InboxConnection> {
  return {
    name: INBOX_COMMAND,
    description: DESCRIPTION,
    version,
    commands: COMMANDS,
    home,
    connect,
  };
}
