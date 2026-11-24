import { describe, expect, it, vi } from "vitest";
import { createTaskTools, type TaskToolsDelegate } from "./taskTools";
import { piToolsOf } from "./toolSpec";

/**
 * The first mate's create_task and update_task take a task's tags
 * (docs/task-tags.md, "Where a task's tags are changed"): the approved plan's
 * first piece says they accept tags, set as the first mate's own.
 */
function toolset() {
  const order: string[] = [];
  const delegate: TaskToolsDelegate = {
    plan: vi.fn(() => ({ taskId: "ab12cd34", key: "SCR-3", text: "Planned SCR-3" })),
    update: vi.fn(() => {
      order.push("update");
      return { text: "SCR-3 moved to website as WEB-1", ok: true };
    }),
    tags: vi.fn((input: { task: string; names: string[] }) => {
      order.push("tags");
      return `${input.task}'s tags: ${input.names.join(", ")}.`;
    }),
    drop: vi.fn(() => ""),
    withdrawMerge: vi.fn(() => ""),
    pin: vi.fn(() => ""),
    override: vi.fn(() => ""),
    withdrawOverride: vi.fn(() => ""),
    withdrawAllowance: vi.fn(() => ""),
    link: vi.fn(() => ""),
    query: vi.fn(() => ({ rows: [], total: 0 })),
    startAgain: vi.fn(async () => ""),
    startNow: vi.fn(async () => ""),
  };
  const run = async (name: string, args: Record<string, unknown>) => {
    const tool = piToolsOf(createTaskTools(delegate)).find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`No tool named ${name}`);
    const result = await tool.execute("call-1", args as never, undefined, undefined, {} as never);
    return (result.content as { text: string }[])[0]?.text;
  };
  return { delegate, order, run };
}

describe("the first mate's tags on a task", () => {
  it("tags a task create_task files, by the id it was filed under", async () => {
    const { delegate, run } = toolset();
    const text = await run("create_task", {
      title: "Fix the sign-in",
      goal: "Signing in works after a restart.",
      tags: ["bug"],
    });
    expect(delegate.tags).toHaveBeenCalledWith({ task: "ab12cd34", names: ["bug"] });
    expect(text).toBe("Planned SCR-3\nab12cd34's tags: bug.");
  });

  it("applies update_task's tags after its other edits, and alone without an empty update", async () => {
    const moved = toolset();
    expect(await moved.run("update_task", { task: "SCR-3", project: "WEB", tags: ["copy"] })).toBe(
      "SCR-3 moved to website as WEB-1\nSCR-3's tags: copy.",
    );
    expect(moved.order).toEqual(["update", "tags"]);

    const alone = toolset();
    expect(await alone.run("update_task", { task: "SCR-3", tags: [] })).toBe("SCR-3's tags: .");
    expect(alone.delegate.update).not.toHaveBeenCalled();
  });
});
