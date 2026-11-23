import type { FirstmateEmote } from "./machine";

// Side channel from the store's event stream to the character, as a module
// ref rather than Zustand state (the liveVoiceLevel pattern): fleet moments
// request an emote here and the character drains the queue on its next
// animation frame, so no React re-render rides on a purely visual reaction.

const pending: FirstmateEmote[] = [];
let noticePending = false;
let sendoffPending: { dx: number; dy: number; strength: number } | null = null;
let receivePending = false;
let stageClearedPending = false;

/** A moment the ambient music answers (../ambient/ambient.ts): a notice pulse, or a celebrate emote. */
export type CharacterCue = "notice" | "celebrate";
const cueListeners = new Set<(cue: CharacterCue) => void>();

/** Hears each notice pulse and celebrate emote as it is requested. Returns the unsubscribe. */
export function onCharacterCue(listener: (cue: CharacterCue) => void): () => void {
  cueListeners.add(listener);
  return () => {
    cueListeners.delete(listener);
  };
}

function cue(moment: CharacterCue): void {
  for (const listener of cueListeners) listener(moment);
}

/**
 * Queue an emote request for the character (dropped if it piles up, and
 * once is enough: the same emote already waiting is not queued twice - a
 * crewmate's failed turn and its task's failure are one confusion).
 */
export function requestCharacterEmote(emote: FirstmateEmote): void {
  if (emote === "celebrate") cue("celebrate");
  if (pending.length >= 4 || pending.includes(emote)) return;
  pending.push(emote);
}

/** Take the oldest pending request, if any. */
export function takeCharacterEmote(): FirstmateEmote | undefined {
  return pending.shift();
}

/**
 * A card landed on the stack unseen: the character gives one "new card"
 * pulse. Not an emote - it changes no machine state, cuts nothing short,
 * and overlays whatever the character is doing - so it rides its own flag
 * on this channel. Several cards before the next frame are one pulse.
 */
export function requestCharacterNotice(): void {
  noticePending = true;
  cue("notice");
}

/** Whether a notice pulse was requested since the last take. */
export function takeCharacterNotice(): boolean {
  const requested = noticePending;
  noticePending = false;
  return requested;
}

/**
 * A crewmate is being sent out (or steered) in direction (dx, dy), screen
 * axes from the character's center: the eyes glance that way and the glow
 * lifts (./crew/cues.ts). Like the notice, an overlay and never a state.
 * Several before the next frame keep the latest direction and the
 * strongest pull.
 */
export function requestCharacterSendoff(dx: number, dy: number, strength = 1): void {
  const len = Math.hypot(dx, dy) || 1;
  sendoffPending = {
    dx: dx / len,
    dy: dy / len,
    strength: Math.max(strength, sendoffPending?.strength ?? 0),
  };
}

/** The send-off requested since the last take, if any. */
export function takeCharacterSendoff(): { dx: number; dy: number; strength: number } | null {
  const requested = sendoffPending;
  sendoffPending = null;
  return requested;
}

/** A report (or a finished crewmate) came home: one quick lift of the glow. */
export function requestCharacterReceive(): void {
  receivePending = true;
}

/** Whether a receive cue was requested since the last take. */
export function takeCharacterReceive(): boolean {
  const requested = receivePending;
  receivePending = false;
  return requested;
}

/**
 * The captain's own press in this window took the last card off the stage
 * (../app/stageCleared.ts): the character plays one fidget
 * (FirstmateMachine.stageCleared). Several before the next frame are one.
 */
export function requestStageClearedFidget(): void {
  stageClearedPending = true;
}

/** Whether a stage-cleared fidget was requested since the last take. */
export function takeStageClearedFidget(): boolean {
  const requested = stageClearedPending;
  stageClearedPending = false;
  return requested;
}
