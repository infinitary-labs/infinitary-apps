import { formatDate, formatTime } from "./i18n/format.ts";
import { levelModel, levelModels } from "./levelWords.ts";
import type { Slot } from "./modelSlots";

/**
 * What a gate holding queued work waits on, read from typed facts alone -
 * the gate and the work's own ask - never from words (`holdOf` in
 * src/core/tasks/taskDetail.ts; docs/task-record.md, "A held task says why"):
 * - `premium`: the captain asked for premium, and the work waits for a
 *   premium model with allowance rather than starting lower (P7 + R1);
 * - `retry`: a stronger-model retry of `from` waits the same way for its
 *   own level (S4);
 *   either one carries its gate's `cause` when no allowance reset can end
 *   the wait (`LevelWaitCause`);
 * - `level`: Firstmate set it to start once a model at a level has allowance;
 * - `plan`: Firstmate set it to start once a provider's allowance is back;
 * - `time`: Firstmate set it to start at a moment (epoch ms).
 */
export type TaskHold =
  | { kind: "premium"; cause?: LevelWaitCause }
  | { kind: "retry"; level: Slot; from: string; cause?: LevelWaitCause }
  | { kind: "level"; level: Slot }
  | { kind: "plan"; provider: string }
  | { kind: "time"; until: number };

/**
 * Why a level the work asked for holds it when no allowance reset can end
 * the wait, as the host routed it (`RouteResult.emptyBucket` and
 * `picturesUnread`, docs/routing.md "Pictures"): `empty` when no model is
 * placed at that level, `pictures` when the work carries pictures and every
 * model placed there reads text only. A wait for allowance carries none.
 */
export type LevelWaitCause = "empty" | "pictures";

/** A hold in the captain's words: what the work waits for, then what ends the wait. */
export type TaskHoldWords = { title: string; text: string };

/** The ask's own way out: Firstmate may start it lower with the captain's word. */
const SOONER = "Ask your first mate to start it sooner on another model.";

/** Where the captain places a model at a level. */
const MODELS_PLACE = "Settings → Intelligence → Models";

/**
 * What a level the work asked for lacks when no reset can end its wait, and
 * what ends it instead: a model placed there, or one there that reads the
 * pictures it carries.
 */
function unservedLevel(level: Slot, cause: LevelWaitCause): string {
  const models = levelModels(level);
  return cause === "pictures"
    ? `none of your ${models} can read the pictures it carries. It starts by itself once one that can is among your ${models} in ${MODELS_PLACE}.`
    : `you have no ${models} in ${MODELS_PLACE}. It starts by itself once you have one.`;
}

function levelTitle(level: Slot, cause: LevelWaitCause | undefined): string {
  return `Waiting for ${levelModel(level)}${cause === "pictures" ? " that reads pictures" : ""}`;
}

/**
 * The one wording of a hold, for Task Details' attention box. A time reads
 * in this computer's own zone.
 */
export function taskHoldWords(hold: TaskHold): TaskHoldWords {
  switch (hold.kind) {
    case "premium":
      return {
        title: levelTitle("premium", hold.cause),
        text: `You asked for premium, and ${hold.cause ? unservedLevel("premium", hold.cause) : "no premium model has allowance now. It starts by itself once one does."} ${SOONER}`,
      };
    case "retry":
      return {
        title: levelTitle(hold.level, hold.cause),
        text: `It retries ${hold.from} on a stronger model, and ${hold.cause ? unservedLevel(hold.level, hold.cause) : `none of your ${levelModels(hold.level)} has allowance now. It starts by itself once one does.`} ${SOONER}`,
      };
    case "level":
      return {
        title: `Waiting for ${levelModel(hold.level)}`,
        text: `Your first mate set it to wait until ${levelModel(hold.level)} has allowance. It starts by itself once one does.`,
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
