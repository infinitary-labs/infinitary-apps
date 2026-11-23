import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { CardFile } from "@shared/cardFiles";
import type { Card } from "@shared/cards";
import type { FileSnapshot } from "@shared/files";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { keepCardFiles } from "../pi/cardFiles";
import { CardFileReads } from "./cardFileReads";
import { saveAllIntoDownloads, saveIntoDownloads } from "./downloadsSave";
import { protectedPlaces } from "./fileReach";

/**
 * Files for the captain on a card (INF-3757, direction C), under the
 * captain's condition on it: "the file content should not physically get
 * attached to the card. data transfer should only happen when user click".
 * A crewmate's card keeps a checked copy where the crewmate runs, the card
 * carries only its reference, and Save reads it piece by piece into the
 * Downloads of the computer whose window was clicked.
 */

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

/** A draft a crewmate wrote for the captain, a little over two save pieces long. */
function draft(dir: string): { path: string; data: Buffer } {
  const line = "Dear landlord, the heating in flat 4 has been off since Monday.\n";
  const data = Buffer.from(line.repeat(Math.ceil((2.5 * 1024 * 1024) / line.length)));
  const path = join(dir, "letter to the landlord.txt");
  writeFileSync(path, data);
  return { path, data };
}

function cardWith(files: CardFile[]): Card {
  return {
    id: "card-t1",
    taskId: "t1",
    author: "crewmate",
    priority: 30,
    title: "The letter is ready",
    meta: "crewmate",
    body: "<p>The letter is ready to send.</p>",
    actions: [],
    status: "ready",
    createdAt: 1,
    files,
  };
}

function workComputer() {
  const asideIds = new Map<string, string>();
  const asked: string[] = [];
  const router = {
    setAsideThere: async (_machine: string, path: string): Promise<FileSnapshot> => {
      asked.push("set aside");
      // As that computer's set-aside refuses a path with nothing there (`unreadable`).
      if (!existsSync(path)) throw new Error(`There is nothing at ${path}.`);
      const data = readFileSync(path);
      const id = `0000000${asideIds.size}-0000-4000-8000-000000000000`;
      asideIds.set(id, path);
      return { id, path, size: data.length, sha256: sha256(data) };
    },
    readThere: async (_machine: string, id: string, offset: number): Promise<Buffer> => {
      asked.push(`read ${offset}`);
      const path = asideIds.get(id);
      if (!path) throw new Error("not set aside");
      return readFileSync(path).subarray(offset, offset + 4 * 1024 * 1024);
    },
    releaseThere: async (_machine: string, id: string): Promise<void> => {
      asked.push("release");
      asideIds.delete(id);
    },
  };
  return { router, asked, asideIds };
}

describe("files for the captain on a card", () => {
  it("keeps one checked copy beside the card copies, reused by a later version of the card", async () => {
    const worktree = scratchDir("card-files-worktree-");
    const dir = join(scratchDir("card-files-crewmates-"), "t1", "cards");
    const { data } = draft(worktree);
    const root = { worktree, dir, taskId: "t1", protectedPlaces: [] };
    const [file] = await keepCardFiles(["letter to the landlord.txt"], root);
    expect(file).toEqual({
      id: `t1-${sha256(data).slice(0, 32)}`,
      name: "letter to the landlord.txt",
      bytes: data.length,
      sha256: sha256(data),
      path: join(dir, `${file?.id}.file`),
    });
    expect(sha256(readFileSync(file?.path ?? ""))).toBe(sha256(data));
    expect(statSync(file?.path ?? "").mode & 0o777).toBe(0o600);
    const again = await keepCardFiles([join(worktree, "letter to the landlord.txt")], root);
    expect(again).toEqual([file]);
    expect(readdirSync(dir)).toEqual([`${file?.id}.file`]);
  });

  it("refuses a folder, an empty file and two files of one name, naming no content", async () => {
    const worktree = scratchDir("card-files-refusals-");
    const dir = join(scratchDir("card-files-crewmates-"), "t1", "cards");
    const root = { worktree, dir, taskId: "t1", protectedPlaces: [] };
    mkdirSync(join(worktree, "drafts"));
    writeFileSync(join(worktree, "empty.txt"), "");
    writeFileSync(join(worktree, "drafts", "notes.txt"), "first");
    writeFileSync(join(worktree, "notes.txt"), "second");
    await expect(keepCardFiles(["drafts"], root)).rejects.toThrow("is not a file");
    await expect(keepCardFiles(["empty.txt"], root)).rejects.toThrow("is empty");
    await expect(keepCardFiles(["missing.txt"], root)).rejects.toThrow("there is no file");
    await expect(keepCardFiles(["notes.txt", "drafts/notes.txt"], root)).rejects.toThrow(
      "two files are named notes.txt",
    );
    await expect(keepCardFiles(["notes.txt"], undefined)).rejects.toThrow("no folder");
  });

  it("saves the home's kept copy into Downloads on Save, whole and checked", async () => {
    const worktree = scratchDir("card-files-home-");
    const crewmates = scratchDir("card-files-crewmates-");
    const { data } = draft(worktree);
    const files = await keepCardFiles(["letter to the landlord.txt"], {
      worktree,
      dir: join(crewmates, "t1", "cards"),
      taskId: "t1",
      protectedPlaces: [],
    });
    const card = cardWith(files);
    const reads = new CardFileReads({
      card: (id) => (id === card.id ? card : undefined),
      localDir: (taskId) => join(crewmates, taskId, "cards"),
      router: workComputer().router,
    });
    const downloads = join(scratchDir("card-files-downloads-"), "Downloads");
    const offsets: number[] = [];
    const saved = await saveIntoDownloads({
      folder: downloads,
      read: (offset) => {
        offsets.push(offset);
        return reads.piece(card.id, files[0]?.id ?? "", offset);
      },
    });
    expect(saved).toEqual({
      savedAs: "letter to the landlord.txt",
      path: realpathSync(join(downloads, "letter to the landlord.txt")),
    });
    expect(sha256(readFileSync(saved.path))).toBe(sha256(data));
    expect(offsets).toEqual([0, 1024 * 1024, 2 * 1024 * 1024]);
    // No part file is left behind.
    expect(readdirSync(downloads)).toEqual(["letter to the landlord.txt"]);
  });

  it("never writes over another file: the same content is the saved file, other content keeps its name", async () => {
    const worktree = scratchDir("card-files-names-");
    const crewmates = scratchDir("card-files-crewmates-");
    const { data } = draft(worktree);
    const files = await keepCardFiles(["letter to the landlord.txt"], {
      worktree,
      dir: join(crewmates, "t1", "cards"),
      taskId: "t1",
      protectedPlaces: [],
    });
    const card = cardWith(files);
    const reads = new CardFileReads({
      card: () => card,
      localDir: (taskId) => join(crewmates, taskId, "cards"),
      router: workComputer().router,
    });
    const downloads = scratchDir("card-files-downloads-");
    writeFileSync(join(downloads, "letter to the landlord.txt"), "The captain's own letter.");
    const read = (offset: number) => reads.piece(card.id, files[0]?.id ?? "", offset);
    const first = await saveIntoDownloads({ folder: downloads, read });
    expect(first.savedAs).toBe("letter to the landlord (2).txt");
    expect(readFileSync(join(downloads, "letter to the landlord.txt"), "utf8")).toBe(
      "The captain's own letter.",
    );
    expect(sha256(readFileSync(first.path))).toBe(sha256(data));
    const second = await saveIntoDownloads({ folder: downloads, read });
    expect(second).toEqual(first);
    expect(readdirSync(downloads).sort()).toEqual([
      "letter to the landlord (2).txt",
      "letter to the landlord.txt",
    ]);
  });

  it("reads a copy kept on a computer that runs work only on Save, and lets it go after the last piece", async () => {
    const worktree = scratchDir("card-files-remote-");
    const { data } = draft(worktree);
    const there = join(scratchDir("card-files-work-"), "tasks", "t1", "cards");
    const [kept] = await keepCardFiles(["letter to the landlord.txt"], {
      worktree,
      dir: there,
      taskId: "t1",
      protectedPlaces: [],
    });
    if (!kept) throw new Error("no file kept");
    const card = cardWith([{ ...kept, computer: "device-work" }]);
    const computer = workComputer();
    const reads = new CardFileReads({
      card: () => card,
      localDir: () => scratchDir("card-files-home-empty-"),
      router: computer.router,
    });
    // Showing the card reads nothing.
    expect(computer.asked).toEqual([]);
    const downloads = scratchDir("card-files-downloads-");
    const saved = await saveIntoDownloads({
      folder: downloads,
      read: (offset) => reads.piece(card.id, kept.id, offset),
    });
    expect(sha256(readFileSync(saved.path))).toBe(sha256(data));
    // One copy set aside, read in one 4 MB order, then let go.
    expect(computer.asked).toEqual(["set aside", "read 0", "release"]);
    expect(computer.asideIds.size).toBe(0);
    // Once that task's folder there goes, Save says so in words, never naming that computer's folder.
    rmSync(kept.path);
    const gone = saveIntoDownloads({
      folder: downloads,
      read: (offset) => reads.piece(card.id, kept.id, offset),
    });
    await expect(gone).rejects.toThrow(
      "The app no longer keeps letter to the landlord.txt: its card copies were removed.",
    );
    await expect(gone).rejects.not.toThrow(there);
  });

  it("never copies the app's own sign-ins or keys onto a card, whatever path names them", async () => {
    const userData = scratchDir("card-files-app-data-");
    const home = scratchDir("card-files-home-folder-");
    mkdirSync(join(userData, "accounts", "claude-1"), { recursive: true });
    writeFileSync(join(userData, "accounts", "claude-1", "auth.json"), '{"refresh":"x"}');
    symlinkSync(join(userData, "accounts"), join(home, "my accounts"));
    writeFileSync(join(home, ".credentials.json"), '{"token":"x"}');
    const root = {
      worktree: home,
      dir: join(scratchDir("card-files-crewmates-"), "t1", "cards"),
      taskId: "t1",
      protectedPlaces: protectedPlaces({ userData, home }),
    };
    await expect(
      keepCardFiles([join(userData, "accounts", "claude-1", "auth.json")], root),
    ).rejects.toThrow("holds the app's own sign-ins or keys");
    await expect(keepCardFiles(["my accounts/claude-1/auth.json"], root)).rejects.toThrow(
      "holds the app's own sign-ins or keys",
    );
    await expect(keepCardFiles([".credentials.json"], root)).rejects.toThrow(
      "holds the app's own sign-ins or keys",
    );
    expect(existsSync(root.dir) ? readdirSync(root.dir) : []).toEqual([]);
  });

  it("refuses a kept copy that changed or went away, and saves nothing", async () => {
    const worktree = scratchDir("card-files-changed-");
    const crewmates = scratchDir("card-files-crewmates-");
    draft(worktree);
    const dir = join(crewmates, "t1", "cards");
    const files = await keepCardFiles(["letter to the landlord.txt"], {
      worktree,
      dir,
      taskId: "t1",
      protectedPlaces: [],
    });
    const card = cardWith(files);
    const reads = new CardFileReads({
      card: () => card,
      localDir: (taskId) => join(crewmates, taskId, "cards"),
      router: workComputer().router,
    });
    const downloads = scratchDir("card-files-downloads-");
    const read = (offset: number) => reads.piece(card.id, files[0]?.id ?? "", offset);
    writeFileSync(files[0]?.path ?? "", "A different letter.");
    await expect(saveIntoDownloads({ folder: downloads, read })).rejects.toThrow("changed");
    writeFileSync(files[0]?.path ?? "", Buffer.alloc(files[0]?.bytes ?? 0));
    await expect(saveIntoDownloads({ folder: downloads, read })).rejects.toThrow(
      "did not arrive whole",
    );
    await expect(reads.piece(card.id, "t1-00000000000000000000000000000000", 0)).rejects.toThrow(
      "no longer carries that file",
    );
    expect(readdirSync(downloads)).toEqual([]);
    expect(existsSync(join(downloads, "letter to the landlord.txt"))).toBe(false);
  });
  /**
   * INF-4427's plan, as the captain approved it: Save all puts every file
   * "in one new folder in Downloads, named for the task", never into a
   * folder already there, each file checked as a single Save is, and a file
   * that cannot be saved is named with why while the rest still land.
   */
  it("saves every file into one new Downloads folder named for the task, never into one already there", async () => {
    const worktree = scratchDir("card-files-all-");
    const crewmates = scratchDir("card-files-crewmates-");
    const { data } = draft(worktree);
    const form = Buffer.from("Name: Sam Okafor\nFlat: 4\nRepair: boiler\n");
    writeFileSync(join(worktree, "repair form.txt"), form);
    const photo = Buffer.from("A photo of the boiler's pressure gauge reading zero.\n");
    writeFileSync(join(worktree, "boiler gauge.txt"), photo);
    const files = await keepCardFiles(
      ["letter to the landlord.txt", "repair form.txt", "boiler gauge.txt"],
      { worktree, dir: join(crewmates, "t1", "cards"), taskId: "t1", protectedPlaces: [] },
    );
    const card = cardWith(files);
    const reads = new CardFileReads({
      card: () => card,
      localDir: (taskId) => join(crewmates, taskId, "cards"),
      router: workComputer().router,
    });
    const downloads = scratchDir("card-files-downloads-");
    mkdirSync(join(downloads, "Write to the landlord - heating"));
    writeFileSync(join(downloads, "Write to the landlord - heating", "notes.txt"), "Mine.");
    const all = files.map((file) => ({
      id: file.id,
      read: (offset: number) => reads.piece(card.id, file.id, offset),
    }));
    const saved = await saveAllIntoDownloads({
      folder: downloads,
      name: "Write to the landlord / heating",
      files: all,
    });
    const folder = join(downloads, "Write to the landlord - heating (2)");
    expect(saved).toEqual({
      savedAs: "Write to the landlord - heating (2)",
      path: realpathSync(folder),
      saved: 3,
      failed: [],
    });
    expect(readdirSync(folder).sort()).toEqual([
      "boiler gauge.txt",
      "letter to the landlord.txt",
      "repair form.txt",
    ]);
    expect(sha256(readFileSync(join(folder, "letter to the landlord.txt")))).toBe(sha256(data));
    expect(sha256(readFileSync(join(folder, "repair form.txt")))).toBe(sha256(form));
    expect(readdirSync(join(downloads, "Write to the landlord - heating"))).toEqual(["notes.txt"]);

    // A kept copy that changed is named with why; the other files still land.
    writeFileSync(files[1]?.path ?? "", "A different form.");
    const again = await saveAllIntoDownloads({
      folder: downloads,
      name: "Write to the landlord / heating",
      files: all,
    });
    expect(again.savedAs).toBe("Write to the landlord - heating (3)");
    expect(again.saved).toBe(2);
    expect(again.failed).toEqual([{ id: files[1]?.id, why: expect.stringContaining("changed") }]);
    expect(readdirSync(again.path).sort()).toEqual([
      "boiler gauge.txt",
      "letter to the landlord.txt",
    ]);
  });
});
