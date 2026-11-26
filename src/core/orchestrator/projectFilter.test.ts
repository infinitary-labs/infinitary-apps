import { describe, expect, it } from "vitest";
import { asAView } from "../askedFromAView";
import { CaptainPlaces } from "../devices/captainPlaces";
import { projectFilterOf } from "./projectFilter";

/**
 * The filter a message says (INF-6860, the captain's answer to question 2:
 * "Every project: say it came from the phone, which shows them all").
 */
const MINI = { id: "device-mini", name: "Sam's Mac mini", system: "macos" as const };
const PHONE = { id: "device-phone", name: "Sam's iPhone", system: "ios" as const };
const places = new CaptainPlaces({ devices: () => [MINI, PHONE], now: () => 1_000 });

function filterFrom(view: string | undefined, message: Parameters<typeof projectFilterOf>[0]) {
  const read = () => projectFilterOf(message, places.fromPhone());
  return view ? asAView(read, { view }) : read();
}

describe("the project filter a message says", () => {
  it("names the window's project, here or from a Mac that controls this one", () => {
    expect(filterFrom(undefined, { focusedProjectId: "project-site" })).toEqual({
      project: "project-site",
    });
    expect(filterFrom(MINI.id, { focusedProjectId: "project-site" })).toEqual({
      project: "project-site",
    });
  });

  it("says All projects, or none from a window with nothing to pick", () => {
    expect(filterFrom(undefined, { allProjects: true })).toBe("all");
    expect(filterFrom(undefined, "fix the login bug")).toBeNull();
  });

  it("says a phone message covers every project, whatever it carries", () => {
    expect(filterFrom(PHONE.id, "what's waiting on me?")).toBe("phone");
    expect(filterFrom(PHONE.id, { focusedProjectId: "project-site" })).toBe("phone");
  });
});
