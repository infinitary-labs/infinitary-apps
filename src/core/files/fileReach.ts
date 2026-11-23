import { randomUUID } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, sep } from "node:path";
import {
  FILE_PIECE_BYTES,
  type FileListing,
  type FileOrderChannel,
  type FileOrderResponse,
  type FileSnapshot,
  fileOrders,
} from "@shared/files";
import { PHONE_DOOR_FOLDER } from "@shared/phoneLink";
import { USER_DATA_FOLDERS } from "@shared/userDataFolders";
import type { HostChildSpawner } from "../host";
import { hostPlatform } from "../platform";
import { sha256OfFile } from "../tasks/handoverFiles";
import {
  changedRefusal,
  FileRefusal,
  reasonOf,
  type SetAsideAnswer,
  type SetAsideChildMessage,
  type SetAsideOrder,
  type SetAsideParentMessage,
  setAsideFile,
  stillChecked,
  unreadable,
} from "./setAside";

export { FileRefusal } from "./setAside";

/**
 * One computer's own files, as the files command reads them (docs/files.md):
 * a folder's listing, and a file set aside whole while the home reads it
 * piece by piece. Every computer keeps one - the home for its own files,
 * and a computer that runs work for its, which the home asks by order.
 *
 * It follows that computer's own file permissions, and refuses the app's
 * own sign-ins and keys by place (`protectedPlaces`), links followed, so a
 * link elsewhere that points into one is refused too, and by device and
 * inode, so the same folder reached by another name is too. A file is copied
 * from the handle opened to the very file that was checked, so a link
 * swapped in after the check is refused, and before it is read, so it
 * cannot change between pieces; a database is copied through its own
 * backup, so a database in use arrives complete. The file is opened and
 * copied in a process of its own (./setAside.ts), so the app's own locks on
 * it, SQLite's on its record among them, stay held. Nothing here reads a
 * file's content into words or a log.
 */

/**
 * A set-aside copy nobody read for this long is let go: the home that asked
 * for it reads it piece by piece without pause, so one this quiet was left
 * by a home that stopped. Housekeeping of the app's own folder, never a
 * bound on what a crewmate may copy.
 */
const QUIET_COPY_MS = 10 * 60 * 1000;

/** The folders and files inside an app data folder that hold its sign-ins and keys. */
const APP_SECRET_PLACES = [
  "auth",
  "accounts",
  "forges",
  "integrations",
  "devices",
  "web-sign-ins",
  "task-channel",
  PHONE_DOOR_FOLDER,
  "pi-agent",
  "joined",
  "decisions",
];

/** The same inside the folder a computer that runs work keeps (docs/helper.md, "Where it keeps its data"). */
const WORK_SECRET_PLACES = [
  "home.json",
  "accounts",
  "claude-login.json",
  "forges",
  "pi-agent",
  "task-channel",
  "display.auth",
  "chromium",
];

/** A file by this name is a Claude client's sign-in wherever it is. */
const SIGN_IN_FILE_NAMES = new Set([".credentials.json"]);

/**
 * The app's data folders, which sit side by side: both flavors of every
 * spelling, the older ones the one-time move leaves in place included
 * (docs/saved-data-compatibility.md, "The one-time move").
 */
const APP_FOLDER_NAMES = Object.values(USER_DATA_FOLDERS).flatMap((flavors) =>
  Object.values(flavors),
);

/**
 * A user's private folders, which another macOS user on the same computer
 * never reads through the files command, whatever their permissions: the
 * words for adding that user say it reads the home folder outside them
 * (the captain's pick on INF-2468).
 */
const PRIVATE_FOLDER_NAMES = ["Desktop", "Documents", "Library", ".ssh"];

export function privateFolders(home: string): string[] {
  return PRIVATE_FOLDER_NAMES.map((name) => join(home, name));
}

/**
 * The places the files command never reads on this computer: the app's own
 * sign-ins and keys, in its data folder of either flavor and in the folder
 * it runs work from, Pi's own folder, and the system's saved passwords.
 * `userData` is the app's data folder here; `workDir`, the folder it runs
 * work from when it is not `userData/work`.
 */
export function protectedPlaces(input: {
  userData: string;
  home: string;
  workDir?: string;
}): string[] {
  const appFolders = new Set([
    input.userData,
    ...APP_FOLDER_NAMES.map((name) => join(dirname(input.userData), name)),
  ]);
  const places = [...appFolders].flatMap((folder) => [
    ...APP_SECRET_PLACES.map((name) => join(folder, name)),
    ...WORK_SECRET_PLACES.map((name) => join(folder, "work", name)),
  ]);
  const { workDir } = input;
  if (workDir) places.push(...WORK_SECRET_PLACES.map((name) => join(workDir, name)));
  places.push(
    join(input.home, ".pi"),
    join(input.home, "Library", "Keychains"),
    join(input.home, ".local", "share", "keyrings"),
  );
  return [...new Set(places)];
}

export type FileReachOptions = {
  /** That computer's user's home folder, which `~` names. */
  home: string;
  /** Absolute places refused, with everything inside them (`protectedPlaces`). */
  protectedPlaces: readonly string[];
  /**
   * This computer's user's private folders (`privateFolders`), refused with
   * everything inside them to another macOS user here (`closedToAnotherUser`).
   */
  privatePlaces?: readonly string[];
  /** The app's own folder for set-aside copies, emptied when this opens. */
  stagingDir: string;
  /** Whether names compare without case, as a Mac's own disk does. */
  caseInsensitive?: boolean;
  /**
   * Starts the process each file is set aside in (./setAsideProcess.ts).
   * Absent, a file is set aside in this process, whose closing of its handle
   * drops every lock this process holds on that file - SQLite's on a
   * database it has open among them - so only a test whose process holds no
   * lock on the files it copies leaves it out.
   */
  setAsideProcess?: HostChildSpawner;
  now?: () => number;
};

type SetAside = { file: string; size: number; touched: number };

export class FileReach {
  private readonly copies = new Map<string, SetAside>();
  private readonly now: () => number;
  private readonly caseInsensitive: boolean;
  private protectedReal: Promise<string[]> | undefined;
  private privateReal: Promise<string[]> | undefined;
  private emptied: Promise<void> | undefined;

  constructor(private readonly options: FileReachOptions) {
    this.now = options.now ?? Date.now;
    this.caseInsensitive =
      options.caseInsensitive ?? (hostPlatform() === "darwin" || hostPlatform() === "win32");
  }

  /** Answers one order from the home (`fileOrders`). */
  async answer<C extends FileOrderChannel>(
    channel: C,
    args: unknown,
  ): Promise<FileOrderResponse<C>> {
    switch (channel) {
      case "inf:files:list": {
        const [{ path }] = fileOrders["inf:files:list"].request.parse(args);
        return (await this.list(path)) as FileOrderResponse<C>;
      }
      case "inf:files:snapshot": {
        const [{ path }] = fileOrders["inf:files:snapshot"].request.parse(args);
        return (await this.snapshot(path)) as FileOrderResponse<C>;
      }
      case "inf:files:read": {
        const [{ id, offset }] = fileOrders["inf:files:read"].request.parse(args);
        return (await this.read(id, offset)) as FileOrderResponse<C>;
      }
      case "inf:files:release": {
        const [{ id }] = fileOrders["inf:files:release"].request.parse(args);
        await this.release(id);
        return { ok: true } as FileOrderResponse<C>;
      }
      default:
        throw new Error(`${channel} is not a request this computer answers.`);
    }
  }

  /** One folder's names, with each one's kind, size and when it changed; the app's own sign-ins marked. */
  async list(path: string): Promise<FileListing> {
    const { real: folder, checked } = await this.resolve(path);
    if (!checked.isDirectory())
      throw new FileRefusal(`${path} is a file, not a folder: copy it with get.`);
    let names: Dirent[];
    try {
      names = await readdir(folder, { withFileTypes: true });
    } catch (error) {
      throw new FileRefusal(`${path} could not be read: ${reasonOf(error)}.`);
    }
    // Its names were read by its path, so it must still be the folder checked.
    await stillChecked(path, folder, checked);
    const entries: FileListing["entries"] = [];
    for (const entry of names.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(folder, entry.name);
      if (await this.isProtected(full)) {
        entries.push({ name: entry.name, kind: "protected" });
        continue;
      }
      const facts = await lstat(full).catch(() => undefined);
      const kind = entry.isSymbolicLink()
        ? "link"
        : entry.isDirectory()
          ? "folder"
          : entry.isFile()
            ? "file"
            : "other";
      entries.push({
        name: entry.name,
        kind,
        ...(kind === "file" && facts ? { size: facts.size } : {}),
        ...(facts ? { modified: Math.round(facts.mtimeMs) } : {}),
      });
    }
    return { folder, entries };
  }

  /**
   * Sets one file aside whole: copied into the app's own folder (a database
   * through its backup), made 0600, and named by its size and sha256. The
   * copy waits for the home to read it, until released.
   */
  async snapshot(path: string): Promise<FileSnapshot> {
    const { real: file, checked } = await this.resolve(path);
    if (checked.isDirectory()) throw new FileRefusal(`${path} is a folder: list it with ls.`);
    if (!checked.isFile()) throw new FileRefusal(`${path} is not a file the command can copy.`);
    await this.sweep();
    const id = randomUUID();
    const staged = join(await this.staging(), id);
    const { database } = await this.setAside({
      path,
      file,
      checked: { dev: checked.dev, ino: checked.ino },
      to: staged,
    }).catch(async (error: unknown) => {
      await rm(staged, { force: true });
      if (error instanceof FileRefusal) throw error;
      throw new FileRefusal(`${path} could not be copied: ${reasonOf(error)}.`);
    });
    const size = (await stat(staged)).size;
    const sha256 = await sha256OfFile(staged);
    this.copies.set(id, { file: staged, size, touched: this.now() });
    return { id, path: file, size, sha256, ...(database ? { database: true } : {}) };
  }

  /**
   * Sets one checked file aside (`setAsideFile`): in a process of its own
   * when this one has `setAsideProcess`, which is started for the one file
   * and stopped once it answers.
   */
  private setAside(order: SetAsideOrder): Promise<SetAsideAnswer> {
    const spawner = this.options.setAsideProcess;
    if (!spawner) return setAsideFile(order);
    return new Promise((resolve, reject) => {
      const child = spawner.spawn();
      let answered = false;
      child.onMessage((raw) => {
        if (answered) return;
        answered = true;
        child.kill();
        const message = raw as SetAsideChildMessage;
        if (message.type === "set") resolve({ database: message.database });
        else if (message.type === "refused") reject(new FileRefusal(message.words));
        else reject(new Error(message.message));
      });
      child.onExit(() => {
        if (answered) return;
        answered = true;
        reject(new Error("the process copying it stopped before it finished"));
      });
      const message: SetAsideParentMessage = { type: "set-aside", order };
      child.postMessage(message);
    });
  }

  /** Where a set-aside copy is on this computer, for the home's own copies. */
  stagedPath(id: string): string {
    const copy = this.copies.get(id);
    if (!copy) throw new FileRefusal("That copy was let go; ask for the file again.");
    copy.touched = this.now();
    return copy.file;
  }

  async read(id: string, offset: number): Promise<FileOrderResponse<"inf:files:read">> {
    const file = this.stagedPath(id);
    const handle = await open(file, "r");
    try {
      const size = (await handle.stat()).size;
      const piece = Buffer.alloc(Math.max(0, Math.min(FILE_PIECE_BYTES, size - offset)));
      const { bytesRead } = piece.length
        ? await handle.read(piece, 0, piece.length, offset)
        : { bytesRead: 0 };
      return { size, offset, data: piece.subarray(0, bytesRead).toString("base64") };
    } finally {
      await handle.close();
    }
  }

  /** Lets a set-aside copy go; one already gone is gone. */
  async release(id: string): Promise<void> {
    const copy = this.copies.get(id);
    this.copies.delete(id);
    if (copy) await rm(copy.file, { force: true });
  }

  /** Lets every copy go, as this computer stops. */
  async close(): Promise<void> {
    this.copies.clear();
    await rm(this.options.stagingDir, { recursive: true, force: true });
  }

  /** A crewmate's path as this computer names it: `~` is its home folder, anything else must be absolute. */
  named(path: string): string {
    const named =
      path === "~"
        ? this.options.home
        : path.startsWith("~/")
          ? join(this.options.home, path.slice(2))
          : path;
    if (!isAbsolute(named))
      throw new FileRefusal(`Name ${path} by its full path, or from the home folder as ~/...`);
    return named;
  }

  /**
   * Why another macOS user on this computer is refused a path through the
   * files command, or undefined. That user reads it as itself, so its own
   * permissions decide what it reaches; here it is refused the app's own
   * sign-ins and keys, and anything in this computer's user's private
   * folders (`privatePlaces`), whatever their permissions. Asked of the path
   * as named and as this computer resolves it now, and again as that user
   * resolved it, links followed (`as` is the path the crewmate named).
   */
  async closedToAnotherUser(path: string, as = path): Promise<FileRefusal | undefined> {
    const named = normalize(this.named(path));
    const real = await realpath(named).catch(() => named);
    if ((await this.isProtected(named)) || (await this.isProtected(real)))
      return protectedRefusal(as);
    const places = this.options.privatePlaces ?? [];
    this.privateReal ??= this.keysOf(places);
    const keys = await this.privateReal;
    if (this.within(named, keys) || this.within(real, keys) || (await reachesPlace(real, places)))
      return privateRefusal(as);
    return undefined;
  }

  /**
   * A crewmate's path checked: links followed, and a place the app keeps its
   * sign-ins or keys in refused before anything is read. Answers the real
   * path and what it named when checked, which every read after must still
   * find there (`stillChecked`).
   */
  private async resolve(path: string): Promise<{ real: string; checked: Stats }> {
    const named = this.named(path);
    if (await this.isProtected(normalize(named))) throw protectedRefusal(path);
    let real: string;
    try {
      real = await realpath(named);
    } catch (error) {
      throw unreadable(path, error);
    }
    if (await this.isProtected(real)) throw protectedRefusal(path);
    let checked: Stats;
    try {
      checked = await lstat(real);
    } catch (error) {
      throw unreadable(path, error);
    }
    if (checked.isSymbolicLink()) throw changedRefusal(path);
    return { real, checked };
  }

  /**
   * Whether a path is one of the app's sign-ins or keys, or inside one: by
   * its name, by place, and by device and inode (`reachesPlace`).
   */
  private async isProtected(path: string): Promise<boolean> {
    if (SIGN_IN_FILE_NAMES.has(basename(path))) return true;
    this.protectedReal ??= this.keysOf(this.options.protectedPlaces);
    if (this.within(path, await this.protectedReal)) return true;
    return reachesPlace(path, this.options.protectedPlaces);
  }

  private within(path: string, places: readonly string[]): boolean {
    const key = this.key(path);
    return places.some((place) => key === place || key.startsWith(`${place}${sep}`));
  }

  /** Places, each as named and as its links resolve (`resolvedPlace`), compared as this disk compares. */
  private keysOf(places: readonly string[]): Promise<string[]> {
    return Promise.all(
      places.map(async (place) =>
        [normalize(place), await resolvedPlace(place)].map((one) => this.key(one)),
      ),
    ).then((each) => [...new Set(each.flat())]);
  }

  private key(path: string): string {
    const trimmed = path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path;
    return this.caseInsensitive ? trimmed.toLowerCase() : trimmed;
  }

  /** The app's own folder for copies, 0700, emptied once when first used. */
  private async staging(): Promise<string> {
    this.emptied ??= (async () => {
      await rm(this.options.stagingDir, { recursive: true, force: true });
      await mkdir(this.options.stagingDir, { recursive: true, mode: 0o700 });
      await chmod(this.options.stagingDir, 0o700);
    })();
    await this.emptied;
    return this.options.stagingDir;
  }

  /** Lets go of each copy the home stopped reading. */
  private async sweep(): Promise<void> {
    const now = this.now();
    for (const [id, copy] of [...this.copies]) {
      if (now - copy.touched > QUIET_COPY_MS) await this.release(id);
    }
  }
}

/**
 * Whether an existing file is one of the app's sign-ins or keys, or inside
 * one of these places (`protectedPlaces`): by its name, and by device and
 * inode for it and every folder above it, so a link or another name for one
 * is caught too. A card's files are held to it before they are copied.
 */
export async function isProtectedFile(path: string, places: readonly string[]): Promise<boolean> {
  return SIGN_IN_FILE_NAMES.has(basename(path)) || (await reachesPlace(path, places));
}

function protectedRefusal(path: string): FileRefusal {
  return new FileRefusal(
    `${path} holds the app's own sign-ins or keys, which the files command never copies.`,
  );
}

function privateRefusal(path: string): FileRefusal {
  return new FileRefusal(
    `${path} is in a private folder - Desktop, Documents, Library or ~/.ssh - which the files command never copies for another user on the same computer.`,
  );
}

/**
 * Whether a path, or a folder above it, is one of these places by device
 * and inode. A folder has more than one path - macOS reaches every one on
 * its data volume under /System/Volumes/Data too - so a place matched by
 * its path alone could be reached by another. Each place is looked at as
 * it is now, so one made since is found too.
 */
async function reachesPlace(path: string, places: readonly string[]): Promise<boolean> {
  const found = await Promise.all(places.map((place) => stat(place).catch(() => undefined)));
  const ids = new Set(found.flatMap((facts) => (facts ? [identityOf(facts)] : [])));
  if (ids.size === 0) return false;
  for (let at = path; ; at = dirname(at)) {
    const facts = await stat(at).catch(() => undefined);
    if (facts && ids.has(identityOf(facts))) return true;
    if (dirname(at) === at) return false;
  }
}

function identityOf(facts: Stats): string {
  return `${facts.dev}:${facts.ino}`;
}

/**
 * A place as its links resolve, through the nearest folder on it that
 * exists, so a place made after the first look still matches, under a
 * linked folder too.
 */
async function resolvedPlace(place: string): Promise<string> {
  const rest: string[] = [];
  let at = normalize(place);
  for (;;) {
    const real = await realpath(at).catch(() => undefined);
    if (real) return join(real, ...rest);
    const up = dirname(at);
    if (up === at) return normalize(place);
    rest.unshift(basename(at));
    at = up;
  }
}
