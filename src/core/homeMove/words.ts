import { HERE } from "@shared/deviceNames";

function size(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

function list(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * What moving the first mate says (docs/devices.md, "Moving the first
 * mate", "The Ready list"): each line of the Ready list, and each step of
 * the move as Settings -> Devices shows it.
 */
export const HOME_MOVE_WORDS = {
  notWork: (name: string) =>
    `${name} does not run work for your first mate, so your first mate cannot move there. Add it as a computer that runs work first.`,
  outOfReach: (name: string) =>
    `${name} is out of reach or runs an older Infinitary that cannot take your first mate. Open Infinitary there and update it.`,
  alreadyMoving: "Your first mate is already moving.",
  notMoving: "Your first mate is not moving.",
  version: (name: string, there: string | null, here: string | null) =>
    `${name} runs Infinitary ${there ?? "of an unknown version"} and ${HERE.this} runs ${here ?? "an unknown version"}. Update both to the same version first.`,
  firstMateThere: (name: string) =>
    `A first mate of its own already runs on ${name}. Quit Infinitary there first, or open it there as a window of this one.`,
  noBackground: (name: string) =>
    `${name} cannot start your first mate in the background. Open Infinitary there once and try again.`,
  noAddresses: (name: string) =>
    `${name} has no network address your other devices could reach it at.`,
  space: (name: string, needs: number, free: number) =>
    `${name} has ${size(free)} free and the move needs about ${size(needs * 2)}. Free some space there first.`,
  /** `refusal` is the task's own reason it cannot move, which names it. */
  taskStays: (refusal: string) =>
    `${refusal} Let it finish or stop it before moving your first mate.`,
  tasksMoveFirst: (count: number, name: string) =>
    `${count === 1 ? "One started task moves" : `${count} started tasks move`} to ${name} first, keeping ${count === 1 ? "its" : "their"} key, branch, files and record.`,
  ownRecord: (name: string) =>
    `${name} keeps a first mate's record of its own. The move sets it aside there and deletes nothing.`,
  signInAgain: (name: string, signIns: readonly string[]) =>
    `You sign in to ${list(signIns)} again on ${name}. The move copies no sign-in, and your first mate there asks you for each one.`,
  overSsh: (computer: string, name: string) =>
    `${computer} reaches your first mate only through ${HERE.this}'s SSH connection, so it is out of reach once your first mate runs on ${name}. Add it again from there after the move.`,
  secrets: (name: string) =>
    `Your Secrets stay on ${HERE.this}, sealed by its own keychain. Add them again on ${name} after the move.`,
  secretsGo: (name: string) =>
    `Your Secrets go along, sealed with ${name}'s own lock. Saved choices and approving devices start empty there, as after a restore.`,
  integrations: (name: string, kinds: readonly string[]) =>
    `${list(kinds)} ${kinds.length === 1 ? "is" : "are"} signed in on ${HERE.this} only. Connect ${kinds.length === 1 ? "it" : "them"} again on ${name} after the move.`,
  uncommitted: (path: string) =>
    `${path} has changes that are not committed. The move carries every commit and branch, and leaves these changes in the folder here.`,
  dictation: (name: string) =>
    `Dictation stays off in ${HERE.this}'s window once your first mate runs on ${name}. Dictate from ${name}'s own window.`,
  started: (name: string) => `Moving your first mate to ${name}.`,
  cancelling: "Cancelling the move.",
  cancelled: "The move was cancelled. Your first mate stays here.",
  tooLate: (name: string) =>
    `Your first mate has already stopped to move to ${name}, so the move can no longer be cancelled.`,
  tasks: (count: number, name: string) =>
    `Moving ${count === 1 ? "one started task" : `${count} started tasks`} to ${name} first.`,
  copying: (name: string) => `Copying your first mate's record to ${name}.`,
  stopping: "Your first mate stopped for the last copy.",
  holding: (name: string) => `Your first mate is moving to ${name}. Try again once it has.`,
  arriving: (name: string) => `Starting your first mate on ${name}.`,
  moved: (name: string) => `Your first mate now runs on ${name}.`,
  failed: (name: string, why: string) =>
    `Your first mate could not move to ${name}, and stays here. ${why}`,
  waitingFor: (name: string) =>
    `Waiting for ${name} to answer. Your first mate starts again on one computer only, once ${name} says where it is.`,
  notDropped: (name: string, why: string) =>
    `${name} has not dropped the move yet, so your first mate stays stopped here and asks again. ${why}`,
  stillAsking: (name: string) =>
    `${HERE.This} is still asking ${name}. Your first mate can start here again only once ${name} has been out of reach for a while.`,
  startedHere: (name: string) =>
    `Your first mate starts here again. If ${name} comes back running it too, your devices stay with ${HERE.this} and refuse ${name}.`,
  notStarted: (name: string) => `${name} could not start your first mate.`,
  taskStopped: (handle: string) =>
    `The move of ${handle} stopped before it reached the other computer.`,
  failedAfterStop: (name: string, why: string) =>
    `Your first mate could not move to ${name}. It starts again here with nothing lost. ${why}`,
};
