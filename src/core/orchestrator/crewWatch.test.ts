/**
 * What the crew's watch (`CrewWatch`) does between turns (docs/inbox.md for
 * a job's result on a task's lane; docs/workspace.md for working copies no
 * record explains): a background job's result reaching a crewmate whose
 * conversation was let go, and the boot sweep of working copies no task
 * owns, keeping a live task's and saying which ones it could not save
 * first. These cases pin the behaviour no other test reaches. Each drives a
 * public door of the watch and reads what the crewmate heard, what the
 * working copies saw and the feed.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { endTurn, fakeCrewmate, intentOf, setup, tick } from "../../../tests/helpers/crewHarness";
import type { TaskWorkspace } from "../workspace/workspaceService";

describe("the crew's watch between turns, as CrewWatch keeps it", () => {
  it("resumes a crewmate whose conversation was let go to hand it a background job's result", async () => {
    const crewmate = fakeCrewmate();
    const h = setup(crewmate);
    const { taskId } = await h.supervisor.intake.commission({
      title: "Count presses",
      intent: intentOf("make the meter count every press"),
    });
    await tick();
    await endTurn(crewmate, taskId, "The tests are running in the background.");
    expect(await h.supervisor.sessions.releaseConversation(taskId)).toBe(true);
    const opened = h.sessions.open.mock.calls.length;
    const prompts = crewmate.promptCalls.length;

    h.supervisor.watch.deliverJobResult(
      taskId,
      '[job] background job j1 finished: "pnpm test" exited 0',
    );
    await tick();

    expect(h.sessions.open.mock.calls.length).toBe(opened + 1);
    expect(crewmate.promptCalls).toHaveLength(prompts + 1);
    expect(crewmate.promptCalls.at(-1)).toContain('"pnpm test" exited 0');
    expect(h.events.filter((event) => event.type === "firstmate_note")).toEqual([]);
  });

  it("keeps a live task's working copy and one whose work could not be saved, and says which at boot", async () => {
    const crewmate = fakeCrewmate();
    const h = setup(crewmate);
    const { taskId } = await h.supervisor.intake.commission({
      title: "Count presses",
      intent: intentOf("make the meter count every press"),
    });
    await tick();
    const orphan = (name: string): TaskWorkspace =>
      ({
        taskId: name,
        cwd: join(h.paths.worktreesDir, name),
        branch: `fm/task-${name}`,
        repoDir: h.paths.defaultWorkspaceDir,
      }) as TaskWorkspace;
    h.workspace.listWorktreeDirs = (() => [taskId, "stuck", "saved"]) as never;
    h.workspace.workspaceAt = (async (name: string) => orphan(name)) as never;
    const retired: string[] = [];
    h.workspace.retireTaskWorktree = (async (workspace: TaskWorkspace) => {
      retired.push(workspace.taskId);
      if (workspace.taskId === "stuck") throw new Error("the branch could not be saved");
      return { outcome: "removed" as const, kept: null };
    }) as never;

    await h.supervisor.watch.reconcileFleetHygiene();

    // The live task's tree is never touched; the other two are retired, and one is kept.
    expect(retired).toEqual(["stuck", "saved"]);
    expect(h.events.filter((event) => event.type === "firstmate_note")).toEqual([
      {
        type: "firstmate_note",
        text: "1 working copy with no task is kept because its work could not be saved first: stuck.",
      },
    ]);
  });
});
