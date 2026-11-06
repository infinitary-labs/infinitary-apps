import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { FILE_PIECE_BYTES } from "@shared/files";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { FileReach, privateFolders, protectedPlaces } from "./fileReach";

/**
 * One computer's own files as the files command reads them (docs/files.md;
 * the captain's choice: "Any file that computer's user can read, except the
 * app's own sign-ins and keys"). The relay between computers is
 * `fileRouter.test.ts`'s.
 */

/**
 * Another writer on the computer, which acts once just before the reach's
 * next call of one kind to one path: a link swapped in after the check.
 */
const writer = vi.hoisted(() => ({ before: new Map<string, () => void>() }));
vi.mock("node:fs/promises", async (load) => {
  const actual = await load<typeof import("node:fs/promises")>();
  const acting =
    <A extends unknown[], R>(name: string, call: (...args: A) => R) =>
    (...args: A): R => {
      const key = `${name}:${String(args[0])}`;
      const act = writer.before.get(key);
      writer.before.delete(key);
      act?.();
      return call(...args);
    };
  return {
    ...actual,
    open: acting("open", actual.open),
    lstat: acting("lstat", actual.lstat),
    readdir: acting("readdir", actual.readdir),
  };
});

/** Puts a link to `target` where `path` was, keeping what was there beside it. */
function swapForLink(path: string, target: string): () => void {
  return () => {
    renameSync(path, `${path}.was`);
    symlinkSync(target, path);
  };
}

function computer() {
  const home = scratchDir("infinitary-file-reach-home-");
  const userData = join(home, "Library", "Application Support", "infinitary");
  mkdirSync(join(userData, "accounts", "a1"), { recursive: true });
  writeFileSync(join(userData, "accounts", "a1", "auth.json"), "{}");
  mkdirSync(join(home, "Documents"), { recursive: true });
  const stagingDir = join(scratchDir("infinitary-file-reach-staging-"), "set-aside");
  const reach = new FileReach({
    home,
    protectedPlaces: protectedPlaces({ userData, home }),
    privatePlaces: privateFolders(home),
    stagingDir,
    caseInsensitive: true,
  });
  return { home, userData, reach, stagingDir };
}

/** Reads a set-aside copy whole, piece by piece, as the home does. */
async function readWhole(reach: FileReach, id: string, size: number): Promise<Buffer> {
  const pieces: Buffer[] = [];
  let offset = 0;
  while (offset < size) {
    const piece = await reach.answer("inf:files:read", [{ id, offset }]);
    expect(piece.offset).toBe(offset);
    const bytes = Buffer.from(piece.data, "base64");
    expect(bytes.length).toBeGreaterThan(0);
    pieces.push(bytes);
    offset += bytes.length;
  }
  return Buffer.concat(pieces);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("one computer's files", () => {
  it("lists a folder with each name's kind, and marks the app's own sign-ins protected", async () => {
    const { home, userData, reach } = computer();
    writeFileSync(join(home, "Documents", "notes.txt"), "hello");
    mkdirSync(join(home, "Documents", "drafts"));
    symlinkSync(join(home, "Documents", "notes.txt"), join(home, "Documents", "latest"));
    const docs = await reach.answer("inf:files:list", [{ path: "~/Documents" }]);
    expect(docs.entries.map(({ name, kind, size }) => ({ name, kind, size }))).toEqual([
      { name: "drafts", kind: "folder", size: undefined },
      { name: "latest", kind: "link", size: undefined },
      { name: "notes.txt", kind: "file", size: 5 },
    ]);
    const app = await reach.answer("inf:files:list", [{ path: userData }]);
    expect(app.entries).toEqual([{ name: "accounts", kind: "protected" }]);
  });

  it("sets a file aside whole, reads it in pieces that match its sha256, and lets it go", async () => {
    const { home, reach } = computer();
    const bytes = Buffer.alloc(FILE_PIECE_BYTES + 1234, 7);
    writeFileSync(join(home, "Documents", "big.bin"), bytes);
    const snapshot = await reach.answer("inf:files:snapshot", [{ path: "~/Documents/big.bin" }]);
    expect(snapshot).toMatchObject({ size: bytes.length, sha256: sha256(bytes) });
    expect(snapshot.database).toBeUndefined();
    const staged = reach.stagedPath(snapshot.id);
    expect(statSync(staged).mode & 0o777).toBe(0o600);
    expect(sha256(await readWhole(reach, snapshot.id, snapshot.size))).toBe(snapshot.sha256);
    await reach.answer("inf:files:release", [{ id: snapshot.id }]);
    expect(existsSync(staged)).toBe(false);
    await expect(reach.answer("inf:files:read", [{ id: snapshot.id, offset: 0 }])).rejects.toThrow(
      "That copy was let go; ask for the file again.",
    );
  });

  it("copies a database another program has open through its own backup, rows in its log included", async () => {
    const { home, reach } = computer();
    const file = join(home, "Documents", "record.db");
    const writer = new Database(file);
    try {
      writer.pragma("journal_mode = WAL");
      writer.pragma("wal_autocheckpoint = 0");
      writer.exec("create table tasks (key text)");
      const add = writer.prepare("insert into tasks (key) values (?)");
      for (let at = 1; at <= 50; at += 1) add.run(`INF-${at}`);
      // The rows are still only in the write-ahead log beside the file.
      expect(existsSync(`${file}-wal`)).toBe(true);
      const snapshot = await reach.answer("inf:files:snapshot", [{ path: file }]);
      expect(snapshot.database).toBe(true);
      const copy = join(scratchDir("infinitary-file-reach-copy-"), "record.db");
      writeFileSync(copy, await readWhole(reach, snapshot.id, snapshot.size));
      expect(sha256(readFileSync(copy))).toBe(snapshot.sha256);
      const reader = new Database(copy, { readonly: true });
      try {
        expect(reader.prepare("select count(*) as n from tasks").get()).toEqual({ n: 50 });
      } finally {
        reader.close();
      }
      await reach.release(snapshot.id);
    } finally {
      writer.close();
    }
  });

  it("refuses the app's sign-ins and keys, whether named in any case or reached through a link", async () => {
    const { home, userData, reach, stagingDir } = computer();
    symlinkSync(join(userData, "accounts"), join(home, "Documents", "innocent"));
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", ".credentials.json"), "{}");
    const refusals = [
      join(userData, "accounts", "a1", "auth.json"),
      join(userData, "ACCOUNTS", "a1", "auth.json"),
      "~/Documents/innocent/a1/auth.json",
      "~/.claude/.credentials.json",
    ];
    for (const path of refusals)
      await expect(reach.answer("inf:files:snapshot", [{ path }])).rejects.toThrow(
        "holds the app's own sign-ins or keys, which the files command never copies.",
      );
    await expect(
      reach.answer("inf:files:list", [{ path: "~/Documents/innocent" }]),
    ).rejects.toThrow("never copies");
    // Nothing was set aside for any of them.
    expect(existsSync(stagingDir) ? readdirSync(stagingDir) : []).toEqual([]);
  });

  it("refuses the sign-ins in every app folder the app has had, and in one made after the first look", async () => {
    const { home, userData, reach, stagingDir } = computer();
    // The one-time move leaves the Firstmate 3000 folder in place, its sign-ins still in it.
    const older = join(dirname(userData), "firstmate-3000");
    mkdirSync(join(older, "forges"), { recursive: true });
    writeFileSync(join(older, "forges", "github.com.json"), "{}");
    mkdirSync(join(older, "work"), { recursive: true });
    writeFileSync(join(older, "work", "home.json"), "{}");
    mkdirSync(join(older, "devices"), { recursive: true });
    writeFileSync(join(older, "devices", "key.json"), "{}");
    // The first look reads where the refused places are; a sign-in folder made after it is refused too,
    // here reached through a link and so named by its real path, under any linked folder above it.
    await reach.answer("inf:files:list", [{ path: "~/Documents" }]);
    mkdirSync(join(userData, "integrations"));
    writeFileSync(join(userData, "integrations", "secrets.json"), "{}");
    symlinkSync(join(userData, "integrations"), join(home, "Documents", "later"));
    const refusals = [
      join(older, "forges", "github.com.json"),
      join(older, "work", "home.json"),
      "~/Library/Application Support/firstmate-3000/devices/key.json",
      "~/Library/Application Support/firstmate-3000-dev/accounts/a1/auth.json",
      "~/Documents/later/secrets.json",
    ];
    for (const path of refusals)
      await expect(reach.answer("inf:files:snapshot", [{ path }])).rejects.toThrow(
        "holds the app's own sign-ins or keys, which the files command never copies.",
      );
    const listing = await reach.answer("inf:files:list", [{ path: older }]);
    expect(listing.entries.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: "devices", kind: "protected" },
      { name: "forges", kind: "protected" },
      { name: "work", kind: "folder" },
    ]);
    expect(existsSync(stagingDir) ? readdirSync(stagingDir) : []).toEqual([]);
  });

  it("refuses a sign-in reached by another name for the same file, by its device and inode", async () => {
    const { home, userData, reach, stagingDir } = computer();
    mkdirSync(join(userData, "work"));
    writeFileSync(join(userData, "work", "home.json"), "{}");
    // A second name for the very same file, outside every refused place.
    linkSync(join(userData, "work", "home.json"), join(home, "Documents", "home-copy.json"));
    await expect(
      reach.answer("inf:files:snapshot", [{ path: "~/Documents/home-copy.json" }]),
    ).rejects.toThrow(
      "holds the app's own sign-ins or keys, which the files command never copies.",
    );
    const listing = await reach.answer("inf:files:list", [{ path: "~/Documents" }]);
    expect(listing.entries).toEqual([{ name: "home-copy.json", kind: "protected" }]);
    expect(existsSync(stagingDir) ? readdirSync(stagingDir) : []).toEqual([]);
  });

  it.runIf(process.platform === "darwin")(
    "refuses the sign-ins and private folders reached under macOS's /System/Volumes/Data path for the same folder",
    async () => {
      const { home, userData, reach, stagingDir } = computer();
      mkdirSync(join(userData, "forges"));
      writeFileSync(join(userData, "forges", "github.com.json"), "{}");
      writeFileSync(join(home, "Documents", "letter.txt"), "private");
      mkdirSync(join(home, "Projects"));
      writeFileSync(join(home, "Projects", "plan.txt"), "shared");
      // macOS reaches every folder on its data volume by this second path as well.
      const aliasOf = (path: string) => join("/System/Volumes/Data", realpathSync(path));
      expect(statSync(aliasOf(userData)).ino).toBe(statSync(userData).ino);
      for (const path of [
        join(aliasOf(userData), "forges", "github.com.json"),
        join(aliasOf(userData), "accounts", "a1", "auth.json"),
      ])
        await expect(reach.answer("inf:files:snapshot", [{ path }])).rejects.toThrow(
          "holds the app's own sign-ins or keys, which the files command never copies.",
        );
      await expect(
        reach.answer("inf:files:list", [{ path: join(aliasOf(userData), "forges") }]),
      ).rejects.toThrow("never copies");
      const app = await reach.answer("inf:files:list", [{ path: aliasOf(userData) }]);
      expect(app.entries).toEqual([
        { name: "accounts", kind: "protected" },
        { name: "forges", kind: "protected" },
      ]);
      // Another user on this Mac is refused them, and the private folders, by that path too.
      expect(
        (await reach.closedToAnotherUser(join(aliasOf(home), "Documents", "letter.txt")))?.message,
      ).toContain("is in a private folder - Desktop, Documents, Library or ~/.ssh");
      expect(
        (await reach.closedToAnotherUser(join(aliasOf(userData), "forges", "github.com.json")))
          ?.message,
      ).toContain("holds the app's own sign-ins or keys");
      expect(existsSync(stagingDir) ? readdirSync(stagingDir) : []).toEqual([]);
      // A file outside them still copies by that path.
      const plan = join(aliasOf(home), "Projects", "plan.txt");
      expect(await reach.closedToAnotherUser(plan)).toBeUndefined();
      const snapshot = await reach.answer("inf:files:snapshot", [{ path: plan }]);
      expect(snapshot).toMatchObject({ path: plan, size: 6 });
    },
  );

  it("refuses a link swapped in after the check, for a file, a folder on its path, a database and a listing", async () => {
    const { home, userData, reach, stagingDir } = computer();
    const docs = realpathSync(join(home, "Documents"));
    const secret = realpathSync(join(userData, "accounts", "a1", "auth.json"));
    const vault = join(userData, "accounts", "a1", "vault.db");
    const sealed = new Database(vault);
    sealed.exec("create table keys (k text); insert into keys values ('secret')");
    sealed.close();
    writeFileSync(join(docs, "notes.txt"), "mine");
    mkdirSync(join(docs, "stage"));
    writeFileSync(join(docs, "stage", "auth.json"), "mine too");
    const mine = new Database(join(docs, "takes.db"));
    mine.exec("create table takes (name text); insert into takes values ('take-1')");
    mine.close();
    mkdirSync(join(docs, "shelf"));
    writeFileSync(join(docs, "shelf", "a.txt"), "a");
    const changed = "changed while it was being read; ask for it again.";

    // The file itself, swapped for a link to a sign-in between the check and the open.
    writer.before.set(
      `open:${join(docs, "notes.txt")}`,
      swapForLink(join(docs, "notes.txt"), secret),
    );
    await expect(
      reach.answer("inf:files:snapshot", [{ path: "~/Documents/notes.txt" }]),
    ).rejects.toThrow(`~/Documents/notes.txt ${changed}`);
    // A folder on its path, swapped for a link to the sign-ins' folder, where a file of the same name is.
    writer.before.set(
      `open:${join(docs, "stage", "auth.json")}`,
      swapForLink(join(docs, "stage"), dirname(secret)),
    );
    await expect(
      reach.answer("inf:files:snapshot", [{ path: "~/Documents/stage/auth.json" }]),
    ).rejects.toThrow(`~/Documents/stage/auth.json ${changed}`);
    // A database, swapped once it was opened and checked, before SQLite opens it by name.
    writer.before.set(
      `lstat:${join(docs, "takes.db")}-wal`,
      swapForLink(join(docs, "takes.db"), realpathSync(vault)),
    );
    await expect(
      reach.answer("inf:files:snapshot", [{ path: "~/Documents/takes.db" }]),
    ).rejects.toThrow(`~/Documents/takes.db ${changed}`);
    // A folder being listed, swapped for a link to the sign-ins' folder before its names are read.
    writer.before.set(
      `readdir:${join(docs, "shelf")}`,
      swapForLink(join(docs, "shelf"), dirname(secret)),
    );
    await expect(reach.answer("inf:files:list", [{ path: "~/Documents/shelf" }])).rejects.toThrow(
      `~/Documents/shelf ${changed}`,
    );
    expect(writer.before.size).toBe(0);
    // Nothing was set aside for any of them.
    expect(existsSync(stagingDir) ? readdirSync(stagingDir) : []).toEqual([]);
  });

  it("refuses a database with a link beside it where SQLite keeps its log", async () => {
    const { home, userData, reach, stagingDir } = computer();
    const file = join(home, "Documents", "mine.db");
    const db = new Database(file);
    db.exec("create table notes (text text); insert into notes values ('mine')");
    db.close();
    // A log beside it that is another database's, which SQLite would read as this one's.
    symlinkSync(join(userData, "accounts", "a1", "vault.db-wal"), `${file}-wal`);
    await expect(
      reach.answer("inf:files:snapshot", [{ path: "~/Documents/mine.db" }]),
    ).rejects.toThrow(
      "~/Documents/mine.db is a database whose mine.db-wal beside it is a link, which the files command does not follow.",
    );
    expect(existsSync(stagingDir) ? readdirSync(stagingDir) : []).toEqual([]);
  });

  it("refuses what it cannot copy in words that say what to do", async () => {
    const { home, reach } = computer();
    writeFileSync(join(home, "Documents", "empty.txt"), "");
    const huge = join(home, "Documents", "huge.bin");
    writeFileSync(huge, "");
    truncateSync(huge, 1024 * 1024 * 1024 + 1);
    const cases: [string, string][] = [
      [
        "Documents/notes.txt",
        "Name Documents/notes.txt by its full path, or from the home folder as ~/...",
      ],
      ["~/Documents/missing.txt", "There is nothing at ~/Documents/missing.txt."],
      ["~/Documents", "~/Documents is a folder: list it with ls."],
      ["~/Documents/empty.txt", "~/Documents/empty.txt is empty, so there is nothing to copy."],
      [
        "~/Documents/huge.bin",
        "~/Documents/huge.bin is larger than 1 GB, the most a hand-over folder takes.",
      ],
    ];
    for (const [path, words] of cases)
      await expect(reach.answer("inf:files:snapshot", [{ path }])).rejects.toThrow(words);
    await expect(
      reach.answer("inf:files:list", [{ path: "~/Documents/empty.txt" }]),
    ).rejects.toThrow("~/Documents/empty.txt is a file, not a folder: copy it with get.");
  });

  it("names the app data folders of every name and flavor, the folder work runs from, and the system's saved passwords", () => {
    const places = protectedPlaces({
      userData: "/Users/me/Library/Application Support/infinitary-dev",
      home: "/Users/me",
      workDir: "/Volumes/Work/infinitary-work",
    });
    expect(places).toEqual(
      expect.arrayContaining([
        "/Users/me/Library/Application Support/infinitary-dev/accounts",
        "/Users/me/Library/Application Support/infinitary/devices",
        "/Users/me/Library/Application Support/infinitary/work/home.json",
        "/Users/me/Library/Application Support/firstmate-3000/forges",
        "/Users/me/Library/Application Support/firstmate-3000-dev/work/home.json",
        "/Volumes/Work/infinitary-work/claude-login.json",
        "/Users/me/.pi",
        "/Users/me/Library/Keychains",
      ]),
    );
    // The record and the crewmates' folders stay readable.
    expect(places).not.toContain("/Users/me/Library/Application Support/infinitary");
    expect(places.some((place) => place.endsWith("crewmates"))).toBe(false);
  });
});
