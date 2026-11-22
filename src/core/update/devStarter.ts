/**
 * What `pnpm dev`'s starter and the app it starts tell each other
 * (docs/alpha.md, "Updates from source"). The starter (`scripts/dev.ts`)
 * runs electron-vite as its child and names a private folder of its own in
 * `INFINITARY_DEV_STARTER`. It writes `session.json` there before each
 * start: the copy it runs, the commit, whether tracked files are edited,
 * the lockfile's digest and how the last update it ran ended. The app
 * marks `started` once its main process runs, and an update it was asked
 * for leaves `update.json` before the app quits; the starter then moves
 * the copy and starts it again.
 *
 * Plain Node loads this file in the starter, so it imports nothing through
 * the project's aliases.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/** The environment variable that names the starter's folder; the app reads it through `settingFrom`. */
export const DEV_STARTER_VARIABLE = "INFINITARY_DEV_STARTER";
/** `DEV_STARTER_VARIABLE` without its prefix, as `settingFrom` takes it. */
export const DEV_STARTER_SETTING = "DEV_STARTER";

const SESSION_FILE = "session.json";
const REQUEST_FILE = "update.json";
const STARTED_FILE = "started";

const commitSchema = z.string().regex(/^[a-f0-9]{40,64}$/);

/** How the last update the starter ran ended, said by the run it started next. */
export const starterOutcomeSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("updated"),
    from: commitSchema,
    to: commitSchema,
    /** The packages changed, so the starter installed them. */
    installed: z.boolean(),
  }),
  z.object({
    outcome: z.literal("went-back"),
    from: commitSchema,
    to: commitSchema,
    /**
     * Where it stopped: `move` left the copy where it was, `install` and
     * `build` returned it to `from` after the copy had moved.
     */
    step: z.enum(["move", "install", "build"]),
  }),
]);
export type StarterOutcome = z.infer<typeof starterOutcomeSchema>;

export const starterSessionSchema = z.object({
  /** The copy of the project `pnpm dev` runs from. */
  root: z.string().min(1),
  /** The commit the starter started, as it read it at that start. */
  commit: commitSchema,
  /** Tracked files differed from `commit` at that start. */
  edited: z.boolean(),
  /** The SHA-256 of `pnpm-lock.yaml` at that start, in hex. */
  lockDigest: z.string(),
  last: starterOutcomeSchema.optional(),
});
export type StarterSession = z.infer<typeof starterSessionSchema>;

/** The update the app asks of the starter: move the copy from `from` forward to `to`. */
export const sourceUpdateRequestSchema = z.object({ from: commitSchema, to: commitSchema });
export type SourceUpdateRequest = z.infer<typeof sourceUpdateRequestSchema>;

/** Replaces a file whole, so a reader never sees half of it. */
function writeWhole(dir: string, name: string, text: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const part = join(dir, `.${name}.${process.pid}`);
  writeFileSync(part, text, { mode: 0o600 });
  renameSync(part, join(dir, name));
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function writeStarterSession(dir: string, session: StarterSession): void {
  writeWhole(dir, SESSION_FILE, JSON.stringify(session));
}

/** The starter's session, or null when there is none or it cannot be read. */
export function readStarterSession(dir: string): StarterSession | null {
  const parsed = starterSessionSchema.safeParse(readJson(join(dir, SESSION_FILE)));
  return parsed.success ? parsed.data : null;
}

export function requestSourceUpdate(dir: string, request: SourceUpdateRequest): void {
  writeWhole(dir, REQUEST_FILE, JSON.stringify(request));
}

/** The update the app asked for, taken once: the file goes as it is read. */
export function takeSourceUpdate(dir: string): SourceUpdateRequest | null {
  const path = join(dir, REQUEST_FILE);
  const parsed = sourceUpdateRequestSchema.safeParse(readJson(path));
  rmSync(path, { force: true });
  return parsed.success ? parsed.data : null;
}

/** The app's main process runs: the build the starter started worked. */
export function markStarted(dir: string): void {
  writeWhole(dir, STARTED_FILE, String(process.pid));
}

/** Whether the run the starter started reached its main process, clearing the mark. */
export function takeStarted(dir: string): boolean {
  const path = join(dir, STARTED_FILE);
  let started = false;
  try {
    readFileSync(path);
    started = true;
  } catch {
    started = false;
  }
  rmSync(path, { force: true });
  return started;
}
