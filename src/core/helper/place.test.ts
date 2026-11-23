import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { writeMoveRecord, writeRetiredMarker } from "../folderMove/record";
import { helperPlace } from "./place";

/**
 * Where the app keeps its data when it runs work for another Mac
 * (docs/helper.md): `work/` in its own folder for its flavor, and only a
 * development run may be isolated elsewhere.
 */

const APP_DATA = "/Users/builder/Library/Application Support";

describe("where the app keeps its data when it runs work", () => {
  it("keeps it in work/ inside the app's own folder for its flavor", () => {
    expect(helperPlace({ packaged: true, flavor: "release", appData: APP_DATA, env: {} })).toEqual({
      packaged: true,
      flavor: "release",
      spelling: "inf",
      dataDir: `${APP_DATA}/infinitary/work`,
      folderSpelling: "inf",
      move: null,
      retired: false,
    });
    expect(helperPlace({ packaged: true, flavor: "dev", appData: APP_DATA, env: {} }).dataDir).toBe(
      `${APP_DATA}/infinitary-dev/work`,
    );
    expect(
      helperPlace({ packaged: false, flavor: "dev", appData: APP_DATA, env: {} }).dataDir,
    ).toBe(`${APP_DATA}/infinitary-dev/work`);
  });

  it("lets only a development run take its folder from the environment", () => {
    const env = { INFINITARY_HELPER_DATA_DIR: " /tmp/run-1 " };
    expect(helperPlace({ packaged: false, flavor: "dev", appData: APP_DATA, env }).dataDir).toBe(
      "/tmp/run-1",
    );
    expect(helperPlace({ packaged: true, flavor: "release", appData: APP_DATA, env }).dataDir).toBe(
      `${APP_DATA}/infinitary/work`,
    );
  });
});

/**
 * Across the Infinitary rename (docs/helper.md, "Under the other name"):
 * Infinitary's work is read where it is now, in Firstmate 3000's folder until
 * the one-time move brings that folder over, and a folder that moved is never
 * opened again.
 */
describe("where the work is across the Infinitary rename", () => {
  const OLDER = "firstmate-3000";
  const OWN = "infinitary";

  function appData(): string {
    return scratchDir("infinitary-place-");
  }

  function joined(dataDir: string): void {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "home.json"), "{}\n");
  }

  const infinitary = (at: string) =>
    helperPlace({ packaged: true, flavor: "release", appData: at, env: {}, spelling: "inf" });

  it("reads Firstmate 3000's folder until the move, which is due", () => {
    const at = appData();
    joined(join(at, OLDER, "work"));
    expect(infinitary(at)).toMatchObject({
      spelling: "inf",
      dataDir: join(at, OLDER, "work"),
      folderSpelling: "fm",
      move: { from: join(at, OLDER), to: join(at, OWN) },
      retired: false,
    });
  });

  it("reads its own folder once the work moved, and the move's last steps while it is not done", () => {
    const at = appData();
    joined(join(at, OLDER, "work"));
    joined(join(at, OWN, "work"));
    writeRetiredMarker(join(at, OLDER), join(at, OWN), "2026-10-14T00:00:00.000Z");
    const record = {
      schemaVersion: 1 as const,
      from: join(at, OLDER),
      to: join(at, OWN),
      at: "2026-10-14T00:00:00.000Z",
    };
    writeMoveRecord(join(at, OWN), { ...record, state: "committed" });
    expect(infinitary(at)).toMatchObject({
      dataDir: join(at, OWN, "work"),
      folderSpelling: "inf",
      move: { from: join(at, OLDER), to: join(at, OWN) },
    });
    writeMoveRecord(join(at, OWN), { ...record, state: "done" });
    expect(infinitary(at)).toMatchObject({
      dataDir: join(at, OWN, "work"),
      folderSpelling: "inf",
      move: null,
      retired: false,
    });
  });

  it("leaves an older folder holding only a window's saved work to the window", () => {
    const at = appData();
    mkdirSync(join(at, OLDER), { recursive: true });
    writeFileSync(join(at, OLDER, "firstmate.db"), "");
    expect(infinitary(at)).toMatchObject({ dataDir: join(at, OWN, "work"), move: null });
  });

  it("stays in its own folder when that joined, whatever the older one holds", () => {
    const at = appData();
    joined(join(at, OLDER, "work"));
    joined(join(at, OWN, "work"));
    expect(infinitary(at)).toMatchObject({ dataDir: join(at, OWN, "work"), move: null });
  });

  it("reads the older folder's work, never moving it, when the person kept Infinitary's own", () => {
    const at = appData();
    joined(join(at, OLDER, "work"));
    mkdirSync(join(at, OWN), { recursive: true });
    writeMoveRecord(join(at, OWN), {
      schemaVersion: 1,
      state: "kept-own",
      from: join(at, OLDER),
      to: join(at, OWN),
      at: "2026-10-14T00:00:00.000Z",
    });
    expect(infinitary(at)).toMatchObject({
      dataDir: join(at, OLDER, "work"),
      folderSpelling: "fm",
      move: null,
    });
  });

  it("has Firstmate 3000 open nothing of a folder that moved", () => {
    const at = appData();
    joined(join(at, OLDER, "work"));
    writeRetiredMarker(join(at, OLDER), join(at, OWN), "2026-10-14T00:00:00.000Z");
    expect(
      helperPlace({ packaged: true, flavor: "release", appData: at, env: {}, spelling: "fm" }),
    ).toMatchObject({ dataDir: join(at, OLDER, "work"), move: null, retired: true });
  });
});
