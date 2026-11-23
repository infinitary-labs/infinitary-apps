import { readFileSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";

/**
 * The settings file a run names (`<app> run --settings <file>`, docs/run.md;
 * INF-1228's approved plan, piece 4): one JSON object whose `path` lists the
 * folders where programs are, in the order they are searched. With it, the
 * run asks no login shell where programs are - nobody may be logged in to
 * answer - and every child the core starts searches these folders first
 * (`configureSettingsPath`, src/core/hostEnv.ts). Whatever starts the
 * command owns the file, as it owns when and as whom the command runs.
 */

export type RunSettings = { path: readonly string[] };

/** The settings, or why the file cannot be used, with the file's full path either way. */
export type RunSettingsReading =
  | { ok: true; file: string; settings: RunSettings }
  | { ok: false; file: string; reason: string };

/** The one setting a file may hold today; any other name is a mistake, never ignored. */
const KNOWN = new Set(["path"]);

/**
 * Reads the file `file` names, relative to `cwd` when it is not a full path.
 * Each reason is part of one sentence that names the file (`RUN_WORDS.settings`).
 */
export function readRunSettings(file: string, cwd: string = process.cwd()): RunSettingsReading {
  const full = resolve(cwd, file);
  const refuse = (reason: string): RunSettingsReading => ({ ok: false, file: full, reason });
  let text: string;
  try {
    text = readFileSync(full, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return refuse("there is no file there");
    if (code === "EACCES" || code === "EPERM") return refuse("this user may not read it");
    if (code === "EISDIR") return refuse("it is a folder, not a file");
    return refuse(`it could not be read (${code ?? String(error)})`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return refuse(`it is not JSON (${(error as Error).message})`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return refuse(`it must hold one object, such as { "path": ["/usr/bin", "/bin"] }`);
  }
  const unknown = Object.keys(value).find((key) => !KNOWN.has(key));
  if (unknown !== undefined) {
    return refuse(`it holds a setting Infinitary does not know, "${unknown}"`);
  }
  const { path } = value as { path?: unknown };
  if (path === undefined) return refuse(`it names no "path"`);
  if (!Array.isArray(path) || path.some((entry) => typeof entry !== "string")) {
    return refuse(`"path" must be a list of folders`);
  }
  for (const entry of path as string[]) {
    if (entry.includes(delimiter)) {
      return refuse(`"${entry}" in "path" holds "${delimiter}", so it names more than one folder`);
    }
    if (!isAbsolute(entry)) {
      return refuse(`"${entry}" in "path" is not a full folder path, such as /opt/homebrew/bin`);
    }
  }
  return { ok: true, file: full, settings: { path: path as string[] } };
}
