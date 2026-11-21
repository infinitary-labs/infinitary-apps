import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { hostEnv } from "@core/hostEnv";
import { hostPlatform } from "@core/platform";
import {
  type AccessRun,
  handsDownToOthers,
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
 * then starts no copy. It goes beside the name `root` gives once every folder on the way there,
 * links resolved, is one no other account can change and the folder it goes in hands no other
 * account access to what is made there (`trustedParent`), so nothing can put another folder in its
 * place and what this app makes there is its own from its making; every later step uses that
 * resolved place. The name holds the folder's reservation (`keepProfilesFolder`); an entry already
 * at the name that is not this app's whole reservation is left exactly as it is, never changed,
 * read into or used, and the next name beside it is tried (`-2`, `-3`).
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
    for (const name of [at, `${at}-2`, `${at}-3`]) {
      const kept = await keepProfilesFolder(name, platform, access);
      if (kept !== "not-ours") return kept;
      console.warn("[app] a word's profiles' name is taken but not by this app; it is left alone");
    }
    return null;
  } catch (error) {
    console.warn(`[app] could not keep a word's profiles private: ${(error as Error).message}`);
    return null;
  }
}

/**
 * The folder `parent` names, links resolved, where it and every folder above it is one no other
 * account can change, so no other account can move or replace what it holds, and where the folder
 * itself hands no other account access to what is made in it; null otherwise. Away from Windows the
 * folder itself is this account's with no one else able to write it, and each above it belongs to
 * this account or the system with no one else able to write it, or is one where only an entry's
 * owner may move it (the sticky bit, as `/tmp`); on a Mac none of them carries an access list
 * entry that allows anything (`macAllows`), which the modes do not show. On Windows each one's
 * access list, read whole, lets no other ordinary account remove, rename or re-permit anything there
 * (`othersCanChange`), and the folder itself hands down nothing to another (`handsDownToOthers`).
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
      if (!sddl) return false;
      const list = readAccessList(sddl);
      if (othersCanChange(list, answer.user)) return false;
      return index > 0 || !handsDownToOthers(list, answer.user);
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
  if (!trusted) return null;
  return platform === "darwin" && (await macAllows(chain)) ? null : real;
}

/**
 * Whether any of these folders carries a Mac access list entry that allows something, read whole by
 * the system's own `ls`; true too where they cannot be read. Entries that only deny take nothing
 * away from what the modes say.
 */
function macAllows(folders: readonly string[]): Promise<boolean> {
  if (folders.some((path) => path.includes("\n"))) return Promise.resolve(true);
  return new Promise((resolve) => {
    execFile("/bin/ls", ["-lde", ...folders], { encoding: "utf8" }, (error, listed) => {
      if (error) resolve(true);
      else resolve(listed.split("\n").some((line) => /^ *\d+: .* allow /.test(line)));
    });
  });
}

/**
 * The profiles' folder whose reservation `name` holds, made and reserved there where nothing is.
 * A reservation is the folder's mark (`WORD_PROFILES_MARK`, in `WORD_PROFILES_RESERVED`) linked
 * at `name`: the folder is made first under a name of its own beside it (`name.<random>`), this
 * account's alone and marked whole, and only then does one hard link put that same mark at `name`,
 * which never replaces anything there. So `name` never shows a reservation half made: a launch
 * ended before the link leaves only its own folder, under a name nothing ever looks for, and the
 * next launch reserves `name` itself. Where two launches reserve at once, the one whose link lands
 * keeps it and the other uses that folder.
 */
async function keepProfilesFolder(
  name: string,
  platform: NodeJS.Platform,
  access: AccessRun,
): Promise<ProfilesFolder | "not-ours" | null> {
  const found = await reservedAt(name, platform, access);
  if (found !== "free") return found;
  const made = await makeProfilesFolder(name, platform, access);
  if (made === null) return null;
  try {
    linkSync(join(made.folder.path, WORD_PROFILES_RESERVED), name);
  } catch (error) {
    dropMade(made);
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const theirs = await reservedAt(name, platform, access);
    return theirs === "free" ? null : theirs;
  }
  const linked = entryOf(name);
  return linked !== null && sameEntry(linked, made.mark) && stillReserved(made.folder)
    ? made.folder
    : null;
}

/**
 * What `name` holds: nothing (`free`), this app's whole reservation, read without changing it, and
 * the folder it reserves, or anything else (`not-ours`). A reservation is a plain file of this
 * account's saying the mark whole (`markedHere`) that is the very file - by device and number -
 * holding the mark in a folder beside it named for it (`name.<random>`), a real folder, not a link,
 * this account's alone (`aloneNow`), and both still the same once all of that is read.
 */
async function reservedAt(
  name: string,
  platform: NodeJS.Platform,
  access: AccessRun,
): Promise<ProfilesFolder | "not-ours" | "free"> {
  const named = entryOf(name);
  if (named === null) return "free";
  if (!named.isFile()) return "not-ours";
  const mark = await markedHere(name, platform, access);
  if (mark === null) return "not-ours";
  const prefix = `${basename(name)}.`;
  for (const each of readdirSync(dirname(name))) {
    if (!each.startsWith(prefix)) continue;
    const path = join(dirname(name), each);
    const found = entryOf(path);
    if (found === null || !found.isDirectory()) continue;
    const inside = entryOf(join(path, WORD_PROFILES_RESERVED));
    if (inside === null || !sameEntry(inside, mark)) continue;
    if (!(await aloneNow(path, found, platform, access))) return "not-ours";
    const still = entryOf(path);
    const pointer = entryOf(name);
    if (still === null || !sameMade(still, found) || pointer === null) return "not-ours";
    return sameEntry(pointer, mark) ? { path, made: found } : "not-ours";
  }
  return "not-ours";
}

/**
 * Makes a profiles' folder under a name of its own beside `name`, this account's alone - made with
 * no access for anyone else, or on Windows given an owner-only access list of its own
 * (`keepOwnerOnly`) - and only then marked whole; null where it cannot be, the folder then removed
 * again only while still the same, empty folder (`dropIfEmpty`).
 */
async function makeProfilesFolder(
  name: string,
  platform: NodeJS.Platform,
  access: AccessRun,
): Promise<{ folder: ProfilesFolder; mark: Stats } | null> {
  const path = `${name}.${randomUUID()}`;
  mkdirSync(path, { mode: 0o700 });
  const folder = { path, made: lstatSync(path) };
  const alone =
    platform === "win32"
      ? (await keepOwnerOnly([path], access)).kept[0]?.kind === "owner-only"
      : folder.made.uid === process.getuid?.() && (folder.made.mode & 0o077) === 0;
  if (!alone || !stillReserved(folder)) {
    dropIfEmpty(path, folder.made);
    return null;
  }
  const markPath = join(path, WORD_PROFILES_RESERVED);
  try {
    writeFileSync(markPath, WORD_PROFILES_MARK, { flag: "wx", mode: 0o600 });
    return { folder, mark: lstatSync(markPath) };
  } catch (error) {
    dropMade({ folder, mark: null });
    throw error;
  }
}

/**
 * Removes a profiles' folder this launch made and never reserved: its own mark, while still the
 * file it wrote, then the folder while still the same and empty, never more.
 */
function dropMade(made: { folder: ProfilesFolder; mark: Stats | null }): void {
  const markPath = join(made.folder.path, WORD_PROFILES_RESERVED);
  const mark = entryOf(markPath);
  if (mark?.isFile() && (made.mark === null || sameEntry(mark, made.mark)))
    try {
      unlinkSync(markPath);
    } catch {
      // Left with the folder, which is then not empty and stays.
    }
  dropIfEmpty(made.folder.path, made.folder.made);
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
 * The file at `path` where it holds the mark whole, read to its end (`readSmallFile`), and only this
 * account could have written it: away from Windows one it owns, on Windows one whose own access
 * list, read whole without changing it, lets no other ordinary account in (`onlyOwnerReaches`);
 * null otherwise.
 */
async function markedHere(
  path: string,
  platform: NodeJS.Platform,
  access: AccessRun,
): Promise<Stats | null> {
  const mark = readSmallFile(path, Buffer.byteLength(WORD_PROFILES_MARK));
  if (mark === null || mark.text !== WORD_PROFILES_MARK) return null;
  if (platform !== "win32") return mark.file.uid === process.getuid?.() ? mark.file : null;
  const answer = await access({ set: [], read: [path] });
  const sddl = answer.read[0]?.sddl;
  return sddl && onlyOwnerReaches(readAccessList(sddl), answer.user) ? mark.file : null;
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
 * profile, in the folder `profiles` reserves (`wordProfilesBeside`, `ownProfilesFolder`), with the
 * temporary folder the copy is given from
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
        // Temporary files of its own, apart from the folder a later holder clears at its start:
        // named by every setting that chooses it, as a Mac or Linux takes `TMPDIR` first.
        {
          env: { ...hostEnv(), TEMP: temp, TMP: temp, TMPDIR: temp },
          stdio: ["pipe", "pipe", "ignore"],
        },
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
