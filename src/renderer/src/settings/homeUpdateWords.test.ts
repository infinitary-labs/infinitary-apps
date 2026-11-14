import type { HomeUpdate } from "@shared/homeUpdate";
import { describe, expect, it } from "vitest";
import {
  homeUpdateAboutToRestart,
  homeUpdateConfirm,
  homeUpdateLine,
  homeUpdateOffersUpdate,
  homeUpdateUnderWay,
} from "./homeUpdateWords";

/**
 * INF-4012 direction 1, the captain's "1 and 2 together": on a Mac that
 * controls another, Settings → General says where the first mate's
 * computer's update stands and what Update would stop there, from the
 * home's own answer (docs/view.md, "Updating the first mate's computer").
 */

const OFFERED: HomeUpdate = {
  version: "0.7.2-alpha.585",
  channel: "alpha",
  offered: "0.7.2-alpha.590",
  step: "offered",
  waitingFor: [],
  stops: { tasks: ["Fix the footer", "Plan the release"], jobs: 1 },
  problem: null,
};

describe("the first mate's computer's update row", () => {
  it("offers Update only for a version the home installs from afar", () => {
    expect(homeUpdateLine(OFFERED, "Mac mini")).toBe("Mac mini has 0.7.2-alpha.590 ready.");
    expect(homeUpdateOffersUpdate(OFFERED)).toBe(true);
    const elsewhere: HomeUpdate = {
      ...OFFERED,
      offered: null,
      step: "elsewhere",
      problem: "This copy is updated at the computer itself, not from afar.",
    };
    expect(homeUpdateOffersUpdate(elsewhere)).toBe(false);
    expect(homeUpdateLine(elsewhere, "Mac mini")).toBe(elsewhere.problem);
    const failed: HomeUpdate = { ...OFFERED, step: "failed", problem: "The download stopped." };
    expect(homeUpdateOffersUpdate(failed)).toBe(true);
    expect(homeUpdateLine(failed, "Mac mini")).toBe(
      "The update on Mac mini did not finish. The download stopped.",
    );
  });

  it("confirms against the running work, the jobs and that nothing undoes it from here", () => {
    expect(homeUpdateConfirm(OFFERED, "Mac mini")).toEqual({
      title: "Update Mac mini to 0.7.2-alpha.590?",
      lines: [
        "Running work finishes first, then carries on after the restart: Fix the footer and Plan the release.",
        "Background jobs that stop at the restart: 1.",
        "If the new version does not start, someone needs to be at Mac mini. It cannot be undone from here.",
      ],
    });
    const idle = { ...OFFERED, stops: { tasks: [], jobs: 0 } };
    expect(homeUpdateConfirm(idle, "Mac mini").lines).toEqual([
      "No crewmate is running work there now.",
      "If the new version does not start, someone needs to be at Mac mini. It cannot be undone from here.",
    ]);
  });

  it("follows the update as it saves work and restarts, and shows the version for a step it does not know", () => {
    const saving: HomeUpdate = { ...OFFERED, step: "saving", waitingFor: ["Fix the footer"] };
    expect(homeUpdateLine(saving, "Mac mini")).toBe(
      "Saving work on Mac mini. Waiting for Fix the footer to finish what is running.",
    );
    expect([homeUpdateUnderWay(saving), homeUpdateAboutToRestart(saving)]).toEqual([true, true]);
    expect(homeUpdateOffersUpdate(saving)).toBe(false);
    const restarting = { ...OFFERED, step: "restarting" };
    expect(homeUpdateLine(restarting, "Mac mini")).toBe("Restarting Mac mini.");
    expect(homeUpdateAboutToRestart(restarting)).toBe(true);
    const later = { ...OFFERED, step: "verifying" };
    expect(homeUpdateLine(later, "Mac mini")).toBe("0.7.2-alpha.585");
    expect(homeUpdateLine({ ...OFFERED, offered: null, step: "current" }, "Mac mini")).toBe(
      "0.7.2-alpha.585, up to date.",
    );
    expect([homeUpdateUnderWay(later), homeUpdateOffersUpdate(later)]).toEqual([false, false]);
  });
});
