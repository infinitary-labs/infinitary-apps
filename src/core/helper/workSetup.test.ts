import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeviceGrant } from "@shared/devices";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { createKeyIdentity } from "../devices/identity";
import { JoinedHome } from "../devices/joinedHome";
import { writeInstalled } from "./background";
import { lockFolder } from "./lock";
import { placeDoesNotLast, setUpWork } from "./workSetup";

/**
 * A Mac's window checking its work half on real folders (docs/view.md, "A
 * Mac that runs work"; the captain's ask, INF-4835: "Set it up again by
 * itself, and say why when it still cannot"). The window and the home over
 * the wire are src/main/shell.test.ts.
 */

const home = createKeyIdentity("The home").pin;
const otherHome = createKeyIdentity("Another home").pin;

function grantFor(deviceId: string, homeKey = home): DeviceGrant {
  const own = createKeyIdentity("Firstmate device");
  return { at: "192.168.1.20:47623", homeKey, deviceId, kind: "mac", key: own.key, cert: own.cert };
}

const workDir = () => join(scratchDir("infinitary-work-setup-"), "work");

/** A background whose run takes the work folder, as a real one does. */
function takesTheFolder(dataDir: string) {
  return vi.fn(async () => {
    lockFolder(dataDir);
    return "running" as const;
  });
}

describe("a Mac's window checking its work", () => {
  it("writes the window's grant again when the work folder lost it, and starts the work", async () => {
    const dataDir = workDir();
    const grant = grantFor("air");
    const background = takesTheFolder(dataDir);
    const found = await setUpWork({
      dataDir,
      grant,
      name: "MacBook Pro",
      joinedAt: 1_000,
      background,
    });
    expect(found).toEqual({ state: "running" });
    expect(new JoinedHome(dataDir).read()).toMatchObject({ grant, name: "MacBook Pro" });
    expect(background).toHaveBeenCalledWith({ launcher: null, app: null });
  });

  it("leaves a live run alone", async () => {
    const dataDir = workDir();
    const grant = grantFor("air");
    new JoinedHome(dataDir).join(grant, 1_000);
    const release = lockFolder(dataDir);
    const background = vi.fn(async () => "running" as const);
    try {
      expect(await setUpWork({ dataDir, grant, name: null, joinedAt: 2_000, background })).toEqual({
        state: "running",
      });
    } finally {
      release();
    }
    expect(background).not.toHaveBeenCalled();
  });

  it("names another first mate's work, or this one's under another entry, and changes nothing", async () => {
    const background = vi.fn(async () => "running" as const);
    const dataDir = workDir();
    new JoinedHome(dataDir).join(grantFor("mini", otherHome), 1_000);
    const setUp = { dataDir, grant: grantFor("air"), name: null, joinedAt: 2_000, background };
    expect(await setUpWork(setUp)).toEqual({ state: "blocked", reason: "other-home" });
    expect(new JoinedHome(dataDir).read()?.grant.deviceId).toBe("mini");

    const same = workDir();
    new JoinedHome(same).join(grantFor("old-air"), 1_000);
    // A live run holds it: it is still named, from the grant it keeps.
    const release = lockFolder(same);
    try {
      expect(await setUpWork({ ...setUp, dataDir: same })).toEqual({
        state: "blocked",
        reason: "other-entry",
      });
    } finally {
      release();
    }
    expect(background).not.toHaveBeenCalled();
  });

  it("never writes over work a newer Infinitary saved, and names it", async () => {
    const dataDir = workDir();
    const grant = grantFor("studio");
    new JoinedHome(dataDir).join(grant, 1_000);
    const file = join(dataDir, "home.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    saved.grant.relay = "wss://relay.example/route";
    writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`);
    const written = readFileSync(file, "utf8");
    const background = vi.fn(async () => "running" as const);
    expect(
      await setUpWork({ dataDir, grant, name: "MacBook Pro", joinedAt: 2_000, background }),
    ).toEqual({ state: "blocked", reason: "newer-work" });
    expect(readFileSync(file, "utf8")).toBe(written);
    expect(background).not.toHaveBeenCalled();
  });

  it("names a removal here that has not finished", async () => {
    const dataDir = workDir();
    new JoinedHome(dataDir).leave({ name: "MacBook Pro", reason: "removed", at: 1_000 }, [
      join(dataDir, "clones"),
    ]);
    const background = vi.fn(async () => "running" as const);
    const found = await setUpWork({
      dataDir,
      grant: grantFor("air"),
      name: null,
      joinedAt: 2_000,
      background,
    });
    expect(found).toEqual({ state: "blocked", reason: "removal-unfinished" });
    expect(new JoinedHome(dataDir).read()).toBeNull();
    expect(background).not.toHaveBeenCalled();
  });

  it("says the system refused the background, and that it has none to use", async () => {
    const grant = grantFor("air");
    const refused = vi.fn(async () => "failed" as const);
    expect(
      await setUpWork({ dataDir: workDir(), grant, name: null, joinedAt: 1, background: refused }),
    ).toEqual({ state: "blocked", reason: "background-off" });
    const none = vi.fn(async () => "unavailable" as const);
    expect(
      await setUpWork({ dataDir: workDir(), grant, name: null, joinedAt: 1, background: none }),
    ).toEqual({ state: "blocked", reason: "no-background" });
    // One that throws is refused as well.
    const thrown = vi.fn(async (): Promise<"running"> => {
      throw new Error("launchctl: Bootstrap failed: 5: Input/output error");
    });
    expect(
      await setUpWork({ dataDir: workDir(), grant, name: null, joinedAt: 1, background: thrown }),
    ).toEqual({ state: "blocked", reason: "background-off" });
  });

  it("says a run that has not taken the folder yet is starting", async () => {
    let now = 0;
    const found = await setUpWork({
      dataDir: workDir(),
      grant: grantFor("air"),
      name: null,
      joinedAt: 1,
      background: async () => "running",
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    expect(found).toEqual({ state: "starting" });
  });

  it("names an app run from a disk image or a copy macOS moved aside, and never starts it", async () => {
    const background = vi.fn(async () => "running" as const);
    const found = await setUpWork({
      dataDir: workDir(),
      grant: grantFor("air"),
      name: null,
      joinedAt: 1,
      background,
      appPath:
        "/private/var/folders/x/AppTranslocation/1234/d/Infinitary.app/Contents/MacOS/Infinitary",
      platform: "darwin",
    });
    expect(found).toEqual({ state: "blocked", reason: "app-place" });
    expect(background).not.toHaveBeenCalled();
  });
});

describe("a Mac a command or its address added, opened later as a window", () => {
  it("sets its work up again from the copy of the app kept beside it, wherever this app runs from", async () => {
    const dataDir = workDir();
    const grant = grantFor("mini");
    new JoinedHome(dataDir).join(grant, 1_000);
    // The command's join kept a copy of the app beside the work and recorded it.
    const kept = keptCopy(dataDir);
    writeInstalled(dataDir, {
      service: { label: "com.infinitary.work", file: join(dataDir, "agent.plist") },
      app: kept,
    });
    const background = takesTheFolder(dataDir);
    const found = await setUpWork({
      dataDir,
      grant,
      name: null,
      joinedAt: 2_000,
      background,
      // This window runs from a disk image, which the kept copy does not need.
      appPath: "/Volumes/Infinitary/Infinitary.app/Contents/MacOS/Infinitary",
      platform: "darwin",
    });
    expect(found).toEqual({ state: "running" });
    expect(background).toHaveBeenCalledWith({
      launcher: { executable: join(kept, "Contents", "MacOS", "Infinitary"), args: [] },
      app: kept,
    });
  });
  it("starts this app where the copy the record names is gone, and says so once", async () => {
    const dataDir = workDir();
    const grant = grantFor("studio");
    new JoinedHome(dataDir).join(grant, 1_000);
    // The record names a copy that was deleted since.
    writeInstalled(dataDir, {
      service: { label: "com.infinitary.work", file: join(dataDir, "agent.plist") },
      app: join(dataDir, "app", "Infinitary.app"),
    });
    const background = takesTheFolder(dataDir);
    const found = await setUpWork({ dataDir, grant, name: null, joinedAt: 2_000, background });
    expect(found).toEqual({ state: "running", copyGone: true });
    // The background sets up from the app that checks, which clears the record.
    expect(background).toHaveBeenCalledWith({ launcher: null, app: null });
  });
});

/** A copy of the app kept beside the work, as a command's join keeps one. */
function keptCopy(dataDir: string): string {
  const kept = join(dataDir, "app", "Infinitary.app");
  mkdirSync(join(kept, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(kept, "Contents", "MacOS", "Infinitary"), "#!/bin/sh\n", { mode: 0o755 });
  return kept;
}

describe("where an app runs from", () => {
  const app = "Infinitary.app/Contents/MacOS/Infinitary";
  it("does not last on a disk image or in a moved-aside copy, on a Mac only", () => {
    const readOnly = () => false;
    expect(placeDoesNotLast(`/Volumes/Infinitary/${app}`, "darwin", readOnly)).toBe(true);
    expect(placeDoesNotLast(`/private/var/AppTranslocation/A/d/${app}`, "darwin")).toBe(true);
    // A drive the person can write to is a place like any other.
    expect(placeDoesNotLast(`/Volumes/Work/${app}`, "darwin", () => true)).toBe(false);
    expect(placeDoesNotLast(`/Applications/${app}`, "darwin")).toBe(false);
    expect(placeDoesNotLast(`/Volumes/Infinitary/${app}`, "linux", readOnly)).toBe(false);
  });
});
