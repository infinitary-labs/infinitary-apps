import type { AppFollowReport } from "@shared/appFollow";
import { type DeviceView, deviceViewSchema } from "@shared/devices";
import { appUpdateCardId, deviceUpdateCardId } from "@shared/deviceUpdateNudge";
import { describe, expect, it } from "vitest";
import { DeviceUpdateNudge } from "./deviceUpdateNudge";

// INF-5372's plan, piece 2: an app on another computer updates by itself, "falling back to the
// existing per-computer card when it cannot".

/** A MacBook Pro whose app is open on 0.8.3 while this computer runs 0.8.4, and what it said. */
const macBook = (follow?: AppFollowReport, app = "0.8.3"): DeviceView =>
  deviceViewSchema.parse({
    id: "macbook-pro",
    kind: "view",
    name: "MacBook Pro",
    pairedAt: 0,
    system: "macos",
    appVersion:
      app === "0.8.4" ? { app, same: true } : { app, than: "older", ...(follow ? { follow } : {}) },
  });

function home() {
  const raised = new Map<string, { title: string; body: string; actions: unknown[] }>();
  const withdrawn: string[] = [];
  const chosen = new Map<string, string>();
  const nudge = new DeviceUpdateNudge({
    devices: () => [],
    homeApp: () => "0.8.4",
    update: async () => {
      throw new Error("The app card never updates a computer's work.");
    },
    broadcastEvent: () => {},
    cards: {
      raise: (card) => {
        raised.set(card.id, card as never);
      },
      withdraw: (id) => {
        if (raised.delete(id)) withdrawn.push(id);
      },
      has: (id) => raised.has(id),
      chosenAction: (id) => chosen.get(id),
    },
  });
  return { nudge, raised, withdrawn, chosen };
}

const ID = appUpdateCardId("macbook-pro");

describe("the card for an app that cannot follow this computer's version by itself", () => {
  it("raises no card while the app follows by itself", () => {
    const h = home();
    h.nudge.appsChanged([macBook({ version: "0.8.4", step: "getting", percent: 10 })]);
    h.nudge.appsChanged([macBook({ version: "0.8.4", step: "waiting" })]);
    expect(h.raised.size).toBe(0);
  });

  it("asks for it there when the app cannot, and says why, with nothing to press here but Got it", () => {
    const h = home();
    h.nudge.appsChanged([macBook({ version: "0.8.4", step: "cannot", reason: "package-manager" })]);
    const card = h.raised.get(ID);
    expect(card?.title).toBe("Update the app on MacBook Pro");
    expect(card?.body).toContain("Infinitary 0.8.3");
    expect(card?.body).toContain("package manager");
    expect(card?.actions).toEqual([
      expect.objectContaining({ id: "not-now@app:0.8.4>0.8.3:cannot", label: "Got it" }),
    ]);
  });

  it("offers Devices, where Update app tries again, once following did not go through", () => {
    const h = home();
    h.nudge.appsChanged([
      macBook({ version: "0.8.4", step: "failed", problem: "The network went away." }),
    ]);
    const card = h.raised.get(ID);
    expect(card?.body).toContain("The network went away.");
    expect(card?.actions).toEqual([
      expect.objectContaining({
        label: "Open Devices",
        effect: { kind: "open", target: "devices" },
      }),
      expect.objectContaining({ label: "Not now" }),
    ]);
  });

  it("comes down once the app runs this computer's version, and Not now holds it for that gap", () => {
    const h = home();
    const cannot = macBook({ version: "0.8.4", step: "cannot", reason: "own-window" });
    h.nudge.appsChanged([cannot]);
    h.nudge.appsChanged([macBook(undefined, "0.8.4")]);
    expect(h.withdrawn).toEqual([ID]);

    h.chosen.set(ID, "not-now@app:0.8.4>0.8.3:cannot");
    h.nudge.appsChanged([cannot]);
    expect(h.raised.size).toBe(0);
  });
});

// INF-5635's plan, piece 3: "ask once per computer before it first runs source, then follow by
// itself".
describe("matching a computer to this computer's source", () => {
  const COMMIT = "c".repeat(40);
  const mini = deviceViewSchema.parse({
    id: "mac-mini",
    kind: "work",
    name: "Mac mini",
    pairedAt: 0,
    system: "macos",
    inReach: true,
    otherVersion: {
      app: "0.8.6-alpha.16",
      takesWork: true,
      updateBy: "connection",
      source: { commit: COMMIT },
    },
  });

  function sourceHome(allowed: boolean) {
    const raised = new Map<string, { title: string; body: string; actions: unknown[] }>();
    const chosen = new Map<string, string>();
    const updates: string[] = [];
    // A match that went through brings it to this computer's commit.
    let listed: DeviceView = mini;
    const nudge = new DeviceUpdateNudge({
      devices: () => [listed],
      homeApp: () => undefined,
      sourceAllowed: () => allowed,
      update: async (deviceId) => {
        updates.push(deviceId);
        const { otherVersion: _matched, ...matched } = mini;
        listed = matched;
        return listed;
      },
      broadcastEvent: () => {},
      cards: {
        raise: (card) => {
          raised.set(card.id, card as never);
        },
        withdraw: (id) => {
          raised.delete(id);
        },
        has: (id) => raised.has(id),
        chosenAction: (id) => chosen.get(id),
      },
    });
    return { nudge, raised, chosen, updates };
  }

  it("asks once on a card before a computer first runs source, and Not now holds it for that commit", () => {
    const h = sourceHome(false);
    h.nudge.refresh("mac-mini");
    expect(h.updates).toEqual([]);
    const card = h.raised.get(deviceUpdateCardId("mac-mini"));
    expect(card?.title).toBe("Run this computer's code on Mac mini?");
    expect(card?.body).toContain("cccccc");
    expect(card?.actions).toEqual([
      expect.objectContaining({
        id: `update@source:${COMMIT}`,
        label: "Match it",
        effect: { kind: "open", target: "devices", update: "mac-mini" },
      }),
      expect.objectContaining({ id: `not-now@source:${COMMIT}`, label: "Not now" }),
    ]);
    h.raised.clear();
    h.chosen.set(deviceUpdateCardId("mac-mini"), `not-now@source:${COMMIT}`);
    h.nudge.refresh("mac-mini");
    expect(h.raised.size).toBe(0);
  });

  it("matches a computer the captain allowed by itself, with no card", async () => {
    const h = sourceHome(true);
    h.nudge.refresh("mac-mini");
    await new Promise((resolve) => setImmediate(resolve));
    h.nudge.refresh("mac-mini");
    expect(h.updates).toEqual(["mac-mini"]);
    expect(h.raised.size).toBe(0);
  });
});
