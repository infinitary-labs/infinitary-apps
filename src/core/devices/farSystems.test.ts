import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BuildFlavor } from "@shared/userDataFolders";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { writeRetiredMarker } from "../folderMove/record";
import { CONNECT, farFolderArgs, LOOK, REMOVE } from "./farSystems";

/**
 * The shell a home sends over SSH to find a computer's work (docs/devices.md,
 * "Adding a computer by its address"; docs/helper.md, "Under the other
 * name"), run by this system's own `/bin/sh` in a throwaway home folder laid
 * out as that system keeps its data. A computer's work may be in Infinitary's
 * folder or in Firstmate 3000's: the look reads the grant of the first that
 * holds one, newest first, and the removal and the controller start the copy
 * kept in the first that keeps one, never in a folder that moved.
 */

// Integration budget (docs/test-cohorts.md): /bin/sh and the system's own
// tools the look asks (on Linux its library and installer probes too), four
// looks at most per test.
vi.setConfig({ testTimeout: 30_000 });

const LINUX = process.platform === "linux";

/** A throwaway home folder, its data folders where this system keeps them. */
function home() {
  const dir = scratchDir("infinitary-far-home-");
  const appData = LINUX ? join(dir, ".config") : join(dir, "Library", "Application Support");
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: dir,
    ...(LINUX ? { XDG_CONFIG_HOME: appData } : {}),
  };
  return { appData, env };
}

/** A work folder in data folder `folder` that joined the home `homeKey` as `deviceId`. */
function joinedIn(appData: string, folder: string, homeKey: string, deviceId: string): void {
  const work = join(appData, folder, "work");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "home.json"), `${JSON.stringify({ grant: { homeKey, deviceId } })}\n`);
}

/** A copy of Firstmate kept in that folder's work, whose program says where it ran from. */
function keptIn(appData: string, folder: string): string {
  const app = join(appData, folder, "work", "app");
  const program = LINUX
    ? join(app, "firstmate-3000.AppImage")
    : join(app, "Firstmate 3000.app", "Contents", "MacOS", "Firstmate 3000");
  mkdirSync(join(program, ".."), { recursive: true });
  writeFileSync(program, '#!/bin/sh\nprintf "ran: %s %s\\n" "$0" "$*"\n', { mode: 0o755 });
  return program;
}

function run(
  script: string,
  words: readonly string[],
  env: NodeJS.ProcessEnv,
  flavor: BuildFlavor = "release",
) {
  const ran = spawnSync(
    "/bin/sh",
    ["-c", script, "firstmate", ...farFolderArgs(flavor), ...words],
    {
      env,
      encoding: "utf8",
    },
  );
  return { code: ran.status, stdout: ran.stdout };
}

/** What the look said, by name. */
function look(env: NodeJS.ProcessEnv, flavor: BuildFlavor = "release"): Record<string, string> {
  const { stdout } = run(LOOK, [""], env, flavor);
  return Object.fromEntries(
    stdout
      .split("\n")
      .map((line) => /^infinitary:([a-z0-9]+)=(.*)$/.exec(line.trim()))
      .flatMap((match) => (match ? [[match[1], match[2]]] : [])),
  );
}

describe("the look a home sends to a computer", () => {
  it("reads the grant in Firstmate 3000's folder, then in Infinitary's, and never in one that moved", () => {
    const { appData, env } = home();
    expect(look(env)).toMatchObject({ joined: "no" });

    joinedIn(appData, "firstmate-3000", "older-home", "device-1");
    expect(look(env)).toMatchObject({ joined: "yes", home: "older-home", device: "device-1" });

    // Moved: Infinitary's folder holds the work, and the older one only its recovery copy.
    joinedIn(appData, "infinitary", "older-home", "device-2");
    writeRetiredMarker(join(appData, "firstmate-3000"), join(appData, "infinitary"), "x");
    expect(look(env)).toMatchObject({ joined: "yes", home: "older-home", device: "device-2" });

    // A recovery copy's grant is never read as this computer's.
    const moved = home();
    joinedIn(moved.appData, "firstmate-3000", "older-home", "device-1");
    writeRetiredMarker(
      join(moved.appData, "firstmate-3000"),
      join(moved.appData, "infinitary"),
      "x",
    );
    expect(look(moved.env)).toMatchObject({ joined: "no" });
  });

  it("reads a development stand-in's work folder under either of its names, Infinitary's first", () => {
    const { appData, env } = home();
    joinedIn(appData, "older", "older-home", "device-1");
    joinedIn(appData, "newer", "newer-home", "device-2");
    const older = join(appData, "older", "work");
    const newer = join(appData, "newer", "work");
    expect(look({ ...env, FM3000_HELPER_DATA_DIR: older }, "dev")).toMatchObject({
      joined: "yes",
      device: "device-1",
    });
    expect(look({ ...env, INFINITARY_HELPER_DATA_DIR: newer }, "dev")).toMatchObject({
      joined: "yes",
      device: "device-2",
    });
    expect(
      look({ ...env, FM3000_HELPER_DATA_DIR: older, INFINITARY_HELPER_DATA_DIR: newer }, "dev"),
    ).toMatchObject({ joined: "yes", device: "device-2" });
  });
});

// INF-4835's plan, piece 3: adding by its address a Mac whose window already joined finishes that
// same entry, so the look names the window's grant when its work keeps none.
describe("the look at a Mac whose window joined", () => {
  /** The grant its window keeps beside data folder `folder`'s work, as `JoinedHome` writes it. */
  function windowIn(appData: string, folder: string, grant: Record<string, string>): void {
    const joined = join(appData, folder, "joined");
    mkdirSync(joined, { recursive: true });
    writeFileSync(
      join(joined, "home.json"),
      `${JSON.stringify({ version: 1, grant, name: null, joinedAt: 0 }, null, 2)}\n`,
    );
  }

  it("names a Mac window's home and id while its work keeps no grant, and never one that only controls", () => {
    const { appData, env } = home();
    windowIn(appData, "infinitary", { homeKey: "the-home", deviceId: "air", kind: "mac" });
    expect(look(env)).toMatchObject({ joined: "no", windowhome: "the-home", windowdevice: "air" });

    const view = home();
    windowIn(view.appData, "infinitary", { homeKey: "the-home", deviceId: "air", kind: "view" });
    expect(look(view.env)).not.toHaveProperty("windowhome");

    // Its work's own grant is what the look reads once it keeps one.
    joinedIn(appData, "infinitary", "the-home", "mini");
    const read = look(env);
    expect(read).toMatchObject({ joined: "yes", device: "mini" });
    expect(read).not.toHaveProperty("windowdevice");
  });
});

describe("the removal and the controller a home starts on a computer", () => {
  const words = ["home-pin", "device-1"];

  it("start the copy kept in whichever folder keeps one, newest first, but one that moved", () => {
    const { appData, env } = home();
    const older = keptIn(appData, "firstmate-3000");
    expect(run(REMOVE, words, env)).toEqual({
      code: 0,
      stdout: `ran: ${older} work remove --from-home --home home-pin --device device-1\n`,
    });
    expect(run(CONNECT, words, env).stdout).toBe(
      `ran: ${older} work connect --from-home --home home-pin --device device-1\n`,
    );

    // Infinitary's folder keeps the copy after the move; the older one keeps its own, retired.
    const own = keptIn(appData, "infinitary");
    writeRetiredMarker(join(appData, "firstmate-3000"), join(appData, "infinitary"), "x");
    expect(run(REMOVE, words, env).stdout).toBe(
      `ran: ${own} work remove --from-home --home home-pin --device device-1\n`,
    );
  });

  it("say nothing of this home is there when no folder keeps a copy", () => {
    const { appData, env } = home();
    keptIn(appData, "firstmate-3000");
    writeRetiredMarker(join(appData, "firstmate-3000"), join(appData, "infinitary"), "x");
    expect(run(REMOVE, words, env)).toEqual({
      code: 1,
      stdout: '{"firstmate":"refused","reason":"not-joined"}\n',
    });
  });
});
