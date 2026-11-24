import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { connect, type TLSSocket } from "node:tls";
import type { DeviceGrant } from "@shared/devices";
import { HOME_CAPABILITIES, PROTOCOL_VERSION } from "@shared/ipc";
import { afterEach, describe, expect, it } from "vitest";
import { claimedPort } from "../../../tests/helpers/claimedPort";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { type HomeConnection, type PairedDevices, startConnection } from "../connection/connection";
import type { CoreDispatch } from "../dispatcher";
import { CoreEventBus } from "../events";
import { readResetRemovals, resetRemovalsPath } from "../reset/removals";
import { claimLink, dialHome } from "./dial";
import { HomeLink } from "./homeLink";
import { peerPin } from "./identity";
import { DevicePairing } from "./pairing";
import { type ResetFarewellOutcome, ResetFarewells } from "./resetFarewells";

/**
 * A reset's computers out of reach (docs/reset.md, "Computers out of
 * reach"), against the real connection, the real pairing over scratch
 * folders and the real device side of the connection: a computer the old
 * first mate could not reach at the reset dials the fresh one on the same
 * port and hears it was removed, whether or not the fresh one paired
 * anything since; and one that never comes back is said to have stayed once
 * its 30 days are up.
 */

const dispatch = (async (channel) => {
  if (channel === "inf:app:healthcheck")
    return {
      ok: true,
      version: "9.9.9",
      platform: "test-os",
      protocolVersion: PROTOCOL_VERSION,
      capabilities: [...HOME_CAPABILITIES],
    };
  throw new Error(`Rejected ${channel}`);
}) as CoreDispatch;

const stops: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

/** A first mate listening on `port` with a pairing in `dir`, answering through `wrap`. */
async function firstMate(
  dir: string,
  port: number,
  wrap: (pairing: DevicePairing) => PairedDevices = (pairing) => pairing,
) {
  const pairing = new DevicePairing({ dir, onProblem: () => {}, interfaces: () => ({}), port });
  const connection: HomeConnection = startConnection({
    dispatch,
    events: new CoreEventBus(),
    devices: wrap(pairing),
    port,
    name: () => "MacBook Pro",
    heartbeatMs: 60_000,
  });
  await connection.settled();
  const quit = async () => {
    await connection.close();
    pairing.dispose();
  };
  stops.push(quit);
  return {
    pairing,
    connection,
    quit,
    join: async (name: string): Promise<DeviceGrant> => {
      const { link } = pairing.invite({ kind: "view", at: `127.0.0.1:${port}` });
      await connection.settled();
      return claimLink(link, { kind: "view", name });
    },
  };
}

function follow(grant: DeviceGrant) {
  const link = new HomeLink({
    grant,
    dial: (dialing) => dialHome(dialing),
    onPush: () => {},
    retryMs: [20],
    pingMs: 60_000,
  });
  stops.push(() => link.close());
  link.start();
  return link;
}

const until = async (check: () => boolean) => {
  await expect.poll(check, { timeout: 8_000, interval: 10 }).toBe(true);
};

/**
 * The old first mate, with one computer paired and connected, reset while
 * that computer is out of reach: its record is kept beside the data folder,
 * and the old first mate stops listening, as the wipe ends it.
 */
async function resetWhileAway() {
  const dataDir = join(scratchDir("infinitary-reset-farewell-"), "Infinitary");
  mkdirSync(dataDir);
  const port = await claimedPort();
  const old = await firstMate(join(scratchDir("infinitary-old-home-"), "devices"), port);
  const grant = await old.join("Mac Studio");
  const studio = follow(grant);
  await until(() => studio.state().contact === "in-reach");
  await old.quit();
  await until(() => studio.state().contact === "closed");
  new ResetFarewells({ dataDir, said: () => {} }).add(
    old.pairing.resetRemoval([grant.deviceId], Date.now()),
  );
  return { dataDir, port, grant, studio, oldPin: old.pairing.identity().pin };
}

/** The fresh first mate's side, with the quiet a removed computer keeps cut to 300 ms. */
function farewells(dataDir: string, now?: () => number) {
  const said: { name: string; outcome: ResetFarewellOutcome }[] = [];
  const answered = new ResetFarewells({
    dataDir,
    said: ({ name }, outcome) => said.push({ name, outcome }),
    quietMs: 300,
    ...(now ? { now } : {}),
  });
  return { answered, said };
}

/** A TLS dial to the first mate on loopback that shows no key of its own, once its handshake finished. */
function handshake(port: number): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket: TLSSocket = connect(
      { host: "127.0.0.1", port, rejectUnauthorized: false, minVersion: "TLSv1.3" },
      () => resolve(socket),
    );
    socket.once("error", reject);
    stops.push(() => {
      socket.destroy();
    });
  });
}

/** The pin of the key the first mate shows a dial from loopback that shows no key of its own. */
async function shownTo(port: number): Promise<string | null> {
  const socket = await handshake(port);
  const shown = peerPin(socket);
  // Ended, not cut, so the first mate reads the whole handshake first.
  const closed = new Promise((resolve) => socket.once("close", resolve));
  socket.end();
  await closed;
  return shown;
}

/** A dial from loopback that gives up on the key it is shown before its handshake ends, as a device does on a key it does not expect. */
function giveUp(port: number): Promise<void> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port, minVersion: "TLSv1.3" });
    socket.once("error", () => {});
    socket.once("close", () => resolve());
  });
}

describe("a reset's computers out of reach", () => {
  it("a computer that comes back to a fresh first mate that paired nothing hears it was removed, and the record and its key go", async () => {
    const away = await resetWhileAway();
    const fresh = farewells(away.dataDir);
    const freshDevices = join(away.dataDir, "devices");
    await firstMate(freshDevices, away.port, (pairing) => fresh.answered.answering(pairing));

    await until(() => away.studio.state().removed);
    await until(() => fresh.said.length > 0);
    expect(fresh.said).toEqual([{ name: "Mac Studio", outcome: "removed" }]);
    expect(existsSync(resetRemovalsPath(away.dataDir))).toBe(false);
    // The fresh first mate made no key of its own to answer it.
    expect(existsSync(freshDevices) ? readdirSync(freshDevices) : []).toEqual([]);
  });

  it("a fresh first mate that paired a computer of its own keeps it, while the old one hears it was removed", async () => {
    const away = await resetWhileAway();
    away.studio.close();
    const fresh = farewells(away.dataDir);
    const home = await firstMate(join(away.dataDir, "devices"), away.port, (pairing) =>
      fresh.answered.answering(pairing),
    );
    const air = follow(await home.join("MacBook Air"));
    await until(() => air.state().contact === "in-reach");
    expect(home.pairing.identity().pin).not.toBe(away.oldPin);

    const studio = follow(away.grant);
    await until(() => studio.state().removed);
    await until(() => fresh.said.length > 0);
    expect(fresh.said).toEqual([{ name: "Mac Studio", outcome: "removed" }]);
    expect(air.state()).toMatchObject({ contact: "in-reach", removed: false });
    expect(existsSync(resetRemovalsPath(away.dataDir))).toBe(false);
  });

  it("a computer that never comes back is said to have stayed once its 30 days are up, and the record and its key go", async () => {
    const away = await resetWhileAway();
    away.studio.close();
    let now = Date.now();
    const fresh = farewells(away.dataDir, () => now);
    let heard = 0;
    fresh.answered.subscribe(() => {
      heard += 1;
    });
    const [studio] = fresh.answered.computers();
    expect(studio?.name).toBe("Mac Studio");
    now = (studio?.at ?? 0) + 30 * 24 * 60 * 60 * 1000 - 1;
    expect(fresh.answered.waiting()).toBe(true);
    expect(fresh.said).toEqual([]);
    now += 1;
    expect(fresh.answered.waiting()).toBe(false);
    expect(fresh.said).toEqual([{ name: "Mac Studio", outcome: "stayed" }]);
    // The connection hears it, and stops listening for that computer.
    expect(heard).toBe(1);
    expect(existsSync(resetRemovalsPath(away.dataDir))).toBe(false);
  });

  it("a second reset on the fresh install keeps the first reset's computer when the record is saved again", async () => {
    const away = await resetWhileAway();
    away.studio.close();
    const fresh = farewells(away.dataDir);
    const second = await firstMate(
      join(scratchDir("infinitary-second-home-"), "devices"),
      await claimedPort(),
    );
    const mini = await second.join("Mac mini");
    fresh.answered.add(second.pairing.resetRemoval([mini.deviceId], Date.now()));
    const [first] = readResetRemovals(away.dataDir);
    // A refusal saves the record from what the running side holds.
    fresh.answered.refused(first?.computers[0]?.keyPin ?? null);
    expect(
      readResetRemovals(away.dataDir).map((reset) => reset.computers.map(({ name }) => name)),
    ).toEqual([["Mac Studio"], ["Mac mini"]]);
  });

  it("a dial from an address that showed no key of its own is shown the fresh first mate's own key from the next one", async () => {
    const away = await resetWhileAway();
    away.studio.close();
    const fresh = farewells(away.dataDir);
    const home = await firstMate(join(away.dataDir, "devices"), away.port, (pairing) =>
      fresh.answered.answering(pairing),
    );
    // A computer of its own makes the fresh first mate show its own key.
    const air = follow(await home.join("MacBook Air"));
    await until(() => air.state().contact === "in-reach");
    const ownPin = home.pairing.identity().pin;
    expect(await shownTo(away.port)).toBe(ownPin);
    // A dial that gives up on the key it was shown moves its address on to the old key.
    await giveUp(away.port);
    await until(() => fresh.answered.identityFor("127.0.0.1")?.cert !== undefined);
    expect(await shownTo(away.port)).toBe(away.oldPin);
    // That dial showed no key, as a computer's join probe does: the next is shown the own key.
    expect(await shownTo(away.port)).toBe(ownPin);
  });

  it("a dial that says nothing after its handshake is cut after 10 seconds", async () => {
    const away = await resetWhileAway();
    away.studio.close();
    const fresh = farewells(away.dataDir);
    await firstMate(join(away.dataDir, "devices"), away.port, (pairing) =>
      fresh.answered.answering(pairing),
    );
    const socket = await handshake(away.port);
    const started = Date.now();
    const heard: string[] = [];
    socket.on("data", (data: Buffer) => heard.push(data.toString("utf8").split("\r\n")[0] ?? ""));
    await new Promise((resolve) => socket.once("close", resolve));
    expect(Date.now() - started).toBeGreaterThanOrEqual(9_000);
    expect(heard).toEqual(["HTTP/1.1 408 Request Timeout"]);
  }, 20_000);
});
