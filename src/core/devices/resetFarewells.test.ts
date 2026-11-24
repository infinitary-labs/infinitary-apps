import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DeviceGrant } from "@shared/devices";
import { HOME_CAPABILITIES, PROTOCOL_VERSION } from "@shared/ipc";
import { afterEach, describe, expect, it } from "vitest";
import { claimedPort } from "../../../tests/helpers/claimedPort";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { type HomeConnection, type PairedDevices, startConnection } from "../connection/connection";
import type { CoreDispatch } from "../dispatcher";
import { CoreEventBus } from "../events";
import { addResetRemoval, RESET_REMOVAL_MS, resetRemovalsPath } from "../reset/removals";
import { claimLink, dialHome } from "./dial";
import { HomeLink } from "./homeLink";
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
  addResetRemoval(dataDir, old.pairing.resetRemoval([grant.deviceId], Date.now()));
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
    const [studio] = fresh.answered.computers();
    expect(studio?.name).toBe("Mac Studio");
    now = (studio?.at ?? 0) + RESET_REMOVAL_MS - 1;
    expect(fresh.answered.waiting()).toBe(true);
    expect(fresh.said).toEqual([]);
    now += 1;
    expect(fresh.answered.waiting()).toBe(false);
    expect(fresh.said).toEqual([{ name: "Mac Studio", outcome: "stayed" }]);
    expect(existsSync(resetRemovalsPath(away.dataDir))).toBe(false);
  });
});
