import { createHash } from "node:crypto";
import type { SessionEvent } from "../session/session";

/**
 * The standing directions a crewmate's conversation holds (INF-2599, the
 * captain: "Send a crewmate its directions once, and again only when they
 * change"; primitives/standing-directions.md). A turn carries its project's
 * directions only when the conversation does not hold the current set: its
 * first turn, a conversation that started over, a fold that may have
 * dropped them, a change to the set, and a copy handed over that its
 * session never read. Every other turn carries none, so a notice or a nudge
 * does not repeat the whole set.
 *
 * The conversation holds a copy only once its session read the input that
 * carried it (`input_read` naming that input, or a model request beginning
 * after it was handed over), never when it is built or handed over, so a
 * turn that never reached its model sends the set again. A conversation
 * whose folds the host cannot hear - one held on a computer outside
 * the current work major - is served the set on every turn, as before.
 */
export type HeldDirections = {
  /** The conversation the copy went to: its session's id, which a renewal changes. */
  conversation: string;
  /** The rendered set's digest. */
  digest: string;
  /** The digest of the input that carried it, as the session's read witness names it. */
  input: string;
  /** The session read that input. */
  read: boolean;
};

/** Whether a turn of `conversation` carries `block`: false only when it already holds this very set. */
export function servesDirections(
  held: HeldDirections | undefined,
  conversation: string | undefined,
  block: string,
  foldsHeard: boolean,
): boolean {
  return !(
    foldsHeard &&
    conversation !== undefined &&
    held?.read === true &&
    held.conversation === conversation &&
    held.digest === sha256(block)
  );
}

/** The copy a turn handed over in `served`, unread until its session says so. */
export function handedDirections(
  conversation: string,
  block: string,
  served: string,
): HeldDirections {
  return { conversation, digest: sha256(block), input: sha256(served), read: false };
}

/**
 * What the conversation holds after one of its session's events: a read of
 * the input that carried the copy, or a model request after it, makes the
 * copy held; a fold forgets it, so the next turn carries the set again.
 */
export function heardDirections(
  held: HeldDirections | undefined,
  event: SessionEvent,
): HeldDirections | undefined {
  if (!held) return held;
  if (event.type === "context_compacted") return undefined;
  if (held.read) return held;
  if (event.type === "request_started") return { ...held, read: true };
  if (event.type === "input_read" && event.textSha256 === held.input)
    return { ...held, read: true };
  return held;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
