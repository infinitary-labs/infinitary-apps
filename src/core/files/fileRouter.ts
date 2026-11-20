import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { HOME } from "@shared/deviceNames";
import {
  FILES_COMMAND,
  type FileListing,
  type FileOrderChannel,
  type FileSnapshot,
  type FilesAnswer,
  fileListingSchema,
  fileOrders,
  fileSnapshotSchema,
} from "@shared/files";
import { LOCAL_MACHINE_ID } from "../session/session";
import type { FileReach } from "./fileReach";
import type { TaskFiles } from "./taskFiles";

/**
 * The home's side of the files command (docs/files.md): it answers every
 * task's list and copy, whatever computer the task runs on. A file on the
 * home is read here; one on a computer that runs work is read there by
 * order, piece by piece, and checked here against its sha256. The copy
 * then goes into the task's hand-over folder on the computer the task runs
 * on, verified again there, and one line on the task's record names the
 * computer and the path. It only reads: nothing is written onto the
 * computer a file came from.
 */

/** A computer that runs work, as the files command names it. */
export type FileComputer = {
  /** Its device id. */
  id: string;
  /** Its name, as the crewmate's computers paragraph gives it. */
  name: string;
  inReach: boolean;
  /** It answers the file orders. */
  answers: boolean;
  /**
   * It runs as another macOS user on the home's own Mac: a home file its
   * tasks copy is read there, as that user, so they reach only what that
   * user can read itself, never the captain's private folders (`reader`).
   */
  onThisMac: boolean;
};

export type FileRouterOptions = {
  /** The home's own files. */
  here: FileReach;
  /** The home's own name, once read; the command takes `home` too. */
  homeName: () => string | undefined;
  /** The computers that run work on the list. */
  computers: () => readonly FileComputer[];
  /** Asks a computer that runs work one file order. */
  ask: (machine: string, channel: FileOrderChannel, args: unknown) => Promise<unknown>;
  /** The computer a task runs on: `local`, or its device id. */
  machineOf: (taskId: string) => string;
  /** Why a task cannot take a file into its hand-over folder now; undefined when it can. */
  refusal: (taskId: string) => string | undefined;
  /** Delivers a verified copy into the task's hand-over folder, wherever it runs. */
  deliver: (
    taskId: string,
    path: string,
    name: string,
    sha256: string,
  ) => Promise<{ file: string; path: string }>;
  /** One line on the task's record. */
  note: (taskId: string, text: string) => void;
  /** The home's own folder for a file it read from another computer, before delivery. */
  stagingDir: string;
};

/** A computer the command can name: the home, or one that runs work. */
type Source = { id: string; name: string };

/** The computer that reads a file for a task, the path it reads, and whether it reads as another user here. */
type Reader = { machine: string; path: string; asAnotherUser: boolean };

/** Words a crewmate reads as the command's refusal. */
class Refused extends Error {}

const HOME_ALIAS = "home";

/** A name as the command matches it: letters and digits only, any case. */
function plain(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * `<computer>:<path>` split at the colon that starts its path - the first
 * one followed by `/`, `~` or nothing - so a name may hold a colon too.
 */
export function splitTarget(target: string): { computer: string; path: string } | undefined {
  const trimmed = target.trim();
  for (let at = trimmed.indexOf(":"); at >= 0; at = trimmed.indexOf(":", at + 1)) {
    const next = trimmed[at + 1];
    if (next === undefined || next === "/" || next === "~") {
      const computer = trimmed.slice(0, at).trim();
      if (!computer) return undefined;
      return { computer, path: trimmed.slice(at + 1) || "~" };
    }
  }
  return undefined;
}

function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function refusedAnswer(error: unknown): FilesAnswer {
  const message = error instanceof Error ? error.message : String(error);
  return { text: message, refused: "refused" };
}

export class FileRouter {
  private emptied: Promise<void> | undefined;

  constructor(private readonly options: FileRouterOptions) {}

  /** The files command for one task. */
  forTask(taskId: string): TaskFiles {
    return {
      computers: async () => ({ data: { computers: this.rows(taskId) } }),
      list: (target) => this.answer(() => this.list(taskId, target)),
      copy: (target) => this.answer(() => this.copy(taskId, target)),
    };
  }

  /**
   * Sets one file on a computer that runs work aside there, for the home to
   * read piece by piece (a card's file for the captain's Save,
   * docs/card-authoring.md "Files for the captain"). Refused in words when
   * that computer is out of reach or must be updated first.
   */
  async setAsideThere(machine: string, path: string): Promise<FileSnapshot> {
    const computer = this.options.computers().find((one) => one.id === machine);
    if (!computer) throw new Refused("The computer that keeps this file is no longer on the list.");
    if (!computer.inReach)
      throw new Refused(
        `${computer.name} keeps this file and is out of reach now; save it again once it is back.`,
      );
    if (!computer.answers)
      throw new Refused(
        `Infinitary on ${computer.name} must be updated before this file can be saved.`,
      );
    return fileSnapshotSchema.parse(
      await this.options.ask(machine, "inf:files:snapshot", [{ path }]),
    );
  }

  /** One piece of a copy set aside there, from `offset`. */
  async readThere(machine: string, id: string, offset: number): Promise<Buffer> {
    const piece = fileOrders["inf:files:read"].response.parse(
      await this.options.ask(machine, "inf:files:read", [{ id, offset }]),
    );
    if (piece.offset !== offset) throw new Refused("The copy stopped short; save it again.");
    return Buffer.from(piece.data, "base64");
  }

  /** Lets a copy set aside there go. */
  async releaseThere(machine: string, id: string): Promise<void> {
    await this.options.ask(machine, "inf:files:release", [{ id }]).catch(() => undefined);
  }

  private async answer(run: () => Promise<FilesAnswer>): Promise<FilesAnswer> {
    try {
      return await run();
    } catch (error) {
      return refusedAnswer(error);
    }
  }

  /** Every computer the command may name, with whether it is in reach and which one runs this task. */
  private rows(taskId: string): Record<string, unknown>[] {
    const runsOn = this.options.machineOf(taskId);
    return [
      {
        name: this.options.homeName() ?? HOME_ALIAS,
        role: HOME.the,
        reach: "in reach",
        thisTask: runsOn === LOCAL_MACHINE_ID,
      },
      ...this.options.computers().map((computer) => ({
        name: computer.name,
        role: "runs work",
        reach: !computer.inReach
          ? "out of reach"
          : computer.answers
            ? "in reach"
            : "needs Infinitary updated",
        thisTask: runsOn === computer.id,
      })),
    ];
  }

  private async list(taskId: string, target: string): Promise<FilesAnswer> {
    const { source, path } = this.target(taskId, target);
    const reader = await this.reader(taskId, source, path);
    const listing: FileListing =
      reader.machine === LOCAL_MACHINE_ID
        ? await this.options.here.list(reader.path)
        : fileListingSchema.parse(
            await this.options.ask(reader.machine, "inf:files:list", [{ path: reader.path }]),
          );
    if (reader.asAnotherUser) {
      // As that user resolved it, links followed; what it may not copy shows as protected.
      const closed = await this.options.here.closedToAnotherUser(listing.folder, path);
      if (closed) throw closed;
      for (const [at, entry] of listing.entries.entries()) {
        if (await this.options.here.closedToAnotherUser(join(listing.folder, entry.name)))
          listing.entries[at] = { name: entry.name, kind: "protected" };
      }
    }
    return {
      data: {
        computer: source.name,
        folder: listing.folder,
        entries: listing.entries.map((entry) => ({
          name: entry.name,
          kind: entry.kind,
          size: entry.size ?? null,
          modified: entry.modified ? new Date(entry.modified).toISOString() : null,
        })),
      },
    };
  }

  private async copy(taskId: string, target: string): Promise<FilesAnswer> {
    const { source, path } = this.target(taskId, target);
    const cannot = this.options.refusal(taskId);
    if (cannot) throw new Refused(`Nothing was copied: ${cannot}`);
    const reader = await this.reader(taskId, source, path);
    const local = reader.machine === LOCAL_MACHINE_ID;
    const snapshot: FileSnapshot = local
      ? await this.options.here.snapshot(reader.path)
      : fileSnapshotSchema.parse(
          await this.options.ask(reader.machine, "inf:files:snapshot", [{ path: reader.path }]),
        );
    let fetched: string | undefined;
    try {
      // As that user resolved it, links followed.
      const closed = reader.asAnotherUser
        ? await this.options.here.closedToAnotherUser(snapshot.path, path)
        : undefined;
      if (closed) throw closed;
      if (!local) fetched = await this.fetch({ id: reader.machine, name: source.name }, snapshot);
      const staged = fetched ?? this.options.here.stagedPath(snapshot.id);
      const name = basename(path.replace(/\/+$/, "")) || basename(snapshot.path);
      const delivered = await this.options.deliver(taskId, staged, name, snapshot.sha256);
      this.options.note(
        taskId,
        `copied ${snapshot.path} from ${source.name} into its hand-over folder (${sizeWords(snapshot.size)})`,
      );
      return {
        data: {
          copied: delivered.path,
          from: `${source.name}:${snapshot.path}`,
          size: snapshot.size,
          sha256: snapshot.sha256,
          ...(snapshot.database
            ? { database: "copied through its own backup, so it is complete" }
            : {}),
        },
      };
    } finally {
      if (fetched) await rm(fetched, { force: true });
      if (local) await this.options.here.release(snapshot.id).catch(() => undefined);
      else
        await this.options
          .ask(reader.machine, "inf:files:release", [{ id: snapshot.id }])
          .catch(() => undefined);
    }
  }

  /**
   * Which computer reads a file for a task: the one the file is on, except a
   * home file for a task on a computer that runs as another macOS user on
   * the home's own Mac (`FileComputer.onThisMac`). That computer reads it as
   * its own user, so the task reaches only what that user can read itself,
   * and the home refuses it the captain's private folders and the app's own
   * sign-ins and keys (`FileReach.closedToAnotherUser`) - the reach the
   * words for adding that user promise. `~` is the home's own home folder.
   */
  private async reader(taskId: string, source: Source, path: string): Promise<Reader> {
    const runsOn = this.options.machineOf(taskId);
    const asAnotherUser =
      source.id === LOCAL_MACHINE_ID &&
      this.options.computers().some((computer) => computer.id === runsOn && computer.onThisMac);
    if (!asAnotherUser) return { machine: source.id, path, asAnotherUser };
    const closed = await this.options.here.closedToAnotherUser(path);
    if (closed) throw closed;
    return { machine: runsOn, path: this.options.here.named(path), asAnotherUser };
  }

  /** Reads a copy set aside on another computer into the home's own folder, checked against its sha256. */
  private async fetch(source: Source, snapshot: FileSnapshot): Promise<string> {
    // A copy left by an app that stopped mid-read goes before the first new one.
    this.emptied ??= (async () => {
      await rm(this.options.stagingDir, { recursive: true, force: true });
      await mkdir(this.options.stagingDir, { recursive: true, mode: 0o700 });
    })();
    await this.emptied;
    const file = join(this.options.stagingDir, randomUUID());
    const handle = await open(file, "wx", 0o600);
    const hash = createHash("sha256");
    let offset = 0;
    try {
      while (offset < snapshot.size) {
        const piece = fileOrders["inf:files:read"].response.parse(
          await this.options.ask(source.id, "inf:files:read", [{ id: snapshot.id, offset }]),
        );
        const bytes = Buffer.from(piece.data, "base64");
        if (piece.offset !== offset || bytes.length === 0)
          throw new Refused(`The copy from ${source.name} stopped short; ask for it again.`);
        await handle.write(bytes, 0, bytes.length, offset);
        hash.update(bytes);
        offset += bytes.length;
      }
    } catch (error) {
      await handle.close();
      await rm(file, { force: true });
      throw error;
    }
    await handle.close();
    if (offset !== snapshot.size || hash.digest("hex") !== snapshot.sha256) {
      await rm(file, { force: true });
      throw new Refused(`The copy from ${source.name} did not arrive whole; ask for it again.`);
    }
    return file;
  }

  /** The computer and path a target names, refused when it names none or the task's own computer. */
  private target(taskId: string, target: string): { source: Source; path: string } {
    const split = splitTarget(target);
    if (!split)
      throw new Refused(
        `Name a computer and a path, such as ${HOME_ALIAS}:~/Documents; run ${FILES_COMMAND} for the computers' names.`,
      );
    const source = this.source(split.computer);
    if (source.id === this.options.machineOf(taskId))
      throw new Refused(
        `${split.path} is on ${source.name}, where this task runs: read it there with your own tools.`,
      );
    return { source, path: split.path };
  }

  /** The computer a crewmate named: by its name in any case and spacing, or `home`. */
  private source(named: string): Source {
    const homeName = this.options.homeName();
    const home = { id: LOCAL_MACHINE_ID, name: homeName ?? HOME_ALIAS };
    const computers = this.options.computers();
    const want = plain(named);
    const matches = [
      ...(want === HOME_ALIAS || (homeName && plain(homeName) === want) ? [home] : []),
      ...computers.filter((computer) => plain(computer.name) === want || computer.id === named),
    ];
    if (matches.length === 0) {
      const names = [home.name, ...computers.map((computer) => computer.name)].join(", ");
      throw new Refused(`No computer is called ${named}: name one of ${names}.`);
    }
    if (matches.length > 1)
      throw new Refused(
        `More than one computer is called ${named}: ${matches.map((one) => one.name).join(", ")}.`,
      );
    const [match] = matches as [Source];
    const computer = computers.find((one) => one.id === match.id);
    if (computer && !computer.inReach)
      throw new Refused(`${computer.name} is out of reach now; ask again once it is back.`);
    if (computer && !computer.answers)
      throw new Refused(
        `Infinitary on ${computer.name} must be updated before its files can be read.`,
      );
    return match;
  }
}
