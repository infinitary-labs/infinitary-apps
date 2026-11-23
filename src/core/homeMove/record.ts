import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  type ReadStream,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { encodeClaudeProjectDir } from "../claude/claudeTranscript";

/** The old home's staging folder for a move, with its mark; set aside with the record once answered. */
export const HOME_MOVING = "home-moving";

/**
 * The record a home move carries (docs/devices.md, "Moving the first
 * mate"): the first mate's own data - its database and knowledge, the
 * crew's conversations, cards, evidence and kept answers, integrations'
 * settings, plugins, the personal workspace, the first mate's and the
 * supervision's conversations, attachments - and the home's identity and
 * device list, so every device trusts the new home with no new link.
 *
 * What belongs to the computer stays: sign-ins (`auth/`, `accounts/`,
 * `forges/`, `web-sign-ins/`), working copies and project folders, caches,
 * doors, locks, logs, the computer's own SSH key and the hosts it checked,
 * where devices last reached it, Secrets (sealed by this computer's own
 * keychain), and the browser's own files. Only the copy of the Secrets sealed
 * to each confirmed computer's own lock goes, with the list of those locks
 * (docs/devices.md, "Secrets on a computer that keeps a copy").
 */
export const RECORD_ROOTS = [
  "firstmate.db",
  "saved-data-format.json",
  "knowledge",
  "crewmates",
  "integrations",
  "private-sites.json",
  "plugins",
  "fleet/personal",
  "firstmate",
  "supervision",
  "overflow",
  "attachments",
  "devices/home-key.pem",
  "devices/home-cert.pem",
  "devices/devices.json",
  "devices/seen.json",
  "devices/failed-updates.json",
  "devices/removing.json",
  "devices/removed.json",
  "devices/systems.json",
  "devices/pushes.json",
  "devices/push-withdrawals.json",
  "devices/push-letters.json",
  "devices/standbys.json",
  "devices/standby-locks.json",
  "devices/standby-secrets.json",
  "devices/take-over.json",
  "devices/returning.json",
  "sign-in-again.json",
] as const;

/**
 * Which takeover made a home (docs/devices.md, "Taking over"): a copy keeps
 * it, but a move does not carry it, since the home a move makes was made by
 * no takeover.
 */
export const COPY_ONLY_ROOTS: readonly string[] = ["devices/take-over.json"];

/**
 * The key of a home's way back (docs/devices.md, "An old home that
 * returns"), which never leaves the home: no copy or move carries it, and it
 * goes aside with the record once the first mate moved away.
 */
export const WAY_BACK_KEY = "devices/returning-key.json";

/**
 * The working folders a first mate's or supervision's Claude conversation
 * may have started in, relative to the data folder: the client keeps each
 * under a folder named after it (`encodeClaudeProjectDir`), which the move
 * carries as `claude/<n>/` and names after the same folder on the new home.
 */
export const CLAUDE_FOLDERS = [
  "",
  "firstmate",
  "firstmate/home",
  "firstmate/claude",
  "supervision",
  "supervision/home",
  "fleet/personal",
] as const;

/** The record's place for Claude's folder of `CLAUDE_FOLDERS[index]`. */
export const CLAUDE_PREFIX = "claude";

/** A task's own folders that are this computer's only: its temporary files and a move's packs. */
const SKIPPED_IN_TASK = new Set(["temp", "move"]);

/** What SQLite keeps beside a database, which a database's own backup already holds. */
export const DATABASE_SIDECARS = ["-wal", "-shm", "-journal"] as const;

export type RecordEntry = {
  /** Its place in the record, written with `/`. */
  path: string;
  abs: string;
  size: number;
  mtimeMs: number;
  /** A SQLite database: copied through its own backup, never byte for byte. */
  database: boolean;
};

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1");

export function isDatabaseFile(abs: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(abs, "r");
    const head = Buffer.alloc(SQLITE_HEADER.length);
    const read = readSync(fd, head, 0, head.length, 0);
    return read === head.length && head.equals(SQLITE_HEADER);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function toRecordPath(path: string): string {
  return path.split(sep).join("/");
}

/**
 * Every file of the record in `userData`, and of the first mate's Claude
 * conversations in `claudeDir`, as it stands now. Links and anything that is
 * not a plain file are left out, and so is what SQLite keeps beside a
 * database. With `kinds` false it reads only each file's size, opening none,
 * for the Ready list, and calls every file a plain one.
 */
export function listRecord(
  userData: string,
  claudeDir: string | null,
  options: { kinds?: boolean } = {},
): RecordEntry[] {
  return [...recordEntries(userData, claudeDir, options)];
}

/** How many files the record's walk reads before it lets the rest of the turn's work run. */
const ENTRIES_PER_TURN = 256;

/**
 * The same walk as `listRecord`, giving the turn back after every few
 * hundred files, so a record of many files never holds up the rest of the
 * process for the whole walk.
 */
export async function listRecordInTurns(
  userData: string,
  claudeDir: string | null,
  options: { kinds?: boolean } = {},
): Promise<RecordEntry[]> {
  const found: RecordEntry[] = [];
  for (const entry of recordEntries(userData, claudeDir, options)) {
    found.push(entry);
    if (found.length % ENTRIES_PER_TURN === 0)
      await new Promise((resolve) => setImmediate(resolve));
  }
  return found;
}

function* recordEntries(
  userData: string,
  claudeDir: string | null,
  { kinds = true }: { kinds?: boolean },
): Generator<RecordEntry> {
  function* add(abs: string, path: string): Generator<RecordEntry> {
    let facts: ReturnType<typeof lstatSync>;
    try {
      facts = lstatSync(abs);
    } catch {
      return;
    }
    if (facts.isDirectory()) {
      yield* walk(abs, path);
      return;
    }
    if (!facts.isFile()) return;
    if (DATABASE_SIDECARS.some((suffix) => path.endsWith(suffix))) {
      const base = path.slice(0, path.lastIndexOf("-"));
      if (existsSync(join(dirname(abs), base.slice(base.lastIndexOf("/") + 1)))) return;
    }
    yield {
      path,
      abs,
      size: facts.size,
      mtimeMs: facts.mtimeMs,
      database: kinds && isDatabaseFile(abs),
    };
  }
  function* walk(dir: string, path: string): Generator<RecordEntry> {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = `${path}/${entry.name}`;
      const parts = child.split("/");
      if (parts[0] === "crewmates" && parts.length === 3 && SKIPPED_IN_TASK.has(entry.name))
        continue;
      yield* add(join(dir, entry.name), child);
    }
  }
  for (const root of RECORD_ROOTS) yield* add(join(userData, ...root.split("/")), root);
  if (claudeDir)
    for (const [index, folder] of CLAUDE_FOLDERS.entries()) {
      const dir = join(claudeDir, "projects", encodeClaudeProjectDir(join(userData, folder)));
      if (existsSync(dir)) yield* walk(dir, `${CLAUDE_PREFIX}/${index}`);
    }
}

/** Where a record path lands on the destination: in its data folder, or Claude's own folder. */
export function landingOf(path: string, userData: string, claudeDir: string): string | null {
  const parts = path.split("/");
  if (parts[0] === CLAUDE_PREFIX) {
    const folder = CLAUDE_FOLDERS[Number(parts[1])];
    if (folder === undefined || parts.length < 3) return null;
    return join(
      claudeDir,
      "projects",
      encodeClaudeProjectDir(join(userData, folder)),
      ...parts.slice(2),
    );
  }
  return join(userData, ...parts);
}

/**
 * The SHA-256 of a whole file, hex, answered only once the file is closed
 * again: Windows refuses to rename or remove a folder holding an open file,
 * so a rename right after a hash must not race the read's own close.
 */
export function hashFile(
  abs: string,
  open: (path: string) => ReadStream = createReadStream,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    let digest: string | null = null;
    open(abs)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => {
        digest = hash.digest("hex");
      })
      .on("close", () => {
        if (digest !== null) resolve(digest);
      });
  });
}

export const MOVED_AWAY_DIR = "moved-away";

/**
 * Sets the record in `userData` aside once the first mate moved away from
 * it, so nothing here opens it again: every record root, with what SQLite
 * kept beside its databases, goes under `moved-away/<move>/`. Nothing is
 * deleted. Answers where it went.
 */
export function setAsideRecord(
  userData: string,
  move: string,
  also: readonly string[] = [],
): string {
  const aside = join(userData, MOVED_AWAY_DIR, move);
  for (const root of [...RECORD_ROOTS, ...also]) {
    const from = join(userData, ...root.split("/"));
    const extras = DATABASE_SIDECARS.map((suffix) => `${from}${suffix}`);
    for (const each of [from, ...extras]) {
      if (!existsSync(each)) continue;
      const to = join(aside, relative(userData, each));
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      renameSync(each, to);
    }
  }
  return aside;
}

/** Where a restore keeps what was made again at a restored path. */
const RECREATED_DIR = "made-since";

/**
 * Puts back what `setAsideRecord` set aside for `move`, for a move undone
 * before it finished; only what is there goes back, so a set-aside that
 * stopped part way is undone too.
 */
export function restoreAside(userData: string, move: string, also: readonly string[] = []): void {
  const aside = join(userData, MOVED_AWAY_DIR, move);
  for (const root of [...RECORD_ROOTS, ...also]) {
    const from = join(userData, ...root.split("/"));
    for (const each of [from, ...DATABASE_SIDECARS.map((suffix) => `${from}${suffix}`)]) {
      const kept = join(aside, relative(userData, each));
      if (!existsSync(kept)) continue;
      // Something made the path again since it went aside: it goes aside in
      // turn, deleted nowhere, and the kept one takes its place.
      if (existsSync(each)) {
        const made = join(aside, RECREATED_DIR, relative(userData, each));
        mkdirSync(dirname(made), { recursive: true, mode: 0o700 });
        renameSync(each, made);
      }
      mkdirSync(dirname(each), { recursive: true, mode: 0o700 });
      renameSync(kept, each);
    }
  }
  pruneEmpty(aside);
}

/** Removes `dir` and the folders under it that hold nothing; a file anywhere keeps its folders. */
function pruneEmpty(dir: string): boolean {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return true;
  }
  let empty = true;
  for (const entry of entries)
    if (!entry.isDirectory() || !pruneEmpty(join(dir, entry.name))) empty = false;
  if (empty) rmSync(dir, { recursive: true, force: true });
  return empty;
}

/** Removes what a move placed at the record's roots, after its own was set aside. */
export function removePlaced(userData: string, also: readonly string[] = []): void {
  for (const root of [...RECORD_ROOTS, ...also]) {
    const at = join(userData, ...root.split("/"));
    for (const each of [at, ...DATABASE_SIDECARS.map((suffix) => `${at}${suffix}`)])
      rmSync(each, { recursive: true, force: true });
  }
}

export { toRecordPath };
