import type { FrameSound } from "@shared/plugins/bridge";
import { create } from "zustand";

/**
 * The one sound the window plays (docs/card-authoring.md "Sound clips"): a
 * card's clip, started by the captain's press on its Listen button. Only one
 * plays in the whole app, so a new press replaces the one before; the card's
 * strip draws it, and it stops when the strip goes - on Pause it only waits.
 */
export type PlayingSound = FrameSound & {
  cardId: string;
  /** A new one for each press, so pressing Listen again starts the clip again. */
  press: number;
};

export const useCardSound = create<{
  sound: PlayingSound | null;
  /** Whether the sound is playing now, not waiting on Pause: the ambient music hushes for it. */
  playing: boolean;
  /** Whether a demo recording with sound is playing now: the ambient music hushes for it too. */
  demo: boolean;
}>(() => ({ sound: null, playing: false, demo: false }));

export function setDemoSounding(on: boolean): void {
  useCardSound.setState({ demo: on });
}

let presses = 0;

/** Plays a card's clip in its strip, in place of any sound before it. */
export function playCardSound(cardId: string, sound: FrameSound): void {
  presses += 1;
  useCardSound.setState({ sound: { ...sound, cardId, press: presses } });
}

/** Stops whatever card's sound is playing: a demo with sound started, and one sound plays at a time. */
export function stopAnyCardSound(): void {
  if (useCardSound.getState().sound) useCardSound.setState({ sound: null, playing: false });
}

/** Stops the sound when it is this card's: the card left the front. */
export function stopCardSound(cardId: string): void {
  if (useCardSound.getState().sound?.cardId === cardId)
    useCardSound.setState({ sound: null, playing: false });
}
