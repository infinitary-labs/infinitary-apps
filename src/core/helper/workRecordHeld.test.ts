import { join } from "node:path";
import type { DeviceGrant } from "@shared/devices";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { createKeyIdentity } from "../devices/identity";
import { JoinedHome } from "../devices/joinedHome";
import { adoptWindowGrant } from "./fromWindow";
import { keepHeard } from "./join";
import { lockFolder } from "./lock";
import { setUpWork } from "./workSetup";

/**
 * The work folder's record on a Windows PC (docs/windows.md, "Joining
 * another computer"). Windows refuses to replace a file another program
 * holds open: its rename answers access denied, which Node names EPERM. A
 * program may open a file the moment it appears, and the installed Windows
 * check saw exactly that. The window put `home.json` in place with the grant,
 * and its second write, of the home's name, was refused, leaving the record
 * nameless and the work never set up. Here every system refuses the same way:
 * from the moment a rename puts a `home.json` in place, it is held open until
 * the test lets it go, the order that check met.
 */
const holder = vi.hoisted(() => ({ holding: false, held: new Set<string>() }));

vi.mock("node:fs", async (load) => {
  const actual = await load<typeof import("node:fs")>();
  const renameSync: typeof actual.renameSync = (from, to) => {
    const path = String(to);
    if (holder.held.has(path))
      throw Object.assign(
        new Error(`EPERM: operation not permitted, rename '${String(from)}' -> '${path}'`),
        { code: "EPERM", syscall: "rename", path: String(from), dest: path },
      );
    actual.renameSync(from, to);
    if (holder.holding && /[\\/]home\.json$/.test(path)) holder.held.add(path);
  };
  return { ...actual, renameSync };
});

/** From now on, each `home.json` put in place is held open, as another program may. */
function holdAsItAppears(): void {
  holder.holding = true;
}

afterEach(() => {
  holder.holding = false;
  holder.held.clear();
});

const home = createKeyIdentity("The home").pin;

function grantFor(deviceId: string): DeviceGrant {
  const own = createKeyIdentity("Firstmate device");
  return {
    at: "192.168.1.20:47623",
    homeKey: home,
    deviceId,
    kind: "mac",
    key: own.key,
    cert: own.cert,
  };
}

describe("the work folder's record, held open by another program from the moment it appears", () => {
  it("keeps the window's grant with the home's name in the one write that puts it in place, and sets the work up", async () => {
    const dataDir = join(scratchDir("infinitary-held-record-"), "work");
    const grant = grantFor("pc");
    // A background whose run takes the work folder, as a real one does.
    const background = vi.fn(async () => {
      lockFolder(dataDir);
      return "running" as const;
    });
    holdAsItAppears();
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

  it("adopts the window's grant with its name in one write, for a join by a command", () => {
    const userData = scratchDir("infinitary-held-adopt-");
    const dataDir = join(userData, "work");
    const grant = grantFor("pc");
    const window = new JoinedHome(join(userData, "joined"));
    window.join(grant, 1_000);
    window.name("MacBook Pro");
    holdAsItAppears();
    expect(adoptWindowGrant(dataDir, home)).toBe(true);
    expect(new JoinedHome(dataDir).read()).toMatchObject({ grant, name: "MacBook Pro" });
  });

  it("keeps the home's name and where this computer runs, heard in one welcome, in one write", () => {
    const dataDir = join(scratchDir("infinitary-held-heard-"), "work");
    const grant = grantFor("pc");
    const joinedHome = new JoinedHome(dataDir);
    joinedHome.join(grant, 1_000);
    // Held from the hearing's write on: this case is the welcome's two fields
    // only, not the record the join put in place before its dial.
    holdAsItAppears();
    const heard = { name: "MacBook Pro", onHomeMac: false };
    expect(keepHeard(joinedHome, grant, heard)).toEqual({ ...grant, onHomeMac: false });
    expect(new JoinedHome(dataDir).read()).toMatchObject({
      grant: { deviceId: "pc", onHomeMac: false },
      name: "MacBook Pro",
    });
  });
});
