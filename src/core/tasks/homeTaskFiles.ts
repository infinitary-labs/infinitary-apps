import type { Ticker } from "../orchestrator/ticker";
import type { PlacedSessions } from "../placed/placedSessions";
import type { WorkDevices } from "../placed/workDevices";
import type { WorkspaceService } from "../workspace/workspaceService";
import { ClosedTaskFiles, type ClosedTaskFilesOptions } from "./closedTaskFiles";
import type { LeftoverPrograms } from "./leftoverPrograms";
import { TaskTempFiles } from "./taskTemp";

/** Home wiring for what a closed task leaves on disk (docs/task-retention.md); each owner keeps its own passes. */
export function startHomeTaskFiles({
  paths,
  tasks,
  placed,
  workspace,
  leftoverPrograms,
  workDevices,
  ticker,
}: {
  paths: ClosedTaskFilesOptions["paths"];
  tasks: ClosedTaskFilesOptions["tasks"];
  placed: Pick<PlacedSessions, "removeClosedTaskFiles" | "removeClosedTaskTemp">;
  workspace: Pick<WorkspaceService, "deleteInBackground">;
  leftoverPrograms: Pick<LeftoverPrograms, "settled">;
  workDevices: Pick<WorkDevices, "onWorkDevice">;
  ticker: Pick<Ticker, "now" | "register">;
}): void {
  // A closed task's leftover files go a week after its close, unless a live
  // task builds on it, was filed from it or waits on it
  // (docs/task-retention.md): pass now, at each close or renewed contact,
  // and hourly so a running app crosses the week without another close.
  const closedTaskFiles = new ClosedTaskFiles({
    paths,
    tasks,
    removePlaced: (record) => placed.removeClosedTaskFiles(record),
    deleteInBackground: (dir) => workspace.deleteInBackground(dir),
    now: ticker.now,
  });
  closedTaskFiles.watch();
  void closedTaskFiles.sweep();
  workDevices.onWorkDevice((contact) => {
    if (contact.contact === "in-reach") void closedTaskFiles.sweep();
  });
  ticker.register("closed-task-files", 60 * 60 * 1000, () => void closedTaskFiles.sweep());
  // A provisioned temporary folder goes at the close, not after a week, and
  // a removal that could not finish is tried again on the same clocks.
  const taskTempFiles = new TaskTempFiles({
    paths,
    tasks,
    removePlaced: async (record) => {
      const result = await placed.removeClosedTaskTemp(record);
      if (result.status === "removed") return { status: "removed", bytes: result.bytes };
      if (result.status === "pending") {
        return {
          status: "pending",
          bytes: 0,
          reason: result.reason ?? "safe removal is uncertain",
        };
      }
      return { status: "absent", bytes: 0 };
    },
    leftoversSettled: (taskId) => leftoverPrograms.settled(taskId),
    deleteInBackground: (dir) => workspace.deleteInBackground(dir),
    now: ticker.now,
  });
  taskTempFiles.watch();
  void taskTempFiles.sweep();
  workDevices.onWorkDevice((contact) => {
    if (contact.contact === "in-reach") void taskTempFiles.sweep();
  });
  ticker.register("task-temp-files", 60 * 60 * 1000, () => void taskTempFiles.sweep());
}
