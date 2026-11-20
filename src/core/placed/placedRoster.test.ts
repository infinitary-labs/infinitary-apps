import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { appPathsFor } from "../paths";
import { PI_CONTROL_PROFILE } from "../pi/controlProfile";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { PlacedSessions } from "./placedSessions";
import { WorkDevices } from "./workDevices";

/**
 * A work computer's contact reads its roster against the record with
 * narrow reads (INF-3040): one composed task per roster entry and then
 * every task held the main thread a third of a second on a long record.
 * The narrow reads must still decide what the composed ones did.
 */

const THERE = "work-computer";

function contactWith(tasks: TaskService, listed: { task: string; closed: boolean }[]) {
  const paths = appPathsFor("/nowhere/infinitary-placed-roster");
  const devices = new WorkDevices();
  let contact: (heard: { deviceId: string; contact: "in-reach" | "gone" }) => void = () => {};
  const asked: string[] = [];
  devices.attach({
    ask: async (_deviceId, channel, args) => {
      const task = (args as [{ task?: string }?])[0]?.task;
      asked.push(task ? `${channel} ${task}` : channel);
      if (channel !== "inf:session:roster") return new Promise(() => {});
      return {
        tasksDir: join(paths.userData, "there", "tasks"),
        worktreesDir: join(paths.userData, "there", "worktrees"),
        tasks: listed.map(({ task, closed }) => ({ task, open: false, closed, seq: 0 })),
      };
    },
    onWorkDevice: (listener) => {
      contact = listener;
      return () => {};
    },
    onViewDevice: () => () => {},
  });
  new PlacedSessions({
    tasks,
    paths,
    devices,
    profiles: { pi: PI_CONTROL_PROFILE },
    deviceName: () => "Work computer",
    projectName: () => undefined,
    broadcastEvent: () => {},
    now: () => Date.now(),
    log: () => {},
  });
  return {
    asked,
    reach: async () => {
      contact({ deviceId: THERE, contact: "in-reach" });
      for (let turn = 0; turn < 10; turn += 1)
        await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function closedWithCopy(tasks: TaskService, id: string, deviceId: string) {
  seedTask(tasks, { id, title: id, status: "idle", deviceId, worktreeDir: `/there/${id}` });
  tasks.close(id, { status: "done", reason: "merged", actor: "host" });
}

describe("a work computer's contact", () => {
  it("counts a closed task's working copy gone once that computer no longer lists it, and only then", async () => {
    const tasks = new TaskService({ db: freshDatabase(), now: () => Date.now() });
    closedWithCopy(tasks, "t-unlisted", THERE);
    closedWithCopy(tasks, "t-listed", THERE);
    closedWithCopy(tasks, "t-elsewhere", "another-computer");
    seedTask(tasks, {
      id: "t-open",
      title: "open",
      status: "idle",
      deviceId: THERE,
      worktreeDir: "/there/t-open",
    });
    for (const id of ["t-unlisted", "t-listed", "t-elsewhere", "t-open"])
      expect(tasks.get(id)?.workspaceState, id).toBe("present");

    await contactWith(tasks, [{ task: "t-listed", closed: true }]).reach();

    expect(tasks.get("t-unlisted")?.workspaceState).toBe("removed");
    expect(tasks.get("t-listed")?.workspaceState).toBe("present");
    expect(tasks.get("t-elsewhere")?.workspaceState).toBe("present");
    expect(tasks.get("t-open")?.workspaceState).toBe("present");
  });

  it("closes there both a listed task this Mac records on another computer, by the leftover rule, and one closed here", async () => {
    const tasks = new TaskService({ db: freshDatabase(), now: () => Date.now() });
    closedWithCopy(tasks, "t-elsewhere", "another-computer");
    seedTask(tasks, { id: "t-closing", title: "closing", status: "idle", deviceId: THERE });
    tasks.close("t-closing", { status: "done", reason: "merged", actor: "host" });
    const roster = contactWith(tasks, [
      { task: "t-elsewhere", closed: true },
      { task: "t-closing", closed: false },
    ]);
    await roster.reach();
    expect(roster.asked.toSorted()).toEqual([
      "inf:session:close t-closing",
      "inf:session:close t-elsewhere",
      "inf:session:roster",
    ]);
  });
});
