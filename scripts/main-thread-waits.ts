/**
 * The wait check (INF-2061's plan, beside the freeze journey;
 * docs/freeze-recorder.md, "Before a change merges"). A synchronous call to
 * another program holds the app's main thread, which handles every click
 * and key and runs the core, until that program ends. It spends almost no
 * processor time, so the freeze journey, which counts the main thread's own
 * processor time, records such a wait without failing it. This check
 * refuses `execSync`, `execFileSync` and `spawnSync` in the code the main
 * process runs (`src/main`, `src/core`, `src/shared`), except a call listed
 * in `LISTED_WAITS` with its reason. A listed file that no longer calls one
 * leaves the list. Plain Node type stripping, no install; `pnpm check` runs it.
 *
 *   node scripts/main-thread-waits.ts    exits 1 naming each unlisted wait
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The code the main process runs; the window's own code and tests are not it. */
export const MAIN_PROCESS_ROOTS = ["src/main", "src/core", "src/shared"] as const;

/** Node's calls that wait on another program on the calling thread. */
export const WAIT_CALLS = ["execSync", "execFileSync", "spawnSync"] as const;

export const LISTED_WAITS: Record<string, string> = {
  "src/core/storage/privateCopy.ts":
    "clones the database with /bin/cp -c, a local call that answers in a few milliseconds; the saved-data check is synchronous by design (it refuses before any writer opens the record) and copied the whole file on this thread before",
  "src/main/host/macInstallation.ts":
    "reads one extended attribute of the app's own bundle with /usr/bin/xattr, a local read that answers at once; the Mac update controller needs it before its first check",
};

export type Wait = { path: string; line: number; call: string };

export function readsFile(path: string): boolean {
  return (
    MAIN_PROCESS_ROOTS.some((root) => path.startsWith(`${root}/`)) &&
    /\.tsx?$/.test(path) &&
    !/\.test\.tsx?$/.test(path)
  );
}

/**
 * The text with every comment and the words of every string blanked to
 * spaces, newlines kept, so a call is found only where code makes it. A
 * template's `${...}` stays code.
 */
export function codeOnly(text: string): string {
  const out = text.split("");
  const blank = (from: number, to: number) => {
    for (let at = from; at < to; at += 1) if (out[at] !== "\n") out[at] = " ";
  };
  // Each open template whose `${` is being read, by the brace depth it opened at.
  const templates: number[] = [];
  let depth = 0;
  let at = 0;
  const readTemplate = (start: number): number => {
    let cursor = start;
    while (cursor < text.length) {
      const char = text[cursor];
      if (char === "\\") cursor += 2;
      else if (char === "`") {
        blank(start, cursor);
        return cursor + 1;
      } else if (char === "$" && text[cursor + 1] === "{") {
        blank(start, cursor);
        templates.push(depth);
        depth += 1;
        return cursor + 2;
      } else cursor += 1;
    }
    blank(start, cursor);
    return cursor;
  };
  while (at < text.length) {
    const char = text[at];
    const next = text[at + 1];
    if (char === "/" && next === "/") {
      const end = text.indexOf("\n", at);
      const stop = end < 0 ? text.length : end;
      blank(at, stop);
      at = stop;
    } else if (char === "/" && next === "*") {
      const end = text.indexOf("*/", at + 2);
      const stop = end < 0 ? text.length : end + 2;
      blank(at, stop);
      at = stop;
    } else if (char === '"' || char === "'") {
      let cursor = at + 1;
      while (cursor < text.length && text[cursor] !== char && text[cursor] !== "\n")
        cursor += text[cursor] === "\\" ? 2 : 1;
      blank(at + 1, cursor);
      at = cursor + 1;
    } else if (char === "`") {
      at = readTemplate(at + 1);
    } else if (char === "{") {
      depth += 1;
      at += 1;
    } else if (char === "}") {
      depth -= 1;
      at += 1;
      if (templates.length > 0 && templates.at(-1) === depth) {
        templates.pop();
        at = readTemplate(at);
      }
    } else at += 1;
  }
  return out.join("");
}

export function waitsIn(path: string, text: string): Wait[] {
  const code = codeOnly(text);
  const waits: Wait[] = [];
  const pattern = new RegExp(`\\b(${WAIT_CALLS.join("|")})\\b`, "g");
  for (const match of code.matchAll(pattern)) {
    // An import names the call; the call itself is what holds the thread.
    const before = code.slice(0, match.index);
    if (/import\s*(?:type\s*)?\{[^}]*$/.test(before)) continue;
    waits.push({ path, line: before.split("\n").length, call: match[1] ?? "" });
  }
  return waits;
}

export function waitProblems(waits: readonly Wait[], listed: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const wait of waits)
    if (listed[wait.path] === undefined)
      problems.push(
        `${wait.path}:${wait.line}: ${wait.call} holds the app's main thread until the other program ends; use the asynchronous call, or, if the main thread truly cannot go on without the answer, list the file in LISTED_WAITS in scripts/main-thread-waits.ts with why`,
      );
  const waiting = new Set(waits.map((wait) => wait.path));
  for (const [path, why] of Object.entries(listed)) {
    if (!why.trim()) problems.push(`scripts/main-thread-waits.ts: ${path} is listed with no reason`);
    if (!waiting.has(path))
      problems.push(
        `scripts/main-thread-waits.ts: LISTED_WAITS holds ${path}, which no longer waits on another program; remove the entry`,
      );
  }
  return problems;
}

function main(): number {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  // Tracked files and new ones git does not ignore, as CI will read them.
  const paths = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...MAIN_PROCESS_ROOTS],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\0")
    .filter(readsFile);
  const waits = paths.flatMap((path) => {
    try {
      return waitsIn(path, readFileSync(resolve(root, path), "utf8"));
    } catch {
      // A tracked file deleted in the working copy.
      return [];
    }
  });
  const problems = waitProblems(waits, LISTED_WAITS);
  for (const problem of problems) console.error(problem);
  if (problems.length) {
    console.error(`main-thread waits: ${problems.length} out of step with the list`);
    return 1;
  }
  console.log(
    `main-thread waits: ${waits.length} call(s) wait on another program, each in a listed file`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main();
