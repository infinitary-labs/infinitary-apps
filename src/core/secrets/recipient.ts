import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, open, realpath, rm, stat } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
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
): Promise<PreparedRecipient | RecipientRefusal> {
  if (!isAbsolute(input.cwd)) return { refused: "folder" };
  if (
    Object.keys(input.env).some((name) => (RECIPIENT_VARIABLES as readonly string[]).includes(name))
  )
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
  const source = program.includes("/")
    ? await regularFile(resolve(cwd, program))
    : await onSearchPath(program, searchPath);
  if (!source) return { refused: "program" };

  await mkdir(join(runDir, "inputs"), { recursive: true, mode: 0o700 });
  await mkdir(join(runDir, "out"), { recursive: true, mode: 0o700 });
  /** Where each bound file runs from, and the digest it must still have there. */
  const runs = new Map<string, { path: string; sha256: string }>();
  const bind = async (slot: string, from: string, mode: number): Promise<Bound> => {
    if (!(await changeable(from))) {
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
  const shebang = await scriptInterpreter(programPath, searchPath);
  if (shebang === "unbound") return { refused: "interpreter" };
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
      const env: NodeJS.ProcessEnv = {};
      for (const name of RECIPIENT_VARIABLES) if (base[name] !== undefined) env[name] = base[name];
      for (const [name, value] of Object.entries(values)) {
        if (value.includes(0)) return "undeliverable";
        env[name] = value.toString("utf8");
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

/** A regular file at this path, resolved through links, or nothing. */
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

/**
 * The interpreter a script's `#!` line names, by real path, with the one
 * argument the line passes it. `env NAME` resolves NAME on the recipient's own
 * search path and starts it directly. A `#!` line naming nothing that resolves
 * is refused rather than left unbound.
 */
export async function scriptInterpreter(
  path: string,
  searchPath: string,
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
    const resolved = await onSearchPath(arg, searchPath);
    return resolved ? { path: resolved, name: arg } : "unbound";
  }
  const resolved = await regularFile(interpreter);
  return resolved ? { path: resolved, name: interpreter, ...(arg ? { arg } : {}) } : "unbound";
}

export async function digestFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
