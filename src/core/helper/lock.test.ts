import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { FolderBusyError, folderHolder, lockFolder } from "./lock";

/** One process at a time works from a data folder (docs/helper.md). */

describe("the data folder's lock", () => {
  it("makes the folder private and names the process that holds it", () => {
    const dir = join(scratchDir("infinitary-helper-lock-"), "helper");
    const release = lockFolder(dir, { pid: 4242, alive: (pid) => pid === 4242 });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "running.lock")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, "running.lock"), "utf8")).toBe("4242\n");
    expect(folderHolder(dir, (pid) => pid === 4242)).toBe(4242);
    release();
    expect(folderHolder(dir, () => true)).toBeNull();
  });

  it("refuses a second process while the first is running", () => {
    const dir = scratchDir("infinitary-helper-lock-");
    const release = lockFolder(dir, { pid: 100, alive: () => true });
    expect(() => lockFolder(dir, { pid: 200, alive: () => true })).toThrow(FolderBusyError);
    try {
      lockFolder(dir, { pid: 200, alive: () => true });
    } catch (error) {
      expect((error as FolderBusyError).pid).toBe(100);
    }
    release();
    lockFolder(dir, { pid: 200, alive: () => true })();
  });

  it("refuses to take a folder twice in one process", () => {
    const dir = scratchDir("infinitary-helper-lock-");
    const release = lockFolder(dir);
    expect(() => lockFolder(dir)).toThrow(FolderBusyError);
    release();
    lockFolder(dir)();
  });

  it("takes over a lock whose process is gone", () => {
    const dir = scratchDir("infinitary-helper-lock-");
    writeFileSync(join(dir, "running.lock"), "100\n");
    const release = lockFolder(dir, { pid: 200, alive: (pid) => pid === 200 });
    expect(readFileSync(join(dir, "running.lock"), "utf8")).toBe("200\n");
    release();
  });

  it("lets go only of its own lock", () => {
    const dir = scratchDir("infinitary-helper-lock-");
    const release = lockFolder(dir, { pid: 100, alive: () => false });
    // Another process took it over meanwhile.
    writeFileSync(join(dir, "running.lock"), "300\n");
    release();
    expect(readFileSync(join(dir, "running.lock"), "utf8")).toBe("300\n");
  });
});
