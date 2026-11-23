import { deviceLabel } from "@shared/devices";
import { remoteLoginWords } from "@shared/remoteLogin";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeEach, home, server, standInBundle } from "../../../tests/helpers/remoteLoginHome";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { SSH_SERVER_AVAILABLE } from "../../../tests/helpers/sshServer";
import type { TypedWake } from "../orchestrator/wakes";
import { CardAdds } from "./cardAdds";

/**
 * How an add the first mate's card began ends, as the first mate hears it
 * (INF-6043's change 4: a user pressed the card's Add it, the add was refused
 * at the key read, and the first mate never heard). The home is
 * `tests/helpers/remoteLoginHome.ts`: the real add over this computer's own
 * ssh against a real SSH server, and a stand-in Infinitary it sends.
 */

// Real processes: sshd, ssh, tar and curl (docs/test-cohorts.md "Budgets").
vi.setConfig({ testTimeout: 30_000 });

afterEach(closeEach);

/** The card's click as the card's action answers it: Settings -> Devices adds this address on arrival. */
const cardClick = (add: string) => ({ effect: { kind: "open", target: "devices", add } });

describe.runIf(SSH_SERVER_AVAILABLE)("the first mate hears how an add its card began ended", () => {
  it("tells it once the computer is on the list, after the check line, and never for an add typed in Settings", async () => {
    const sshd = await server();
    sshd.knownHosts("unknown");
    const adds = new CardAdds();
    const told: TypedWake[] = [];
    adds.attach((wake) => told.push(wake));
    const at = await home({
      ssh: sshd.ssh(),
      bundle: standInBundle(`${scratchDir("infinitary-card-add-")}/started`),
      hears: (event) => adds.heard(event),
    });
    const add = (options = {}) =>
      adds.watch(sshd.address, () => at.remote.addOrAsk(sshd.address, options));

    // An add typed in Settings with no card is the captain's own.
    const own = await add();
    expect(own).toMatchObject({ asks: "confirm" });
    expect(told).toEqual([]);

    adds.chose(cardClick(sshd.address));
    const asked = await add();
    if (!("asks" in asked) || asked.asks !== "confirm") throw new Error("No check line asked.");
    // The check line is a question on the way, not the add's end.
    expect(told).toEqual([]);
    const device = await add({ confirm: asked.line });
    if ("asks" in device) throw new Error(`Asked ${device.asks}.`);
    const finished = at.said
      .filter((event) => event.doing === "add" && event.stage === "done")
      .map((event) => event.text);
    expect(finished.length).toBeGreaterThan(0);
    expect(told).toEqual([
      {
        facts: {
          kind: "device-add",
          address: sshd.address,
          outcome: "added",
          name: deviceLabel(device),
          deviceId: device.id,
          lines: finished,
        },
      },
    ]);

    // Told once: a later add at that address is the captain's own again.
    await add().catch(() => undefined);
    expect(told).toHaveLength(1);
  });

  it("tells it the refusal's two lines when the computer cannot be reached, and nothing for a second press while it runs", async () => {
    const sshd = await server();
    const adds = new CardAdds();
    const told: TypedWake[] = [];
    adds.attach((wake) => told.push(wake));
    const at = await home({
      ssh: sshd.ssh(),
      bundle: standInBundle(`${scratchDir("infinitary-card-add-")}/started`),
      hears: (event) => adds.heard(event),
    });
    const address = "sam@no-such-mac.invalid";
    adds.chose(cardClick(address));
    const add = () => adds.watch(address, () => at.remote.addOrAsk(address));
    const [first, second] = await Promise.allSettled([add(), add()]);
    expect(second).toMatchObject({
      status: "rejected",
      reason: new Error(`${address} is being set up already.`),
    });
    const lines = remoteLoginWords.refused("unreachable", { address, doing: "add" });
    expect(first).toMatchObject({ status: "rejected", reason: { lines } });
    expect(told).toEqual([
      { facts: { kind: "device-add", address, outcome: "refused", lines: [...lines] } },
    ]);
    expect(at.pairing.list()).toEqual([]);
  });
});
