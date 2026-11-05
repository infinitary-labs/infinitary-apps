import type { Card } from "@shared/cards";
import type { TaskRecord } from "../storage/taskStore";
import { cardEmitter } from "./cardEmit";

/** A terminal response to the task's own result, never an intermediate consent. */
export function taskResultResponse(
  card: Card,
  record: TaskRecord | undefined,
  action: string,
  by: "captain" | "firstmate" | "crewmate",
): boolean {
  if (by !== "captain" || !card.taskId) return false;
  if (record?.status !== "active" || record.kind !== "work") return false;
  if (cardEmitter(card.id, card.taskId) !== "crewmate") return false;
  if (card.continues || card.awaiting === "answer") return false;
  if (card.actions.some((entry) => entry.effect?.kind === "request_write")) return false;
  if (card.attachment?.kind === "browser" && card.attachment.handoff) return false;
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
