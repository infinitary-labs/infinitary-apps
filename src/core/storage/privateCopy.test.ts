import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { openDatabase } from "./db";
import { privateCopy } from "./privateCopy";

// The saved-data check reads a copy of the database so that reading never
// changes the original (docs/saved-data-compatibility.md); the copy is a
// clone where the disk allows one, which must stay as private as a full copy.
describe("privateCopy", () => {
  it("copies a database whose later changes on either side never reach the other", () => {
    const dir = scratchDir("fm-private-copy-");
    openDatabase(dir).close();
    const source = join(dir, "firstmate.db");
    const copy = join(scratchDir("fm-private-copy-to-"), "copy.db");
    const original = readFileSync(source);

    privateCopy(source, copy);
    expect(readFileSync(copy).equals(original)).toBe(true);

    const db = openDatabase(dir);
    db.prepare("INSERT INTO settings (key, value) VALUES ('later', '1')").run();
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    expect(readFileSync(source).equals(original)).toBe(false);
    expect(readFileSync(copy).equals(original)).toBe(true);

    const changed = readFileSync(source);
    writeFileSync(copy, "overwritten");
    appendFileSync(copy, " and more");
    expect(readFileSync(source).equals(changed)).toBe(true);
  });
});
