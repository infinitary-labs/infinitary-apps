import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { hostEnv } from "@core/hostEnv";
import { hostPlatform } from "@core/platform";
import {
  type AccessRun,
  keepOwnerOnly,
  onlyOwnerReaches,
  othersCanChange,
  ownerOnlyVerdict,
  powerShellAccess,
  readAccessList,
  UNFINISHED_MARK,
} from "@core/storage/ownerOnly";
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
  WORD_REMOVING_PREFIX,
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

/** The profiles' folder a launch keeps its words' profiles in, and which folder it was. */
export type ProfilesFolder = { path: string; made: Stats };

/**
 * The profiles' folder this app keeps for this account, or null where it has none it can trust; it
 * then starts no copy. It goes in the folder `root` names once every folder on the way to it, links
 * resolved, is one no other account can change (`trustedParent`), so nothing can put another folder
 * in its place, and every later step uses that resolved place. Only a folder this app made, made
 * this account's alone, and marked (`WORD_PROFILES_RESERVED`) is used; an empty folder of this
 * account's at its name is one a launch made and never finished marking, and is finished. A folder
 * already there that is neither is left exactly as it is, never changed, read into or used, and the
 * next name beside it is tried (`-2`, `-3`).
 */
export async function ownProfilesFolder(
  root: string,
  platform: NodeJS.Platform,
  access: AccessRun = powerShellAccess,
): Promise<ProfilesFolder | null> {
  try {
    const parent = await trustedParent(dirname(root), platform, access);
    if (parent === null) {
      console.warn("[app] a word's profiles would go where others can change them; none is made");
      return null;
    }
    const at = join(parent, basename(root));
    for (const path of [at, `${at}-2`, `${at}-3`]) {
      const kept = await keepProfilesFolder(path, platform, access);
      if (kept !== "not-ours") return kept;
      console.warn("[app] a word's profiles' folder is there but not this app's; it is left alone");
    }
    return null;
  } catch (error) {
    console.warn(`[app] could not keep a word's profiles private: ${(error as Error).message}`);
    return null;
  }
}

/**
 * The folder `parent` names, links resolved, where it and every folder above it is one no other
 * account can change, so no other account can move or replace what it holds; null otherwise. Away
 * from Windows the folder itself is this account's with no one else able to write it, and each
 * above it belongs to this account or the system with no one else able to write it, or is one where
 * only an entry's owner may move it (the sticky bit, as `/tmp`). On Windows each one's access list
 * lets no other ordinary account remove, rename or re-permit anything there (`othersCanChange`).
 */
async function trustedParent(
  parent: string,
  platform: NodeJS.Platform,
  access: AccessRun,
): Promise<string | null> {
  const real = realpathSync.native(parent);
  const chain = [real];
  for (let up = dirname(real); up !== chain[chain.length - 1]; up = dirname(up)) chain.push(up);
  if (platform === "win32") {
    const answer = await access({ set: [], read: chain });
    const trusted = chain.every((path, index) => {
      const sddl = answer.read[index]?.path === path ? answer.read[index]?.sddl : null;
      return !!sddl && !othersCanChange(readAccessList(sddl), answer.user);
    });
    return trusted ? real : null;
  }
  const user = process.getuid?.();
  const trusted = chain.every((path, index) => {
    const found = entryOf(path);
    if (found === null || !found.isDirectory() || found.isSymbolicLink()) return false;
    if (index === 0) return found.uid === user && (found.mode & 0o022) === 0;
    return (
      (found.uid === user || found.uid === 0) &&
      ((found.mode & 0o022) === 0 || (found.mode & 0o1000) !== 0)
    );
  });
  return trusted ? real : null;
}

/**
 * Makes the profiles' folder at one name, or finds this app's there. A folder it makes is this
 * account's alone before its mark goes in: made with no access for anyone else, or on Windows given
 * an owner-only access list of its own (`keepOwnerOnly`); one that cannot be is removed again only
 * while still the same, empty folder (`dropIfEmpty`). A folder already there is this app's only
 * where it is a real folder, not a link, already this account's alone - on Windows its access list
 * read as owner-only, with no list left half set - holding the mark whole from this account
 * (`markedHere`), and still the same folder once all of that is read; that one is only read. An
 * empty one of this account's (on Windows holding at most an unfinished list's note) is a launch's
 * folder ended before its mark went in, and is finished as one made now.
 */
async function keepProfilesFolder(
  path: string,
  platform: NodeJS.Platform,
  access: AccessRun,
): Promise<ProfilesFolder | "not-ours" | null> {
  let made: Stats;
  let fresh = true;
  try {
    mkdirSync(path, { mode: 0o700 });
    made = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const found = entryOf(path);
    if (found === null || !found.isDirectory() || found.isSymbolicLink()) return "not-ours";
    if (!(await unfinished(path, found, platform, access))) {
      if (!(await aloneNow(path, found, platform, access))) return "not-ours";
      if (!(await markedHere(path, platform, access))) return "not-ours";
      const still = entryOf(path);
      return still !== null && sameMade(still, found) ? { path, made: found } : "not-ours";
    }
    made = found;
    fresh = false;
  }
  const alone =
    platform === "win32"
      ? (await keepOwnerOnly([path], access)).kept[0]?.kind === "owner-only"
      : made.uid === process.getuid?.() && (made.mode & 0o077) === 0;
  const still = entryOf(path);
  if (!alone || still === null || !sameMade(still, made)) {
    if (fresh) dropIfEmpty(path, made);
    return fresh ? null : "not-ours";
  }
  try {
    writeFileSync(join(path, WORD_PROFILES_RESERVED), WORD_PROFILES_MARK, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (!fresh) return "not-ours";
    dropIfEmpty(path, made);
    throw error;
  }
  return { path, made };
}

/**
 * Whether a folder already there is one a launch made and ended before marking: this account's,
 * holding nothing - on Windows, at most the note of an access list left half set - and, away from
 * Windows, already this account's alone, as a launch makes it.
 */
async function unfinished(
  path: string,
  found: Stats,
  platform: NodeJS.Platform,
  access: AccessRun,
): Promise<boolean> {
  let names: string[];
  try {
    names = readdirSync(path);
  } catch {
    return false;
  }
  if (platform !== "win32")
    return names.length === 0 && found.uid === process.getuid?.() && (found.mode & 0o077) === 0;
  if (names.some((name) => name !== UNFINISHED_MARK)) return false;
  const answer = await access({ set: [], read: [path] });
  const sddl = answer.read[0]?.sddl;
  return !!sddl && readAccessList(sddl).owner === answer.user;
}

/** Removes a folder this launch made while it is still that folder and still empty, never more. */
function dropIfEmpty(path: string, made: Stats): void {
  const now = entryOf(path);
  if (now === null || !now.isDirectory() || !sameMade(now, made)) return;
  try {
    rmdirSync(path);
  } catch (error) {
    console.warn(
      `[app] left a word's profiles' folder it could not finish: ${(error as Error).message}`,
    );
  }
}

/** Whether a folder already there is this account's alone, read without changing it. */
async function aloneNow(
  path: string,
  found: Stats,
  platform: NodeJS.Platform,
  access: AccessRun,
): Promise<boolean> {
  if (platform !== "win32") return found.uid === process.getuid?.() && (found.mode & 0o077) === 0;
  if (entryOf(join(path, UNFINISHED_MARK)) !== null) return false;
  const answer = await access({ set: [], read: [path] });
  const sddl = answer.read[0]?.sddl;
  return !!sddl && ownerOnlyVerdict(readAccessList(sddl), answer.user) === "owner-only";
}

/**
 * Whether a folder holds the mark whole (`isProfilesMark`) in a file only this account could have
 * written: away from Windows one it owns, on Windows one whose own access list, read without
 * changing it, lets no other ordinary account in (`onlyOwnerReaches`).
 */
async function markedHere(
  path: string,
  platform: NodeJS.Platform,
  access: AccessRun,
): Promise<boolean> {
  const mark = join(path, WORD_PROFILES_RESERVED);
  if (!isProfilesMark(mark, platform)) return false;
  if (platform !== "win32") return true;
  const answer = await access({ set: [], read: [mark] });
  const sddl = answer.read[0]?.sddl;
  return !!sddl && onlyOwnerReaches(readAccessList(sddl), answer.user);
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

/** Whether the profiles' folder is still the one this launch reserved. */
const stillReserved = (folder: ProfilesFolder) => {
  const now = entryOf(folder.path);
  return now !== null && now.isDirectory() && sameMade(now, folder.made);
};

/**
 * Removes a profile this launch made or found ended, only while its path still names that folder,
 * by device, number and birth. It first moves the folder to a name of its own beside it
 * (`WORD_REMOVING_PREFIX`), which no other remover reads and nothing else is put at, and checks
 * again what it moved: only that folder goes, so one remover alone owns it through its removal.
 * Anything else it moved, or what of it could not be removed, stays at that name and is never put
 * back, where it could take the place of what came to its old name since.
 */
function removeIfSame(path: string, made: Stats): void {
  const now = entryOf(path);
  if (now === null || !now.isDirectory() || !sameMade(now, made)) return;
  const aside = join(dirname(path), `${WORD_REMOVING_PREFIX}${randomUUID()}`);
  try {
    renameSync(path, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      console.warn(`[app] could not remove a word's folder: ${(error as Error).message}`);
    return;
  }
  const moved = entryOf(aside);
  if (moved === null || !moved.isDirectory() || !sameMade(moved, made)) {
    console.warn("[app] a word's folder was replaced before its removal; it is left set aside");
    return;
  }
  try {
    rmSync(aside, { recursive: true, force: true });
  } catch (error) {
    console.warn(`[app] could not remove a word's folder: ${(error as Error).message}`);
  }
}

/** A folder this launch made or read, still the same: its device, number and birth. */
const sameMade = (a: Stats, b: Stats) => sameEntry(a, b) && a.birthtimeMs === b.birthtimeMs;

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
function reclaimWordProfiles(folder: ProfilesFolder): void {
  const root = folder.path;
  if (!stillReserved(folder)) return;
  let names: string[];
  try {
    names = readdirSync(root).filter((name) => name.startsWith(WORD_PROFILE_PREFIX));
  } catch {
    return;
  }
  for (const name of names) {
    const profile = join(root, name);
    const found = entryOf(profile);
    if (found === null || !found.isDirectory()) continue;
    const owner = profileOwner(profile);
    if (owner === null || !processGone(owner.pid)) continue;
    // The same folder and the same whole owner file, read again just before it goes: a profile
    // where either was replaced or changed since is left as it is.
    const now = entryOf(profile);
    if (now === null || !now.isDirectory() || !sameMade(now, found)) continue;
    const still = profileOwner(profile);
    if (still === null || still.pid !== owner.pid || !sameEntry(still, owner)) continue;
    removeIfSame(profile, found);
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
  const folder = profiles === null ? null : await ownProfilesFolder(profiles, hostPlatform());
  if (folder === null) return "unshown";
  if (signal?.aborted) return null;
  reclaimWordProfiles(folder);
  const profile = join(folder.path, `${WORD_PROFILE_PREFIX}${randomUUID()}`);
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
    // Made in the folder this launch reserved, and in no other put in its place.
    if (!stillReserved(folder)) throw new Error("its profiles' folder was replaced");
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
