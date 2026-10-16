import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  OLDER_TEMP_MARKER_NAME,
  provisionTaskTemp,
  removeOwnedTempFolder,
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
