import { open } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  CARD_FILE_PIECE_BYTES,
  type CardFile,
  type CardFilePiece,
  cardFileStoredName,
  cardFileTask,
} from "@shared/cardFiles";
import type { Card } from "@shared/cards";
import type { FileSnapshot } from "@shared/files";
import { type AppPaths, crewmateCardPicturesDir } from "../paths";
import type { FileRouter } from "./fileRouter";

/**
 * The home's side of saving a card's file (docs/card-authoring.md, "Files for
 * the captain"): a window whose Save the captain clicked asks for the file a
 * piece at a time (`inf:cards:file`), and this reads it from wherever its kept
 * copy is - the home's own card copies, or a computer that runs work, where
 * it is set aside and read by the file orders (docs/files.md). Nothing is
 * read before that click, and nothing is kept here once the last piece is
 * served. A file may hold secrets: nothing here reads it into words or a log.
 */

/** How long a copy set aside on another computer waits for the next piece before it is let go. */
const IDLE_RELEASE_MS = 2 * 60 * 1000;

type Reading = {
  machine: string;
  snapshot: Promise<FileSnapshot>;
  /** The last piece read from that computer, which serves several smaller pieces. */
  held?: { offset: number; data: Buffer };
  timer?: ReturnType<typeof setTimeout>;
};

export type CardFileReadsOptions = {
  /** A card by id, open or closed. */
  card: (cardId: string) => Card | undefined;
  /** The home's own folder of a task's card copies. */
  localDir: (taskId: string) => string;
  /** Reads a file on a computer that runs work. */
  router: Pick<FileRouter, "setAsideThere" | "readThere" | "releaseThere">;
};

/** Why a Save found no kept copy: that task's card copies went with its folder. */
function goneWords(name: string): string {
  return `The app no longer keeps ${name}: its card copies were removed. Ask for the file again.`;
}

/** The home's reader, its card copies beside each task's card pictures (`createServices`). */
export function homeCardFileReads(
  card: CardFileReadsOptions["card"],
  paths: AppPaths,
  router: CardFileReadsOptions["router"],
): CardFileReads {
  return new CardFileReads({
    card,
    localDir: (taskId) => crewmateCardPicturesDir(paths, taskId),
    router,
  });
}

export class CardFileReads {
  private readonly readings = new Map<string, Reading>();

  constructor(private readonly options: CardFileReadsOptions) {}

  /** One piece of a card's file, from `offset`, with the whole file's size and sha256. */
  async piece(cardId: string, fileId: string, offset: number): Promise<CardFilePiece> {
    const file = this.options.card(cardId)?.files?.find((one) => one.id === fileId);
    if (!file) throw new Error("This card no longer carries that file.");
    if (offset > file.bytes) throw new Error("That piece is past the end of the file.");
    const data = file.computer
      ? await this.remotePiece(cardId, file, file.computer, offset)
      : await this.localPiece(file, offset);
    return {
      name: file.name,
      bytes: file.bytes,
      sha256: file.sha256,
      offset,
      data: data.toString("base64"),
    };
  }

  /** Lets every copy still set aside on another computer go. */
  async close(): Promise<void> {
    await Promise.all([...this.readings.keys()].map((key) => this.release(key)));
  }

  private async localPiece(file: CardFile, offset: number): Promise<Buffer> {
    const taskId = cardFileTask(file.id);
    if (!taskId) throw new Error("That is not a card file's name.");
    // Located from its id alone, as a picture is: the recorded path is never read here.
    const path = join(this.options.localDir(taskId), cardFileStoredName(file.id));
    const handle = await open(path, "r").catch(() => {
      throw new Error(goneWords(file.name));
    });
    try {
      const { size } = await handle.stat();
      if (size !== file.bytes)
        throw new Error(`The kept copy of ${file.name} changed. Ask for the file again.`);
      const piece = Buffer.alloc(Math.max(0, Math.min(CARD_FILE_PIECE_BYTES, size - offset)));
      if (piece.length > 0) await handle.read(piece, 0, piece.length, offset);
      return piece;
    } finally {
      await handle.close();
    }
  }

  private async remotePiece(
    cardId: string,
    file: CardFile,
    machine: string,
    offset: number,
  ): Promise<Buffer> {
    if (basename(file.path) !== cardFileStoredName(file.id))
      throw new Error("That is not a card file's kept copy.");
    const key = `${cardId}\u0000${file.id}`;
    let reading = this.readings.get(key);
    // A save starts at the beginning: it gets a fresh copy set aside.
    if (reading && offset === 0) {
      await this.release(key);
      reading = undefined;
    }
    if (!reading) {
      const fresh: Reading = {
        machine,
        snapshot: this.options.router.setAsideThere(machine, file.path).catch((caught) => {
          // That computer's refusal names its own folder; the captain is told what it means.
          if (
            caught instanceof Error &&
            caught.message.includes(`There is nothing at ${file.path}.`)
          )
            throw new Error(goneWords(file.name));
          throw caught;
        }),
      };
      reading = fresh;
      this.readings.set(key, fresh);
      fresh.snapshot.catch(() => {
        if (this.readings.get(key) === fresh) this.readings.delete(key);
      });
    }
    this.keepAlive(key, reading);
    const snapshot = await reading.snapshot;
    if (snapshot.size !== file.bytes || snapshot.sha256 !== file.sha256) {
      await this.release(key);
      throw new Error(`The kept copy of ${file.name} changed. Ask for the file again.`);
    }
    const length = Math.min(CARD_FILE_PIECE_BYTES, file.bytes - offset);
    if (length <= 0) {
      await this.release(key);
      return Buffer.alloc(0);
    }
    let held = reading.held;
    if (!held || offset < held.offset || offset + length > held.offset + held.data.length) {
      const data = await this.options.router.readThere(machine, snapshot.id, offset);
      if (data.length < length) {
        await this.release(key);
        throw new Error(`The copy of ${file.name} stopped short; save it again.`);
      }
      held = { offset, data };
      reading.held = held;
    }
    const from = offset - held.offset;
    const piece = Buffer.from(held.data.subarray(from, from + length));
    // The last piece lets the copy go.
    if (offset + length >= file.bytes) await this.release(key);
    return piece;
  }

  private keepAlive(key: string, reading: Reading): void {
    if (reading.timer) clearTimeout(reading.timer);
    reading.timer = setTimeout(() => void this.release(key), IDLE_RELEASE_MS);
    reading.timer.unref?.();
  }

  private async release(key: string): Promise<void> {
    const reading = this.readings.get(key);
    if (!reading) return;
    this.readings.delete(key);
    if (reading.timer) clearTimeout(reading.timer);
    const snapshot = await reading.snapshot.catch(() => undefined);
    if (snapshot) await this.options.router.releaseThere(reading.machine, snapshot.id);
  }
}
