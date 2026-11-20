import { AxiError } from "axi-sdk-js";
import type { SecretAskAnswer } from "../secrets/asks";
import { type SecretAskInput, validSecretAsk } from "../secrets/asks";
import {
  type SecretBringRequest,
  type SecretBringStatus,
  validSecretBring,
} from "../secrets/bring";
import {
  type Injection,
  SECRETS_COMMAND,
  type SecretReference,
  type UseCheck,
  type UseReceipt,
  validInjection,
} from "../secrets/requests";
import type { AxiCommand, TaskAxiCli } from "./cli";
import type { ChannelReply } from "./protocol";

export type SecretsOp =
  | "secrets.list"
  | "secrets.show"
  | "secrets.check"
  | "secrets.inject"
  | "secrets.status"
  | "secrets.cancel"
  | "secrets.ask"
  | "secrets.bring";
export type SecretsAnswer = {
  secrets?: SecretReference[];
  secret?: SecretReference;
  requests?: UseReceipt[];
  receipt?: UseReceipt;
  /** The crew's pre-check: the failed check, or the checked run and its saved decision. */
  check?: UseCheck;
  /** An ask to keep secrets: waiting, already kept with references, unavailable (its help beside it), or withdrawn. */
  ask?:
    | Exclude<SecretAskAnswer, { state: "unavailable" }>
    | { ask: string; state: "unavailable" | "withdrawn" };
  /** A bring from another tool: waiting, unavailable (its help beside it), or how it ended, by name, reference and outcome. */
  bring?: SecretBringStatus | { bring: string; state: "unavailable" | "withdrawn" };
  unavailable?: true;
  /** Why a use is unavailable, or what a check means; host words, never a backend's. */
  help?: string;
};
export type SecretsReply = ChannelReply<SecretsAnswer>;
export type SecretsConnection = {
  call(command: string, op: SecretsOp, input: unknown): Promise<SecretsReply>;
};

async function call(
  connection: SecretsConnection,
  command: string,
  op: SecretsOp,
  input: unknown,
): Promise<Record<string, unknown>> {
  const reply = await connection.call(command, op, input);
  if (reply.kind === "answer") return { ...reply.answer };
  if (reply.kind === "earlier")
    return {
      earlier: reply.command,
      note: "This command was not run; this is the earlier command's answer.",
      ...reply.answer,
    };
  if (reply.kind === "busy")
    throw new AxiError(
      "The earlier command is still answering. Read its kept answer before submitting another operation.",
      "BUSY",
    );
  return {
    state: reply.kind,
    help: `Run ${SECRETS_COMMAND} again to read the kept answer; do not repeat the operation.`,
  };
}
function invalid(): never {
  throw new AxiError("The request is not valid. Use this command's --help.", "VALIDATION_ERROR");
}

/** This interface accepts a flat JSON string map; duplicate decoded keys refuse. */
function mapping(raw: string): Record<string, string> {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalid();
  const keys = new Set<string>();
  // JSON.parse already checked syntax. Tokenize strings, skipping their escaped contents.
  const strings = raw.match(/"(?:[^"\\]|\\.)*"/g) ?? [];
  if (strings.length !== Object.keys(parsed).length * 2) invalid();
  for (let i = 0; i < strings.length; i += 2) {
    const token = strings[i];
    if (token === undefined) invalid();
    const key = JSON.parse(token) as string;
    if (keys.has(key)) invalid();
    keys.add(key);
  }
  if (Object.values(parsed).some((value) => typeof value !== "string")) invalid();
  return parsed as Record<string, string>;
}

const COMMANDS: Record<string, AxiCommand<SecretsConnection>> = {
  list: {
    usage: "list",
    description: "List the secrets the captain added: metadata, never values.",
    run: async (args, connection) => {
      if (args.positional.length) invalid();
      return call(connection, "list", "secrets.list", {});
    },
  },
  show: {
    usage: "show <reference>",
    description: "Describe one secret's metadata, never its value.",
    run: async (args, connection) => {
      if (args.positional.length !== 1 || !args.positional[0]) invalid();
      return call(connection, "show", "secrets.show", { ref: args.positional[0] });
    },
  },
  check: {
    usage: "check --env '<JSON references>' -- <program> [args...]",
    description:
      "Check one exact program operation before asking: the same checks inject makes. Asks no one, records nothing and runs nothing.",
    flags: { "--env": "value" },
    run: async (args, connection) => {
      let env: unknown;
      try {
        env = mapping(String(args.flags["--env"]));
      } catch {
        invalid();
      }
      const input = { env, argv: args.positional } as Injection;
      if (!validInjection({ ...input, id: "check", reason: "Check before asking" })) invalid();
      return call(connection, "check", "secrets.check", input);
    },
  },
  inject: {
    usage: "inject --env '<JSON references>' --reason '<why>' --id <intent> -- <program> [args...]",
    description:
      "Request one exact program operation. Values go only to the approved recipient, not this shell. Approval is separate.",
    flags: { "--env": "value", "--reason": "value", "--id": "value" },
    run: async (args, connection) => {
      let env: unknown;
      try {
        env = mapping(String(args.flags["--env"]));
      } catch {
        invalid();
      }
      const input = {
        id: args.flags["--id"],
        reason: args.flags["--reason"],
        env,
        argv: args.positional,
      } as Injection;
      if (!validInjection(input)) invalid();
      return call(connection, "inject", "secrets.inject", input);
    },
  },
  ask: {
    usage:
      "ask --name '<name>' [--place '<place>'] --reason '<why>' --id <ask> | ask --replace <reference> --reason '<why>' --id <ask> | ask --secrets '<JSON list>' --reason '<why>' --id <ask>",
    description:
      'Ask the captain to keep a secret, by name, place and reason, never a value: Infinitary draws its own field for them. --replace names one already kept that stopped working. --secrets asks for several on one card, as [{"name":"...","place":"...","replace":"..."}]. Answers at once; whether it was kept, and each reference, reach your inbox once. Cancel a waiting ask with cancel <ask>.',
    flags: {
      "--name": "value",
      "--place": "value",
      "--replace": "value",
      "--secrets": "value",
      "--reason": "value",
      "--id": "value",
    },
    run: async (args, connection) => {
      if (args.positional.length) invalid();
      const one = (flag: string) =>
        args.flags[flag] === undefined ? undefined : String(args.flags[flag]);
      let secrets: unknown;
      if (one("--secrets") !== undefined) {
        if (one("--name") ?? one("--place") ?? one("--replace")) invalid();
        try {
          secrets = JSON.parse(String(one("--secrets")));
        } catch {
          invalid();
        }
      } else if (one("--replace") !== undefined) {
        if (one("--name") ?? one("--place")) invalid();
        secrets = [{ replace: one("--replace") }];
      } else {
        const place = one("--place");
        secrets = [{ name: one("--name"), ...(place !== undefined ? { place } : {}) }];
      }
      const input = { id: one("--id"), reason: one("--reason"), secrets } as SecretAskInput;
      if (!validSecretAsk(input)) invalid();
      return call(connection, "ask", "secrets.ask", input);
    },
  },
  bring: {
    usage: "bring --from '<JSON>' --reason '<why>' --id <bring>",
    description:
      'Bring secrets the captain keeps in another tool into Secrets, never seeing a value: Infinitary shows its own card, and on the captain\'s press runs the tool\'s command or reads the file itself and keeps the output. --from is {"tool":"<the tool\'s name>","source":{"run":["<program>","<args>..."],"folder":"<absolute folder>"} or {"file":"<absolute path>"},"reads":"value"|"lines"|"env0"|"json","secrets":[{"name":"<name in the source>","as":"<name to keep>","place":"<place>","replace":"<reference>"}],"trim":"newline","uses":{"<variable>":"<kept reference>"}}. value: the whole output is one secret (one entry in secrets). lines: NAME=value lines as in a .env file; leave out secrets to list every name after a first read. env0: NAME=value entries ended by a zero byte, as /usr/bin/env -0 prints. json: exact named text fields of a top-level JSON object. uses: optional, for a trusted run with explicit names and no file arguments; your captain confirms delivery to the program for this run only. Never run a command that prints a value yourself. Answers at once; each name, reference and outcome reach your inbox once. status <bring> reads it; cancel <bring> withdraws it.',
    flags: { "--from": "value", "--reason": "value", "--id": "value" },
    run: async (args, connection) => {
      if (args.positional.length) invalid();
      let from: unknown;
      try {
        from = JSON.parse(String(args.flags["--from"]));
      } catch {
        invalid();
      }
      const input = {
        id: args.flags["--id"],
        reason: args.flags["--reason"],
        from,
      } as SecretBringRequest;
      if (!validSecretBring(input)) invalid();
      return call(connection, "bring", "secrets.bring", input);
    },
  },
};
for (const name of ["status", "cancel"] as const) {
  COMMANDS[name] = {
    usage: `${name} <request>`,
    description:
      name === "status"
        ? "Read state and exit status without launching again."
        : "Withdraw unused permission, or a waiting ask or bring by its id; an operation already sent may still finish.",
    run: async (args, connection) => {
      if (args.positional.length !== 1 || !args.positional[0]) invalid();
      return call(connection, name, `secrets.${name}`, { request: args.positional[0] });
    },
  };
}

export function secretsAxi(
  version: string,
  connect: () => Promise<SecretsConnection>,
): TaskAxiCli<SecretsConnection> {
  return {
    name: SECRETS_COMMAND,
    version,
    connect,
    description:
      "Request approved program operations using secret references, ask the captain to keep a secret, or bring secrets from another tool. Task names are context, not secret authority. No value-returning command.",
    commands: COMMANDS,
    home: (connection) => call(connection, "list", "secrets.list", {}),
  };
}
