import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { hostEnv } from "@core/hostEnv";
import { hostPlatform } from "@core/platform";
import { readLinuxInstallation } from "@core/update/linuxInstall";
import * as m from "@shared/i18n/messages.generated";
import { languageOverride, startLanguage } from "@shared/i18n/start";
import type { MessageBoxOptions } from "electron";
import {
  endWithRequester,
  PERSON_WORD_ARG,
  type PersonReply,
  type PersonWord,
  readReply,
  replyLine,
} from "./personWordArg";

/*
 * A word a window launch refused the folder's lock says to the person
 * (docs/run.md, "Opened while it runs"). Electron never becomes ready in a
 * process refused that lock before it was ready, as every window launch asks
 * for it, so the refused launch shows no box itself: it starts a copy of this
 * program that shows the one word and says which button was pressed
 * (`askPersonWord`). That copy asks for no lock, opens no first mate and
 * keeps its own throwaway profile, so it touches nothing of the folder.
 */

export {
  PERSON_WORD_ARG,
  type PersonReply,
  type PersonWord,
  personWordArg,
  wordProfilePrivate,
} from "./personWordArg";

/**
 * How a launch starts the copy that shows a word: as it was itself started, the installed program
 * with no arguments, or on Linux its AppImage file where it runs from one (`readLinuxInstallation`:
 * the file and the folder its runtime mounted this program from), so the AppImage's own start runs
 * again and an `APPIMAGE` this launch only inherited starts nothing else; a development run of
 * Electron names the app's folder.
 */
export function wordLauncher(launch: {
  packaged: boolean;
  platform: NodeJS.Platform;
  execPath: string;
  appPath: string;
  resourcesDir: string;
  env: NodeJS.ProcessEnv;
}): { execPath: string; args: string[] } {
  if (!launch.packaged) return { execPath: launch.execPath, args: [launch.appPath] };
  const own = { execPath: launch.execPath, args: [] };
  if (launch.platform !== "linux") return own;
  const installation = readLinuxInstallation({
    chip: process.arch,
    resourcesDir: launch.resourcesDir,
    execPath: launch.execPath,
    env: launch.env,
  });
  return installation.package === "appimage" && installation.appImage
    ? { execPath: installation.appImage, args: [] }
    : own;
}

/** The question's Open here, after its Leave it, the first and closing answer. */
export const OPEN_ONCE_CLOSED = 1;

/**
 * The box for a word, in the language a launch speaks at its start, before
 * any choice in Settings is read (`startLanguage`): that Infinitary is open
 * and to click it in the Dock, or whether to open it here once the holder
 * that showed nothing closes, Leave it first and the answer to a box closed
 * any other way.
 */
export function personWordBox(word: PersonWord, preferred: readonly string[], packaged: boolean) {
  startLanguage(preferred, languageOverride(process.env, packaged));
  const box: MessageBoxOptions =
    word === "dock"
      ? {
          type: "info",
          title: "Infinitary",
          message: m.dialogOpenInDock(),
          detail: m.dialogOpenInDockDetail(),
        }
      : {
          type: "info",
          title: "Infinitary",
          message: m.dialogOpenInDock(),
          detail: m.dialogOnceClosedDetail(),
          buttons: [m.dialogLeaveIt(), m.dialogOpenOnceClosed()],
          defaultId: 0,
          cancelId: 0,
        };
  return box;
}

/**
 * The copy that shows one word: it keeps out of the Dock, so the Infinitary the word names there is
 * the only one to click, and ends with the launch that asked for it (`endWithRequester`). Once
 * Electron is ready it shows the box in front of whatever the person uses now and writes the button
 * pressed, or that the box could not be shown, and ends.
 */
export async function showPersonWord(word: PersonWord): Promise<void> {
  const { app, dialog } = await import("electron");
  if (hostPlatform() === "darwin") app.setActivationPolicy("accessory");
  endWithRequester(process.stdin, () => app.exit(0));
  await app.whenReady();
  const box = personWordBox(word, app.getPreferredSystemLanguages(), app.isPackaged);
  let reply: PersonReply = "unshown";
  try {
    app.focus({ steal: true });
    reply = (await dialog.showMessageBox(box)).response;
  } catch (error) {
    console.warn(`[app] could not show a word to the person: ${(error as Error).message}`);
  }
  process.stdout.write(replyLine(reply), () => app.exit(0));
}

/**
 * The folder in the data folder that holds the copies' throwaway profiles, and only them: a folder of
 * this account's alone, apart from the temporary folder a holder clears at its start
 * (`clearPrivateTemp`) and from one other accounts share, so a profile is never taken from under a
 * copy still using it and reclaiming touches nothing another program made.
 */
export const WORD_PROFILES_DIR = "word-profiles";
/** The file in a profile naming the launch that made it and, once started, its copy. */
const OWNER_FILE = "infinitary-word.pid";
const PROFILE_PREFIX = "infinitary-word-";
/** Two process numbers and a space: anything longer is no owner file of ours. */
const OWNER_FILE_BYTES = 64;

/**
 * Makes the profiles' folder and says whether it is this account's alone: a real folder, not a link,
 * and away from Windows owned by this account with no access for anyone else (a wider one of its own
 * is narrowed). On Windows it takes the data folder's owner-only access list (`wordProfilePrivate`).
 */
function ownProfilesFolder(root: string): boolean {
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const folder = lstatSync(root);
    if (!folder.isDirectory() || folder.isSymbolicLink()) return false;
    if (hostPlatform() === "win32") return true;
    if (folder.uid !== process.getuid?.()) return false;
    if ((folder.mode & 0o077) !== 0) chmodSync(root, 0o700);
    return (lstatSync(root).mode & 0o077) === 0;
  } catch (error) {
    console.warn(`[app] could not keep a word's profiles private: ${(error as Error).message}`);
    return false;
  }
}

/**
 * Removes the throwaway profiles in the profiles' folder whose launch died before it could, as one
 * ended by force: only a profile whose owner file names a copy that has positively ended (no process
 * with its number), or, where its copy never started, a launch that has. A profile with no such file,
 * a file that is not a small plain file, or an owner still running or whose number another program
 * took since, is left as it is.
 */
function reclaimWordProfiles(root: string): void {
  let names: string[];
  try {
    names = readdirSync(root).filter((name) => name.startsWith(PROFILE_PREFIX));
  } catch {
    return;
  }
  for (const name of names) {
    const profile = join(root, name);
    let owner: number | undefined;
    try {
      if (!lstatSync(profile).isDirectory()) continue;
      const file = join(profile, OWNER_FILE);
      const kept = lstatSync(file);
      if (!kept.isFile() || kept.size > OWNER_FILE_BYTES) continue;
      // The copy where it started, or else the launch that made the profile.
      owner = Number(readFileSync(file, "utf8").trim().split(" ").at(-1));
    } catch {
      continue;
    }
    if (!Number.isInteger(owner) || owner <= 0 || !processGone(owner)) continue;
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[app] could not remove a word's profile: ${(error as Error).message}`);
    }
  }
}

/** True only where no process has this number; one this account may not signal still lives. */
function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * Shows a word through a copy of this program (`showPersonWord`) and gives its reply (`readReply`)
 * once the copy has ended and said all it had: null where the word was taken away (`signal`),
 * which ends that copy and its box, and unshown where the copy could not be made, started or show
 * its box, or where its profile has no private folder to go in (`profiles` null, as
 * `wordProfilePrivate` decides, or one not this account's alone), which then makes none. The copy's
 * input stays open while this launch lives, so the copy ends with it too. Its throwaway profile, in
 * `profiles` (`WORD_PROFILES_DIR`), names this launch from its making and the copy once it started,
 * and goes once the copy has ended - by this launch, or by a later one's ask where this launch died
 * first - and a profile that cannot go changes no reply. `launcher` starts this app as it was
 * started (`wordLauncher`).
 */
export function askPersonWord(
  word: PersonWord,
  options: {
    launcher: { execPath: string; args: readonly string[] };
    profiles: string | null;
    signal?: AbortSignal;
  },
): Promise<PersonReply | null> {
  const { signal, profiles } = options;
  if (signal?.aborted) return Promise.resolve(null);
  if (profiles === null || !ownProfilesFolder(profiles)) return Promise.resolve("unshown");
  return new Promise((done) => {
    let settled = false;
    let takeAway = () => {};
    const settle = (reply: PersonReply | null) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", takeAway);
      done(reply);
    };
    let profile: string | null = null;
    // Only once the copy has ended, or never started.
    const cleanUp = () => {
      if (profile === null) return;
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch (error) {
        console.warn(`[app] could not remove a word's profile: ${(error as Error).message}`);
      }
    };
    let copy: ChildProcess;
    try {
      reclaimWordProfiles(profiles);
      profile = mkdtempSync(join(profiles, PROFILE_PREFIX));
      // Named from its making: a later launch removes it once this launch has gone, should no copy
      // have started.
      writeFileSync(join(profile, OWNER_FILE), String(process.pid));
      copy = spawn(
        options.launcher.execPath,
        [...options.launcher.args, `${PERSON_WORD_ARG}=${word}`, `--user-data-dir=${profile}`],
        { env: hostEnv(), stdio: ["pipe", "pipe", "ignore"] },
      );
    } catch (error) {
      console.warn(`[app] could not show a word to the person: ${(error as Error).message}`);
      cleanUp();
      settle("unshown");
      return;
    }
    // The copy's number is known as it starts, before anything else runs here: from now its own
    // end, not this launch's, lets a later launch remove the profile.
    try {
      if (copy.pid !== undefined)
        writeFileSync(join(profile, OWNER_FILE), `${process.pid} ${copy.pid}`);
    } catch (error) {
      console.warn(`[app] could not name a word's copy: ${(error as Error).message}`);
    }
    let started = false;
    copy.once("spawn", () => {
      started = true;
    });
    let said = "";
    takeAway = () => {
      // Closing its input ends the copy on its own, should this end not reach it.
      copy.stdin?.end();
      if (!copy.kill()) console.warn("[app] could not end a word taken away; it ends on its own");
      settle(null);
    };
    signal?.addEventListener("abort", takeAway, { once: true });
    // A copy already gone leaves its input closed; writing nothing, the launch only holds it open.
    copy.stdin?.on("error", () => {});
    copy.stdout?.setEncoding("utf8");
    copy.stdout?.on("data", (chunk: string) => {
      said += chunk;
    });
    // A copy that never started settles here; an error once it runs, as an end that could not
    // reach it, leaves it running and its profile in use, for its close to settle.
    copy.on("error", (error) => {
      console.warn(`[app] could not show a word to the person: ${error.message}`);
      if (started) return;
      cleanUp();
      settle("unshown");
    });
    // Close, not exit: only once the copy's output is all read, or after a start that failed.
    copy.once("close", (code, ended) => {
      cleanUp();
      settle(signal?.aborted ? null : readReply(word, said, code, ended));
    });
  });
}
