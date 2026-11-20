import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { FileReach } from "../../src/core/files/fileReach";
import { forkChildProcess } from "../../src/core/sql/forkChildProcess";

/**
 * The app's own process as the files command runs in it, which
 * `fileReachLocks.integration.test.ts` bundles and runs with plain Node:
 * `recordHolder <folder> <rows> [set-aside entry]` holds `firstmate.db` open
 * in WAL mode as the app does, copies the record, its log and its shared
 * memory through its own `FileReach` - in a process of its own when the
 * set-aside entry is named, in this one otherwise - and then writes while a
 * fresh program opens the record to read, as the query process does when
 * it starts again. It prints one line of JSON: each copy, what the fresh
 * program read, the shared memory's size after it, and what it read itself.
 * Should a fresh program cut the shared memory short, its next read faults
 * and it dies by SIGBUS before printing anything.
 */

/**
 * A fresh program that opens the record to read, as the query process does
 * (src/core/sql/sqlEngine.ts), and prints how many notes it read.
 */
const FRESH_OPENER = `
const { DatabaseSync } = require("node:sqlite");
try {
  const db = new DatabaseSync(process.argv[1], { readOnly: true, allowExtension: false, defensive: true });
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM notes").get();
  db.close();
  console.log(JSON.stringify({ rows: n }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
}
`;

const [folder, rowsArg, setAsideEntry] = process.argv.slice(2) as [string, string, string?];
const rows = Number(rowsArg);
const record = join(folder, "firstmate.db");
const db = new Database(record);
db.pragma("journal_mode = WAL");
// Every note stays in the log and nearly every read misses the cache, so
// each read looks a page up in the log's index in the shared memory, past
// its first page: where a shared memory cut short faults.
db.pragma("wal_autocheckpoint = 0");
db.pragma("cache_size = 1");
db.exec("CREATE TABLE notes (body TEXT NOT NULL)");
const insert = db.prepare("INSERT INTO notes (body) VALUES (?)");
db.transaction(() => {
  for (let at = 0; at < rows; at += 1) insert.run(`note ${at} ${"-".repeat(200)}`);
})();

const reach = new FileReach({
  home: folder,
  protectedPlaces: [],
  stagingDir: join(folder, "set-aside"),
  ...(setAsideEntry ? { setAsideProcess: forkChildProcess(setAsideEntry) } : {}),
});
const copied: { name: string; file: string; size: number; sha256: string; database: boolean }[] =
  [];
for (const name of ["firstmate.db", "firstmate.db-wal", "firstmate.db-shm"]) {
  const snapshot = await reach.snapshot(join(folder, name));
  copied.push({
    name,
    file: reach.stagedPath(snapshot.id),
    size: snapshot.size,
    sha256: snapshot.sha256,
    database: snapshot.database ?? false,
  });
}

// The app writes while a fresh program opens the record.
db.exec("BEGIN IMMEDIATE");
const opened = spawnSync(process.execPath, ["--no-warnings", "-e", FRESH_OPENER, record], {
  encoding: "utf8",
});
const shm = statSync(`${record}-shm`).size;
const read = db.prepare("SELECT COUNT(*) AS n, SUM(LENGTH(body)) AS bytes FROM notes").get();
insert.run("written after the copy");
db.exec("COMMIT");
db.close();
console.log(
  JSON.stringify({ copied, opener: JSON.parse(opened.stdout.trim() || "{}"), shm, read }),
);
