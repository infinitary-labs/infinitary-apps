import { join } from "node:path";
import { PULL_REQUEST_COMMENTS_WAKE } from "@shared/pullComments";
import { effectiveTaskPolicies, type TaskPolicyEdits } from "@shared/taskPolicies";
import { describe, expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
} from "../../../tests/helpers/crewHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { Runbooks } from "../runbooks/runbooks";
import { seedProject } from "../workspace/seedProject";

// Intent: review INF-4479's F3, the captain's answer - a crewmate's
// conversation that opened without the Pull request comments guidance is
// never woken about comments, so the host records at the conversation's
// opening which wakes its served guidance asks for; a policy notice adds
// only the wakes of the guidance it carries (N2).

fakeCrewTimersEachTest();

async function opened(on: boolean, delivery: "queue-pr" | "local-only") {
  const switches = { "pull-comments": on };
  const runbooks = new Runbooks(join(process.cwd(), "resources/runbooks"), {
    getRunbookStates: () => switches,
    setRunbookStates: () => {},
  });
  const crewmate = fakeCrewmate();
  const h = setup(crewmate, { runbooks });
  seedProject(h.db, {
    id: "invites",
    name: "Invites",
    path: scratchDir("inf-served-wakes-"),
    origin: "https://github.com/octo/invites.git",
    delivery,
  });
  const { taskId } = await h.supervisor.intake.commission({
    title: "Expire old invites",
    intent: intentOf("expire old invites"),
    repoId: "invites",
  });
  await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
  const served = () => h.tasks.get(taskId)?.delivery?.servedWakes;
  /** The captain's policy edit and its notice, as the app makes them. */
  const edit = (policies: TaskPolicyEdits) => {
    const record = h.tasks.get(taskId);
    if (!record) throw new Error("The task was lost");
    const before = effectiveTaskPolicies(record, h.repos.get("invites"));
    h.tasks.updateFields(taskId, { policies }, "captain");
    h.supervisor.policiesChanged(taskId, policies, before);
  };
  return { served, edit, switches };
}

describe("the wakes a crewmate's conversation was told about", () => {
  it("records the comment wake when its pull request crewmate is served the guidance", async () => {
    expect((await opened(true, "queue-pr")).served()).toEqual([PULL_REQUEST_COMMENTS_WAKE]);
  });

  it("records none while the runbook is off or the change opens no pull request", async () => {
    expect((await opened(false, "queue-pr")).served()).toBeUndefined();
    expect((await opened(true, "local-only")).served()).toBeUndefined();
  });

  it("adds the wake only when a policy notice carries the guidance that asks for it", async () => {
    // Opened while off, then switched on: a rigor raise carries only Careful's section.
    const raised = await opened(false, "queue-pr");
    raised.switches["pull-comments"] = true;
    raised.edit({ rigor: "reviewed" });
    expect(raised.served()).toBeUndefined();
    // A change that now opens a pull request carries the comment guidance, and its wake.
    const moved = await opened(true, "local-only");
    moved.edit({ delivery: "queue-pr" });
    expect(moved.served()).toEqual([PULL_REQUEST_COMMENTS_WAKE]);
  });
});
