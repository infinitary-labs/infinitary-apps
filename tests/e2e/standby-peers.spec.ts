import { X509Certificate } from "node:crypto";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { WebSocket } from "ws";
import { homeSocketUrl, pinnedSocket } from "../../src/core/devices/dial";
import { createKeyIdentity, keyPin } from "../../src/core/devices/identity";
import { JoinedHome } from "../../src/core/devices/joinedHome";
import { joinHome } from "../../src/core/helper/join";
import { helperStatus } from "../../src/core/helper/run";
import { helperWords } from "../../src/core/helper/words";
import { readStandbyState } from "../../src/core/standby/keeper";
import { STANDBY_WORDS } from "../../src/core/standby/words";
import * as m from "../../src/shared/i18n/messages.generated";
import { COPY_LINK_PATH, COPY_WHERE_ORDER } from "../../src/shared/standbyPeers";
import { claimedPort } from "../helpers/claimedPort";
import { scratchDir } from "../helpers/scratchDirs";
import { BUILDER, openDevices, selectDevice } from "./deviceFixtures";
import { FIRST_CONTACT_TIMEOUT_MS } from "./helperContact";
import { type HelperRun, startHelper } from "./helperRun";
import { type LaunchedApp, launchApp } from "./launch";
import { regionShot } from "./pictures";
import { pressKey } from "./windowKeys";

/**
 * Copies that reach each other (docs/devices.md, "Copies that reach each
 * other"), from the captain's ask that every computer keeping a copy of the
 * first mate can reach the others, since a takeover is not possible
 * otherwise. The home is the built app on a scratch data folder; Mac mini
 * and Mac Studio are two work modes in this process, each joined to it as
 * another Mac and listening for the other copy on loopback. The captain
 * keeps a copy on both by keys and opens each one's Ready to take over list.
 * A key that is not on the first mate's list dials Mac mini and is refused.
 * Then the home is killed, and Mac mini still asks Mac Studio where its copy
 * stands, and its status still says it reaches Mac Studio's copy.
 *
 * Promised result: each Ready to take over list says it reaches the other
 * copy; the stranger's dial is refused before any order; with the home gone,
 * Mac Studio answers Mac mini with its own copy's stream, change and home
 * number, and Mac mini's status says it reaches the copy on Mac Studio.
 * Data: a scratch home with its own first launch's record, kept on both.
 * Completion signal: each list's line for the other copy, the refused
 * upgrade's status, the answer and the status lines.
 * Platform prerequisites: none; it runs on Linux and the Mac.
 * Shared resources: the loopback connection each work mode opens, and the
 * loopback listener each opens for the other copy on a claimed port.
 */

const MACBOOK = { INFINITARY_DEVICE_NAME: "MacBook Pro", INFINITARY_JOINS_FROM_ANOTHER_MAC: "1" };

const apps: LaunchedApp[] = [];
const runs: HelperRun[] = [];
test.afterEach(async () => {
  for (const run of runs.splice(0)) await run.stop();
  for (const app of apps.splice(0).reverse()) await app.close().catch(() => {});
});

type Computer = {
  name: string;
  dataDir: string;
  deviceId: string;
  run: HelperRun;
  /** Where it listens for the other copy, and the pin of the key it joined with. */
  listens: string;
  pin: string;
};

/** A computer that runs work for the home, joined as another Mac and running. */
async function computer(home: LaunchedApp, name: string): Promise<Computer> {
  const dataDir = join(scratchDir("infinitary-standby-peer-"), "work");
  const invite = await home.page.evaluate(() => window.infinitary.devices.invite({ kind: "work" }));
  const joined = await joinHome({
    text: invite.link,
    dataDir,
    io: { say: () => {}, ask: async () => "yes" },
    device: { name, user: BUILDER },
    timeoutMs: 5_000,
  });
  if (!joined.ok) throw new Error(joined.reason);
  const port = await claimedPort();
  const started = startHelper({
    dataDir,
    say: () => {},
    retryMs: [50],
    log: () => {},
    copies: { hosts: () => ["127.0.0.1"], port },
  });
  if (!started.ok) throw new Error(started.reason);
  runs.push(started.run);
  await expect
    .poll(() => started.run.state().contact, { timeout: FIRST_CONTACT_TIMEOUT_MS })
    .toBe("in-reach");
  return {
    name,
    dataDir,
    deviceId: joined.grant.deviceId,
    run: started.run,
    listens: `127.0.0.1:${port}`,
    pin: keyPin(new X509Certificate(joined.grant.cert).publicKey),
  };
}

test("computers that keep a copy reach each other, refuse a stranger, and still ask each other with the home gone", async () => {
  test.setTimeout(240_000);
  const pro = await launchApp({
    userDataDir: scratchDir("infinitary-standby-peers-pro-"),
    env: { ...MACBOOK, INFINITARY_CONNECTION_LOOPBACK_PORT: String(await claimedPort()) },
  });
  apps.push(pro);
  const mini = await computer(pro, "Mac mini");
  const studio = await computer(pro, "Mac Studio");
  const rowOf = (there: Computer) => selectDevice(pro.page, there.deviceId);

  await test.step("Keep a copy here on both rows, by keys: each Ready to take over list says it reaches the other copy", async () => {
    await openDevices(pro.page);
    for (const there of [mini, studio])
      await pressKey(
        (await rowOf(there)).getByRole("button", {
          name: m.settingsDevicesStandbyKeepNamed({ device: there.name }),
        }),
        "Enter",
      );
    for (const there of [mini, studio])
      await expect((await rowOf(there)).locator("[data-standby]")).toHaveAttribute(
        "data-standby",
        "in-sync",
        { timeout: 60_000 },
      );
    for (const [here, other] of [
      [mini, studio],
      [studio, mini],
    ] as const) {
      const ready = pro.page.locator(`[data-standby-ready="${here.deviceId}"]`);
      const line = ready.locator(`[data-gap="peer-${other.deviceId}"]`);
      // The other copy's address reaches this one in the record, so the line may first say it has not heard.
      await expect(async () => {
        if ((await ready.count()) === 0)
          await pressKey(
            (await rowOf(here)).getByRole("button", {
              name: m.settingsDevicesStandbyReadyNamed({ device: here.name }),
            }),
            "Enter",
          );
        try {
          await expect(line).toHaveAttribute("data-level", "notes", { timeout: 1_000 });
        } catch (error) {
          await pressKey(
            ready.getByRole("button", { name: m.settingsDevicesStandbyClose() }),
            "Enter",
          );
          throw error;
        }
      }).toPass({ timeout: 60_000 });
      await expect(line).toHaveText(STANDBY_WORDS.peerReaches(here.name, other.name));
      await pro.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await regionShot(ready, test.info().outputPath(`standby-peers-${here.name}.png`));
      await pressKey(ready.getByRole("button", { name: m.settingsDevicesStandbyClose() }), "Enter");
      await expect(ready).toHaveCount(0);
    }
  });

  await test.step("a key not on the first mate's list dials Mac mini's copy and is refused before any order", async () => {
    // Pinned to Mac mini's own key, as another copy dials it, but showing a stranger's.
    const socket = await pinnedSocket(
      { address: mini.listens },
      mini.pin,
      createKeyIdentity("Firstmate device"),
      { relay: null },
    );
    const ws = new WebSocket(homeSocketUrl(mini.listens, COPY_LINK_PATH), {
      createConnection: () => socket,
      perMessageDeflate: false,
    });
    const status = await new Promise<number>((resolve) => {
      ws.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
      ws.once("open", () => resolve(101));
      ws.once("error", () => resolve(0));
    });
    ws.terminate();
    expect(status).toBe(401);
  });

  await test.step("the home is killed: Mac mini still asks Mac Studio where its copy stands, and its status says it reaches it", async () => {
    const killed = pro.app.process();
    const ended = new Promise<void>((resolve) => {
      if (killed.exitCode !== null || killed.signalCode !== null) resolve();
      else killed.once("exit", () => resolve());
    });
    killed.kill("SIGKILL");
    await ended;
    for (const there of [mini, studio])
      await expect.poll(() => there.run.state().contact, { timeout: 60_000 }).not.toBe("in-reach");
    const answer = await mini.run.askCopy(studio.deviceId, COPY_WHERE_ORDER, []);
    expect(answer).toEqual({
      ...readStandbyState(studio.dataDir),
      homeNumber: new JoinedHome(studio.dataDir, () => {}).homeNumber(),
    });
    expect((answer as { stream: string }).stream).toBe(readStandbyState(mini.dataDir).stream);
    expect(helperStatus(mini.dataDir)).toContain(helperWords.copyPeer(studio.name, "in-reach"));
    expect(helperStatus(studio.dataDir)).toContain(helperWords.copyPeer(mini.name, "in-reach"));
  });
});
