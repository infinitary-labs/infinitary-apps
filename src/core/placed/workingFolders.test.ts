import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { folderOwners, under, workingFoldersFromLsof } from "./workingFolders";

/**
 * INF-4072 finding 3: a program counts against the task whose folders it works in.
 * The listing's shape is this Mac's `lsof -a -d cwd -u <uid> -F pn`.
 */
describe("a program's working folder names its task", () => {
  it("matches a working folder the system names by its real path to the task's folder", async () => {
    const tasksDir = scratchDir("infinitary-working-folders-");
    const work = join(tasksDir, "worktrees", "task-a");
    const temp = join(tasksDir, "tasks", "task-a", "temp");
    const other = join(tasksDir, "worktrees", "task-b");
    for (const dir of [work, temp, other]) mkdirSync(dir, { recursive: true });
    // macOS lists a working folder under /private/var for a task folder under /var.
    const listing = [
      "p255",
      "fcwd",
      "n/",
      "p4211",
      "fcwd",
      `n${join(realpathSync(work), "packages", "app")}`,
      "p4300",
      "fcwd",
      `n${realpathSync(temp)}`,
      "p4301",
      "fcwd",
      `n${realpathSync(other)}`,
      "p4302",
      "fcwd",
      `n${realpathSync(work)}-sibling`,
      "",
    ].join("\n");
    const folders = workingFoldersFromLsof(listing);
    expect(folders.get(255)).toBe("/");
    const owners = await folderOwners(folders, [
      { taskId: "task-a", folders: [work, temp] },
      { taskId: "task-b", folders: [`${other}/`] },
    ]);
    expect(Object.fromEntries(owners)).toEqual({ 4211: "task-a", 4300: "task-a", 4301: "task-b" });
  });
});

describe("a Windows folder holds a path", () => {
  it("whatever case Windows names either in, and never a neighbour that only starts the same", () => {
    // Windows names one folder in more than one case (INF-4253): a program's
    // working folder reads as the shell wrote it, the task's as the app did.
    const task = ["C:\\Users\\kun\\AppData\\Roaming\\infinitary\\work\\worktrees\\858b7095"];
    expect(
      under(
        "c:\\users\\kun\\appdata\\roaming\\infinitary\\work\\worktrees\\858b7095\\src",
        task,
        "\\",
      ),
    ).toBe(true);
    expect(
      under("C:\\Users\\kun\\AppData\\Roaming\\infinitary\\work\\worktrees\\858b7095", task, "\\"),
    ).toBe(true);
    expect(
      under(
        "C:\\Users\\kun\\AppData\\Roaming\\infinitary\\work\\worktrees\\858b7095-old",
        task,
        "\\",
      ),
    ).toBe(false);
  });
});
