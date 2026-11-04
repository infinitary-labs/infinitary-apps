import type { Card } from "./cards";
import { formatResetText } from "./quota";
import type { AccountHold, WorkPosture } from "./workPosture";

/**
 * What the captain's reply under a crewmate's card is waiting on, while no
 * line has answered it and no turn of its author's is running (FI3-592;
 * docs/card-threads.md, "The waiting line"). It is read from the task's
 * work posture - the same typed state the Tasks dot reads - never from
 * anyone's words, and it is never a thread message, so the card keeps
 * showing what it showed.
 */
export type ThreadWait =
  /** A typed cut-off stands on the task's account: the reply is kept, not sent. */
  | { on: "account"; hold?: AccountHold }
  /** The author waits for the checks on its change; their end wakes it. */
  | { on: "checks" }
  /** The author waits for its own background work. */
  | { on: "background" }
  /** The task is being merged or discarded. */
  | { on: "finishing" }
  /** Nothing else holds the author: the answer is its to give. */
  | { on: "author" };

/**
 * The wait, or none: on a crewmate's card the captain replied under last,
 * with a posture that says what holds it. A running turn has none - the
 * thread says `working` then - and neither does any card the Firstmate
 * answers.
 */
export function threadWait(
  card: Pick<Card, "author" | "awaiting" | "taskId">,
  posture: WorkPosture | undefined,
): ThreadWait | undefined {
  if (card.author !== "crewmate" || card.awaiting !== "answer" || !card.taskId || !posture) {
    return undefined;
  }
  switch (posture.reason) {
    case "access":
      return posture.hold ? { on: "account", hold: posture.hold } : { on: "account" };
    case "checks":
      return { on: "checks" };
    case "job":
      return { on: "background" };
    case "settlement":
      return { on: "finishing" };
    case "guidance":
      return { on: "author" };
    default:
      return undefined;
  }
}

/** The way on while a hold stands, beside the line the hold's class gives. */
const SOONER = "To go on sooner, ask your first mate to move the work to another model.";

/**
 * The way on while the author answers (INF-770): a reply never moves its
 * card, and Put aside brings it back on its own when the answer lands.
 */
export const PUT_ASIDE_WAY_ON = "Put the card aside to go on; it comes back when the answer lands.";

/**
 * The one line the thread shows for a wait: that the reply is saved, what
 * holds it, who goes next and the way on - Put aside or, for a held
 * account, the way back that clears it. `crewmate` is the task's assignee ("crewmate 7").
 */
export function threadWaitWords(
  wait: ThreadWait,
  crewmate: string | undefined,
  now: number,
): string {
  const who = crewmate ?? "the crewmate";
  const Who = who.charAt(0).toUpperCase() + who.slice(1);
  switch (wait.on) {
    case "checks":
      return `Saved. ${Who} is waiting for the checks to finish, then answers. ${PUT_ASIDE_WAY_ON}`;
    case "background":
      return `Saved. ${Who} is waiting for its background work to finish, then answers. ${PUT_ASIDE_WAY_ON}`;
    case "finishing":
      return `Saved. ${Who} is finishing the task, then answers. ${PUT_ASIDE_WAY_ON}`;
    case "author":
      return `Saved. ${Who} has not answered yet. ${PUT_ASIDE_WAY_ON}`;
    case "account":
      return heldWords(wait.hold, who, now);
  }
}

function heldWords(hold: AccountHold | undefined, who: string, now: number): string {
  if (!hold) {
    return `Saved, not sent yet: the work is paused until its plan's allowance resets. It goes to ${who} then, on its own. ${SOONER}`;
  }
  const provider = hold.provider;
  // A task on another Mac waits on that Mac's own sign-in, which is where
  // the captain signs in again.
  const there = hold.where ? ` ${hold.where}` : "";
  switch (hold.class) {
    case "no_headroom": {
      const reset = hold.resetsAt !== undefined ? formatResetText(hold.resetsAt, now) : undefined;
      return reset
        ? `Saved, not sent yet: your ${provider} plan's allowance${there} is used up and ${reset}. It goes to ${who} then, on its own. ${SOONER}`
        : `Saved, not sent yet: your ${provider} plan's allowance${there} is used up. It goes to ${who} once it resets, on its own. ${SOONER}`;
    }
    case "signed_out":
      return `Saved, not sent yet: ${provider} needs you to sign in again${there}. Sign in from Settings, under Intelligence, and it goes to ${who}.`;
    case "refused":
      return `Saved, not sent yet: ${provider} is refusing this sign-in${there}. It goes to ${who} once you sign in to another ${provider} account${there} or update ${provider}. ${SOONER}`;
  }
}
