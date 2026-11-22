import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, open, realpath, rm, stat } from "node:fs/promises";
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve, win32 } from "node:path";
import { hostPlatform } from "../platform";
import { windowsGit } from "../windowsGit";
import { readRunOutput, type SourceOutput } from "./bringOutput";
import { canonical, sha256 } from "./custody";

/**
 * The only names a recipient keeps from the host environment (docs/secrets.md,
 * "The recipient"). Everything else - the task channel, the app's git sign-in
 * helper, the crewmate's own variables - is dropped, and a mapping onto one of
 * these names is refused rather than overwritten.
 */
export const RECIPIENT_VARIABLES = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TZ",
  "TMPDIR",
  "TERM",
] as const;

/**
 * The names a recipient on Windows keeps besides those: what a Windows
 * program needs to start and find its own folders. Windows itself refuses
 * many programs without `SystemRoot`, and a command without an extension is
 * found through `PATHEXT`.
 */
export const WINDOWS_RECIPIENT_VARIABLES = [
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "PATHEXT",
  "USERPROFILE",
  "USERNAME",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "CommonProgramFiles",
  "TEMP",
  "TMP",
  "HOMEDRIVE",
  "HOMEPATH",
  "OS",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
] as const;

/** The names a recipient keeps from the host on this platform. */
export function recipientVariables(platform: NodeJS.Platform = hostPlatform()): readonly string[] {
  return platform === "win32"
    ? [...RECIPIENT_VARIABLES, ...WINDOWS_RECIPIENT_VARIABLES]
    : RECIPIENT_VARIABLES;
}

/**
 * Whether a request's variable is one a recipient keeps from the host, which
 * a mapping may not overwrite. Windows reads a variable's name in any case,
 * so there `Path` is `PATH`.
 */
export function keepsHostVariable(
  name: string,
  platform: NodeJS.Platform = hostPlatform(),
): boolean {
  const kept = recipientVariables(platform);
  if (platform !== "win32") return kept.includes(name);
  const folded = name.toUpperCase();
  return kept.some((keep) => keep.toUpperCase() === folded);
}

/** The program extensions Windows starts directly, without a shell to read the file. */
const WINDOWS_PROGRAMS = [".exe", ".com"];

/** Whether Windows starts this file as a program, rather than a script an interpreter reads. */
export function windowsProgram(path: string): boolean {
  return WINDOWS_PROGRAMS.includes(win32.extname(path).toLowerCase());
}

/**
 * The file names a command name may be on Windows' search path: itself when
 * it names a program, else that name as a program. A batch file is never
 * one: Windows runs it only through a shell, which a recipient never asks.
 */
export function windowsProgramNames(name: string): string[] {
  if (windowsProgram(name)) return [name];
  if (extname(name) !== "") return [];
  return WINDOWS_PROGRAMS.map((extension) => `${name}${extension}`);
}

/**
 * Where a script's `#!` line points on Windows: a POSIX path such as
 * `/bin/sh` or `/usr/bin/bash` names that program in the Git for Windows the
 * app uses, as its Git Bash reads it (`/bin` is its `usr\bin`), so a script
 * written for Git Bash runs as it would there. Undefined where it names no
 * such place.
 */
export function windowsInterpreter(
  interpreter: string,
  gitRoot: string | undefined,
): string | undefined {
  if (!gitRoot || !interpreter.startsWith("/") || interpreter.startsWith("//")) return undefined;
  const parts = interpreter.split("/").filter((part) => part.length > 0);
  const name = parts.pop();
  if (!name) return undefined;
  const folder = parts.join("/");
  const inGit = folder === "bin" || folder === "usr/bin" ? ["usr", "bin"] : parts;
  return win32.join(gitRoot, ...inGit, windowsProgram(name) ? name : `${name}.exe`);
}

/**
 * Where a Windows recipient looks a name up, in Git Bash's own order: the Git
 * for Windows the app uses (`mingw64\\bin`, then `usr\\bin`) before Windows'
 * search path, so `bash` or `#!/usr/bin/env bash` means the program Git Bash
 * would run, never WSL's `bash.exe` in System32. Unchanged without that Git.
 */
export function gitBashSearchPath(searchPath: string, gitRoot: string | undefined): string {
  if (!gitRoot) return searchPath;
  const own = [win32.join(gitRoot, "mingw64", "bin"), win32.join(gitRoot, "usr", "bin")];
  return [...own, ...searchPath.split(win32.delimiter).filter((dir) => dir.length > 0)].join(
    win32.delimiter,
  );
}

/**
 * A file the approval covers, by its real path and digest. `copied` says it
 * runs from a private copy because this user could change it; otherwise
 * nothing this user runs can replace it, and it runs in place.
 */
type Bound = { path: string; sha256: string; copied: boolean };

/** Every fact an approval covers. Reasons and labels are not facts; they are shown beside them. */
export type RecipientFacts = {
  /** The program the request names, found from the working folder or on the search path. */
  executable: Bound;
  /** The interpreter a `#!` line names, when the program is a script; it is started directly. */
  interpreter?: Bound & { arg?: string };
  /** The arguments as the requester named them. */
  argv: string[];
  /** File arguments, each run from a private copy rather than its mutable path. */
  inputs: (Omit<Bound, "copied"> & { index: number })[];
  cwd: string;
  /** Recipient variable to secret reference. */
  env: Record<string, string>;
  delivery: "environment";
};

/**
 * Which check a recipient failed, as a typed fact the crew's pre-check names
 * (docs/secrets.md, "The crew's pre-check"): the working folder, a variable a
 * recipient keeps from the host, the program, or the interpreter a script's
 * `#!` line names. Never a path or a value.
 */
export type RecipientRefusal = { refused: "folder" | "variable" | "program" | "interpreter" };

export type LaunchResult = { exitCode: number } | { signal: string } | "changed" | "undeliverable";

export type PreparedRecipient = {
  facts: RecipientFacts;
  /**
   * The operation key a saved rule binds: every fact above, none of this run's
   * private paths, so a reviewed script keeps its rule across runs while any
   * change to its code, interpreter, inputs, arguments or mapping asks again.
   */
  operation: string;
  /** Recheck every bound digest and the working folder. */
  check(): Promise<boolean>;
  /**
   * Recheck, then synchronously verify authorization at spawn, then call
   * `launched` once the program started. Output stays private.
   */
  launch(
    values: Record<string, Buffer>,
    base: NodeJS.ProcessEnv,
    authorized: () => boolean,
    launched?: () => void,
  ): Promise<LaunchResult>;
  /** Remove copies and private output. Removal is not secure erasure. */
  dispose(): Promise<void>;
};

/**
 * Bind an exact recipient (docs/secrets.md, "The recipient"). The program, its
 * interpreter and every argument naming a regular file are bound by digest.
 * Each one this user could change - by writing it or any folder above it - is
 * copied into this run's private folder and runs from there; one it cannot
 * change runs in place and is hashed again right before it starts. A script's
 * interpreter is started directly with the script's copy, so neither the
 * script's `#!` line nor the search path is read again at launch. A shell is
 * never asked to evaluate a command string the request did not name as a
 * file. Sibling files a script reads while it runs are not bound, and the
 * approval says so.
 */
export async function prepareRecipient(
  input: { argv: string[]; cwd: string; env: Record<string, string> },
  runDir: string,
  searchPath: string,
  capture?: { limitMs: number; authorized(): boolean; receive(output: SourceOutput): void },
): Promise<PreparedRecipient | RecipientRefusal> {
  if (!isAbsolute(input.cwd)) return { refused: "folder" };
  const platform = hostPlatform();
  const windows = platform === "win32";
  if (Object.keys(input.env).some((name) => keepsHostVariable(name, platform)))
    return { refused: "variable" };
  let cwd: string;
  try {
    cwd = await realpath(input.cwd);
    if (!(await stat(cwd)).isDirectory()) return { refused: "folder" };
  } catch {
    return { refused: "folder" };
  }
  const [program, ...rest] = input.argv;
  if (!program) return { refused: "program" };
  const named = program.includes("/") || (windows && program.includes("\\"));
  const gitRoot = windows ? windowsGit()?.root : undefined;
  const lookup = windows ? gitBashSearchPath(searchPath, gitRoot) : searchPath;
  const source = named
    ? await regularFile(resolve(cwd, program))
    : await onSearchPath(program, lookup, windows);
  if (!source) return { refused: "program" };
  if (
    capture &&
    !(await access(source, constants.X_OK).then(
      () => true,
      () => false,
    ))
  )
    return { refused: "program" };

  await mkdir(join(runDir, "inputs"), { recursive: true, mode: 0o700 });
  await mkdir(join(runDir, "out"), { recursive: true, mode: 0o700 });
  /** Where each bound file runs from, and the digest it must still have there. */
  const runs = new Map<string, { path: string; sha256: string }>();
  const bind = async (slot: string, from: string, mode: number): Promise<Bound> => {
    // A Windows program needs the libraries beside it, so it runs where it is
    // and is hashed again right before it starts (docs/secrets.md, "The recipient").
    if ((windows && windowsProgram(from)) || !(await changeable(from))) {
      const bound = { path: from, sha256: await digestFile(from) };
      runs.set(slot, bound);
      return { ...bound, copied: false };
    }
    const folder = join(runDir, "inputs", slot);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const path = join(folder, basename(from));
    // A clone where the file system makes one, so a large program costs no copy.
    await copyFile(from, path, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    await chmod(path, mode);
    const digest = await digestFile(path);
    runs.set(slot, { path, sha256: digest });
    return { path: from, sha256: digest, copied: true };
  };

  const executable = await bind("program", source, 0o500);
  const programPath = runs.get("program")?.path ?? source;
  const shebang = await scriptInterpreter(programPath, lookup, windows);
  if (shebang === "unbound") return { refused: "interpreter" };
  // Windows starts only a program directly: anything else needs a `#!` line naming one.
  if (windows && !shebang && !windowsProgram(source)) return { refused: "program" };
  const interpreter = shebang
    ? {
        ...(await bind("interpreter", shebang.path, 0o500)),
        ...(shebang.arg ? { arg: shebang.arg } : {}),
      }
    : undefined;

  const inputs: RecipientFacts["inputs"] = [];
  const launchArgs: string[] = [];
  for (const [offset, arg] of rest.entries()) {
    const index = offset + 1;
    const file = await regularFile(resolve(cwd, arg));
    if (!file) {
      launchArgs.push(arg);
      continue;
    }
    // A bring cannot snapshot a file that might hold source values.
    if (capture) return { refused: "program" };
    // A file argument is always copied: it is input the recipient reads, not a program.
    const folder = join(runDir, "inputs", String(index));
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const path = join(folder, basename(file));
    await copyFile(file, path, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    await chmod(path, 0o400);
    const digest = await digestFile(path);
    runs.set(String(index), { path, sha256: digest });
    inputs.push({ index, path: file, sha256: digest });
    launchArgs.push(path);
  }

  const facts: RecipientFacts = {
    executable,
    ...(interpreter ? { interpreter } : {}),
    argv: [...input.argv],
    inputs,
    cwd,
    env: { ...input.env },
    delivery: "environment",
  };
  const interpreterPath = runs.get("interpreter")?.path;
  const command = interpreterPath
    ? {
        path: interpreterPath,
        args: [...(shebang?.arg ? [shebang.arg] : []), programPath, ...launchArgs],
        argv0: shebang?.name ?? interpreterPath,
      }
    : { path: programPath, args: launchArgs, argv0: program };

  const check = async (): Promise<boolean> => {
    try {
      if ((await realpath(input.cwd)) !== cwd) return false;
      for (const bound of runs.values())
        if ((await digestFile(bound.path)) !== bound.sha256) return false;
      return true;
    } catch {
      return false;
    }
  };

  return {
    facts,
    operation: sha256(canonical(facts)),
    check,
    launch: async (values, base, authorized, launched) => {
      const env = recipientBase(base, platform, gitRoot);
      for (const [name, value] of Object.entries(values)) {
        if (value.includes(0)) return "undeliverable";
        env[name] = value.toString("utf8");
      }
      if (capture) {
        if (!(await check()) || !authorized() || !capture.authorized()) return "changed";
        const result = readRunOutput(
          command.path,
          command.args,
          {
            argv0: command.argv0,
            cwd,
            env,
          },
          capture.limitMs,
        );
        for (const name of Object.keys(values)) delete env[name];
        const output = await result;
        capture.receive(output);
        if (output === "changed") return "changed";
        if (output === "too-large") return "undeliverable";
        if ("output" in output) return { exitCode: 0 };
        return output.failed.exitCode !== undefined
          ? { exitCode: output.failed.exitCode }
          : { signal: output.failed.signal ?? "unknown" };
      }
      const stdout = await open(join(runDir, "out", "stdout"), "w", 0o600);
      try {
        const stderr = await open(join(runDir, "out", "stderr"), "w", 0o600);
        try {
          // Finish every awaited launch check before the owner's synchronous
          // authorization check. No await separates that decision from spawn.
          if (!(await check()) || !authorized()) return "changed";
          return await new Promise<LaunchResult>((settle, fail) => {
            const child = spawn(command.path, command.args, {
              argv0: command.argv0,
              cwd,
              env,
              stdio: ["ignore", stdout.fd, stderr.fd],
              // The installed app has no console: a console program opens none.
              windowsHide: true,
            });
            child.once("error", fail);
            child.once("spawn", () => launched?.());
            child.once("exit", (code, signal) =>
              settle(code !== null ? { exitCode: code } : { signal: signal ?? "unknown" }),
            );
          });
        } finally {
          await stderr.close();
        }
      } finally {
        await stdout.close();
      }
    },
    dispose: async () => {
      await rm(runDir, { recursive: true, force: true });
    },
  };
}

/**
 * The host variables a recipient starts with. On Windows its `PATH` is Git
 * Bash's order (gitBashSearchPath), the one its name was looked up in, so a
 * script started through Git's `usr\\bin\\sh.exe` or `bash.exe`, which add no
 * folders of their own, finds `cat`, `grep` or `sed` as it would in Git Bash.
 */
export function recipientBase(
  base: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  gitRoot: string | undefined,
): NodeJS.ProcessEnv {
  const windows = platform === "win32";
  const env: NodeJS.ProcessEnv = {};
  for (const name of recipientVariables(platform)) {
    const value = hostVariable(base, name, windows);
    if (value !== undefined) env[name] = value;
  }
  if (windows && gitRoot) env.PATH = gitBashSearchPath(env.PATH ?? "", gitRoot);
  return env;
}

export async function regularFile(path: string): Promise<string | undefined> {
  try {
    await lstat(path);
    const real = await realpath(path);
    return (await stat(real)).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a program this user runs could replace the file: write access to it
 * or to any folder above it. A system program (`/bin/sh`) is not, and runs in
 * place: macOS stops a copy of one from starting at all.
 */
export async function changeable(path: string): Promise<boolean> {
  let current = path;
  for (;;) {
    try {
      await access(current, constants.W_OK);
      return true;
    } catch {
      // Not writable by this user; the folder above decides next.
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** A host variable by its name, in any case on Windows, where a copied environment may say `Path`. */
function hostVariable(base: NodeJS.ProcessEnv, name: string, windows: boolean): string | undefined {
  if (base[name] !== undefined || !windows) return base[name];
  const folded = name.toUpperCase();
  const key = Object.keys(base).find((candidate) => candidate.toUpperCase() === folded);
  return key === undefined ? undefined : base[key];
}

async function onSearchPath(
  name: string,
  searchPath: string,
  windows = false,
): Promise<string | undefined> {
  const names = windows ? windowsProgramNames(name) : [name];
  for (const dir of searchPath.split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    for (const candidate of names) {
      const file = await regularFile(join(dir, candidate));
      if (!file) continue;
      try {
        await access(file, constants.X_OK);
        return file;
      } catch {
        // Not executable; keep looking, as a shell would.
      }
    }
  }
  return undefined;
}

/**
 * The interpreter a script's `#!` line names, by real path, with the one
 * argument the line passes it. `env NAME` resolves NAME on the recipient's own
 * search path and starts it directly. A `#!` line naming nothing that resolves
 * is refused rather than left unbound.
 */
export async function scriptInterpreter(
  path: string,
  searchPath: string,
  windows = false,
): Promise<{ path: string; name: string; arg?: string } | undefined | "unbound"> {
  const handle = await open(path, "r");
  let head: string;
  try {
    const buffer = Buffer.alloc(256);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    head = buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
  if (!head.startsWith("#!")) return undefined;
  const line = head.slice(2).split("\n")[0]?.trim() ?? "";
  const [interpreter, ...args] = line.split(/\s+/);
  if (!interpreter || !isAbsolute(interpreter) || args.length > 1) return "unbound";
  const [arg] = args;
  if (basename(interpreter) === "env") {
    if (!arg || arg.startsWith("-")) return "unbound";
    // A Windows caller passes Git Bash's lookup order (gitBashSearchPath).
    const resolved = await onSearchPath(arg, searchPath, windows);
    return resolved ? { path: resolved, name: arg } : "unbound";
  }
  const mapped = windows ? windowsInterpreter(interpreter, windowsGit()?.root) : undefined;
  const resolved = await regularFile(mapped ?? interpreter);
  return resolved ? { path: resolved, name: interpreter, ...(arg ? { arg } : {}) } : "unbound";
}

export async function digestFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
