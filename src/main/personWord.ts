import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { hostEnv } from "@core/hostEnv";
import { hostPlatform } from "@core/platform";
import {
  type AccessRun,
  keepsToOwner,
  powerShellAccess,
  readAccessList,
} from "@core/storage/ownerOnly";
import { readLinuxInstallation } from "@core/update/linuxInstall";
import * as m from "@shared/i18n/messages.generated";
import { languageOverride, startLanguage } from "@shared/i18n/start";
import { isWordProfileName, WORD_PROFILE_PREFIX, WORD_RECORDS } from "@shared/wordProfiles";
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
 * it holds alone, so it touches nothing else there: one the app made and
 * recorded as its own, never one it found.
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
 * The profile a word's copy uses, kept in the data folder with its temporary folder in it: the one
 * the first record the app can read names (`WORD_RECORDS`), where it is still a real folder of this
 * account's alone; or, where that record names none or one no longer so, a new one made under a
 * name no one else chose (`WORD_PROFILE_PREFIX`) with no access for anyone else, which the record
 * then names. The record is the app's evidence the profile is its own: a folder no record names, or
 * one a record names that is not this account's alone, is never used, and anything at a record's
 * name the app did not write is left as it is and the next name is tried; null where none is left.
 * Nothing is ever moved or removed, and only a folder the app made is ever written in, so the app
 * changes nothing but what it made in its own folder. Whether the folders let anyone else in by an
 * access list, which modes do not show, is judged as the copy starts (`keptToOwner`).
 */
export function wordProfileIn(dataDir: string, platform: NodeJS.Platform): string | null {
  for (const name of WORD_RECORDS) {
    const record = join(dataDir, name);
    const found = readRecord(record);
    if (found.kind === "else") {
      console.warn("[app] a word's profile's record holds something else; it is left alone");
      continue;
    }
    if (found.kind === "ours") {
      const profile = join(dataDir, found.profile);
      if (ownFolder(profile, platform) && ownFolder(join(profile, WORD_TEMP_DIR), platform, true))
        return profile;
      console.warn(
        "[app] the profile a word's record names is gone or not private; it is left alone",
      );
    }
    const made = makeProfile(dataDir, platform);
    if (made !== null) writeRecord(record, basename(made));
    return made;
  }
  return null;
}

/** What is at a record's name: nothing, the app's record of a profile, or something else. */
type FoundRecord = { kind: "none" } | { kind: "ours"; profile: string } | { kind: "else" };

/** How long a record may be: one profile's name, said in the record's one form. */
const RECORD_BYTES = 128;

/**
 * Reads a record without following a link or waiting on what is not a file: the app's own only
 * when it is a small file of this account's holding exactly `{"profile": <a profile's name>}`.
 */
function readRecord(path: string): FoundRecord {
  try {
    if (lstatSync(path).isSymbolicLink()) return { kind: "else" };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "none" } : { kind: "else" };
  }
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch {
    return { kind: "else" };
  }
  try {
    const found = fstatSync(fd);
    if (!found.isFile() || found.size > RECORD_BYTES) return { kind: "else" };
    if (process.getuid && found.uid !== process.getuid()) return { kind: "else" };
    const bytes = Buffer.alloc(RECORD_BYTES + 1);
    const read = readSync(fd, bytes, 0, bytes.length, 0);
    const parsed: unknown = JSON.parse(bytes.subarray(0, read).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return { kind: "else" };
    const keys = Object.keys(parsed);
    const profile = (parsed as { profile?: unknown }).profile;
    return keys.length === 1 && typeof profile === "string" && isWordProfileName(profile)
      ? { kind: "ours", profile }
      : { kind: "else" };
  } catch {
    return { kind: "else" };
  } finally {
    closeSync(fd);
  }
}

/**
 * Names `profile` in the record: written whole beside it under a name of this launch's own, then
 * put in its place in one rename, so a record is never read half written. One that cannot be
 * written leaves the profile used this once.
 */
function writeRecord(record: string, profile: string): void {
  const staged = `${record}.${process.pid}-${randomBytes(4).toString("hex")}`;
  let made = false;
  try {
    writeFileSync(staged, JSON.stringify({ profile }), { flag: "wx", mode: 0o600 });
    made = true;
    renameSync(staged, record);
  } catch {
    console.warn("[app] could not record a word's profile; it is used this once");
    if (made) rmSync(staged, { force: true });
  }
}

/** A new profile and its temporary folder, made where nothing was, or null where it could not be. */
function makeProfile(dataDir: string, platform: NodeJS.Platform): string | null {
  let profile: string;
  try {
    profile = mkdtempSync(join(dataDir, WORD_PROFILE_PREFIX));
  } catch {
    return null;
  }
  return ownFolder(profile, platform) && ownFolder(join(profile, WORD_TEMP_DIR), platform, true)
    ? profile
    : null;
}

/**
 * Whether `path` is a real folder of this account's with no access for anyone else by its mode,
 * never a link; with `make`, made so first where nothing is.
 */
function ownFolder(path: string, platform: NodeJS.Platform, make = false): boolean {
  if (make)
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
 * Whether the folders keep to this account by their access lists too, which modes do not show: on
 * Windows each read whole, letting in no one else and handing that down to all made in it
 * (`keepsToOwner`); on a Mac with no access list entry that allows anything; elsewhere the modes
 * `ownFolder` read say it all. Anything not read is not private.
 */
export async function keptToOwner(
  paths: readonly string[],
  platform: NodeJS.Platform,
  access: AccessRun = powerShellAccess,
): Promise<boolean> {
  if (platform === "win32") {
    try {
      const answer = await access({ set: [], read: paths });
      // Matched to what was asked by their order, never by the path printed back.
      return paths.every((_, index) => {
        const sddl = answer.read[index]?.sddl;
        return Boolean(sddl) && keepsToOwner(readAccessList(sddl as string), answer.user);
      });
    } catch {
      return false;
    }
  }
  if (platform === "darwin") {
    const listed = await new Promise<string | null>((resolve) =>
      execFile("/bin/ls", ["-lde", ...paths], { env: hostEnv(), encoding: "utf8" }, (error, out) =>
        resolve(error ? null : out),
      ),
    );
    return listed !== null && !/^\s*\d+: .*\ballow\b/m.test(listed);
  }
  return true;
}

/**
 * Asks in turn: each ask starts once the one before it has answered, whether it answered or
 * failed, so a word taken away has let its copy's profile go before the next word's copy starts.
 */
export function oneWordAtATime(): <T>(ask: () => Promise<T>) => Promise<T> {
  let before: Promise<unknown> = Promise.resolve();
  return (ask) => {
    const now = before.then(ask, ask);
    before = now.catch(() => {});
    return now;
  };
}

/**
 * Shows a word through a copy of this program (`showPersonWord`) and gives its reply (`readReply`)
 * once the copy has ended and said all it had: null where the word was taken away (`signal`),
 * which ends that copy and its box and answers once the copy has ended and let its profile go, so a
 * word shown next can take it; and unshown where the copy could not be started or show its box, or
 * where its profile has no private place (`dataDir` null, as `wordProfilePrivate` decides, no
 * profile the app can call its own, `wordProfileIn`, or folders an access list opens to someone
 * else, `keptToOwner`), which then starts none. The copy's input stays open while this launch
 * lives, so the copy ends with it too. The copy uses the profile kept in the data folder, with its
 * temporary files in it from its start, and takes it for itself alone as it starts
 * (`claimWordProfile`). `launcher` starts this app as it was started (`wordLauncher`); `access`
 * reads Windows' access lists.
 */
export async function askPersonWord(
  word: PersonWord,
  options: {
    launcher: { execPath: string; args: readonly string[] };
    dataDir: string | null;
    signal?: AbortSignal;
    access?: AccessRun;
  },
): Promise<PersonReply | null> {
  const { signal, dataDir } = options;
  if (signal?.aborted) return null;
  const platform = hostPlatform();
  const profile = dataDir === null ? null : wordProfileIn(dataDir, platform);
  if (profile === null) return "unshown";
  const temp = join(profile, WORD_TEMP_DIR);
  if (!(await keptToOwner([profile, temp], platform, options.access))) {
    console.warn("[app] a word's profile lets someone else in; it is left alone and not used");
    return "unshown";
  }
  if (signal?.aborted) return null;
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
      // Closing its input ends the copy on its own, should this end not reach it. Answered once
      // the copy has ended (its close), so its profile is free for the next word.
      copy.stdin?.end();
      if (!copy.kill()) console.warn("[app] could not end a word taken away; it ends on its own");
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
      settle(signal?.aborted ? null : "unshown");
    });
    // Close, not exit: only once the copy's output is all read, or after a start that failed.
    copy.once("close", (code, ended) => {
      settle(signal?.aborted ? null : readReply(word, said, code, ended));
    });
  });
}
