import { type Card, settleEffectOf } from "@shared/cards";
import type { TaskRecord } from "../storage/taskStore";
import { cardEmitter } from "./cardEmit";

/**
 * The action a signed-off answer is recorded under (INF-2845, the captain's
 * direction A): the crewmate marked the captain's line under its answer as
 * saying they are done, and the card ended as Done ends a saved answer.
 */
export const SIGNED_OFF_ACTION_ID = "signed-off";

/** What the host reads before a crewmate's line may sign an answer off. */
export type SignOffFacts = {
  taskId: string;
  /** The card the line names, while it is on the stack. */
  card: Card | undefined;
  record: TaskRecord | undefined;
  answersMessage: number | undefined;
  interim: boolean;
  /** The captain's message the card waits on for its author, if any. */
  waitingOn: number | undefined;
};

/**
 * Why a crewmate's line may not carry `signs_off`, or undefined when it may.
 * Typed facts only: whether the captain's words say they are done is the
 * crewmate's judgment, never the host's (docs/principles.md, "Put ambiguous
 * judgments in agent instructions"). A mark never stands in for a merge, a
 * write, a question still asking or work the card continues.
 */
export function signOffRefusal(facts: SignOffFacts): string | undefined {
  const { card, record } = facts;
  if (facts.answersMessage === undefined) {
    return "signs_off needs answers_message, naming the captain's message that says they are done.";
  }
  if (facts.interim) return "signs_off ends the answer, so it is never an interim line.";
  if (!card || card.taskId !== facts.taskId || cardEmitter(card.id, facts.taskId) !== "crewmate") {
    return "signs_off goes only on your own card while it is on the stack.";
  }
  if (record?.status !== "active" || record.kind !== "work") {
    return "signs_off goes only on the answer of a task that is still open.";
  }
  if (record.shape?.deliverable !== "answer" || card.answering !== true) {
    return "signs_off ends only an answer task's answering card; write the line without it.";
  }
  if (card.asking === true || card.continues === true) {
    return "this card still asks or continues, so the captain's choice on it comes first; write the line without signs_off.";
  }
  const sends = card.actions.some(
    (action) =>
      settleEffectOf(action) !== undefined ||
      action.effect?.kind === "request_merge" ||
      action.effect?.kind === "request_write",
  );
  if (sends || (card.attachment?.kind === "browser" && card.attachment.handoff)) {
    return "this card carries something only the captain's click sends, so write the line without signs_off.";
  }
  if (facts.waitingOn !== facts.answersMessage) {
    return facts.waitingOn === undefined
      ? "no message of the captain's waits on this card, so there is nothing to sign off."
      : `signs_off answers only the captain's message this card waits on (${facts.waitingOn}).`;
  }
  return undefined;
}
