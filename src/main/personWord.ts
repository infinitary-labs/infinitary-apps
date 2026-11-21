import { type ChildProcess, spawn } from "node:child_process";
import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { hostEnv } from "@core/hostEnv";
import { hostPlatform } from "@core/platform";
import { readLinuxInstallation } from "@core/update/linuxInstall";
import * as m from "@shared/i18n/messages.generated";
import { languageOverride, startLanguage } from "@shared/i18n/start";
import type { MessageBoxOptions } from "electron";
import {
  claimWordProfile,
  endWithRequester,
  endWithRequesterOffMain,
  PERSON_WORD_ARG,
  type PersonReply,
  type PersonWord,
  readReply,
  replyLine,
  WORD_PROFILES,
  WORD_TEMP_DIR,
} from "./personWordArg";

/*
 * A word a window launch refused the folder's lock says to the person
 * (docs/run.md, "Opened while it runs"). Electron never becomes ready in a
 * process refused that lock before it was ready, as every window launch asks
 * for it, so the refused launch shows no box itself: it starts a copy of this
 * program that shows the one word and says which button was pressed
 * (`askPersonWord`). That copy asks for no lock on the folder, opens no
 * first mate and keeps a profile of its own in it (`wordProfileIn`), which
 * it holds alone, so it touches nothing else there.
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
 * the only one to click, takes its profile for itself alone (`claimWordProfile`), and ends with the launch
 * that asked for it (`endWithRequester`, and on a Mac, whose box holds the copy's main thread,
 * `endWithRequesterOffMain`). Once
 * Electron is ready it shows the box in front of whatever the person uses now and writes the button
 * pressed, or that the box could not be shown, and ends.
 */
export async function showPersonWord(word: PersonWord): Promise<void> {
  const { app, dialog } = await import("electron");
  if (hostPlatform() === "darwin") app.setActivationPolicy("accessory");
  // Its profile's one user before anything else it does, or it shows nothing.
  if (!claimWordProfile(process.argv, () => app.requestSingleInstanceLock())) {
    process.stdout.write(replyLine("unshown"), () => app.exit(0));
    return;
  }
  endWithRequester(process.stdin, () => app.exit(0));
  if (hostPlatform() === "darwin") endWithRequesterOffMain();
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
 * The profile a word's copy uses, kept in the data folder (`WORD_PROFILES`) with its temporary
 * folder in it: the first name holding a real folder of this account's alone, or where nothing is,
 * one made there so - away from Windows owned by this account with no access for anyone else, on
 * Windows under the data folder's owner-only list, which Windows hands down to it
 * (`wordProfilePrivate`). Anything else at a name, as a link, a file or a folder others may reach,
 * is left exactly as it is and the next name is tried; null where none is left. A profile is used
 * again by every later word and never moved, removed or given other access, so the app changes
 * nothing but what it keeps in its own folder.
 */
export function wordProfileIn(dataDir: string, platform: NodeJS.Platform): string | null {
  for (const name of WORD_PROFILES) {
    const profile = join(dataDir, name);
    if (privateFolder(profile, platform) && privateFolder(join(profile, WORD_TEMP_DIR), platform))
      return profile;
    console.warn("[app] a word's profile's name holds something else; it is left alone");
  }
  return null;
}

/**
 * Whether `path` is a real folder of this account's alone, made there with no access for anyone
 * else where nothing is; never a link, nor one others may reach away from Windows.
 */
function privateFolder(path: string, platform: NodeJS.Platform): boolean {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
  }
  try {
    const found = lstatSync(path);
    if (!found.isDirectory()) return false;
    return platform === "win32" || (found.uid === process.getuid?.() && (found.mode & 0o077) === 0);
  } catch {
    return false;
  }
}

/**
 * Shows a word through a copy of this program (`showPersonWord`) and gives its reply (`readReply`)
 * once the copy has ended and said all it had: null where the word was taken away (`signal`),
 * which ends that copy and its box, and unshown where the copy could not be started or show its box,
 * or where its profile has no private place (`dataDir` null, as `wordProfilePrivate` decides, or
 * no name in it left for one, `wordProfileIn`), which then starts none. The copy's input stays open
 * while this launch lives, so the copy ends with it too. The copy uses the profile kept in the data
 * folder, with its temporary files in it from its start, and takes it for itself alone as it starts
 * (`claimWordProfile`). `launcher` starts this app as it was started (`wordLauncher`).
 */
export async function askPersonWord(
  word: PersonWord,
  options: {
    launcher: { execPath: string; args: readonly string[] };
    dataDir: string | null;
    signal?: AbortSignal;
  },
): Promise<PersonReply | null> {
  const { signal, dataDir } = options;
  if (signal?.aborted) return null;
  const profile = dataDir === null ? null : wordProfileIn(dataDir, hostPlatform());
  if (profile === null) return "unshown";
  const temp = join(profile, WORD_TEMP_DIR);
  return new Promise((done) => {
    let settled = false;
    let takeAway = () => {};
    const settle = (reply: PersonReply | null) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", takeAway);
      done(reply);
    };
    let copy: ChildProcess;
    try {
      copy = spawn(
        options.launcher.execPath,
        [...options.launcher.args, `${PERSON_WORD_ARG}=${word}`, `--user-data-dir=${profile}`],
        // Temporary files of its own, apart from the folder a later holder clears at its start:
        // named by every setting that chooses it, as a Mac or Linux takes `TMPDIR` first.
        {
          env: { ...hostEnv(), TEMP: temp, TMP: temp, TMPDIR: temp },
          stdio: ["pipe", "pipe", "ignore"],
        },
      );
    } catch (error) {
      console.warn(`[app] could not show a word to the person: ${(error as Error).message}`);
      settle("unshown");
      return;
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
    // reach it, leaves it running, for its close to settle.
    copy.on("error", (error) => {
      console.warn(`[app] could not show a word to the person: ${error.message}`);
      if (started) return;
      settle("unshown");
    });
    // Close, not exit: only once the copy's output is all read, or after a start that failed.
    copy.once("close", (code, ended) => {
      settle(signal?.aborted ? null : readReply(word, said, code, ended));
    });
  });
}
