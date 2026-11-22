import { deviceInviteLine } from "@shared/deviceInvite";
import { describe, expect, it, vi } from "vitest";
import { fakeClockEachTest, setup, tick } from "../../../tests/helpers/firstmateHarness";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/** The first mate agent: which way to add a computer it recommends on each home (tests/helpers/firstmateHarness.ts). */
describe("FirstmateAgent: the way to add a computer", () => {
  fakeClockEachTest();

  // INF-4926's plan: the first mate recommends the address on a home that adds a computer by it,
  // and the link on a Windows PC, which adds none; the card for the address opens the address
  // form, or the link there. The catalog app_state serves on each home is read first. A scripted
  // model stands in for the choice: this shows what the host serves and offers for the home's
  // system, never a real model's pick.
  it("serves the address way on a Mac home and the link on a Windows home, and opens each from its card", async () => {
    const served: Record<string, string> = {};
    for (const platform of ["darwin", "win32"]) {
      const { agent, session, specs, supervisor } = setup({ platform });
      // Each value the general area reads, as the app answers it with nothing set up yet.
      const nothingYet: Record<string, unknown> = {
        "inf:devices:list": [],
        "inf:voice:status": { modelReady: false },
        "inf:release-notes:list": { notes: [] },
        "inf:knowledge:directions": { state: "ready", rows: [] },
        "inf:settings:sharing:get": {
          diagnostics: { enabled: false },
          contribution: { enabled: false },
        },
        "inf:shell:preferences": { panels: { enabled: false } },
      };
      agent.bindAppDispatch(async (channel) => (nothingYet[channel] ?? {}) as never);
      await agent.converse("add my mini");
      const state = specs[0]?.tools.find((entry) => entry.name === "app_state");
      if (!state) throw new Error("Missing app_state");
      const catalog = JSON.parse((await state.run({ area: "general" })).text) as {
        action: string;
        line: string;
      }[];
      const line = catalog.find((entry) => entry.action === "device-invite")?.line ?? "";
      expect(line).toBe(deviceInviteLine(platform === "win32"));
      served[platform] = line;
      const app = specs[0]?.tools.find((entry) => entry.name === "app_change");
      if (!app) throw new Error("Missing app_change");
      await app.run({
        action: "device-invite",
        value: { how: "address", name: "Mac mini" },
        evidence: "add my mini",
      });
      const offered = supervisor.cards
        .snapshot()
        .find((entry) => entry.id.includes("device-invite"));
      const open = offered?.actions.find((action) => action.default);
      expect(supervisor.cardActions.act(offered?.id ?? "", open?.id ?? "")).toEqual(
        platform === "win32"
          ? { effect: { kind: "open", target: "devices", make: "link" } }
          : { effect: { kind: "open", target: "devices", addressForm: true } },
      );
      session.emitTurnEnd("Offered.");
      session.resolveNextPrompt();
      await tick();
    }
    // Each home is served its own recommendation.
    expect(served.darwin).not.toBe(served.win32);
  });
});
