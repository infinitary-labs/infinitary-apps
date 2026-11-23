import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PHONE_DOOR_FOLDER } from "@shared/phoneLink";
import { remoteLoginWords } from "@shared/remoteLogin";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeEach,
  doors,
  home,
  otherUser,
  pairings,
  server,
  standInBundle,
  THEIR_UID,
} from "../../../tests/helpers/remoteLoginHome";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { SSH_SERVER_AVAILABLE } from "../../../tests/helpers/sshServer";
import { STAND_IN_APP, standInFirstmate } from "../../../tests/helpers/standInFirstmate";
import { DevicePairing } from "./pairing";
import { PhoneDoor } from "./phoneDoor";
import type { DeviceSetupEvent } from "./remoteLogin";

/**
 * INF-6207's approved plan, part 2: the welcome screen's Another computer
 * sets the first mate up on that computer over SSH - its key line first,
 * the person's own SSH, its system, the copy kept in that account's
 * Applications folder, then the copy's own `start-at-boot`. The other
 * computer is a real SSH server on loopback with an account folder of its
 * own, and the copy is the stand-in Firstmate, which writes down how it was
 * started.
 */

// Real processes: sshd, ssh and tar (docs/test-cohorts.md "Budgets").
vi.setConfig({ testTimeout: 15_000 });

afterEach(closeEach);

/** A Linux computer starts the first mate at every restart only with systemd. */
const SYSTEMD = process.platform !== "linux" || existsSync("/run/systemd/system");

async function setUp(boot = 0, hears?: (event: DeviceSetupEvent) => void) {
  const sshd = await server();
  const them = otherUser();
  const record = join(scratchDir("infinitary-home-record-"), "started");
  const bundle =
    boot === 0
      ? standInBundle(record)
      : standInFirstmate(record, THEIR_UID, { joined: "at-login", updated: "running", boot });
  const at = await home({
    ssh: sshd.ssh({ remote: them.env }),
    bundle,
    ...(hears ? { hears } : {}),
  });
  return { sshd, them, record, at };
}

describe.runIf(SSH_SERVER_AVAILABLE && SYSTEMD)(
  "setting the first mate up on another computer",
  () => {
    it("asks the key line first, then keeps the copy in that account's Applications and starts it at boot", async () => {
      const { sshd, them, record, at } = await setUp();
      const asked = await at.remote.homeAt(sshd.address);
      if (!("asks" in asked) || asked.asks !== "confirm") throw new Error("No key line.");
      // Nothing reached that account before the yes.
      expect(existsSync(record)).toBe(false);

      const answer = await at.remote.homeAt(sshd.address, { confirm: asked.line });
      expect(answer).toMatchObject({
        started: true,
        address: sshd.address,
        name: "Mac mini",
        lingerOff: expect.any(Boolean),
        waitsForLogin: expect.any(Boolean),
        private: expect.any(Boolean),
      });
      expect(readFileSync(record, "utf8")).toBe("started: start-at-boot\n");
      expect(existsSync(join(them.home, "Applications", STAND_IN_APP))).toBe(true);
      expect(at.lines()).toEqual([
        remoteLoginWords.reaching(sshd.address),
        remoteLoginWords.settingUp("Mac mini"),
        remoteLoginWords.starting("Mac mini"),
      ]);
      // It started a first mate there; it added no computer here.
      expect(at.pairing.list()).toEqual([]);
    });

    it("stops at the start step when the copy's start-at-boot fails, naming that computer", async () => {
      const { sshd, record, at } = await setUp(1);
      const asked = await at.remote.homeAt(sshd.address);
      if (!("asks" in asked) || asked.asks !== "confirm") throw new Error("No key line.");
      expect(await at.remote.homeAt(sshd.address, { confirm: asked.line })).toEqual({
        refused: "not-started",
        step: "start",
        name: "Mac mini",
      });
      expect(readFileSync(record, "utf8")).toBe("started: start-at-boot\n");
    });

    it("stops at the next step after Cancel, and deletes the copy it sent before anything started", async () => {
      let cancel = () => {};
      let cancelled = false;
      const { sshd, them, record, at } = await setUp(0, (event) => {
        // Cancel pressed once the copy is under way.
        if (cancelled || event.copy?.state !== "preparing") return;
        cancelled = true;
        cancel();
      });
      cancel = () => at.remote.cancelHomeAt(sshd.address);
      const asked = await at.remote.homeAt(sshd.address);
      if (!("asks" in asked) || asked.asks !== "confirm") throw new Error("No key line.");
      expect(await at.remote.homeAt(sshd.address, { confirm: asked.line })).toEqual({
        refused: "cancelled",
        step: "send",
        name: "Mac mini",
      });
      expect(cancelled).toBe(true);
      expect(existsSync(join(them.home, "Applications", STAND_IN_APP))).toBe(false);
      expect(existsSync(record)).toBe(false);
    });

    it("offers to connect where Infinitary already runs for that account, sending nothing", async () => {
      const sshd = await server();
      const data = join(scratchDir("infinitary-far-home-"), "data");
      const pairing = new DevicePairing({ dir: join(data, "devices"), interfaces: () => ({}) });
      pairings.push(pairing);
      doors.push(
        await PhoneDoor.open({
          dir: join(data, PHONE_DOOR_FOLDER),
          invite: () => pairing.invite({ kind: "mac" }),
          listening: async () => {},
        }),
      );
      const them = otherUser({ INFINITARY_USER_DATA_DIR: data });
      const record = join(scratchDir("infinitary-home-record-"), "started");
      const at = await home({ ssh: sshd.ssh({ remote: them.env }), bundle: standInBundle(record) });
      const asked = await at.remote.homeAt(sshd.address);
      if (!("asks" in asked) || asked.asks !== "confirm") throw new Error("No key line.");
      expect(await at.remote.homeAt(sshd.address, { confirm: asked.line })).toEqual({
        asks: "runs",
        address: sshd.address,
        name: "Mac mini",
      });
      expect(existsSync(record)).toBe(false);
      expect(existsSync(join(them.home, "Applications"))).toBe(false);
    });
  },
);

describe.runIf(SSH_SERVER_AVAILABLE && !SYSTEMD)("on a Linux computer without systemd", () => {
  it("stops at checking its system, before sending anything", async () => {
    const { sshd, them, record, at } = await setUp();
    const asked = await at.remote.homeAt(sshd.address);
    if (!("asks" in asked) || asked.asks !== "confirm") throw new Error("No key line.");
    expect(await at.remote.homeAt(sshd.address, { confirm: asked.line })).toMatchObject({
      refused: "no-systemd",
      step: "look",
    });
    expect(existsSync(record)).toBe(false);
    expect(existsSync(join(them.home, "Applications"))).toBe(false);
  });
});
