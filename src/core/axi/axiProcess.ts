import { browserAxi } from "./browserCommands";
import { runTaskAxiCli, type TaskAxiCli } from "./cli";
import { integrationsAxi } from "./integrationCommands";
import type {
  AxiChildMessage,
  AxiParentMessage,
  AxiRunMessage,
  BrowserOp,
  IntegrationOp,
} from "./protocol";
import { type SecretsOp, secretsAxi } from "./secretsCommands";

/**
 * The command process's entry (docs/axi-commands.md, "The channel"): one
 * process for one `infinitary-<tool>-axi` command, started by the app when the
 * task's channel accepted it. axi-sdk-js writes `process.exitCode` and
 * reads `process.argv`, so its dispatcher runs here, in a process of its
 * own, and never in the app's.
 *
 * The same file runs under Electron's `utilityProcess` in the app (reached
 * through `HostCapabilities.axiProcess`) and under a plain `fork` in tests,
 * so it speaks to whichever parent port it was given. It reaches its task
 * only through `call`, which the app answers for the task the key named.
 */

type Port = {
  send: (message: AxiChildMessage) => void;
  listen: (listener: (message: AxiParentMessage) => void) => void;
};

function parentPort(): Port {
  const electronPort = (
    process as unknown as {
      parentPort?: {
        postMessage: (message: unknown) => void;
        on: (event: "message", listener: (event: { data: unknown }) => void) => void;
      };
    }
  ).parentPort;
  if (electronPort) {
    return {
      send: (message) => electronPort.postMessage(message),
      listen: (listener) =>
        electronPort.on("message", (event) => listener(event.data as AxiParentMessage)),
    };
  }
  if (process.send) {
    const send = process.send.bind(process);
    return {
      send: (message) => {
        send(message);
      },
      listen: (listener) =>
        process.on("message", (message) => listener(message as AxiParentMessage)),
    };
  }
  throw new Error("the command process has no parent to answer");
}

/** A command's connection: each operation sent to the app and its reply, whatever the tool. */
type Connection = {
  call: (
    command: string,
    op: BrowserOp | IntegrationOp | SecretsOp,
    input: unknown,
  ) => Promise<never>;
};

/** The commands this process can run, by the name the shell ran. */
const TOOLS: Record<
  string,
  (version: string, connect: () => Promise<Connection>) => TaskAxiCli<Connection>
> = {
  "infinitary-browser-axi": browserAxi as never,
  "infinitary-integrations-axi": integrationsAxi as never,
  "infinitary-secrets-axi": secretsAxi as never,
};

const port = parentPort();
const waiting = new Map<number, (reply: never) => void>();
let calls = 0;
let started = false;

async function run(message: AxiRunMessage): Promise<void> {
  let stdout = "";
  const capture = {
    write: (chunk: string) => {
      stdout += chunk;
      return true;
    },
  };
  // The SDK names the command by the path the shell ran it from.
  process.argv[1] = message.bin;
  process.exitCode = 0;
  const make = Object.hasOwn(TOOLS, message.tool) ? TOOLS[message.tool] : undefined;
  if (!make) {
    port.send({
      type: "done",
      stdout: `error: ${message.tool} is not a command this app runs\ncode: UNKNOWN_TOOL\n`,
      exitCode: 1,
    });
    return;
  }
  const tool = make(message.version, async () => ({
    call: (command, op, input) =>
      new Promise<never>((resolve) => {
        calls += 1;
        waiting.set(calls, resolve);
        port.send({ type: "call", id: calls, command, op, input });
      }),
  }));
  try {
    await runTaskAxiCli(tool, message.argv, capture);
  } catch (error) {
    stdout += `error: ${error instanceof Error ? error.message : String(error)}\ncode: UNKNOWN\n`;
    process.exitCode = 1;
  }
  const code = Number(process.exitCode ?? 0);
  port.send({ type: "done", stdout, exitCode: Number.isInteger(code) ? code : 1 });
}

port.listen((message) => {
  if (message.type === "run") {
    if (started) return;
    started = true;
    void run(message);
    return;
  }
  if (message.type === "result") {
    const resolve = waiting.get(message.id);
    waiting.delete(message.id);
    resolve?.(message.reply as never);
  }
});
