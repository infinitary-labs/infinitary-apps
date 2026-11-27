import type { DeviceView } from "@shared/devices";
import { describe, expect, it } from "vitest";
import { ComputerOrbits, HOME_COMPUTER } from "./computers";
import {
  builtInProject,
  type CrewGroupingInput,
  type GroupProject,
  groupOf,
  groupPlanOf,
} from "./crewGroups";
import { lightFrame, OUT_OF_FOCUS_LIGHT, restedLight } from "./focusLight";

// Grouping the crew animation by project (docs/crew-orbits.md, "Grouping by
// project"), as the captain approved it on INF-6955: the middle ring holds the
// only project of their own with crew, else the focused one; "the default
// built-in projects should always stay with first mate"; an away computer's
// crew keep its frozen group.

const PROJECTS: GroupProject[] = [
  { id: "scratch", name: "Scratch", builtIn: true },
  { id: "workspace", name: "Workspace", builtIn: true },
  { id: "website", name: "website", builtIn: false },
  { id: "shop", name: "shop", builtIn: false },
];
const PROJECT_OF: Record<string, string> = {
  "web-home": "website",
  "web-studio": "website",
  "shop-home": "shop",
  "shop-studio": "shop",
  "scratch-studio": "scratch",
  "workspace-home": "workspace",
  "web-away": "website",
};
const input = (focus: string | null = null): CrewGroupingInput => ({
  grouping: "project",
  projects: PROJECTS,
  projectOf: (id) => PROJECT_OF[id],
  focus,
});
const crewAt = (id: string) => ({
  id,
  computer: id.endsWith("-home") ? HOME_COMPUTER : id.endsWith("-studio") ? "studio" : "away-mac",
  away: id.endsWith("-away"),
});
const groupsOf = (focus: string | null, ids: string[]) => {
  const crew = ids.map(crewAt);
  const plan = groupPlanOf(input(focus), crew);
  if (!plan) throw new Error("Expected a plan");
  return {
    plan,
    groups: Object.fromEntries(crew.map((cm) => [cm.id, groupOf(plan, input(focus), cm)])),
  };
};

describe("the group rule", () => {
  it("names Scratch and the app's own workspace built in, as the project pill does", () => {
    expect(builtInProject({ repo: null })).toBe(true);
    expect(builtInProject({ repo: { kind: "personal" } })).toBe(true);
    expect(builtInProject({ repo: { kind: "project" } })).toBe(false);
    expect(builtInProject({ repo: {} })).toBe(false);
  });

  it("groups by computer while the switch is off", () => {
    expect(groupPlanOf({ ...input(), grouping: "computer" }, [crewAt("web-home")])).toBeNull();
  });

  it("seats the only project of the person's own with crew, and the built-in ones, with the first mate", () => {
    const { plan, groups } = groupsOf(null, [
      "web-home",
      "web-studio",
      "scratch-studio",
      "workspace-home",
    ]);
    expect(plan).toEqual({ middle: "website", groups: [] });
    expect(new Set(Object.values(groups))).toEqual(new Set([HOME_COMPUTER]));
  });

  it("gives each of two projects a group in the board's order, with nothing focused", () => {
    const { plan, groups } = groupsOf(null, ["shop-home", "web-studio", "scratch-studio"]);
    expect(plan).toEqual({
      middle: null,
      groups: [
        { id: "project:website", name: "website" },
        { id: "project:shop", name: "shop" },
      ],
    });
    expect(groups).toEqual({
      "shop-home": "project:shop",
      "web-studio": "project:website",
      "scratch-studio": HOME_COMPUTER,
    });
  });

  it("seats the focused project with the first mate, but never a built-in one", () => {
    expect(groupsOf("shop", ["web-home", "shop-studio"]).groups).toEqual({
      "web-home": "project:website",
      "shop-studio": HOME_COMPUTER,
    });
    expect(groupsOf("scratch", ["web-home", "shop-studio"]).plan.middle).toBeNull();
  });

  it("keeps an away computer's crew in that computer's group", () => {
    const { groups } = groupsOf(null, ["web-home", "shop-studio", "web-away"]);
    expect(groups["web-away"]).toBe("away-mac");
  });

  // The review of this change (F1): a crewmate's spawn reaches the stage
  // before its board row, so a start must not regroup everyone else.
  it("keeps a crewmate whose project the board does not name yet in its computer's group, and the others in theirs", () => {
    const starting = {
      ...input(),
      projectOf: (id: string) => (id === "shop-studio" ? undefined : PROJECT_OF[id]),
    };
    const crew = [crewAt("web-home"), crewAt("shop-home"), crewAt("shop-studio")];
    const plan = groupPlanOf(starting, crew);
    if (!plan) throw new Error("Expected a plan");
    expect(crew.map((cm) => groupOf(plan, starting, cm))).toEqual([
      "project:website",
      "project:shop",
      "studio",
    ]);
  });

  it("groups by computer while the board names no projects", () => {
    expect(groupPlanOf({ ...input(), projects: [] }, [crewAt("web-home")])).toBeNull();
  });
});

const device = (id: string, patch: Partial<DeviceView> = {}): DeviceView => ({
  id,
  kind: "work",
  name: `Computer ${id}`,
  pairedAt: id === "studio" ? 1 : 2,
  inReach: true,
  ...patch,
});
function stage(ids: string[], focus: string | null = null, grouping = input(focus)) {
  const model = new ComputerOrbits(0);
  model.configure([device("studio"), device("away-mac", { inReach: false })]);
  for (const id of ids) {
    const at = crewAt(id).computer;
    model.setPlacement(id, at === HOME_COMPUTER ? null : at);
    model.spawn(id, "working", 0, true, "high");
  }
  model.settleBootRoster(0);
  model.setGrouping(grouping);
  return model;
}
const clusterOf = (model: ComputerOrbits, id: string) =>
  model.update(0, true).crew.find((c) => c.id === id)?.computerId;

describe("the stage grouped by project", () => {
  it("draws one project's crew from two computers in one group named for the project", () => {
    const model = stage(["web-home", "web-studio", "shop-home"]);
    expect(clusterOf(model, "web-home")).toBe("project:website");
    expect(clusterOf(model, "web-studio")).toBe("project:website");
    expect(clusterOf(model, "shop-home")).toBe("project:shop");
    expect(model.clusters().map((c) => [c.id, c.name])).toEqual([
      [HOME_COMPUTER, "This computer"],
      ["project:website", "website"],
      ["project:shop", "shop"],
    ]);
  });

  it("keeps an away computer's frozen group beside the project groups", () => {
    const model = stage(["web-home", "shop-studio", "web-away"]);
    const away = model.clusters().find((c) => c.id === "away-mac");
    expect(away).toMatchObject({ name: "Computer away-mac", reachable: false });
    expect(clusterOf(model, "web-away")).toBe("away-mac");
  });

  it("keeps a starting crewmate on its computer's group until the board names its project", () => {
    const starting = {
      ...input(),
      projectOf: (id: string) => (id === "shop-studio" ? undefined : PROJECT_OF[id]),
    };
    const model = stage(["web-home", "shop-home", "shop-studio"], null, starting);
    expect(clusterOf(model, "web-home")).toBe("project:website");
    expect(clusterOf(model, "shop-studio")).toBe("studio");
    expect(model.clusters().map((c) => c.id)).toEqual([
      HOME_COMPUTER,
      "project:website",
      "project:shop",
      "studio",
    ]);
    model.setGrouping(input());
    expect(clusterOf(model, "shop-studio")).toBe("project:shop");
  });

  it("draws one project's crew on the first mate's own ring alone, as a stage of one computer", () => {
    const model = stage(["web-home", "web-studio"]);
    expect(model.multiple).toBe(false);
    expect(model.clusters()).toEqual([]);
    expect(model.groupOf("web-studio")).toBe(HOME_COMPUTER);
  });

  it("draws a program whose parts run on two computers once, in its project's group", () => {
    const model = stage(["web-home", "web-studio", "shop-home"]);
    const parts = ["web-home", "web-studio"].map((id) => ({ id, state: "live" as const }));
    model.setPrograms([{ id: "program", state: "live", parts }], 0);
    expect(model.update(0, true).programs.filter((p) => p.id === "program")).toHaveLength(1);
    model.setGrouping(null);
    expect(model.update(0, true).programs.filter((p) => p.id === "program")).toHaveLength(2);
  });

  // The review of this change (F2): the approved plan keeps the fall home's
  // path and trip, so the cue must reach the first mate once it lands.
  it("keeps a project group on the stage until its last crewmate's fall home lands", () => {
    const model = stage(["web-home", "shop-home", "shop-studio"]);
    model.update(0);
    model.takeCues();
    model.leave("web-home", "home", 16);
    expect(model.clusters().some((c) => c.id === "project:website")).toBe(true);
    const cues = [];
    for (let now = 32; now < 2000; now += 16) {
      model.update(now);
      cues.push(...model.takeCues());
    }
    expect(model.has("web-home")).toBe(false);
    expect(cues).toContainEqual({ kind: "receive" });
  });

  it("goes back to each computer's group when the switch turns off", () => {
    const model = stage(["web-home", "web-studio", "shop-home"]);
    model.setGrouping(null);
    expect(clusterOf(model, "web-studio")).toBe("studio");
    expect(clusterOf(model, "web-home")).toBe(HOME_COMPUTER);
  });

  it("lights the rested crewmate's computer's crew across every group", () => {
    const model = stage(["web-home", "shop-home", "web-studio"]);
    const frame = model.update(0, true);
    const lit = lightFrame(
      frame,
      restedLight({ project: null, projectOf: (id) => PROJECT_OF[id] }, "web-studio", (id) =>
        model.computerOf(id),
      ),
      new Map(),
      0,
      0,
    );
    const alpha = (f: typeof frame, id: string) =>
      f.crew.find((c) => c.id === id)?.alpha ?? Number.NaN;
    expect(alpha(lit, "web-studio")).toBe(alpha(frame, "web-studio"));
    expect(alpha(lit, "web-home")).toBeCloseTo(alpha(frame, "web-home") * OUT_OF_FOCUS_LIGHT);
    expect(alpha(lit, "shop-home")).toBeCloseTo(alpha(frame, "shop-home") * OUT_OF_FOCUS_LIGHT);
  });
});
