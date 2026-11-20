import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { BrokerInput, ProgramFacts, SecretBroker } from "./brokers";
import { canonical, sha256 } from "./custody";
import { digestFile, regularFile, scriptInterpreter } from "./recipient";

/**
 * A consumer's program as it would start it (docs/secrets.md, "Programs that
 * keep running"): found, with its folder, every other variable it runs with,
 * and which variable each secret goes in.
 */
export type BoundProgram = {
  /** What a person reads for the use, such as the server's own name. */
  label: string;
  /** The program as the consumer found it, by an absolute path. */
  program: string;
  args: string[];
  cwd: string;
  /** Every other variable the program runs with; not part of what is checked. */
  env: Record<string, string>;
  /** Which variable each secret goes in, by reference. */
  keys: Record<string, string>;
  /** What starting it does, in words, and what comes back. */
  operation: string;
  result: string;
};

/** What a start answers its consumer: the started program's handle, or why it did not start. */
export type ProgramStarted<T> = { started: T } | { failed: string } | { changed: true };

const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Adapt a consumer that starts a program and keeps talking to it, such as an
 * MCP server over its pipes, where a protected launch would own the whole
 * run. The facts bind the program and the interpreter its `#!` line names by
 * real path and digest, each argument naming a regular file by its real
 * path, the arguments, the folder, and which variable gets which secret;
 * each is checked again right before the start. `start` is a code capability supplied at
 * composition: it receives the values in the program's environment, starts
 * it through the consumer's own transport and answers its handle, which only
 * that consumer takes. A start that fails answers its words with every value
 * replaced by `hidden`. The keys are the ones the person gave with the
 * program, so the adapter declares `givenWithProgram`.
 */
export function programSecretBroker<T>(options: {
  id: string;
  resolve(input: BrokerInput): BoundProgram | undefined;
  start(program: {
    program: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
  }): Promise<T>;
  hidden: string;
}): SecretBroker {
  return {
    id: options.id,
    givenWithProgram: true,
    async prepare(input) {
      const resolved = options.resolve(structuredClone(input));
      if (!resolved) return undefined;
      const bound = structuredClone(resolved);
      const variables = Object.keys(bound.keys);
      if (
        variables.length === 0 ||
        !variables.every((name) => VARIABLE.test(name)) ||
        !Object.values(bound.keys).every((ref) => typeof ref === "string")
      )
        return undefined;
      const checked = await bindProgram(bound);
      if (!checked) return undefined;
      const facts = {
        broker: options.id,
        label: bound.label,
        destination: checked.facts.executable.path,
        operation: bound.operation,
        inputDigest: sha256(canonical({ program: checked.facts, keys: bound.keys })),
        read: false,
        result: bound.result,
        secrets: { ...bound.keys },
        program: checked.facts,
      };
      return {
        facts,
        async run(values): Promise<ProgramStarted<T>> {
          if (!(await checked.check())) return { changed: true };
          const env = { ...bound.env };
          const given: string[] = [];
          try {
            for (const name of variables) {
              const value = values[name];
              if (!value) throw new Error("Credential unavailable.");
              if (value.includes(0))
                return { failed: "A key holds a character no program's environment can carry." };
              const text = value.toString("utf8");
              given.push(text);
              env[name] = text;
            }
            try {
              return {
                started: await options.start({
                  program: bound.program,
                  args: [...bound.args],
                  cwd: checked.facts.cwd,
                  env,
                }),
              };
            } catch (error) {
              const words = error instanceof Error ? error.message : String(error);
              return { failed: hide(words, given, options.hidden) };
            }
          } finally {
            // The program has its copy; the consumer's transport keeps none past its start.
            for (const name of variables) delete env[name];
          }
        },
      };
    },
  };
}

/** Bind the program's checked facts, and the check that they still hold. */
async function bindProgram(
  bound: BoundProgram,
): Promise<{ facts: ProgramFacts; check: () => Promise<boolean> } | undefined> {
  if (!isAbsolute(bound.cwd) || !isAbsolute(bound.program)) return undefined;
  try {
    const cwd = await realpath(bound.cwd);
    if (!(await stat(cwd)).isDirectory()) return undefined;
    const executable = await regularFile(bound.program);
    if (!executable) return undefined;
    const files = new Map<string, string>([[executable, await digestFile(executable)]]);
    const shebang = await scriptInterpreter(executable, bound.env.PATH ?? "");
    // An interpreter the line names through no path it can resolve is not bound, and the docs say so.
    const interpreter =
      shebang && shebang !== "unbound"
        ? {
            path: shebang.path,
            sha256: await digestFile(shebang.path),
            ...(shebang.arg ? { arg: shebang.arg } : {}),
          }
        : undefined;
    if (interpreter) files.set(interpreter.path, interpreter.sha256);
    const inputs: ProgramFacts["inputs"] = [];
    for (const [offset, arg] of bound.args.entries()) {
      const file = await regularFile(resolve(cwd, arg));
      if (file) inputs.push({ index: offset + 1, path: file });
    }
    const facts: ProgramFacts = {
      executable: { path: executable, sha256: files.get(executable) as string },
      ...(interpreter ? { interpreter } : {}),
      argv: [bound.program, ...bound.args],
      inputs,
      cwd,
    };
    const check = async (): Promise<boolean> => {
      try {
        if ((await realpath(bound.cwd)) !== cwd) return false;
        if ((await regularFile(bound.program)) !== executable) return false;
        for (const input of inputs)
          if ((await regularFile(resolve(cwd, bound.args[input.index - 1] ?? ""))) !== input.path)
            return false;
        for (const [path, digest] of files) if ((await digestFile(path)) !== digest) return false;
        return true;
      } catch {
        return false;
      }
    };
    return { facts, check };
  } catch {
    return undefined;
  }
}

/** Words with every given value replaced, longest first, in one pass. */
function hide(words: string, values: readonly string[], hidden: string): string {
  const shown = [...new Set(values.filter((value) => value.length > 0))].sort(
    (a, b) => b.length - a.length,
  );
  if (shown.length === 0) return words;
  const pattern = new RegExp(
    shown.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "g",
  );
  return words.replace(pattern, hidden);
}
