import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { tableRowsReadSettled } from "../../../tests/helpers/tableRowsRead";
import { appPathsFor } from "../paths";
import { openInMemoryDatabase } from "../storage/db";
import { seedTask } from "./seedTask";
import { TaskService } from "./taskService";
import {
  OLDER_TEMP_MARKER_NAME,
  provisionTaskTemp,
  removeOwnedTempFolder,
  TaskTempFiles,
  TEMP_DIR_NAME,
  TEMP_MARKER_NAME,
} from "./taskTemp";

/**
 * The Infinitary rename (step 8 of FI3-1780's plan): a task's temporary
 * folder is marked with Infinitary's marker now, and one Firstmate 3000
 * provisioned before the update is still the app's to remove at the close.
 */
describe("a task's temporary folder across the rename", () => {
  it("removes a folder Firstmate 3000 provisioned under its own marker, and marks new ones Infinitary's", async () => {
    const root = scratchDir("infinitary-task-temp-");
    const older = join(root, "older");
    mkdirSync(join(older, TEMP_DIR_NAME), { recursive: true });
    writeFileSync(join(older, OLDER_TEMP_MARKER_NAME), "fm3000-temp-v1\n");
    writeFileSync(join(older, TEMP_DIR_NAME, "download.zip"), "bytes");
    // Provisioning again keeps the older marker as it is.
    provisionTaskTemp(older);
    expect(existsSync(join(older, TEMP_MARKER_NAME))).toBe(false);
    const trash = join(root, "trash");
    const removed: string[] = [];
    const result = await removeOwnedTempFolder(older, trash, "older", (dir) => removed.push(dir));
    expect(result).toEqual({ status: "removed", bytes: 5 });
    expect(readdirSync(older)).toEqual([]);
    expect(removed).toHaveLength(1);

    // A marker that is not the app's, under the older name, is never ownership.
    const foreign = join(root, "foreign");
    mkdirSync(join(foreign, TEMP_DIR_NAME), { recursive: true });
    writeFileSync(join(foreign, OLDER_TEMP_MARKER_NAME), "someone else's\n");
    provisionTaskTemp(foreign);
    expect(existsSync(join(foreign, TEMP_MARKER_NAME))).toBe(false);
    expect(await removeOwnedTempFolder(foreign, trash, "foreign", () => {})).toEqual({
      status: "absent",
      bytes: 0,
    });

    const fresh = join(root, "fresh");
    provisionTaskTemp(fresh);
    expect(readdirSync(fresh).sort()).toEqual([TEMP_MARKER_NAME, TEMP_DIR_NAME].sort());
  });
});

/**
 * A pass reads only the closes since the last one (INF-3032), so a removal
 * its computer could not make yet comes back at the next pass with no close.
 */
describe("closed tasks' temporary folders", () => {
  it("tries a computer's removal again at the next pass, with no new close", async () => {
    const paths = appPathsFor(scratchDir("infinitary-task-temp-retry-"));
    const tasks = new TaskService({ db: openInMemoryDatabase(), now: () => 1_000, strict: true });
    seedTask(tasks, { id: "away", title: "away", status: "cancelled", deviceId: "mini" });
    const asked: (string | null | undefined)[] = [];
    let inReach = false;
    const temp = new TaskTempFiles({
      paths,
      tasks,
      deleteInBackground: () => {},
      now: () => 2_000,
      removePlaced: async (record) => {
        asked.push(record.deviceId);
        return inReach
          ? { status: "removed", bytes: 5 }
          : { status: "pending", bytes: 0, reason: "its computer is out of reach" };
      },
    });
    await temp.sweep();
    inReach = true;
    await temp.sweep();
    expect(asked).toEqual(["mini", "mini"]);
    expect(tasks.timeline("away").map((event) => event.text)).toEqual(
      expect.arrayContaining([
        "temporary files kept: its computer is out of reach",
        "temporary files removed, 5 B",
      ]),
    );
  });

  /**
   * Every pass tries each folder it kept again and says why it keeps it
   * once. Finding that earlier note by reading each kept task's whole
   * timeline held the main thread for over a second after a start, on a
   * record with thousands of tasks kept on computers out of reach (INF-5047).
   */
  it("finds a kept folder's earlier note without decoding the task's history", async () => {
    const paths = appPathsFor(scratchDir("infinitary-task-temp-history-"));
    const tasks = new TaskService({ db: openInMemoryDatabase(), now: () => 1_000, strict: true });
    seedTask(tasks, { id: "away", title: "away", status: "cancelled", deviceId: "mini" });
    // A finished task's history: the crewmate's notes from its turns.
    for (let step = 1; step <= 40; step += 1)
      tasks.note("away", `step ${step} of the work is done`, { news: false });
    const temp = new TaskTempFiles({
      paths,
      tasks,
      deleteInBackground: () => {},
      now: () => 2_000,
      removePlaced: async () => ({
        status: "pending",
        bytes: 0,
        reason: "its computer is out of reach",
      }),
    });
    await temp.sweep();
    const { rows } = await tableRowsReadSettled("task_events", () => temp.sweep());
    // The one row read is the note it found, so it writes no second one.
    expect(rows).toHaveLength(1);
    expect(
      tasks
        .timeline("away")
        .filter((event) => event.text === "temporary files kept: its computer is out of reach"),
    ).toHaveLength(1);
  });
});
