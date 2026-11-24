import type { DeviceView } from "@shared/devices";
import { PROGRAM_ONLY_CHANNELS } from "@shared/ipc";
import { describe, expect, it } from "vitest";
import { asAView } from "../askedFromAView";
import type { CoreServices } from "../coreServices";
import { resetHandlers } from "./resetHandlers";

/**
 * A reset asked from a computer that controls this first mate (docs/reset.md,
 * "From a computer that controls the first mate"): the person confirmed it
 * there, so this computer resets without asking again, and no agent, phone
 * or computer that only runs work can ask it.
 */

function setup(devices: Partial<DeviceView>[], accepts = true) {
  const removed: string[] = [];
  let asked = 0;
  const services = {
    devices: { list: () => devices, remove: async (id: string) => removed.push(id) },
    computers: { list: () => devices },
    vault: { list: () => [] },
    integrations: { view: () => ({ integrations: [] }) },
    tasks: { listLive: () => [] },
    keptRunning: { list: () => ({ jobs: [] }) },
    repos: { list: () => [] },
    paths: { userData: "/nowhere" },
  } as unknown as CoreServices;
  const handlers = resetHandlers(services, {
    resetForController: async () => {
      if (!accepts) throw new Error("Infinitary is still starting.");
      asked += 1;
    },
  });
  return { handlers, removed, asked: () => asked };
}

const laptop = { id: "laptop", kind: "view", system: "macos" } as const;

describe("a reset asked by a controlling computer", () => {
  it("is served only to the program, never the window's page or the command", () => {
    expect(PROGRAM_ONLY_CHANNELS.has("inf:home-reset:start")).toBe(true);
  });

  it("resets this computer and leaves the asking computer paired until it resets itself", async () => {
    const phone = { id: "phone", kind: "view", system: "ios" } as const;
    const { handlers, removed, asked } = setup([laptop, phone]);
    expect(await asAView(() => handlers["inf:home-reset:start"](), { view: "laptop" })).toEqual({
      ok: true,
    });
    expect(asked()).toBe(1);
    await handlers["inf:app:reset-prepare"]();
    expect(removed).toEqual(["phone"]);
  });

  it("keeps no asking computer from an ask this computer did not accept", async () => {
    const { handlers, removed } = setup([laptop], false);
    await expect(
      asAView(() => handlers["inf:home-reset:start"](), { view: "laptop" }),
    ).rejects.toThrow("Infinitary is still starting.");
    await handlers["inf:app:reset-prepare"]();
    expect(removed).toEqual(["laptop"]);
  });

  it("refuses a phone, a computer that only runs work, an unknown view and this computer's own window", async () => {
    const { handlers, asked } = setup([
      { id: "phone", kind: "view", system: "ios" },
      { id: "runner", kind: "work", system: "linux" },
    ]);
    for (const view of ["phone", "runner", "stranger"]) {
      await expect(asAView(() => handlers["inf:home-reset:start"](), { view })).rejects.toThrow(
        "Only a computer that controls this first mate can reset it.",
      );
    }
    await expect(handlers["inf:home-reset:start"]()).rejects.toThrow();
    expect(asked()).toBe(0);
  });

  it("refuses when this computer cannot reset from another one", async () => {
    const services = { devices: { list: () => [laptop] } } as unknown as CoreServices;
    const handlers = resetHandlers(services, {});
    await expect(
      asAView(() => handlers["inf:home-reset:start"](), { view: "laptop" }),
    ).rejects.toThrow("Infinitary cannot reset this computer from another one.");
  });
});
