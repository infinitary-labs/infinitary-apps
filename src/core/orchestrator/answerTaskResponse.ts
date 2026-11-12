import type { Card } from "@shared/cards";
import type { TaskRecord } from "../storage/taskRecords";
import { cardEmitter } from "./cardEmit";
import { SIGNED_OFF_ACTION_ID } from "./cardSignOff";

/** A terminal response to the task's own result, never an intermediate consent. */
export function taskResultResponse(
  card: Card,
  record: TaskRecord | undefined,
  action: string,
  by: "captain" | "firstmate" | "crewmate",
): boolean {
  // A line its crewmate signed off is the captain's words, judged by it (INF-2845).
  const signedOff = action === SIGNED_OFF_ACTION_ID && by === "crewmate";
  if ((by !== "captain" && !signedOff) || !card.taskId) return false;
  if (record?.status !== "active" || record.kind !== "work") return false;
  if (cardEmitter(card.id, card.taskId) !== "crewmate") return false;
  if (card.continues || card.awaiting === "answer") return false;
  if (card.actions.some((entry) => entry.effect?.kind === "request_write")) return false;
  if (card.attachment?.kind === "browser" && card.attachment.handoff) return false;
  if (signedOff) return card.answering === true && record.shape?.deliverable === "answer";
  // A put-off (INF-3846 piece 3) answers later, when the same card is back.
  if (card.actions.some((entry) => entry.id === action && entry.until)) return false;
  // A declared choice retains its own meaning; bare close and put-away never receipt an answer.
  if (card.actions.some((entry) => entry.id === action)) return true;
  return action === "answer-done" && card.answering === true && card.actions.length === 0;
}

/** The same terminal choice that closes an answer task, for ask acceptance. */
export function answerTaskChoice(
  card: Card,
  record: TaskRecord | undefined,
  action: string | undefined,
): boolean {
  return (
    action !== undefined &&
    card.actions.some((entry) => entry.id === action) &&
    record?.shape?.deliverable === "answer" &&
    taskResultResponse(card, record, action, "captain")
  );
}
