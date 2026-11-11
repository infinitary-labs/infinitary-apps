import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONNECTION_PATH, LOCAL_DOOR_FILES, LOCAL_DOOR_KEY_HEADER } from "@shared/connection";
import type { DeviceGrant } from "@shared/devices";
import { CORE_INVOKE_CHANNELS, invokeContract, PROTOCOL_VERSION } from "@shared/ipc";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { connectClient } from "../../../tests/helpers/connectionClient";
import { answersAt, changed, home, postPair } from "../../../tests/helpers/connectionHome";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { homeSocketUrl, pinnedSocket } from "../devices/dial";
import type { ViewDeviceContact } from "./connection";
import { dialLocalDoor, readLocalDoor } from "./localDoor";

/**
 * Opens a socket to the local door read from `dir`, as `dialLocalDoor` does,
 * with the key, an Origin or the path changed for a refusal test.
 */
async function doorSocket(
  dir: string,
  tamper: { key?: string | null; origin?: string; path?: string } = {},
): Promise<WebSocket> {
  const door = readLocalDoor(dir);
  if (!door) throw new Error("no local door");
  const socket = await pinnedSocket({ address: door.address }, door.pin, null, { relay: null });
  const key = tamper.key === undefined ? door.key : tamper.key;
  return new WebSocket(homeSocketUrl(door.address, tamper.path ?? CONNECTION_PATH), {
    createConnection: () => socket,
    ...(tamper.origin ? { origin: tamper.origin } : {}),
    ...(key === null ? {} : { headers: { [LOCAL_DOOR_KEY_HEADER]: key } }),
  });
}

/** A client of the local door, which holds no grant: the grant here only satisfies the helper. */
const LOCAL_GRANT = {} as DeviceGrant;

// INF-1352's plan (local_path=real-connection, local_proof=folder-key): the window on the first
// mate's own computer, and any second local client, reach it over the connection through a
// loopback door its key admits, with no pairing and no row on the list of devices.
describe("the local door", () => {
  async function withDoor() {
    const door = join(scratchDir("infinitary-local-door-"), "local-door");
    const at = await home({ localDoor: door });
    await at.connection.settled();
    const local = () => connectClient(LOCAL_GRANT, { open: () => dialLocalDoor(door), as: "view" });
    return { ...at, door, local };
  }

  it("opens with nothing paired, in a folder and files only this account can read", async () => {
    const at = await withDoor();
    // Nothing paired: no address for devices, only the door.
    expect(at.connection.listening()).toEqual([]);
    expect(await answersAt(at.port)).toBe(false);
    const address = at.connection.localDoor();
    expect(address).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(statSync(at.door).mode & 0o777).toBe(0o700);
    for (const name of Object.values(LOCAL_DOOR_FILES))
      expect(statSync(join(at.door, name)).mode & 0o777).toBe(0o600);
    expect(readLocalDoor(at.door)?.address).toBe(address);
    // phase0-guardrails' "accepts no device while nothing is paired": the door has a key of its
    // own, so pairing still writes nothing, not even the home's key, until the first link.
    const client = await at.local();
    expect(existsSync(at.devicesDir)).toBe(false);
    expect(readLocalDoor(at.door)?.pin).not.toBe(at.pairing.identity().pin);
    await client.close();

    await at.connection.close();
    expect(existsSync(at.door)).toBe(false);
  });

  it("admits its key as the captain, with no device row, and refuses a computer's work", async () => {
    const at = await withDoor();
    const heard: ViewDeviceContact[] = [];
    at.connection.onViewDevice((contact) => heard.push(contact));
    const client = await at.local();
    expect(client.welcome.protocolVersion).toBe(PROTOCOL_VERSION);

    // What stays on this computer, Secrets included, is the window's to ask, as the captain himself.
    const stays = CORE_INVOKE_CHANNELS.find((channel) => invokeContract[channel].reach === "home");
    expect(stays).toBeDefined();
    if (!stays) return;
    await expect(client.invoke(stays, [{}])).rejects.toThrow("malformed request");
    expect(at.asked).toEqual([{ channel: stays, args: [{}], actor: { kind: "captain" } }]);
    await expect(client.invoke("inf:work:progress", [{}])).rejects.toThrow(
      "asked only by a computer that runs work",
    );
    expect(at.asked).toHaveLength(1);

    expect(at.pairing.list()).toEqual([]);
    expect(heard).toEqual([]);
    expect(at.connection.runningVersions()).toEqual([]);
    await client.close();
    expect(heard).toEqual([]);
  });

  it("admits a second local client with the same key, and both hear every push", async () => {
    const at = await withDoor();
    const window = await at.local();
    const command = await at.local();
    changed(at.events);
    await Promise.all(
      [window, command].map((client) =>
        client.push((push) => push.channel === "inf:models:changed"),
      ),
    );
    await window.close();
    await command.close();
  });

  it("refuses before any frame a wrong or missing key, a browser, another path, and plain requests", async () => {
    const at = await withDoor();
    const refused = (tamper: Parameters<typeof doorSocket>[1]) =>
      connectClient(LOCAL_GRANT, { open: () => doorSocket(at.door, tamper) }).then(
        () => "accepted",
        (error: Error) => error.message,
      );
    expect(await refused({ key: null })).toBe("refused: 401");
    expect(await refused({ key: "0".repeat(64) })).toBe("refused: 401");
    expect(await refused({ origin: "https://example.com" })).toBe("refused: 403");
    expect(await refused({ path: "/elsewhere" })).toBe("refused: 404");
    expect(await refused({})).toBe("accepted");
    expect(at.asked).toEqual([]);
  });

  it("answers no pairing on the door, and a key from an earlier door no longer opens it", async () => {
    const door = join(scratchDir("infinitary-local-door-"), "local-door");
    const first = await home({ localDoor: door });
    await first.connection.settled();
    const earlier = readLocalDoor(door);
    const address = first.connection.localDoor();
    if (!earlier || !address) throw new Error("no local door");
    const paired = await postPair(address, earlier.pin, { body: "{}" });
    expect(paired.status).toBe(404);
    await first.connection.close();

    const second = await home({ localDoor: door });
    await second.connection.settled();
    expect(readLocalDoor(door)?.key).not.toBe(earlier.key);
    const stale = await connectClient(LOCAL_GRANT, {
      open: () => doorSocket(door, { key: earlier.key }),
    }).then(
      () => "accepted",
      (error: Error) => error.message,
    );
    expect(stale).toBe("refused: 401");
  });

  // The full journey suite's update-channels journey: a first mate standing in a newer contract
  // still takes changes from its own window, which is the same build on the same computer.
  it("lets a local client change things whatever contract the first mate says it is on", async () => {
    const door = join(scratchDir("infinitary-local-door-"), "local-door");
    const newerMajor = Number(PROTOCOL_VERSION.split(".")[0]) + 5;
    const at = await home({
      localDoor: door,
      protocolVersion: `${newerMajor}.0.0`,
      viewFloor: newerMajor,
    });
    await at.connection.settled();
    const client = await connectClient(LOCAL_GRANT, { open: () => dialLocalDoor(door) });
    expect(client.welcome.access).toBe("full");
    await expect(client.invoke("inf:cards:act", ["card-1"])).rejects.toThrow("malformed request");
    expect(at.asked.map((ask) => ask.channel)).toEqual(["inf:cards:act"]);
    await client.close();
  });

  // The captain's answer to INF-1359's measurement review: "keep the record of recent updates
  // small when nothing is paired". With nothing paired the journal numbers pushes and keeps none.
  it("keeps no pushes while nothing is paired, and keeps them again once something is", async () => {
    const at = await withDoor();
    const first = await at.local();
    changed(at.events);
    await first.push(() => true);
    const caughtUp = first.cursor();
    await first.close();

    // Missed nothing: there is nothing to replay, and none is needed.
    const same = await connectClient(LOCAL_GRANT, {
      open: () => dialLocalDoor(at.door),
      as: "view",
      cursor: caughtUp,
    });
    expect(same.welcome.catchUp).toBe("replay");
    await same.close();

    // Missed a push while nothing was paired: none was kept, so it reads everything again.
    changed(at.events);
    const missed = await connectClient(LOCAL_GRANT, {
      open: () => dialLocalDoor(at.door),
      as: "view",
      cursor: caughtUp,
    });
    expect(missed.welcome.catchUp).toBe("reload");
    expect(missed.pushes).toEqual([]);
    const cursor = missed.cursor();
    await missed.close();

    // Once a device is paired, a push the local client missed is kept and replayed.
    await at.join();
    changed(at.events);
    const back = await connectClient(LOCAL_GRANT, {
      open: () => dialLocalDoor(at.door),
      as: "view",
      cursor,
    });
    expect(back.welcome.catchUp).toBe("replay");
    expect(back.pushes.map((push) => [push.seq, push.channel])).toEqual([
      [cursor.seq + 1, "inf:models:changed"],
    ]);
    await back.close();
  });

  it("keeps its clients while devices start and stop being listened for", async () => {
    const at = await withDoor();
    const client = await at.local();
    const grant = await at.join();
    expect(at.connection.listening()).toEqual([`127.0.0.1:${at.port}`]);
    at.pairing.remove(grant.deviceId);
    await expect.poll(() => at.connection.listening()).toEqual([]);
    changed(at.events);
    await client.push((push) => push.channel === "inf:models:changed");
    expect(at.connection.localDoor()).not.toBeNull();
    await client.close();
  });
});
