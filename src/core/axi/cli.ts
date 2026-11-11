import { encode } from "@toon-format/toon";
import { AxiError, RESERVED_COMMANDS, runAxiCli } from "axi-sdk-js";

export type AxiArguments = {
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
};

export type AxiFlagKind = "value" | "switch" | "values";

export type AxiCommand<Context> = {
  usage: string;
  description: string;
  /**
   * Values consume the next argument; switches consume none; a `values`
   * flag may repeat, and gathers each value in order.
   */
  flags?: Record<string, AxiFlagKind>;
  /** An object prints as TOON; a string prints as it is, for a tool that composes its own. */
  run: (args: AxiArguments, context: Context) => Promise<Record<string, unknown> | string>;
};

export type TaskAxiCli<Context> = {
  name: string;
  description: string;
  version: string;
  commands: Record<string, AxiCommand<Context>>;
  home: (context: Context) => Promise<Record<string, unknown> | string>;
  /** The launcher supplies its task-bound channel here, never a task id from argv. */
  connect: () => Promise<Context>;
};

function invalid(message: string, suggestions: string[]): never {
  throw new AxiError(message, "VALIDATION_ERROR", suggestions);
}

/** Shared flag parsing for infinitary-<tool>-axi command tables. No inferred page actions. */
export function parseAxiArguments(
  args: string[],
  flags: Record<string, AxiFlagKind> = {},
): AxiArguments {
  const result: AxiArguments = { positional: [], flags: Object.create(null) };
  const valid = ["--help", ...Object.keys(flags)].join(", ");
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--") {
      result.positional.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-")) {
      result.positional.push(arg);
      continue;
    }
    const kind = Object.hasOwn(flags, arg) ? flags[arg] : undefined;
    if (!kind) invalid(`Unknown flag: ${arg}`, [`Valid flags: ${valid}`]);
    if (kind !== "values" && Object.hasOwn(result.flags, arg))
      invalid(`Repeated flag: ${arg}`, [`Valid flags: ${valid}`]);
    if (kind === "switch") result.flags[arg] = true;
    else {
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) {
        invalid(`Flag ${arg} needs a value`, [`Valid flags: ${valid}`]);
      }
      const gathered = result.flags[arg];
      result.flags[arg] =
        kind === "values" ? [...(Array.isArray(gathered) ? gathered : []), value] : value;
    }
  }
  return result;
}

/**
 * Runs ONLY in a dedicated launcher process: axi-sdk-js sets process.exitCode.
 * The app process must never call this function. Help/version require no channel.
 * SDK updates are shadowed, and no hook installer or updater is ever called.
 */
export async function runTaskAxiCli<Context>(
  tool: TaskAxiCli<Context>,
  argv: string[],
  stdout: { write: (chunk: string) => unknown } = process.stdout,
): Promise<void> {
  const commands: Parameters<typeof runAxiCli<Context>>[0]["commands"] = Object.create(null);
  const descriptions = Object.entries(tool.commands).map(([command, spec]) => ({
    command,
    usage: `${tool.name} ${spec.usage}`,
    description: spec.description,
  }));
  const help = (command: string): string | undefined => {
    const spec = Object.hasOwn(tool.commands, command) ? tool.commands[command] : undefined;
    return spec
      ? `${encode({ command, usage: `${tool.name} ${spec.usage}`, description: spec.description, flags: spec.flags ?? {}, help: [`${tool.name} --help`] })}\n`
      : undefined;
  };
  // Reserved handlers exist even when absent from our public command table.
  // This also keeps the SDK from advertising its npm updater in global help.
  for (const name of RESERVED_COMMANDS) {
    commands[name] = () =>
      invalid("This command is managed by the app", [`Use ${tool.name} --help`]);
  }
  for (const [name, spec] of Object.entries(tool.commands)) {
    if (RESERVED_COMMANDS.some((reserved) => reserved === name)) {
      throw new Error(`Reserved AXI command: ${name}`);
    }
    commands[name] = async () => {
      // Validate before connecting, so invalid flags cannot cause task effects.
      const parsed = parseAxiArguments(argv.slice(1), spec.flags);
      return spec.run(parsed, await tool.connect());
    };
  }
  await runAxiCli({
    description: tool.description,
    version: tool.version,
    // The SDK recognizes --help anywhere; content after -- is not a flag.
    argv: argv.includes("--") ? argv.slice(0, argv.indexOf("--")) : argv,
    stdout,
    commands,
    topLevelHelp: `${encode({ tool: tool.name, description: tool.description, commands: descriptions, help: [`${tool.name} <command> --help`] })}\n`,
    getCommandHelp: help,
    home: async () => tool.home(await tool.connect()),
  });
}
