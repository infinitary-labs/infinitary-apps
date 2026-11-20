import { describe, expect, it } from "vitest";
import { entryWorking } from "./entryWorking";

/**
 * The docked request's thread shows its crewmate working while it answers a
 * reply written beside the page (INF-4578), not the line saying it has not
 * answered yet.
 */
describe("entryWorking", () => {
  it("reads a browser view's working from its task's crewmate", () => {
    const browserView = { author: "host" as const, browserTaskId: "t1" };
    expect(entryWorking(browserView, false, { t1: "running" })).toBe(true);
    expect(entryWorking(browserView, false, { t1: "idle" })).toBe(false);
  });

  it("reads a crewmate's card from its own task and a first mate card from the first mate", () => {
    expect(entryWorking({ author: "crewmate", taskId: "t2" }, false, { t2: "starting" })).toBe(
      true,
    );
    expect(entryWorking({ author: "firstmate", taskId: "t2" }, true, { t2: "idle" })).toBe(true);
  });
});
