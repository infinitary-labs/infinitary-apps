import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { BRING_OUTPUT_MAX_BYTES, readRunOutput, type SourceOutput } from "./bringOutput";
import { sha256 } from "./custody";
import { digestFile, RECIPIENT_VARIABLES, regularFile, scriptInterpreter } from "./recipient";

/** Where a bring's secrets come from: a program it runs, or a file it reads. */
export type BringSourceInput = { run: string[]; folder?: string } | { file: string };

/** A file the card names and a press must find unchanged, by its real path and digest. */
export type BoundFile = { path: string; sha256: string };

/**
 * What the card shows and the press runs (docs/secrets.md, "Bringing secrets
 * from another tool"): the program by its real path and digest, the
 * interpreter a script's `#!` line names, the arguments as the asker wrote
 * them and the folder by its real path; or the file by its real path and
 * digest. A program runs where it is installed, never from a copy: a tool's
 * command often works only from its own place, and a system program such as
 * `/usr/bin/env` will not start from a copy at all.
 */
export type BoundSource =
  | {
      kind: "run";
      program: BoundFile;
      interpreter?: BoundFile & { arg?: string };
      argv: string[];
      folder: string;
    }
  | { kind: "file"; file: BoundFile };

/** Why a source could not be bound: it names no folder, program, interpreter or file that resolves. */
export type BringRefusal = "folder" | "program" | "interpreter" | "file";

async function onSearchPath(name: string, searchPath: string): Promise<string | undefined> {
  for (const dir of searchPath.split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const file = await regularFile(join(dir, name));
    if (!file) continue;
    try {
      await access(file, constants.X_OK);
      return file;
    } catch {
      // Not executable; keep looking, as a shell would.
    }
  }
  return undefined;
}

/** Binds a source for its card: what the press will run or read, and nothing else. */
export async function bindSource(
  source: BringSourceInput,
  base: NodeJS.ProcessEnv,
  shellFolder?: string,
): Promise<BoundSource | BringRefusal> {
  if ("file" in source) {
    if (!isAbsolute(source.file)) return "file";
    const path = await regularFile(source.file);
    if (!path) return "file";
    if ((await stat(path)).size > BRING_OUTPUT_MAX_BYTES) return "file";
    return { kind: "file", file: { path, sha256: await digestFile(path) } };
  }
  const wanted = source.folder ?? shellFolder ?? base.HOME;
  if (!wanted || !isAbsolute(wanted)) return "folder";
  let folder: string;
  try {
    folder = await realpath(wanted);
    if (!(await stat(folder)).isDirectory()) return "folder";
  } catch {
    return "folder";
  }
  const [program] = source.run;
  if (!program) return "program";
  const searchPath = base.PATH ?? "";
  const path = program.includes("/")
    ? await regularFile(resolve(folder, program))
    : await onSearchPath(program, searchPath);
  if (!path) return "program";
  const shebang = await scriptInterpreter(path, searchPath).catch(() => "unbound" as const);
  if (shebang === "unbound") return "interpreter";
  return {
    kind: "run",
    program: { path, sha256: await digestFile(path) },
    ...(shebang
      ? {
          interpreter: {
            path: shebang.path,
            sha256: await digestFile(shebang.path),
            ...(shebang.arg ? { arg: shebang.arg } : {}),
          },
        }
      : {}),
    argv: [...source.run],
    folder,
  };
}

async function unchanged(bound: BoundSource): Promise<boolean> {
  try {
    if (bound.kind === "file") return (await digestFile(bound.file.path)) === bound.file.sha256;
    if ((await realpath(bound.folder)) !== bound.folder) return false;
    if ((await digestFile(bound.program.path)) !== bound.program.sha256) return false;
    if (
      bound.interpreter &&
      (await digestFile(bound.interpreter.path)) !== bound.interpreter.sha256
    )
      return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs or reads the bound source once and answers its output in one buffer
 * inside this process. A program starts with the short list of base
 * variables a recipient keeps and none of Infinitary's secrets; its error
 * output goes nowhere, and its output reaches only a pipe, never a file. It
 * is stopped when it runs past `limitMs` or prints more than
 * `BRING_OUTPUT_MAX_BYTES`. A file is read where it is, and a file whose
 * bytes no longer match the digest the card showed is `changed`.
 */
export async function readSource(
  bound: BoundSource,
  base: NodeJS.ProcessEnv,
  limitMs: number,
): Promise<SourceOutput> {
  if (!(await unchanged(bound))) return "changed";
  if (bound.kind === "file") {
    let output: Buffer;
    try {
      output = await readFile(bound.file.path);
    } catch {
      return "changed";
    }
    if (sha256(output) !== bound.file.sha256) {
      output.fill(0);
      return "changed";
    }
    if (output.length > BRING_OUTPUT_MAX_BYTES) {
      output.fill(0);
      return "too-large";
    }
    return { output };
  }
  const env: NodeJS.ProcessEnv = {};
  for (const name of RECIPIENT_VARIABLES) if (base[name] !== undefined) env[name] = base[name];
  const [given, ...args] = bound.argv;
  const command = bound.interpreter
    ? {
        path: bound.interpreter.path,
        args: [
          ...(bound.interpreter.arg ? [bound.interpreter.arg] : []),
          bound.program.path,
          ...args,
        ],
      }
    : { path: bound.program.path, args };
  return readRunOutput(
    command.path,
    command.args,
    {
      argv0: bound.interpreter ? command.path : (given ?? command.path),
      cwd: bound.folder,
      env,
    },
    limitMs,
  );
}
