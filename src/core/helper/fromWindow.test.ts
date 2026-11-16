import { dirname, join } from "node:path";
import type { DeviceGrant } from "@shared/devices";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { createKeyIdentity, loadOrCreateHomeIdentity } from "../devices/identity";
import { JoinedHome } from "../devices/joinedHome";
import { windowFromWork, workFromWindow } from "./fromWindow";
import { lockFolder } from "./lock";

/**
 * A Mac's two halves on their own (docs/helper.md, "A Mac that also
 * controls"): what its window keeps in the work folder when it joins as a
 * Mac, and which grant there its window controls a home with. The window
 * and the home over the wire are src/main/shell.test.ts.
 */

const home = createKeyIdentity("The home").pin;

function grantFor(deviceId: string, kind: DeviceGrant["kind"] = "mac"): DeviceGrant {
  const own = createKeyIdentity("Firstmate device");
  return { at: "192.168.1.20:47623", homeKey: home, deviceId, kind, key: own.key, cert: own.cert };
}

const workDir = () => join(scratchDir("infinitary-from-window-"), "work");

describe("a Mac's window and its work", () => {
  it("keeps the window's grant for its work and sets it up in the background, once", async () => {
    const dataDir = workDir();
    const grant = grantFor("air");
    const background = vi.fn(async () => "running" as const);
    const setUp = { dataDir, grant, name: "MacBook Pro", joinedAt: 1_000, background };
    expect(await workFromWindow(setUp)).toBe("running");
    expect(new JoinedHome(dataDir).read()).toMatchObject({ grant, name: "MacBook Pro" });
    expect(background).toHaveBeenCalledWith({ launcher: null, app: null });
    // The same Mac again keeps what it has, and loads the background again.
    expect(await workFromWindow({ ...setUp, joinedAt: 2_000 })).toBe("running");
    expect(new JoinedHome(dataDir).read()?.joinedAt).toBe(1_000);
  });

  it("leaves work it runs for another home as it is, and waits for a folder in use", async () => {
    const dataDir = workDir();
    new JoinedHome(dataDir).join(grantFor("mini"), 1_000);
    const background = vi.fn(async () => "running" as const);
    const setUp = { dataDir, grant: grantFor("air"), name: null, joinedAt: 2_000, background };
    expect(await workFromWindow(setUp)).toBe("other-home");
    expect(new JoinedHome(dataDir).read()?.grant.deviceId).toBe("mini");

    const free = workDir();
    const release = lockFolder(free);
    expect(await workFromWindow({ ...setUp, dataDir: free })).toBe("busy");
    release();
    expect(new JoinedHome(free).read()).toBeNull();
    expect(background).not.toHaveBeenCalled();
  });

  it("opens a window only on a Mac's own grant, never one that only runs work or the device it left", () => {
    const dataDir = workDir();
    expect(windowFromWork(dataDir, null)).toBeNull();
    new JoinedHome(dataDir).join(grantFor("mini", "work"), 1_000);
    expect(windowFromWork(dataDir, null)).toBeNull();
    new JoinedHome(dataDir).join(grantFor("mini"), 1_000);
    expect(windowFromWork(dataDir, null)?.grant.deviceId).toBe("mini");
    expect(windowFromWork(dataDir, "mini")).toBeNull();
  });

  it('opens no window of the first mate once that first mate moved here (docs/devices.md, "Moving the first mate")', () => {
    const dataDir = workDir();
    const moved = loadOrCreateHomeIdentity(join(dirname(dataDir), "devices"));
    const own = createKeyIdentity("Firstmate device");
    new JoinedHome(dataDir).join(
      { ...grantFor("mini"), homeKey: moved.pin, key: own.key, cert: own.cert },
      1_000,
    );
    expect(windowFromWork(dataDir, null)).toBeNull();
  });
});
