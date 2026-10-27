import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { bundleForElectron, electronBinary } from "../../../tests/helpers/electronBundle";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { PlacedTasks } from "../helper/placedTasks";
import { TEMP_DIR_NAME, TEMP_MARKER_NAME } from "./taskTemp";

/**
 * INF-1594: a crewmate's clone in its temporary folder holds
 * `node_modules/electron`, whose `default_app.asar` Electron's own file reads
 * show as a folder on a made-up device. The close-time removal read that as
 * a mounted volume and kept the folder for good, and the in-process delete
 * stopped at it. Run inside Electron, a computer that runs work removes such
 * a closed task's temporary folder and its leftover files like any other.
 */
const RESOURCES = "clone/node_modules/electron/dist/Electron.app/Contents/Resources";
let inElectron: Awaited<ReturnType<typeof bundleForElectron>>;

beforeAll(async () => {
  inElectron = await bundleForElectron("tests/helpers/taskTempProcess.ts");
});

/** The archive the installed Electron itself ships, beside its binary. */
function installedAsar(): string {
  const resources = process.platform === "darwin" ? "../Resources" : "resources";
  return join(dirname(electronBinary()), resources, "default_app.asar");
}

/** A closed task on a computer that runs work, with Electron's archive in `parts`. */
function closedTaskHolding(...parts: string[]): { dataDir: string; root: string; bytes: number } {
  const dataDir = scratchDir("infinitary-task-temp-electron-");
  const tasks = new PlacedTasks(dataDir);
  const folders = tasks.ensure("task");
  tasks.writeState("task", { ...tasks.state("task"), closed: true });
  let bytes = 0;
  for (const part of parts) {
    const into = join(folders.root, part, RESOURCES);
    mkdirSync(into, { recursive: true });
    copyFileSync(installedAsar(), join(into, "default_app.asar"));
    bytes += statSync(join(into, "default_app.asar")).size;
  }
  writeFileSync(join(folders.temp, "download.txt"), "unpacked\n");
  bytes += "unpacked\n".length;
  return { dataDir, root: folders.root, bytes };
}

describe("a closed task's folders holding an Electron app, inside Electron", () => {
  it("removes the temporary folder at the close, counting the archive as the file it is", () => {
    const task = closedTaskHolding(TEMP_DIR_NAME);
    const removed = inElectron("temp", task.dataDir, "task");
    expect(removed.status, removed.stderr).toBe(0);
    expect(JSON.parse(removed.stdout)).toEqual({ status: "removed", bytes: task.bytes });
    expect(existsSync(join(task.root, TEMP_DIR_NAME))).toBe(false);
    expect(existsSync(join(task.root, TEMP_MARKER_NAME))).toBe(false);
    // The delete finished: nothing is left in this computer's trash.
    expect(readdirSync(join(task.dataDir, "worktree-trash"))).toEqual([]);
  });

  it("removes the leftover files with the temporary folder a week later", () => {
    const task = closedTaskHolding(TEMP_DIR_NAME, "evidence");
    const marker = statSync(join(task.root, TEMP_MARKER_NAME)).size;
    const removed = inElectron("leftovers", task.dataDir, "task");
    expect(removed.status, removed.stderr).toBe(0);
    expect(JSON.parse(removed.stdout)).toEqual({
      removedFiles: [TEMP_MARKER_NAME, "evidence", TEMP_DIR_NAME],
      bytes: task.bytes + marker,
    });
    for (const part of [TEMP_MARKER_NAME, "evidence", TEMP_DIR_NAME])
      expect(existsSync(join(task.root, part))).toBe(false);
    expect(readdirSync(join(task.dataDir, "worktree-trash"))).toEqual([]);
  });
});
