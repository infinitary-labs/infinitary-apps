import { formatDate, formatTime } from "./i18n/format.ts";
import type { Slot } from "./modelSlots";

/**
 * What a gate holding queued work waits on, read from typed facts alone -
 * the gate and the work's own ask - never from words (`holdOf` in
 * src/core/tasks/taskProtocol.ts; docs/task-record.md, "A held task says why"):
 * - `premium`: the captain asked for premium, and the work waits for a
 *   premium model with allowance rather than starting lower (P7 + R1);
 * - `retry`: a stronger-model retry of `from` waits the same way for its
 *   own level (S4);
 * - `level`: Firstmate set it to start once a model at a level has allowance;
 * - `plan`: Firstmate set it to start once a provider's allowance is back;
 * - `time`: Firstmate set it to start at a moment (epoch ms).
 */
export type TaskHold =
  | { kind: "premium" }
  | { kind: "retry"; level: Slot; from: string }
  | { kind: "level"; level: Slot }
  | { kind: "plan"; provider: string }
  | { kind: "time"; until: number };

/** A hold in the captain's words: what the work waits for, then what ends the wait. */
export type TaskHoldWords = { title: string; text: string };

/** The ask's own way out: Firstmate may start it lower with the captain's word. */
const SOONER = "Ask your first mate to start it sooner on another model.";

/**
 * The one wording of a hold, for Task Details' attention box. A time reads
 * in this computer's own zone.
 */
export function taskHoldWords(hold: TaskHold): TaskHoldWords {
  switch (hold.kind) {
    case "premium":
      return {
        title: "Waiting for a premium model",
        text: `You asked for premium, and no premium model has allowance now. It starts by itself once one does. ${SOONER}`,
      };
    case "retry":
      return {
        title: `Waiting for a ${hold.level} model`,
        text: `It retries ${hold.from} on a stronger model, and no ${hold.level} model has allowance now. It starts by itself once one does. ${SOONER}`,
      };
    case "level":
      return {
        title: `Waiting for a ${hold.level} model`,
        text: `Your first mate set it to wait until a ${hold.level} model has allowance. It starts by itself once one does.`,
      };
    case "plan":
      return {
        title: `Waiting for ${hold.provider} allowance`,
        text: `Your first mate set it to wait until your ${hold.provider} plan has allowance again. It starts by itself once it does.`,
      };
    case "time": {
      const at = new Date(hold.until);
      const day = formatDate(at, { month: "short", day: "numeric" });
      const time = formatTime(at, { hour: "numeric", minute: "2-digit" });
      return {
        title: "Waiting for its start time",
        text: `Your first mate set it to start on ${day} at ${time}. It starts by itself then.`,
      };
    }
  }
}
