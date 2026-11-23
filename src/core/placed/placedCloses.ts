import { speaksTempCleanup } from "@shared/contractFeatures";
import { keepsAtClose, leftoversOf } from "@shared/leftoverPrograms";
import { type WorkOrderResponse, workOrders } from "@shared/work";
import type { TaskRetentionFields } from "../storage/taskRecords";
import type { KeptJobs } from "../tasks/keptJobs";
import { noteLeftovers, openSuccessor } from "../tasks/leftoverPrograms";
import { TaskService } from "../tasks/taskService";
import type { WorkDevices } from "./workDevices";

/**
 * The close orders the home sends a computer that runs work, for
 * `PlacedSessions` (docs/leftover-programs.md, "On a computer that runs
 * work"): the close of a task's conversation there, its report noted on the
 * task's timeline once and its kept jobs recorded here, and the orders that
 * remove a closed task's files and temporary folder there once its retention
 * period is over (docs/task-retention.md).
 */

export type PlacedClosesOptions = {
  tasks: TaskService;
  devices: WorkDevices;
  /** The home's record of the jobs closes kept running, here and there (`KeptJobs`). */
  keptJobs: KeptJobs;
  /** Whether the computer's close order runs the task's stops and answers its report. */
  listsStops: (deviceId: string) => boolean;
  log: (line: string) => void;
};

export class PlacedCloses {
  /** Close orders whose report is already noted on their task's timeline in this run, by computer and order. */
  private readonly leftoversNoted = new Set<string>();

  constructor(private readonly options: PlacedClosesOptions) {}

  /** Called only for a closed task whose home-authoritative retention period is over. */
  async removeClosedTaskFiles(
    record: TaskRetentionFields,
  ): Promise<WorkOrderResponse<"inf:session:clean-files">> {
    if (!record.deviceId || !TaskService.isClosed(record))
      throw new Error("This task is not closed on another computer.");
    const deviceId = record.deviceId;
    if (!this.options.devices.inReach(deviceId))
      throw new Error("This task's computer is out of reach.");
    await this.closeThere(deviceId, record.id);
    const result = await this.options.devices.ask(deviceId, "inf:session:clean-files", [
      { orderId: `clean-files:${record.id}:${record.closedAt}`, task: record.id },
    ]);
    return workOrders["inf:session:clean-files"].response.parse(result);
  }

  /**
   * Removes only the provisioned temporary folder on the computer that
   * holds the task. An older computer, or one out of reach, is not reported
   * as cleaned; the caller retries.
   */
  async removeClosedTaskTemp(
    record: TaskRetentionFields,
  ): Promise<WorkOrderResponse<"inf:session:clean-temp">> {
    if (!record.deviceId || !TaskService.isClosed(record))
      throw new Error("This task is not closed on another computer.");
    const deviceId = record.deviceId;
    if (!this.options.devices.inReach(deviceId))
      throw new Error("This task's computer is out of reach.");
    const version = this.options.devices.version(deviceId)?.contract ?? "";
    if (!speaksTempCleanup(version))
      throw new Error("This computer needs an update before temporary files can be removed.");
    await this.closeThere(deviceId, record.id);
    const result = await this.options.devices.ask(deviceId, "inf:session:clean-temp", [
      { orderId: `clean-temp:${record.id}:${record.closedAt}`, task: record.id },
    ]);
    return workOrders["inf:session:clean-temp"].response.parse(result);
  }

  /**
   * Closes the task's conversation there for good, under the one order id
   * every close of it uses, or a move's own (`orderId`): every close order
   * the home sends goes through here. A computer admitted to work on this
   * major runs the task's stops and ends the programs holding its folders there
   * first, or hands its stops to the task on that computer that carries its
   * work on, and its answer's report goes on the task's timeline once
   * (docs/leftover-programs.md, "On a computer that runs work").
   */
  async closeThere(deviceId: string, task: string, orderId = `close:${task}`): Promise<unknown> {
    const stops = this.options.listsStops(deviceId);
    const carrier = stops ? this.carrierThere(task, deviceId) : undefined;
    const record = stops ? this.options.tasks.get(task) : undefined;
    const startedAt = record?.startedAt;
    // A merged or answered close keeps the task's kept jobs running there;
    // any other close, a move's or one whose record is gone, removes them,
    // as the computer does when the order says nothing.
    const keeps =
      (record?.status === "done" || record?.status === "dropped") &&
      keepsAtClose(record.closedReason) === "keep";
    const answer = await this.options.devices.ask(deviceId, "inf:session:close", [
      {
        orderId,
        task,
        ...(carrier ? { carriedTo: carrier } : {}),
        ...(typeof startedAt === "number" ? { startedAt } : {}),
        ...(keeps ? { keeps: "keep" as const } : {}),
      },
    ]);
    const parsed = workOrders["inf:session:close"].response.safeParse(answer);
    const report = parsed.success ? parsed.data.leftovers : undefined;
    // An order asked again is answered as it was: its report is noted once.
    const noted = `${deviceId}:${orderId}`;
    if (report && this.options.tasks.get(task) && !this.leftoversNoted.has(noted)) {
      this.leftoversNoted.add(noted);
      const same = JSON.stringify(report);
      const already = this.options.tasks
        .timeline(task)
        .some(
          (event) =>
            event.data?.leftoversComputerId === deviceId &&
            JSON.stringify(leftoversOf(event.data)) === same,
        );
      if (!already) noteLeftovers(this.options.tasks, task, report, deviceId);
    }
    // Its kept jobs run there now, recorded here by that computer (`KeptJobs`, once per job).
    const kept = report?.kept ?? [];
    if (kept.length > 0)
      try {
        this.options.keptJobs.record(kept, {
          computer: deviceId,
          task,
          key: this.options.tasks.get(task)?.key ?? task,
        });
      } catch (caught) {
        // The close's line already names each kept job; the order's answer still goes back.
        this.options.log(
          `could not record the kept jobs of ${task}: ${caught instanceof Error ? caught.message : String(caught)}`,
        );
      }
    return answer;
  }

  /** The task carrying a closed task's work on, when it runs on that same computer. */
  private carrierThere(task: string, deviceId: string): { task: string; key: string } | undefined {
    const record = this.options.tasks.get(task);
    const carrier = record ? openSuccessor(this.options.tasks, record) : undefined;
    if (!carrier || carrier.deviceId !== deviceId) return undefined;
    return { task: carrier.id, key: carrier.key || carrier.id };
  }
}
