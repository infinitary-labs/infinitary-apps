import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeAll, describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { bundleSetAside } from "../../../tests/helpers/setAsideBundle";
import { forkChildProcess } from "../sql/forkChildProcess";
import { FileReach, FileRefusal } from "./fileReach";

/**
 * The files command copying the app's own record while the app runs
 * (docs/files.md, "How a copy travels"). Closing a handle to a file drops
 * every lock its process holds on that file, so a copy made in the app's
 * own process once let the next program that opened the record take it
 * over as its first opener and cut its shared memory to 3 bytes, and the
 * app's next read died by SIGBUS. Each file is now set aside in a process
 * of its own, here the real entry bundled as the app bundles it.
 */

/** Enough notes that the log's index in the shared memory runs past its first page. */
const ROWS = 3000;

let entries: { setAsideProcess: string; recordHolder: string };

beforeAll(async () => {
  entries = await bundleSetAside();
}, 60_000);

type Held = {
  copied: { name: string; file: string; size: number; sha256: string; database: boolean }[];
  opener: { rows?: number; error?: string };
  shm: number;
  read: { n: number; bytes: number };
};

function sha256Of(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

describe("the files command beside the app's own record", () => {
  it("keeps the app's connection through copies of its record, log and shared memory and a fresh opener after them", () => {
    const folder = scratchDir("infinitary-record-holder-");
    const held = spawnSync(
      process.execPath,
      [entries.recordHolder, folder, String(ROWS), entries.setAsideProcess],
      { encoding: "utf8" },
    );
    // The app's process lived on: it was not killed by SIGBUS.
    expect({ signal: held.signal, status: held.status }, held.stderr).toEqual({
      signal: null,
      status: 0,
    });
    const result = JSON.parse(held.stdout) as Held;

    // Each file arrived whole, the record through its backup with every note.
    expect(result.copied.map(({ name, database }) => ({ name, database }))).toEqual([
      { name: "firstmate.db", database: true },
      { name: "firstmate.db-wal", database: false },
      { name: "firstmate.db-shm", database: false },
    ]);
    for (const copy of result.copied) expect(sha256Of(copy.file)).toBe(copy.sha256);
    const [record] = result.copied;
    const copy = new Database(record?.file ?? "", { readonly: true, fileMustExist: true });
    expect(copy.prepare("SELECT COUNT(*) AS n FROM notes").get()).toEqual({ n: ROWS });
    copy.close();

    // The fresh opener found the app still holding the record: it read
    // every note and left the shared memory whole, and so did the app.
    expect(result.opener).toEqual({ rows: ROWS });
    expect(result.shm).toBeGreaterThanOrEqual(32 * 1024);
    expect(result.read.n).toBe(ROWS);

    // What the app wrote after the copy is in its record.
    const after = new Database(join(folder, "firstmate.db"), { readonly: true });
    expect(after.prepare("SELECT COUNT(*) AS n FROM notes").get()).toEqual({ n: ROWS + 1 });
    after.close();
  });

  it("brings a refusal from the copying process back in its own words, and a file whole", async () => {
    const folder = scratchDir("infinitary-set-aside-apart-");
    const reach = new FileReach({
      home: folder,
      protectedPlaces: [],
      stagingDir: join(folder, "set-aside"),
      setAsideProcess: forkChildProcess(entries.setAsideProcess),
    });
    writeFileSync(join(folder, "empty.txt"), "");
    const refused = reach.snapshot(join(folder, "empty.txt"));
    await expect(refused).rejects.toBeInstanceOf(FileRefusal);
    await expect(refused).rejects.toThrow(
      `${join(folder, "empty.txt")} is empty, so there is nothing to copy.`,
    );

    const notes = Buffer.from("plain notes, copied whole\n".repeat(1000));
    writeFileSync(join(folder, "notes.txt"), notes);
    const snapshot = await reach.snapshot(join(folder, "notes.txt"));
    expect(snapshot.size).toBe(notes.length);
    expect(snapshot.sha256).toBe(createHash("sha256").update(notes).digest("hex"));
    expect(readFileSync(reach.stagedPath(snapshot.id))).toEqual(notes);
    await reach.close();
  });
});
