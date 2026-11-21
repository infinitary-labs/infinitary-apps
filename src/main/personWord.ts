import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { hostEnv } from "@core/hostEnv";
import { hostPlatform } from "@core/platform";
import { type AccessRun, keepOwnerOnly, powerShellAccess } from "@core/storage/ownerOnly";
import { readLinuxInstallation } from "@core/update/linuxInstall";
import * as m from "@shared/i18n/messages.generated";
import { languageOverride, startLanguage } from "@shared/i18n/start";
import type { MessageBoxOptions } from "electron";
import {
  claimWordProfile,
  endWithRequester,
  PERSON_WORD_ARG,
  type PersonReply,
  type PersonWord,
  readReply,
  replyLine,
  WORD_OWNER_FILE,
  WORD_PROFILE_PREFIX,
  WORD_PROFILES_MARK,
  WORD_PROFILES_RESERVED,
  WORD_TEMP_DIR,
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
 * the only one to click, names itself in its profile (`claimWordProfile`), and ends with the launch
 * that asked for it (`endWithRequester`). Once
 * Electron is ready it shows the box in front of whatever the person uses now and writes the button
 * pressed, or that the box could not be shown, and ends.
 */
export async function showPersonWord(word: PersonWord): Promise<void> {
  const { app, dialog } = await import("electron");
  if (hostPlatform() === "darwin") app.setActivationPolicy("accessory");
  // Named as its profile's one user before anything else it does, or it shows nothing.
  if (!claimWordProfile(process.argv)) {
    process.stdout.write(replyLine("unshown"), () => app.exit(0));
    return;
  }
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

export { wordProfilesBeside } from "@core/folderMove/due";

/** Its process number and the line's end, and nothing else: anything longer is no owner file of ours. */
const OWNER_FILE_BYTES = 16;

/**
 * Makes the profiles' folder and says whether it is this app's and this account's alone. Only a
 * folder this app made, marked whole before it took its name (`WORD_PROFILES_RESERVED`), is ever
 * used: one already there without that mark, with a mark of any other kind, or away from Windows
 * one it or its mark belongs to another account, or a link, is left exactly as it is. Away from
 * Windows it must have no access for anyone else (a wider mode of its own is narrowed); on Windows
 * it gets an owner-only access list of its own (`keepOwnerOnly`).
 */
export async function ownProfilesFolder(
  root: string,
  platform: NodeJS.Platform,
  access: AccessRun = powerShellAccess,
): Promise<boolean> {
  try {
    if (!reserveProfilesFolder(root, platform)) {
      console.warn("[app] a word's profiles' folder is there but not this app's; it is left alone");
      return false;
    }
    if (platform === "win32")
      return (await keepOwnerOnly([root], access)).kept[0]?.kind === "owner-only";
    if ((lstatSync(root).mode & 0o077) !== 0) chmodSync(root, 0o700);
    return (lstatSync(root).mode & 0o077) === 0;
  } catch (error) {
    console.warn(`[app] could not keep a word's profiles private: ${(error as Error).message}`);
    return false;
  }
}

/**
 * Makes the profiles' folder whole, or finds one this app made. Where nothing is there, a folder of
 * its own beside it (`.making-`) gets the mark first and then takes the name in one move, which
 * never replaces a folder holding anything; so the name never stands for a folder without its mark,
 * and a launch ended halfway leaves only its own `.making-` folder. Where the move loses to another
 * launch, or anything is there already, the folder is this app's only where it is a real folder,
 * not a link, holding the mark whole (`isProfilesMark`), and away from Windows both are this
 * account's.
 */
function reserveProfilesFolder(root: string, platform: NodeJS.Platform): boolean {
  if (entryOf(root) === null) {
    const making = `${root}.making-${randomUUID()}`;
    mkdirSync(making, { mode: 0o700 });
    const made = lstatSync(making);
    try {
      writeFileSync(join(making, WORD_PROFILES_RESERVED), WORD_PROFILES_MARK, {
        flag: "wx",
        mode: 0o600,
      });
      renameSync(making, root);
    } catch (error) {
      removeIfSame(making, made);
      const code = (error as NodeJS.ErrnoException).code;
      // Another launch's folder took the name first: it is read as any folder already there.
      if (code !== "EEXIST" && code !== "ENOTEMPTY" && code !== "EPERM") throw error;
    }
  }
  const folder = entryOf(root);
  if (folder === null || !folder.isDirectory() || folder.isSymbolicLink()) return false;
  if (platform !== "win32" && folder.uid !== process.getuid?.()) return false;
  return isProfilesMark(join(root, WORD_PROFILES_RESERVED), platform);
}

/** The profiles' folder's mark: a plain file of this account's saying `WORD_PROFILES_MARK` whole. */
function isProfilesMark(path: string, platform: NodeJS.Platform): boolean {
  const mark = readSmallFile(path, Buffer.byteLength(WORD_PROFILES_MARK));
  return (
    mark !== null &&
    mark.text === WORD_PROFILES_MARK &&
    (platform === "win32" || mark.file.uid === process.getuid?.())
  );
}

/**
 * Removes a folder this launch made, only while its path still names that folder: one replaced
 * since, by whatever moved it away, is left as it is.
 */
function removeIfSame(path: string, made: { dev: number; ino: number }): void {
  const now = entryOf(path);
  if (now === null || !now.isDirectory() || !sameEntry(now, made)) return;
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    console.warn(`[app] could not remove a word's folder: ${(error as Error).message}`);
  }
}

/** Which entry a path is, by device and number: the same only while nothing replaced it. */
const sameEntry = (a: { dev: number; ino: number }, b: { dev: number; ino: number }) =>
  a.dev === b.dev && a.ino === b.ino;

/** A profile's owner: the copy's number, and which file said it. */
type Owner = { pid: number; dev: number; ino: number };

/**
 * The copy a profile's owner file names (`claimWordProfile`): its number and the line's end, and
 * nothing else, read whole (`readSmallFile`); anything else, a record not yet written whole, or no
 * file, is no owner.
 */
function profileOwner(profile: string): Owner | null {
  const owner = readSmallFile(join(profile, WORD_OWNER_FILE), OWNER_FILE_BYTES);
  if (owner === null || !/^[1-9][0-9]{0,9}\n$/.test(owner.text)) return null;
  return { pid: Number(owner.text.trimEnd()), dev: owner.file.dev, ino: owner.file.ino };
}

/**
 * A small file's whole text and which file it was: a plain file, never a link nor a pipe, whose
 * opened file is the one the path named and which reads to its end in no more than `most` bytes;
 * null for anything else or nothing there.
 */
function readSmallFile(path: string, most: number): { text: string; file: Stats } | null {
  let fd: number | undefined;
  try {
    // Checked before it is opened, where opening cannot refuse a link itself, as on Windows.
    const named = lstatSync(path);
    if (!named.isFile() || named.size > most) return null;
    fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const kept = fstatSync(fd);
    if (!kept.isFile() || !sameEntry(kept, named) || kept.size > most) return null;
    const bytes = Buffer.alloc(most + 1);
    let read = 0;
    for (let got = 1; got > 0 && read < bytes.length; read += got)
      got = readSync(fd, bytes, read, bytes.length - read, read);
    if (read !== kept.size) return null;
    return { text: bytes.toString("utf8", 0, read), file: kept };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Removes the throwaway profiles in the profiles' folder whose copy has positively ended (no process
 * with its number) with no launch left to remove them, as one ended by force. A profile whose copy
 * never named itself, whose owner file is not one of ours, or whose copy still runs or whose number
 * another program took since, is left as it is.
 */
function reclaimWordProfiles(root: string): void {
  let names: string[];
  try {
    names = readdirSync(root).filter((name) => name.startsWith(WORD_PROFILE_PREFIX));
  } catch {
    return;
  }
  for (const name of names) {
    const profile = join(root, name);
    const folder = entryOf(profile);
    if (folder === null || !folder.isDirectory()) continue;
    const owner = profileOwner(profile);
    if (owner === null || !processGone(owner.pid)) continue;
    // The same folder and the same whole owner file, read again just before it goes: a profile
    // where either was replaced or changed since is left as it is.
    const now = entryOf(profile);
    if (now === null || !now.isDirectory() || !sameEntry(now, folder)) continue;
    const still = profileOwner(profile);
    if (still === null || still.pid !== owner.pid || !sameEntry(still, owner)) continue;
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[app] could not remove a word's profile: ${(error as Error).message}`);
    }
  }
}

/** What a path names, not following a link; null where nothing can be read there. */
function entryOf(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
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
 * which ends that copy and its box, and unshown where the copy could not be started or show its box,
 * or where its profile has no private folder to go in (`profiles` null, as `wordProfilePrivate`
 * decides, or one not this account's alone), which then starts none. The copy's input stays open
 * while this launch lives, so the copy ends with it too. This launch makes the copy's throwaway
 * profile, in `profiles` (`wordProfilesBeside`), with the temporary folder the copy is given from
 * its start inside it; the copy, the one process to use it, names itself there as it starts
 * (`claimWordProfile`). It goes once the copy has ended - by this launch, or by a later one's ask
 * where this launch died after the copy named itself; one never named stays - and a profile that
 * cannot go changes no reply. `launcher` starts
 * this app as it was started (`wordLauncher`).
 */
export async function askPersonWord(
  word: PersonWord,
  options: {
    launcher: { execPath: string; args: readonly string[] };
    profiles: string | null;
    signal?: AbortSignal;
  },
): Promise<PersonReply | null> {
  const { signal, profiles } = options;
  if (signal?.aborted) return null;
  if (profiles === null || !(await ownProfilesFolder(profiles, hostPlatform()))) return "unshown";
  if (signal?.aborted) return null;
  reclaimWordProfiles(profiles);
  const profile = join(profiles, `${WORD_PROFILE_PREFIX}${randomUUID()}`);
  const temp = join(profile, WORD_TEMP_DIR);
  // Its profile and temporary folder are there before the copy runs, so its temporary files
  // have a place from its start; it names itself there before using either. Only the profile
  // this launch made goes, while its path still names it (`removeIfSame`).
  let made: Stats;
  try {
    mkdirSync(profile, { mode: 0o700 });
    made = lstatSync(profile);
  } catch (error) {
    console.warn(`[app] could not make a word's profile: ${(error as Error).message}`);
    return "unshown";
  }
  const cleanUp = () => removeIfSame(profile, made);
  try {
    mkdirSync(temp, { mode: 0o700 });
  } catch (error) {
    console.warn(`[app] could not make a word's profile: ${(error as Error).message}`);
    cleanUp();
    return "unshown";
  }
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
        // Temporary files of its own, apart from the folder a later holder clears at its start.
        { env: { ...hostEnv(), TEMP: temp, TMP: temp }, stdio: ["pipe", "pipe", "ignore"] },
      );
    } catch (error) {
      console.warn(`[app] could not show a word to the person: ${(error as Error).message}`);
      cleanUp();
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
