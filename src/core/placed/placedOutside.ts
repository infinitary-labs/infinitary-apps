import { type WorkOrderResponse, workOrders } from "@shared/work";
import { DeviceOutOfReachError } from "../connection/connection";
import type { ContractChangeName } from "../connection/contractChanges";
import {
  dueRule,
  type OutsideDue,
  type PlacedOutsideVisit,
  rewriteOutsideData,
} from "../integrations";
import type { TaskRecord } from "../storage/taskRecords";
import { type PlacedHost, REATTACH_ONLY_OPEN } from "./crewMachines";
import type { PlacedSession } from "./placedSession";
import { heldSession, type Placed } from "./placedState";
import type { WorkDevices } from "./workDevices";

/**
 * The words from outside a crewmate's conversation on a computer that runs
 * work holds, cleared there once due, for `PlacedSessions`
 * (docs/task-retention.md, "Words from outside"; docs/helper.md, "Words
 * from outside").
 */

/** What clearing words from outside reads of the home's side (`PlacedSessions`). */
export type OutsideReach = {
  readonly devices: WorkDevices;
  now(): number;
  /** The computers that run work on the list, by device id. */
  computers(): readonly string[];
  nameOf(deviceId: string): string;
  takesOutsideFiles(deviceId: string): boolean;
  listsChange(deviceId: string, change: ContractChangeName): boolean;
  /** Whether a conversation held here is refused there until accepted again (`PlacedLedger.refused`). */
  refusedHeld(taskId: string): boolean;
  refuseHeld(taskId: string, refused: boolean): void;
  /** The supervisor, once it exists. */
  host(): PlacedHost | undefined;
  /** The task's state, kept from the first ask on (`loadPlaced`). */
  load(task: string, deviceId: string): Placed;
  /** Opens the conversation there again for the session this Mac holds (`PlacedSessions.reopen`). */
  reopen(placed: Placed, session: PlacedSession, deviceId: string): Promise<void>;
};

/**
 * The words from outside a task's conversation there holds, once due
 * (`inf:session:delete-outside`; docs/task-retention.md, "Words from
 * outside"): this Mac's copy of its callbacks' answers first, then that
 * computer's files, and this Mac's copy of each it changed, whole. `files`
 * are files from outside due in its hand-over folder there. A computer out
 * of reach or without the change, or an open there unanswered, waits for
 * a later pass; one no longer on the list leaves this Mac's copy to the
 * caller (`gone`). This Mac opens the conversation again, routed, or, on
 * an older computer that opens it by itself, lets its own go first.
 */
export async function deleteOutside(
  reach: OutsideReach,
  record: TaskRecord,
  due: OutsideDue,
  files: readonly string[] = [],
): Promise<PlacedOutsideVisit> {
  const deviceId = record.deviceId;
  if (!deviceId || !reach.computers().includes(deviceId)) return "gone";
  const rule = dueRule(due.kinds);
  const placed = reach.load(record.id, deviceId);
  const answers = rewriteOutsideData(placed.ledger.callsFile, rule, due.legacy);
  if (answers > 0) placed.ledger.reread();
  const computer = reach.nameOf(deviceId);
  if (!reach.devices.inReach(deviceId)) return { computer, until: "reach" };
  if (!reach.devices.takesCurrentWork(deviceId)) return { computer, until: "update" };
  if (files.length > 0 && !reach.takesOutsideFiles(deviceId)) return { computer, until: "update" };
  // An open there unanswered, or one here not yet accepted (still refused), is not to let go.
  const [live, refused] = [heldSession(placed), reach.refusedHeld(placed.task)];
  if (placed.asking > 0 || placed.adopting || placed.cleaning || (live && refused))
    return "waiting";
  // An older computer reopens it unchecked: never reattached to (`refusedThere`), let go first.
  const older = !reach.listsChange(deviceId, REATTACH_ONLY_OPEN);
  if (older) reach.refuseHeld(placed.task, true);
  // Only a session held, only at once: one left for a turn's end would wake its words first.
  if (older && live && !live.isStreaming()) reach.host()?.letGo?.(placed.task, true);
  if (older && heldSession(placed)) return reach.refuseHeld(placed.task, refused), "waiting";
  // Opens there wait for its answer, and words to it for the reopen it asks too.
  let cleaned: (open: boolean | Promise<boolean>) => void = () => {};
  const gate = new Promise<boolean>((done) => (cleaned = done));
  let answered = () => {};
  placed.cleaning = new Promise<void>((done) => (answered = done));
  const before = placed.reopening;
  const held = gate.then(async (open) => open && (await before) !== false);
  placed.reopening = held;
  let answer: WorkOrderResponse<"inf:session:delete-outside"> | undefined;
  let lost: unknown;
  try {
    answer = workOrders["inf:session:delete-outside"].response.parse(
      await reach.devices.ask(deviceId, "inf:session:delete-outside", [
        {
          orderId: `delete-outside:${record.id}:${reach.now()}`,
          task: record.id,
          kinds: due.kinds,
          legacy: due.legacy,
          ...(files.length > 0 ? { files: [...files] } : {}),
          // The home opens it again after routing it (`reattach-only-open.md`).
          ...(older ? {} : { holdReopen: true }),
        },
      ]),
    );
  } catch (caught) {
    lost = caught;
  }
  placed.cleaning = undefined;
  answered();
  // A reopen asked meanwhile, which waited for this answer, is the one that opens it again.
  const session = older || placed.adopting ? undefined : heldSession(placed);
  // Let go of there or not known: this Mac opens it again, routed; words given back then go.
  if (session && (!answer || answer.reopen || answer.status === "changed"))
    void reach.reopen(placed, session, deviceId).then(() => reach.host()?.caughtUp([placed.task]));
  if (placed.reopening === held) placed.reopening = before;
  cleaned(placed.reopening ?? true);
  // A wait for that computer's update ends: what it holds is refused now.
  if (older) reach.host()?.caughtUp([placed.task]);
  if (!answer) {
    if (lost instanceof DeviceOutOfReachError) return { computer, until: "reach" };
    throw lost;
  }
  if (answer.status === "waiting") return "waiting";
  const copied = await placed.record.replaceDue(answer.files, rule, due.legacy);
  if (copied.short) return "waiting";
  return answer.status === "changed" || answers > 0 || copied.any ? "changed" : "unchanged";
}
