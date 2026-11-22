import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { Writable } from "node:stream";
import { type BuildIdentity, buildIdentitySchema } from "@shared/buildIdentity";
import { FETCH_SOURCE_PATH } from "@shared/connection";
import type { DeviceGrant } from "@shared/devices";
import type { SourceBuildStep } from "@shared/work";
import { z } from "zod";
import { type DialOptions, fetchFromHome } from "../devices/dial";
import { writePrivate } from "../devices/identity";
import { hostEnv } from "../hostEnv";
import { hostPlatform } from "../platform";
import { findOnPath } from "../userBin";
import { atUtilityQos } from "../utilityQos";
import {
  type BackgroundContext,
  type Launcher,
  readInstalled,
  reloadInBackground,
  rewriteInBackground,
} from "./background";
import { homeDialOptions } from "./route";
import {
  beginTrial,
  putBack,
  setAside,
  setAsidePath,
  trialWatchOf,
  watchTrial,
} from "./updateTrial";

/**
 * Building the home's source here (docs/helper.md, "Building the home's
 * source"): a home run from source asks a Mac that runs work for it to run
 * the same commit (`inf:source:build`). This computer gets the home's
 * committed tree at that commit with its own key (`FETCH_SOURCE_PATH`),
 * unpacks it in a private folder of its work folder, installs its packages
 * with its own pnpm, builds it, and writes what it built beside it
 * (`SOURCE_BUILD_FILE`). Its background then starts Electron from that
 * folder, on trial as an update's copy is: the agent's file and the record
 * are set aside, and a build that does not reach the home in the update's
 * wait has them put back and goes (docs/helper.md, "A copy that does not
 * start"). A step that fails changes nothing here and says which it was,
 * with the last lines it printed.
 */

/** Where the builds live inside the work folder, one folder per commit. */
export const SOURCE_DIR = "source";
/** What a finished build says of itself, in its own folder: read by the run it starts. */
export const SOURCE_BUILD_FILE = "infinitary-build.json";

const sourceBuildFileSchema = z.strictObject({
  version: z.literal(1),
  commit: z.string().regex(/^[a-f0-9]{40,64}$/),
  lockDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});

/** How long one step may run before it is stopped: an install on a slow network takes minutes. */
const STEP_MS = 30 * 60_000;
/** How much of what a failed step printed goes back to the home. */
const TAIL_CHARS = 2000;

/** What one step answered: its exit code and the last of what it printed. */
export type StepResult = { code: number | null; tail: string };

/** Runs one program for a step, in `cwd`; stopped by `signal` or after `STEP_MS`. */
export type StepRunner = (
  file: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal },
) => Promise<StepResult>;

export type SourceBuildOptions = {
  dataDir: string;
  grant: DeviceGrant;
  commit: string;
  /** This user's background and what it carries of the run's environment; none for a run started by hand. */
  background: { context: BackgroundContext; env: Readonly<Record<string, string>> } | null;
  /** Says each step as it starts, for the home's progress order. */
  onStep?: (step: "fetching" | "installing" | "building") => void;
  log?: (line: string) => void;
  signal?: AbortSignal;
  now?: () => number;
  /** How long the build has to reach the home before its watcher goes back. */
  trialSeconds?: number;
  /** The programs each step runs; this computer's own unless a test stands in its own. */
  run?: StepRunner;
  /** Gets the home's source into a sink; `fetchFromHome` unless a test stands in its own. */
  fetch?: typeof fetchFromHome;
  /** The Node and pnpm a build uses; found on this user's search path unless a test names them. */
  tools?: { node: string; pnpm: string } | null;
  /** The system it runs: a build runs on a Mac alone. */
  platform?: string;
  /** The folder this run's app was loaded from: a build there stays, since a trial goes back to it. */
  running?: string;
};

export type SourceBuilt =
  | { restarts: boolean; afterRun?: () => Promise<void> }
  | { failed: SourceBuildStep; detail?: string };

/** The folder that holds a commit's build. */
export function sourceBuildDir(dataDir: string, commit: string): string {
  return join(dataDir, SOURCE_DIR, commit);
}

/**
 * The build a run from source says it is (docs/devices.md, "Matching the
 * home's build"): one this computer built from its home's source names its
 * commit and lockfile, from the file it wrote beside it; any other run from
 * source names no commit, so a home run from source reads it as another
 * build. An installed release names the commit its source index names.
 */
export function buildIdentityOf(input: {
  packaged: boolean;
  appDir: string;
  releaseCommit?: string | null;
}): BuildIdentity {
  if (input.packaged) return input.releaseCommit ? { commit: input.releaseCommit } : {};
  const built = readBuildFile(input.appDir);
  if (!built) return { source: { edited: false } };
  return buildIdentitySchema.parse({
    commit: built.commit,
    source: { edited: false, ...(built.lockDigest ? { lockDigest: built.lockDigest } : {}) },
  });
}

function readBuildFile(dir: string): z.infer<typeof sourceBuildFileSchema> | null {
  try {
    return sourceBuildFileSchema.parse(
      JSON.parse(readFileSync(join(dir, SOURCE_BUILD_FILE), "utf8")),
    );
  } catch {
    return null;
  }
}

/**
 * Whether this run is a build kept in its work folder's `source/`: such a
 * run hands its background back to an installed copy when its home brings
 * it to a release (`keepsFirst`, ./update.ts).
 */
export function runsSourceBuild(dataDir: string, appDir: string, packaged: boolean): boolean {
  if (packaged) return false;
  const builds = resolve(dataDir, SOURCE_DIR);
  const inside = relative(builds, resolve(appDir));
  return (
    inside !== "" && !inside.startsWith(`..${sep}`) && inside !== ".." && !inside.includes(sep)
  );
}

/** The Electron program inside a build, as its package names it in `path.txt`. */
export function electronOf(dir: string): string {
  const named = readFileSync(join(dir, "node_modules", "electron", "path.txt"), "utf8").trim();
  return join(dir, "node_modules", "electron", "dist", named);
}

/** The background's launcher for a build: its Electron, given the build's folder. */
export function sourceLauncher(dir: string): Launcher {
  return { executable: electronOf(dir), args: [dir] };
}

const defaultRun: StepRunner = (file, args, options) =>
  new Promise((done) => {
    const { file: program, args: rest } = atUtilityQos(file, [...args]);
    const child = spawn(program, rest, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let tail = "";
    const keep = (chunk: Buffer) => {
      tail = (tail + chunk.toString("utf8")).slice(-TAIL_CHARS);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const timer = setTimeout(() => child.kill("SIGTERM"), STEP_MS);
    const stop = () => child.kill("SIGTERM");
    options.signal?.addEventListener("abort", stop, { once: true });
    child.once("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
      done({ code: null, tail: `${tail}\n${String(error)}`.slice(-TAIL_CHARS) });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
      done({ code, tail });
    });
  });

/** This user's own Node and pnpm, on the search path the app reads for its children. */
function ownTools(): { node: string; pnpm: string } | null {
  const env = hostEnv();
  const node = findOnPath("node", env);
  const pnpm = findOnPath("pnpm", env);
  return node && pnpm ? { node, pnpm } : null;
}

/** Unpacks the home's gzipped tar into `into` with the Mac's own tar. */
async function getSource(
  options: SourceBuildOptions,
  into: string,
  dial: DialOptions,
): Promise<boolean> {
  const { file, args } = atUtilityQos("/usr/bin/tar", ["-xzf", "-", "-C", into]);
  const child = spawn(file, args, { env: hostEnv(), stdio: ["pipe", "ignore", "ignore"] });
  const unpacked = new Promise<number | null>((done) => {
    child.once("error", () => done(null));
    child.once("close", done);
  });
  child.stdin?.on("error", () => {});
  try {
    await (options.fetch ?? fetchFromHome)(options.grant, child.stdin as Writable, dial, {
      path: FETCH_SOURCE_PATH,
      body: { commit: options.commit },
    });
  } catch (error) {
    child.kill();
    await unpacked;
    options.log?.(`could not get the home's source: ${String(error)}`);
    return false;
  }
  return (await unpacked) === 0;
}

/** The SHA-256 of a build's lockfile, in hex; absent when it has none. */
function lockDigestOf(dir: string): string | undefined {
  try {
    return createHash("sha256")
      .update(readFileSync(join(dir, "pnpm-lock.yaml")))
      .digest("hex");
  } catch {
    return undefined;
  }
}

/**
 * Builds the home's source at `commit` here and moves the background to it
 * (`SourceBuilt`). A build of that commit kept here already is used again.
 */
export async function buildSourceHere(options: SourceBuildOptions): Promise<SourceBuilt> {
  const { dataDir, commit, log } = options;
  if ((options.platform ?? hostPlatform()) !== "darwin") return { failed: "system" };
  const installed = readInstalled(dataDir);
  const background = options.background;
  if (!background || !("launchctl" in background.context) || !installed.service)
    return {
      failed: "keep",
      detail: "No background runs work here to start the build.",
    };
  const tools = options.tools === undefined ? ownTools() : options.tools;
  if (!tools) return { failed: "tools" };
  const dir = sourceBuildDir(dataDir, commit);
  if (readBuildFile(dir)?.commit !== commit) {
    const built = await build(options, tools, dir);
    if (built) return built;
  } else log?.(`the build of ${commit} kept here is used again`);
  return keepSource(options, background, installed.service, dir);
}

/** Gets, installs and builds into a partial folder, renamed to `dir` once whole; answers a failure, or null. */
async function build(
  options: SourceBuildOptions,
  tools: { node: string; pnpm: string },
  dir: string,
): Promise<SourceBuilt | null> {
  const { dataDir, commit, log, signal } = options;
  const run = options.run ?? defaultRun;
  const builds = join(dataDir, SOURCE_DIR);
  mkdirSync(builds, { recursive: true, mode: 0o700 });
  const partial = join(builds, `.${commit}.partial`);
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial, { mode: 0o700 });
  const failed = (step: SourceBuildStep, detail?: string): SourceBuilt => {
    rmSync(partial, { recursive: true, force: true });
    log?.(`could not build ${commit} here: ${step}${detail ? `\n${detail}` : ""}`);
    return { failed: step, ...(detail ? { detail: detail.trim().slice(-TAIL_CHARS) } : {}) };
  };
  options.onStep?.("fetching");
  const dial: DialOptions = {
    timeoutMs: 60_000,
    ...homeDialOptions(dataDir, options.grant, options.now),
    ...(signal ? { signal } : {}),
  };
  if (!(await getSource(options, partial, dial))) return failed("fetch");
  if (!existsSync(join(partial, "package.json"))) return failed("fetch");
  // The build's own tools first on its search path, then this user's.
  const env = hostEnv({
    CI: "1",
    PATH: [join(tools.node, ".."), join(tools.pnpm, ".."), hostEnv().PATH ?? ""].join(":"),
  });
  options.onStep?.("installing");
  const install = await run(tools.pnpm, ["install", "--frozen-lockfile"], {
    cwd: partial,
    env,
    ...(signal ? { signal } : {}),
  });
  if (install.code !== 0) return failed("install", install.tail);
  options.onStep?.("building");
  for (const args of [
    // The dev Electron signed with this Mac's local development identity, as `pnpm dev` signs it.
    ["scripts/prepare-local-codesign.mjs"],
    ["node_modules/electron-vite/bin/electron-vite.js", "build"],
  ]) {
    const step = await run(tools.node, args, {
      cwd: partial,
      env: { ...env, NODE_ENV: "production" },
      ...(signal ? { signal } : {}),
    });
    if (step.code !== 0) return failed("build", step.tail);
  }
  if (!existsSync(join(partial, "out", "main"))) return failed("build", "The build wrote no app.");
  try {
    electronOf(partial);
  } catch {
    return failed("install", "Its packages hold no Electron to start it with.");
  }
  const lockDigest = lockDigestOf(partial);
  writePrivate(
    join(partial, SOURCE_BUILD_FILE),
    `${JSON.stringify({ version: 1, commit, ...(lockDigest ? { lockDigest } : {}) })}\n`,
  );
  rmSync(dir, { recursive: true, force: true });
  renameSync(partial, dir);
  return null;
}

/**
 * Moves the background to a build, on trial where launchctl can be asked
 * from outside the run, and takes away every other build but the one this
 * run started from, which the trial goes back to.
 */
function keepSource(
  options: SourceBuildOptions,
  background: { context: BackgroundContext; env: Readonly<Record<string, string>> },
  service: { label: string; file: string },
  dir: string,
): SourceBuilt {
  const { dataDir, log } = options;
  const { context } = background;
  const installed = readInstalled(dataDir);
  const watch = trialWatchOf(context, service);
  const previous = setAsidePath(dataDir);
  const pairs = watch
    ? setAside(previous, [{ path: service.file }, { path: join(dataDir, "installed.json") }])
    : [];
  try {
    rewriteInBackground(context, service, {
      launcher: sourceLauncher(dir),
      env: background.env,
      app: installed.app,
    });
  } catch (error) {
    if (watch) putBack(pairs, previous);
    log?.(`could not move the background to the build: ${String(error)}`);
    return { failed: "keep", detail: String(error) };
  }
  pruneBuilds(dataDir, [dir, ...(options.running ? [options.running] : [])]);
  const reload = () => reloadInBackground(context, service);
  if (!watch) return { restarts: true, afterRun: reload };
  try {
    beginTrial(dataDir, dir, previous);
  } catch (error) {
    rmSync(previous, { recursive: true, force: true });
    log?.(`could not keep the previous copy on trial: ${String(error)}`);
    return { restarts: true, afterRun: reload };
  }
  const restore = { restore: pairs, remove: [dir], commands: watch.reload(service) };
  return {
    restarts: true,
    afterRun: async () => {
      await watchTrial(dataDir, watch, {
        ...(options.trialSeconds ? { seconds: options.trialSeconds } : {}),
        restore,
      });
      await reload();
    },
  };
}

/** Takes away every build in the work folder but those named, and any partial one. */
export function pruneBuilds(dataDir: string, keep: readonly string[]): void {
  const builds = join(dataDir, SOURCE_DIR);
  let entries: string[];
  try {
    entries = readdirSync(builds);
  } catch {
    return;
  }
  const kept = new Set(
    keep.flatMap((path) => {
      try {
        return [realpathSync(path)];
      } catch {
        return [];
      }
    }),
  );
  for (const entry of entries) {
    const path = join(builds, entry);
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      continue;
    }
    if (!kept.has(real)) rmSync(path, { recursive: true, force: true });
  }
}
