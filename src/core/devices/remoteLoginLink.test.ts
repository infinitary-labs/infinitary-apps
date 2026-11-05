import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { parsePairingLink } from "@shared/devices";
import { PHONE_DOOR_FOLDER } from "@shared/phoneLink";
import { addressAtPort } from "@shared/remoteLogin";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeEach,
  doors,
  home,
  otherUser,
  pairings,
  server,
  servers,
} from "../../../tests/helpers/remoteLoginHome";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { SSH_SERVER_AVAILABLE, startSshServer } from "../../../tests/helpers/sshServer";
import { OWN_KEY_COMMENT } from "./ownKey";
import { DevicePairing } from "./pairing";
import { PhoneDoor } from "./phoneDoor";

/**
 * INF-1827's accepted plan, "Join by its address" at first launch, with the
 * captain's answers (the desktop's own SSH, a port on the row, the password
 * once): this computer signs in to the other over the person's own SSH and
 * runs the one fixed command there, which asks the Infinitary open there
 * for a computer link at its door. The other computer is a real door over
 * real pairing in its own data folder, which each SSH session there is
 * handed as that account's own settings would.
 */

// Real processes: sshd, ssh, tar, curl and openssl (Mac slowest per-case
// fastest 2.1 s, docs/test-cohorts.md "Budgets").
vi.setConfig({ testTimeout: 15_000 });

afterEach(closeEach);

describe.runIf(SSH_SERVER_AVAILABLE)("asking a computer for a link by its address", () => {
  /** The other computer's open Infinitary: its pairing and its door, in a data folder of its own. */
  async function farHome() {
    const data = join(scratchDir("infinitary-far-home-"), "data");
    const pairing = new DevicePairing({ dir: join(data, "devices"), interfaces: () => ({}) });
    pairings.push(pairing);
    const door = await PhoneDoor.open({
      dir: join(data, PHONE_DOOR_FOLDER),
      invite: (phone) => pairing.invite({ kind: "mac", ...(phone ? { phone } : {}) }),
      listening: async () => {},
    });
    doors.push(door);
    return { data, pairing };
  }

  it("checks the key line first, then answers that computer's link with the host it reached, saying nothing in the feed", async () => {
    const sshd = await server();
    const far = await farHome();
    const at = await home({
      ssh: sshd.ssh({ remote: { INFINITARY_USER_DATA_DIR: far.data } }),
      bundle: null,
    });
    const asked = await at.remote.linkAt(sshd.address);
    if (!("asks" in asked) || asked.asks !== "confirm") throw new Error("No key line.");
    expect(asked.address).toBe(sshd.address);
    const answer = await at.remote.linkAt(sshd.address, { confirm: asked.line });
    if (!("link" in answer)) throw new Error(`No link: ${JSON.stringify(answer)}`);
    const link = parsePairingLink(answer.link);
    expect(link).toMatchObject({ kind: "mac", key: far.pairing.identity().pin });
    expect(answer.host).toBe("127.0.0.1");
    // The yes is kept by its address; the next ask goes straight to the link.
    expect(at.pairing.rememberedHost(sshd.address)).toMatchObject({ line: asked.line });
    const again = await at.remote.linkAt(sshd.address);
    expect("link" in again && parsePairingLink(again.link).code).not.toBe(link.code);
    expect(at.said).toEqual([]);
  });

  it("reaches the port typed beside the address, and keeps the key line under that address", async () => {
    const sshd = await server();
    const far = await farHome();
    // The person's own SSH settings name no port that answers: only the typed one does.
    const at = await home({
      ssh: sshd.ssh({ port: 1, remote: { INFINITARY_USER_DATA_DIR: far.data } }),
      bundle: null,
    });
    const address = addressAtPort(sshd.address, String(sshd.port));
    if (!address) throw new Error("No address at the port.");
    expect(address).toBe(`ssh://${sshd.address}:${sshd.port}`);
    const asked = await at.remote.linkAt(address);
    if (!("asks" in asked) || asked.asks !== "confirm") throw new Error("No key line.");
    const answer = await at.remote.linkAt(address, { confirm: asked.line });
    expect("link" in answer && parsePairingLink(answer.link).key).toBe(far.pairing.identity().pin);
    expect(at.pairing.rememberedHost(address)).toMatchObject({ line: asked.line });
    expect(at.pairing.rememberedHost(sshd.address)).toBeNull();
    // Without the port, the person's own settings name one where nothing listens.
    expect(await at.remote.linkAt(sshd.address)).toEqual({ refused: "remote-login-off" });
  });

  it("says Infinitary is not open there, and refuses a link this computer made for itself", async () => {
    const sshd = await server();
    const empty = join(scratchDir("infinitary-far-home-"), "data");
    const closed = await home({
      ssh: sshd.ssh({ remote: { INFINITARY_USER_DATA_DIR: empty, HOME: dirname(empty) } }),
      bundle: null,
    });
    const asked = await closed.remote.linkAt(sshd.address);
    if (!("asks" in asked) || asked.asks !== "confirm") throw new Error("No key line.");
    expect(await closed.remote.linkAt(sshd.address, { confirm: asked.line })).toEqual({
      refused: "not-open",
    });

    // Over SSH to its own account, the door that answers is this computer's own.
    const own = join(scratchDir("infinitary-own-home-"), "data");
    const self = await home({
      ssh: sshd.ssh({ remote: { INFINITARY_USER_DATA_DIR: own } }),
      bundle: null,
      dir: join(own, "devices"),
    });
    doors.push(
      await PhoneDoor.open({
        dir: join(own, PHONE_DOOR_FOLDER),
        invite: () => self.pairing.invite({ kind: "mac" }),
        listening: async () => {},
      }),
    );
    const line = await self.remote.linkAt(sshd.address);
    if (!("asks" in line) || line.asks !== "confirm") throw new Error("No key line.");
    expect(await self.remote.linkAt(sshd.address, { confirm: line.line })).toEqual({
      refused: "self",
    });
  });

  it("asks that account's password once when it refuses the key, lets Infinitary's own key in, and keeps none of it", async () => {
    const INVENTED = "invented-pw-77aa";
    const them = otherUser();
    const sshd = await startSshServer({ passwords: true, home: them.home });
    servers.push(sshd);
    const far = await farHome();
    const root = scratchDir("infinitary-remote-home-");
    const at = await home({
      ssh: sshd.ssh({
        key: "refused",
        password: INVENTED,
        remote: { ...them.env, INFINITARY_USER_DATA_DIR: far.data },
      }),
      bundle: null,
      dir: join(root, "Application Support", "devices"),
    });
    const checked = await at.remote.linkAt(sshd.address);
    if (!("asks" in checked) || checked.asks !== "confirm") throw new Error("No key line.");
    const asked = await at.remote.linkAt(sshd.address, { confirm: checked.line });
    expect(asked).toEqual({ asks: "password", address: sshd.address, user: userInfo().username });
    expect(await at.remote.linkAt(sshd.address, { password: "not-the-password" })).toEqual({
      ...asked,
      wrong: true,
    });
    const answer = await at.remote.linkAt(sshd.address, { password: INVENTED });
    expect("link" in answer && parsePairingLink(answer.link).key).toBe(far.pairing.identity().pin);
    expect(readFileSync(join(them.home, ".ssh", "authorized_keys"), "utf8")).toMatch(
      new RegExp(`^ssh-ed25519 \\S+ ${OWN_KEY_COMMENT}\n$`),
    );
    for (const run of sshd.sshRuns()) {
      expect(run.args.join(" ")).not.toContain(INVENTED);
      expect(run.envHeldPassword).toBe(false);
    }
    expect(at.said).toEqual([]);
  }, 30_000);
});
