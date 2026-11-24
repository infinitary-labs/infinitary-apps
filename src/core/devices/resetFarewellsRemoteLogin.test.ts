import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deviceLabel } from "@shared/devices";
import { remoteLoginWords } from "@shared/remoteLogin";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimedPort } from "../../../tests/helpers/claimedPort";
import { scratchDir, socketScratchDir } from "../../../tests/helpers/scratchDirs";
import { SSH_SERVER_AVAILABLE, startSshServer } from "../../../tests/helpers/sshServer";
import { standInFirstmate } from "../../../tests/helpers/standInFirstmate";
import { startConnection } from "../connection/connection";
import type { CoreDispatch } from "../dispatcher";
import { CoreEventBus } from "../events";
import { WorkDevices } from "../placed/workDevices";
import { addResetRemoval, resetRemovalsPath } from "../reset/removals";
import { DevicePairing } from "./pairing";
import { RemoteLogin } from "./remoteLogin";
import { type ResetFarewellOutcome, ResetFarewells, removeThereOverSsh } from "./resetFarewells";
import { SshConnections } from "./sshConnections";

/**
 * A reset's computer the old first mate reached over Remote Login
 * (docs/reset.md, "Computers out of reach"): the Mac's own ssh against a
 * throwaway SSH server on loopback (`tests/helpers/sshServer.ts`), the real
 * pairing and Remote Login adding it, and a stand-in Firstmate there that
 * writes down each start (`tests/helpers/standInFirstmate.ts`), as
 * src/core/devices/sshConnections.test.ts's.
 */

// Real processes: sshd, ssh, curl and openssl (fastest of three runs 1.8 s).
vi.setConfig({ testTimeout: 10_000 });

const dispatch = (async (channel) => {
  throw new Error(`Rejected ${channel}`);
}) as CoreDispatch;

const stops: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

/** The macOS user number the stand-in there joins as; the old first mate runs as another. */
const THEIR_UID = 4242;

describe.runIf(SSH_SERVER_AVAILABLE)("a reset's computer reached over Remote Login", () => {
  it("is tried again while out of reach, and once back, what the old first mate set up there is removed with its key and the host key the captain checked", async () => {
    const sshd = await startSshServer();
    stops.push(() => sshd.stop());
    const theirHome = scratchDir("infinitary-reset-ssh-user-");
    const them = {
      HOME: theirHome,
      INFINITARY_HELPER_DATA_DIR: join(theirHome, "work"),
      INFINITARY_DEVICE_NAME: "Mac mini",
    };
    const reach = sshd.ssh({ remote: them });

    // The old first mate adds the Mac mini by its address over Remote Login.
    const port = await claimedPort();
    const pairing = new DevicePairing({
      dir: join(scratchDir("infinitary-reset-ssh-home-"), "devices"),
      onProblem: () => {},
      interfaces: () => ({}),
      port,
      ownUid: THEIR_UID + 1,
    });
    const connection = startConnection({
      dispatch,
      events: new CoreEventBus(),
      devices: pairing,
      port,
    });
    const work = new WorkDevices();
    work.attach(connection);
    const record = join(scratchDir("infinitary-reset-ssh-record-"), "started");
    const controlBase = socketScratchDir("fm-r-");
    const connections = new SshConnections({
      pairing,
      ssh: reach,
      flavor: "dev",
      listening: () => work.listening(),
      settled: () => work.settled(),
      welcomed: (deviceId) => work.inReach(deviceId) || work.version(deviceId) !== undefined,
      onWorkDevice: (listener) => work.onWorkDevice(listener),
      cleanUpThere: () => Promise.resolve("done" as const),
      emit: () => {},
      changed: () => {},
      controlBase,
    });
    const remote = new RemoteLogin({
      pairing,
      ssh: reach,
      flavor: "dev",
      appBundle: () =>
        standInFirstmate(record, THEIR_UID, { joined: "running", updated: "running" }),
      listening: () => work.settled(),
      inReach: (deviceId) => work.inReach(deviceId),
      connections,
      controlBase,
      emit: () => {},
    });
    const asked = await remote.addOrAsk(sshd.address, {});
    const added =
      "asks" in asked && asked.asks === "confirm"
        ? await remote.addOrAsk(sshd.address, { confirm: asked.line })
        : asked;
    if ("asks" in added) throw new Error(remoteLoginWords.leaveQuestion(added)[0]);

    // Reset while it is out of reach: the old first mate is gone.
    const dataDir = join(scratchDir("infinitary-reset-ssh-"), "Infinitary");
    mkdirSync(dataDir);
    addResetRemoval(dataDir, pairing.resetRemoval([added.id], Date.now()));
    const oldPin = pairing.identity().pin;
    await connection.close();
    pairing.dispose();

    // The fresh first mate tries it where nothing answers, then once it is back.
    const dead = await claimedPort();
    const tried = { ...sshd.ssh({ remote: them, port: dead }) };
    const said: { name: string; outcome: ResetFarewellOutcome }[] = [];
    const removeThere = removeThereOverSsh({ ssh: tried, flavor: "dev" });
    const outcomes: string[] = [];
    const answered = new ResetFarewells({
      dataDir,
      said: ({ name }, outcome) => said.push({ name, outcome }),
      removeThere: async (reset, computer) => {
        const outcome = await removeThere(reset, computer);
        outcomes.push(outcome);
        return outcome;
      },
      retryMs: [200],
    });
    stops.push(answered.start());
    await vi.waitFor(() => expect(outcomes.length).toBeGreaterThanOrEqual(2), { timeout: 10_000 });
    expect(answered.waiting()).toBe(true);
    expect(said).toEqual([]);

    Object.assign(tried, reach);
    await vi.waitFor(() => expect(answered.waiting()).toBe(false), { timeout: 10_000 });
    expect(new Set(outcomes)).toEqual(new Set(["failed", "done"]));
    expect(outcomes.at(-1)).toBe("done");
    expect(readFileSync(record, "utf8")).toContain(
      `started: work remove --from-home --home ${oldPin} --device ${added.id}`,
    );
    // Named as the old first mate's list of computers named it.
    expect(said).toEqual([{ name: deviceLabel(added), outcome: "removed" }]);
    expect(existsSync(resetRemovalsPath(dataDir))).toBe(false);
  });
});
