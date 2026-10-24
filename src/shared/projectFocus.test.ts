import { describe, expect, it } from "vitest";
import { heldFocus, pillShown, projectPillsOf, waitingElsewhere } from "./projectFocus";
import type { ProjectView, TaskView } from "./tasks";

/**
 * Which projects get a pill and what each counts (INF-1091: every project
 * set up in Settings in board order, Scratch while it has tasks, a pill's
 * counts the collapsed Tasks panel's; the mono tail "N waiting elsewhere").
 */

const repo = { name: "kunchenguid/infinitary", delivery: "direct-pr", autonomy: false } as const;
const counts = { needsYou: 0, waitingOnYou: 0, open: 0, active: 0, doneRecent: 0 };

function project(id: string, key: string, name: string, more: Partial<ProjectView> = {}) {
  return { id, key, name, repo, archived: false, counts, ...more } as ProjectView;
}

function task(id: string, projectId: string, more: Partial<TaskView> = {}) {
  return {
    id,
    projectId,
    kind: "work",
    status: "active",
    requiredAction: null,
    waitingCardId: null,
    minimizedCardId: null,
    captainWait: null,
    startPolicy: "when-ready",
    startAttempt: null,
    activity: "working",
    ...more,
  } as TaskView;
}

const app = project("p-app", "INF", "infinitary");
const site = project("p-site", "WEB", "website");
const scratch = project("p-scratch", "SCR", "Scratch", { repo: null });
const old = project("p-old", "OLD", "old-site", { archived: true });

describe("projectPillsOf", () => {
  it("counts each project's waiting and working tasks the way the Tasks summary does", () => {
    const pills = projectPillsOf({
      projects: [app, site],
      tasks: [
        task("a1", "p-app"),
        task("a2", "p-app", { waitingCardId: "card-merge" }),
        task("a3", "p-app", { status: "open", startPolicy: "on-request", activity: null }),
        task("s1", "p-site", { status: "done", activity: null }),
      ],
    });
    expect(pills).toEqual({
      projects: [
        { id: "p-app", key: "INF", name: "infinitary", waiting: 1, working: 1 },
        { id: "p-site", key: "WEB", name: "website", waiting: 0, working: 0 },
      ],
      waiting: 1,
      working: 1,
    });
  });

  it("keeps Scratch only while it has a task, and never an archived project", () => {
    expect(
      projectPillsOf({ projects: [app, scratch, old], tasks: [] }).projects.map((p) => p.key),
    ).toEqual(["INF"]);
    const withScratch = projectPillsOf({
      projects: [app, scratch, old],
      tasks: [task("x1", "p-scratch"), task("o1", "p-old")],
    });
    expect(withScratch.projects.map((p) => p.key)).toEqual(["INF", "SCR"]);
  });
});

describe("the focus that holds", () => {
  const two = projectPillsOf({ projects: [app, site], tasks: [] });
  const one = projectPillsOf({ projects: [app], tasks: [] });

  it("shows the pill only with a choice of two projects or more", () => {
    expect(pillShown(two)).toBe(true);
    expect(pillShown(one)).toBe(false);
  });

  it("holds the saved project while it has a pill, and lets go when it is gone or the pill hides", () => {
    expect(heldFocus("p-site", two)).toBe("p-site");
    expect(heldFocus(null, two)).toBeNull();
    expect(heldFocus("p-gone", two)).toBeNull();
    expect(heldFocus("p-app", one)).toBeNull();
  });

  it("counts what waits on the captain in the other projects for the tail", () => {
    const pills = projectPillsOf({
      projects: [app, site],
      tasks: [
        task("a1", "p-app", { waitingCardId: "c1" }),
        task("s1", "p-site", { waitingCardId: "c2" }),
        task("s2", "p-site", { waitingCardId: "c3" }),
      ],
    });
    expect(waitingElsewhere(pills, "p-app")).toBe(2);
    expect(waitingElsewhere(pills, "p-site")).toBe(1);
    expect(waitingElsewhere(pills, null)).toBe(0);
  });
});
