import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, createWriteStream, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Writable } from "node:stream";
import { type Spelling, spellingOfMacApp, workLabelOf } from "@shared/codeNames";
import { FETCH_APP_TYPES } from "@shared/connection";
import { COMPUTER } from "@shared/deviceNames";
import type { DeviceGrant } from "@shared/devices";
import { readsFetchAppSystem } from "@shared/ipc";
import { spellingOfUserDataFolder, userDataFolderOf } from "@shared/userDataFolders";
import type { WorkUpdateAnswer } from "@shared/work";
import { defaultClaudeConfigDir } from "../claude/claudeQuota";
import { type DialOptions, fetchFirstmate } from "../devices/dial";
import { LINUX_APP_FILE } from "../devices/farSystems";
import type { MoveDeps } from "../folderMove/move";
import { hostEnv } from "../hostEnv";
import { hostPlatform, thisDeviceSystem } from "../platform";
import { atUtilityQos } from "../utilityQos";
import {
  type BackgroundContext,
  moveInBackground,
  readInstalled,
  rewriteInBackground,
  writeInstalled,
} from "./background";
import { fetchedLauncher, keepApp } from "./join";
import { homeDialOptions } from "./route";

/**
 * Updated by its home over the connection (docs/helper.md, "Updated by its
 * home"): the home's update order brings Firstmate here to the home's own
 * version. Where a command or the home kept a copy of Firstmate here (`app/`),
 * the home's is got with this computer's own key and kept in its place, at
 * the same path the background starts; where this user runs its Mac's own
 * app, that app is the home's already and nothing is got. Either way the run
 * then ends, and the background - which keeps it running while it is
 * joined - starts it again from what is kept here.
 *
 * A home on the other side of the Infinitary rename sends that app, under
 * its own name (FI3-1780 step 2): `Infinitary.app` to a computer that keeps
 * `Firstmate 3000.app`, or back. It is kept beside the one here, and the
 * background moves to it, under that app's own label, before the run ends;
 * the old copy and agent go once the run let the folder go (`afterRun`).
 * An app that keeps its work in another folder - Infinitary's - takes the
 * work there first: once the run let the folder go, the whole data folder
 * moves into that app's own with the one-time move (src/core/folderMove/),
 * and only then does the background move to the copy, in the new folder.
 * A move that cannot be made changes nothing: the copy kept goes, and the
 * background starts this app's run again as it was.
 */

export type UpdateHereOptions = {
  dataDir: string;
  grant: DeviceGrant;
  /**
   * The contract its home said in its welcome: a home that reads the asking
   * computer's system (`readsFetchAppSystem`) is told this computer's, and
   * answers the Firstmate for it.
   */
  homeProtocol?: string | null;
  /** How long a quiet stretch of the copy may last. */
  timeoutMs?: number;
  now?: () => number;
  /**
   * This user's background and what it carries of the run's environment,
   * which moves to another spelling's app the home sends; none for a run
   * started by hand.
   */
  background?: { context: BackgroundContext; env: Readonly<Record<string, string>> } | null;
  /** How the one-time move runs here (`MoveDeps`); this computer's own unless a test stands in its own. */
  moveDeps?: MoveDeps;
  /** Where notes about the update go: the folder's own log. */
  log?: (line: string) => void;
};

/**
 * The answer to the home, and for a copy kept under another name what
 * follows once the run let the folder go: the old copy and the old agent
 * taken away. Run from that agent, the last step ends this process.
 */
export type UpdatedHere = WorkUpdateAnswer & { afterRun?: () => Promise<void> };

const QUIET_MS = 60_000;

/**
 * Keeps the home's Firstmate here when a copy is kept, and answers whether
 * a background is set up to start the run again. Rejects, with nothing here
 * changed, when the copy could not be got or kept.
 */
export async function updateHere(options: UpdateHereOptions): Promise<UpdatedHere> {
  const { dataDir, grant } = options;
  const installed = readInstalled(dataDir);
  let afterRun: (() => Promise<void>) | undefined;
  if (installed.app) {
    // Unpacked beside the folder's own copy, on the same disk, so keeping it
    // clones rather than copies; deleted whatever happens.
    const into = mkdtempSync(join(dataDir, "update-"));
    try {
      // From the home the way its connection reaches it now: at the route
      // its SSH connection keeps, or the grant's address.
      // It asks for the system of the copy it keeps: a Mac's bundle, or a Linux AppImage.
      const { chip } = thisDeviceSystem();
      const system = installed.app.endsWith(".AppImage") ? "linux" : "macos";
      const bundle = await getFirstmate(
        grant,
        into,
        {
          timeoutMs: options.timeoutMs ?? QUIET_MS,
          ...homeDialOptions(dataDir, grant, options.now),
        },
        options.homeProtocol && readsFetchAppSystem(options.homeProtocol) && chip
          ? { system, chip }
          : undefined,
      );
      // The background starts the copy at its path, which names the app.
      if (basename(bundle) === basename(installed.app)) keepApp(bundle, dataDir);
      else if (otherSpelling(basename(installed.app), basename(bundle)))
        afterRun = await keepRenamed(options, installed, bundle);
      else throw new Error("The home sent another app than the one kept here, so nothing changed.");
    } finally {
      rmSync(into, { recursive: true, force: true });
    }
  }
  return { restarts: installed.service !== null, ...(afterRun ? { afterRun } : {}) };
}

/** Whether two Mac apps are this app in two spellings, of the same flavor. */
function otherSpelling(kept: string, sent: string): boolean {
  return (["release", "dev"] as const).some(
    (flavor) => spellingOfMacApp(kept, flavor) && spellingOfMacApp(sent, flavor),
  );
}

/**
 * Keeps another spelling's app beside the one here and moves the
 * background to it, under that app's own label. A move the service manager
 * refuses takes the new copy away again, so nothing here changed. Answers
 * what follows once the run let the folder go.
 */
async function keepRenamed(
  options: UpdateHereOptions,
  installed: ReturnType<typeof readInstalled>,
  bundle: string,
): Promise<() => Promise<void>> {
  const { dataDir, background } = options;
  const old = installed.app as string;
  if (installed.service && !background)
    throw new Error("This run cannot move its background to the home's copy, so nothing changed.");
  const kept = keepApp(bundle, dataDir);
  if (!installed.service || !background) {
    // Nothing starts it in the background: the next run started here is the new copy.
    writeInstalled(dataDir, { service: null, app: kept });
    return async () => rmSync(old, { recursive: true, force: true });
  }
  const { context, env } = background;
  const launcher = fetchedLauncher(kept);
  const spelling = spellingOfMacApp(basename(kept), context.flavor);
  // Work in one of the app's own data folders whose app keeps it in another:
  // the folder moves there before the background does. A folder a test or a
  // development run named stays where it is.
  const from = dirname(dataDir);
  const theirs = spelling && userDataFolderOf(spelling, context.flavor);
  if (theirs && spellingOfUserDataFolder(basename(from)) && theirs !== basename(from)) {
    const to = join(dirname(from), theirs);
    return async () =>
      moveThenHandOver({ ...options, background }, { from, to, old, kept, spelling });
  }
  let moved: Awaited<ReturnType<typeof moveInBackground>>;
  try {
    if (!spelling || !launcher) throw new Error("Not an app of this flavor.");
    moved = await moveInBackground(context, {
      label: workLabelOf(spelling, context.flavor),
      launcher,
      env,
      app: kept,
    });
    if (moved.state === "failed") throw new Error("The background refused it.");
  } catch (error) {
    rmSync(kept, { recursive: true, force: true });
    throw new Error(
      `Infinitary could not start in the background from the home's copy, so nothing changed: ${(error as Error).message}`,
    );
  }
  return async () => {
    rmSync(old, { recursive: true, force: true });
    await moved.retire();
  };
}

/**
 * After the run let the folder go: moves the whole data folder into the
 * kept app's own, then has the background start that copy there, under its
 * label, and the agent before it goes last, which ends this run's process.
 * Anything short of a move leaves both folders as they were and takes the
 * kept copy away, so the background starts this app's run again.
 */
async function moveThenHandOver(
  options: UpdateHereOptions & {
    background: { context: BackgroundContext; env: Readonly<Record<string, string>> };
  },
  at: { from: string; to: string; old: string; kept: string; spelling: Spelling },
): Promise<void> {
  const { context, env } = options.background;
  const log = options.log ?? (() => {});
  const { runMove } = await import("../folderMove/move");
  const outcome = await runMove(
    { from: at.from, to: at.to },
    options.moveDeps ?? {
      platform: hostPlatform(),
      claudeConfigDir: defaultClaudeConfigDir(),
      hostname: hostname(),
    },
  );
  if (outcome.kind !== "moved") {
    log(
      `could not move the work into ${at.to}, so nothing changed: ${outcome.kind === "refused" ? outcome.refusal.reason : outcome.kind}`,
    );
    rmSync(at.kept, { recursive: true, force: true });
    return;
  }
  const work = join(at.to, basename(options.dataDir));
  const app = join(work, "app", basename(at.kept));
  const launcher = fetchedLauncher(app);
  const moved = launcher
    ? await moveInBackground(
        { ...context, dataDir: work, spelling: at.spelling },
        { label: workLabelOf(at.spelling, context.flavor), launcher, env, app },
      ).catch(() => null)
    : null;
  if (!moved || moved.state === "failed") {
    // The agent before it names the folder that moved: from its next load
    // it starts the kept copy here, whose run hands it to that app's label.
    const before = readInstalled(work).service;
    if (before && launcher)
      rewriteInBackground({ ...context, dataDir: work }, before, { launcher, env, app });
    log(`moved the work into ${at.to}, but could not start it in the background there`);
    return;
  }
  rmSync(join(work, "app", basename(at.old)), { recursive: true, force: true });
  await moved.retire();
}

/**
 * Gets the home's Firstmate into `into` and answers the app it holds: a
 * Mac's bundle, unpacked from the home's gzipped tar or its published zip,
 * or a Linux AppImage, kept as it came (`FETCH_APP_TYPES`).
 */
async function getFirstmate(
  grant: DeviceGrant,
  into: string,
  dial: DialOptions,
  want: Parameters<typeof fetchFirstmate>[3],
): Promise<string> {
  const notWhole = () =>
    new Error(`Infinitary did not arrive whole from the ${COMPUTER.one} that sent it.`);
  let form = "tar" as "tar" | "zip" | "appimage";
  let tar: ChildProcess | null = null;
  let unpacked: Promise<number | null> = Promise.resolve(0);
  let written: Promise<void> = Promise.resolve();
  const open = (contentType: string): Writable => {
    const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    if (type === FETCH_APP_TYPES.zip || type === FETCH_APP_TYPES.appImage) {
      form = type === FETCH_APP_TYPES.zip ? "zip" : "appimage";
      const file = createWriteStream(
        join(into, form === "zip" ? ".firstmate.zip" : LINUX_APP_FILE),
        { mode: 0o700 },
      );
      written = new Promise((resolve, reject) => {
        file.once("finish", resolve);
        file.once("error", reject);
      });
      return file;
    }
    const { file, args } = atUtilityQos("/usr/bin/tar", ["-xzf", "-", "-C", into]);
    const child = spawn(file, args, { env: hostEnv(), stdio: ["pipe", "ignore", "ignore"] });
    tar = child;
    unpacked = new Promise<number | null>((resolve) => {
      child.once("error", () => resolve(null));
      child.once("close", resolve);
    });
    child.stdin?.on("error", () => {});
    return child.stdin as Writable;
  };
  try {
    await fetchFirstmate(grant, open, dial, want);
  } catch (error) {
    (tar as ChildProcess | null)?.kill();
    await unpacked;
    await written.catch(() => undefined);
    throw error;
  }
  if (form === "appimage") {
    await written.catch(() => {
      throw notWhole();
    });
    const app = join(into, LINUX_APP_FILE);
    chmodSync(app, 0o700);
    return app;
  }
  if (form === "zip") {
    await written.catch(() => {
      throw notWhole();
    });
    const zip = join(into, ".firstmate.zip");
    const code = await new Promise<number | null>((resolve) => {
      const ditto = spawn("/usr/bin/ditto", ["-x", "-k", zip, into], {
        env: hostEnv(),
        stdio: "ignore",
      });
      ditto.once("error", () => resolve(null));
      ditto.once("close", resolve);
    });
    rmSync(zip, { force: true });
    if (code !== 0) throw notWhole();
  } else if ((await unpacked) !== 0) throw notWhole();
  const bundle = readdirSync(into).find((entry) => entry.endsWith(".app"));
  if (!bundle) throw notWhole();
  return join(into, bundle);
}
