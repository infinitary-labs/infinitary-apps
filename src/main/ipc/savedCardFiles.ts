import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import {
  type CardFileSaved,
  cardFileSavedSchema,
  cardFilesSavedSchema,
  type OpenCardFileResult,
  type SavedCardFiles,
} from "@shared/cardFiles";
import { z } from "zod";

const recordSchema = z.object({
  files: z.array(cardFileSavedSchema.extend({ id: z.string(), folder: z.string().optional() })),
  batch: cardFilesSavedSchema.extend({ ids: z.array(z.string()) }).nullable(),
});
type RecordOnDisk = z.infer<typeof recordSchema>;

/** This window host's private record; it never follows a path named by the renderer. */
export class SavedCardFileStore {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly folder: string) {}

  private path(cardId: string): string {
    return join(this.folder, `${createHash("sha256").update(cardId).digest("hex")}.json`);
  }

  private async read(cardId: string): Promise<RecordOnDisk> {
    try {
      return recordSchema.parse(JSON.parse(await readFile(this.path(cardId), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { files: [], batch: null };
    }
  }

  private update(cardId: string, change: (record: RecordOnDisk) => void): Promise<void> {
    const next = this.pending.then(async () => {
      const record = await this.read(cardId);
      change(record);
      const path = this.path(cardId);
      const part = `${path}.${randomUUID()}.tmp`;
      await mkdir(this.folder, { recursive: true, mode: 0o700 });
      try {
        await writeFile(part, JSON.stringify(record), { flag: "wx", mode: 0o600 });
        await rename(part, path);
      } finally {
        await rm(part, { force: true });
      }
    });
    this.pending = next.catch(() => {});
    return next;
  }

  remember(
    cardId: string,
    files: RecordOnDisk["files"],
    batch?: NonNullable<RecordOnDisk["batch"]>,
  ): Promise<void> {
    return this.update(cardId, (record) => {
      const ids = new Set(files.map((file) => file.id));
      record.files = [...record.files.filter((file) => !ids.has(file.id)), ...files];
      if (batch) record.batch = batch;
    });
  }

  async snapshot(cardId: string, ids: string[]): Promise<SavedCardFiles> {
    const { files, batch } = await this.read(cardId);
    const wanted = new Set(ids);
    return {
      files: files
        .filter((file) => wanted.has(file.id))
        .map(({ id, savedAs, folder }) => ({ id, savedAs, folder })),
      batch:
        batch && ids.length === batch.ids.length && batch.ids.every((id) => wanted.has(id))
          ? { savedAs: batch.savedAs, saved: batch.saved, failed: batch.failed }
          : null,
    };
  }

  async open(
    cardId: string,
    fileId: string | null,
    system: {
      openPath: (path: string) => Promise<string>;
      showItemInFolder: (path: string) => void;
    },
  ): Promise<OpenCardFileResult> {
    const record = await this.read(cardId);
    const target: CardFileSaved | null | undefined =
      fileId === null ? record.batch : record.files.find((file) => file.id === fileId);
    if (!target) return "missing";
    const stillThere = async () => {
      if (!isAbsolute(target.path)) return false;
      try {
        const info = await lstat(target.path);
        return (
          (fileId === null ? info.isDirectory() : info.isFile()) &&
          (await realpath(dirname(target.path))) === dirname(target.path)
        );
      } catch (error) {
        if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
          return false;
        throw error;
      }
    };
    const forget = async () => {
      await this.update(cardId, (latest) => {
        if (fileId === null) {
          if (latest.batch?.path === target.path) latest.batch = null;
        } else {
          latest.files = latest.files.filter(
            (file) => file.id !== fileId || file.path !== target.path,
          );
        }
      });
      return "missing" as const;
    };
    if (!(await stillThere())) return forget();
    if (!(await system.openPath(target.path))) return "opened";
    if (!(await stillThere())) return forget();
    if (fileId === null) return "failed";
    system.showItemInFolder(target.path);
    return "revealed";
  }
}
