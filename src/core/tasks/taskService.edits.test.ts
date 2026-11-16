import { describe, expect, it } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { seedTask } from "./seedTask";
import { TaskService } from "./taskService";

/**
 * The edits `update_task` makes to a task's shape, pinned before the task
 * service splits into its owners and its shape-replace pattern folds into
 * one (INF-2625's plan, the task service row). Each edit replaces one key of
 * the shape and must leave every other key standing, and work that started
 * refuses the edits only unstarted work takes (`UpdateTaskPatch`'s own
 * documentation).
 */
function setup() {
  const db = freshDatabase();
  let now = 1_000;
  const tasks = new TaskService({ db, now: () => now, strict: true });
  return { tasks, tick: (ms = 1) => (now += ms) };
}

const requirements = { systems: ["macos" as const], tools: ["xcodebuild"] };
const resultSchema = { type: "object", properties: { url: { type: "string" } } };

function unstarted(tasks: TaskService) {
  return seedTask(tasks, { id: "build", title: "Build the export", status: "queued" });
}

describe("editing an unstarted task's shape", () => {
  it("sets every shape edit in one update and names each change in order", () => {
    const { tasks } = setup();
    unstarted(tasks);

    const changes = tasks.updateFields(
      "build",
      {
        placementRequirements: requirements,
        resultSchema,
        internalStep: true,
        speed: "fast",
        reasoning: "high",
        model: "claude-opus-5-5",
        runsOn: { ask: "this-mac", words: "This Mac" },
      },
      "firstmate",
    );

    expect(changes).toEqual([
      "computer requirements updated",
      "result shape set",
      "marked an internal step",
      "crew speed fast",
      "reasoning high",
      "model claude-opus-5-5",
      "Runs on: This Mac",
    ]);
    expect(tasks.get("build")?.shape).toMatchObject({
      placement_requirements: requirements,
      result_schema: resultSchema,
      internal_step: true,
      override_speed: "fast",
      override_reasoning: "high",
      override_model_id: "claude-opus-5-5",
      runs_on_ask: "this-mac",
    });
    expect(tasks.timeline("build").at(-1)).toMatchObject({
      actor: "firstmate",
      kind: "note",
      text: `updated: ${changes.join(", ")}`,
    });
  });

  it("clears each edit alone and keeps the others", () => {
    const { tasks } = setup();
    unstarted(tasks);
    tasks.updateFields(
      "build",
      {
        placementRequirements: requirements,
        resultSchema,
        internalStep: true,
        speed: "fast",
        reasoning: "high",
        model: "claude-opus-5-5",
        runsOn: { ask: "this-mac", words: "This Mac" },
      },
      "firstmate",
    );
    const cleared = [
      [{ placementRequirements: null }, "placement_requirements", "computer requirements updated"],
      [{ resultSchema: null }, "result_schema", "result shape cleared"],
      [{ internalStep: false }, "internal_step", "internal step cleared"],
      [{ speed: null }, "override_speed", "crew speed follows the model default"],
      [{ reasoning: null }, "override_reasoning", "reasoning follows Models"],
      [{ model: "" }, "override_model_id", "model cleared"],
      [
        { runsOn: { ask: null, words: "Follows its project" } },
        "runs_on_ask",
        "Runs on: Follows its project",
      ],
    ] as const;
    const gone: string[] = [];

    for (const [patch, key, words] of cleared) {
      expect(tasks.updateFields("build", patch, "firstmate")).toEqual([words]);
      gone.push(key);
      const shape = (tasks.get("build")?.shape ?? {}) as Record<string, unknown>;
      for (const [, other] of cleared) {
        if (gone.includes(other)) expect(shape).not.toHaveProperty(other);
        else expect(shape).toHaveProperty(other);
      }
    }
  });

  it("names the standing direction behind an edit", () => {
    const { tasks } = setup();
    unstarted(tasks);

    expect(
      tasks.updateFields("build", { speed: "ultrafast", direction: "d:d-fast" }, "firstmate"),
    ).toEqual(["crew speed ultrafast, from d:d-fast"]);
  });

  it("writes nothing when an edit matches what is there", () => {
    const { tasks } = setup();
    unstarted(tasks);
    tasks.updateFields("build", { internalStep: true, reasoning: "low" }, "firstmate");
    const events = tasks.timeline("build").length;

    expect(
      tasks.updateFields(
        "build",
        { internalStep: true, reasoning: "low", branchFrom: "", title: "Build the export" },
        "firstmate",
      ),
    ).toEqual([]);
    expect(tasks.timeline("build")).toHaveLength(events);
  });

  it("records the task unstarted work branches from, and clears it", () => {
    const { tasks } = setup();
    seedTask(tasks, { id: "base", title: "Lay the base", status: "queued" });
    unstarted(tasks);
    const base = tasks.get("base");
    const ref = base?.key || "base";

    expect(tasks.updateFields("build", { branchFrom: ref }, "firstmate")).toEqual([
      `branches from ${ref}`,
    ]);
    expect(tasks.get("build")?.shape?.branch_from).toBe(ref);

    expect(tasks.updateFields("build", { branchFrom: "  " }, "firstmate")).toEqual([
      "branch_from cleared",
    ]);
    expect(tasks.get("build")?.shape?.branch_from).toBeUndefined();
  });
});

describe("editing a started task's shape", () => {
  function started(tasks: TaskService) {
    return seedTask(tasks, {
      id: "build",
      title: "Build the export",
      status: "running",
      worktreeDir: "/work/build",
      branch: "task/build",
    });
  }

  it.each([
    [
      { placementRequirements: requirements },
      "Computer requirements can change only before the task starts.",
    ],
    [
      { resultSchema },
      "A result shape, branch_from or branch can only change on open work that has not started.",
    ],
    [
      { branchFrom: "base" },
      "A result shape, branch_from or branch can only change on open work that has not started.",
    ],
    [{ internalStep: true }, "internal_step can only change on open work that has not started."],
    [
      { model: "claude-opus-5-5" },
      "A model can only be named on open work that no crewmate has taken.",
    ],
    [
      { reasoning: "high" as const },
      "A reasoning effort can only be named on open work that no crewmate has taken.",
    ],
    [
      { runsOn: { ask: "this-mac", words: "This Mac" } },
      "Where a task runs can change only before it starts; a started task finishes where it started.",
    ],
    [
      { programBound: 3 },
      "program_bound changes only an open program's bound, to a whole number of at least 1.",
    ],
  ])("refuses %o", (patch, refusal) => {
    const { tasks } = setup();
    started(tasks);
    const before = tasks.get("build");

    expect(() => tasks.updateFields("build", patch, "firstmate")).toThrow(refusal);
    expect(tasks.get("build")).toEqual(before);
  });

  it("still changes crew speed on started work", () => {
    const { tasks } = setup();
    started(tasks);

    expect(tasks.updateFields("build", { speed: "fast" }, "captain")).toEqual(["crew speed fast"]);
    expect(tasks.get("build")?.shape?.override_speed).toBe("fast");
  });

  it("refuses crew speed on finished work", () => {
    const { tasks } = setup();
    unstarted(tasks);
    tasks.close("build", { status: "done", reason: "settled", actor: "host" });

    expect(() => tasks.updateFields("build", { speed: "fast" }, "captain")).toThrow(
      "Crew speed can only change on unfinished work.",
    );
  });
});

describe("moving a task by update", () => {
  it("refuses a project it does not know", () => {
    const { tasks } = setup();
    unstarted(tasks);

    expect(() => tasks.updateFields("build", { project: "NOPE" }, "firstmate")).toThrow(
      'Unknown project "NOPE".',
    );
  });

  it("refuses a parent it does not know", () => {
    const { tasks } = setup();
    unstarted(tasks);

    expect(() => tasks.updateFields("build", { parent: "missing" }, "firstmate")).toThrow(
      'Unknown parent "missing".',
    );
  });
});
