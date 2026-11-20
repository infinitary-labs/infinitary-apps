import { join } from "node:path";
import { createServer as createTlsServer } from "node:tls";
import { expect, test } from "@playwright/test";
import { createKeyIdentity } from "../../src/core/devices/identity";
import { JoinedHome } from "../../src/core/devices/joinedHome";
import { claimedPort } from "../helpers/claimedPort";
import { standInHomeAnnouncements } from "../helpers/dnsSdStandIn";
import { scratchDir } from "../helpers/scratchDirs";
import { type LaunchedApp, launchApp } from "./launch";

/**
 * A Mac controlling another finds it again after its address moved (INF-4207
 * piece 1, "Find the home on any route": a window keeps every address the home
 * offers and, once none answers, listens for the home's announcement on the
 * local network, checking each route against the home's key; docs/devices.md,
 * "Finding the home again"). The Mac where Firstmate lives starts again at
 * another port, as when its network changed; no address the view keeps names
 * it. The view's dns-sd is a stand-in that hears only what the journey
 * announces, so nothing listens on this Mac's own network: first another
 * computer with a key of its own, which the view must refuse, then the home
 * at its new address, which the view must come back to and keep.
 */

/** Another computer announcing Infinitary: TLS with a key of its own, counting every dial. */
async function anotherComputer() {
  const other = createKeyIdentity("Another computer");
  let dialed = 0;
  const server = createTlsServer(
    { key: other.key, cert: other.cert, minVersion: "TLSv1.3" },
    (socket) => socket.on("error", () => {}),
  );
  server.on("connection", () => {
    dialed += 1;
  });
  server.on("tlsClientError", () => {});
  const port = await claimedPort();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    at: `127.0.0.1:${port}`,
    dialed: () => dialed,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("a Mac controlling another finds it at its new address by its announcement, and never takes another computer for it", async () => {
  test.setTimeout(180_000);
  const opened: LaunchedApp[] = [];
  const stranger = await anotherComputer();
  const announcements = standInHomeAnnouncements();
  const proDir = scratchDir("infinitary-home-moved-pro-");
  try {
    const pro = await launchApp({
      userDataDir: proDir,
      env: { INFINITARY_DEVICE_NAME: "MacBook Pro" },
    });
    opened.push(pro);
    const invite = await pro.page.evaluate(() => window.infinitary.devices.invite({ kind: "mac" }));
    const air = await launchApp({
      env: { INFINITARY_DEVICE_NAME: "MacBook Air", INFINITARY_DNS_SD: announcements.program },
    });
    opened.push(air);
    // Joining starts the window over, so its answer may never return to this page.
    await air.page.evaluate((link) => {
      void window.infinitary.devices.join(link);
    }, invite.link);
    const contact = air.page.locator("[data-remote-control]");
    await expect(contact).toHaveAttribute("data-remote-control", "in-reach");
    const devicesBefore = (await pro.page.evaluate(() => window.infinitary.devices.list())).map(
      (device) => device.id,
    );
    const kept = () => new JoinedHome(join(air.userDataDir, "joined"), () => {}).read()?.grant;
    const keptBefore = kept();
    expect(keptBefore?.at).toBeTruthy();

    await test.step("another computer announcing Infinitary is dialed and refused while the home is away", async () => {
      await pro.close();
      announcements.announce([{ name: "MacBook Pro", at: stranger.at }]);
      await expect(contact).not.toHaveAttribute("data-remote-control", "in-reach");
      await expect.poll(stranger.dialed, { timeout: 60_000 }).toBeGreaterThan(0);
      await expect(contact).not.toHaveAttribute("data-remote-control", "in-reach");
      // Nothing of the other computer is kept as a way to the home.
      const grant = kept();
      expect(grant?.at).toBe(keptBefore?.at);
      expect(grant?.also ?? []).not.toContain(stranger.at);
    });

    await test.step("the home starts again at another address and the view comes back to it there", async () => {
      const port = String(await claimedPort());
      const moved = await launchApp({
        userDataDir: proDir,
        env: { INFINITARY_DEVICE_NAME: "MacBook Pro", INFINITARY_CONNECTION_LOOPBACK_PORT: port },
      });
      opened.push(moved);
      const at = `127.0.0.1:${port}`;
      expect(keptBefore?.at).not.toBe(at);
      expect(keptBefore?.also ?? []).not.toContain(at);
      announcements.announce([{ name: "MacBook Pro", at }]);
      await expect(contact).toHaveAttribute("data-remote-control", "in-reach", {
        timeout: 90_000,
      });
      // The view keeps the address that answered, dialed first next time.
      await expect.poll(() => kept()?.at).toBe(at);
      // The same view, under the same name: the home paired nothing new.
      const devicesAfter = (await moved.page.evaluate(() => window.infinitary.devices.list())).map(
        (device) => device.id,
      );
      expect(devicesAfter).toEqual(devicesBefore);
    });
  } finally {
    for (const app of opened.reverse()) await app.close();
    await stranger.close();
  }
});
