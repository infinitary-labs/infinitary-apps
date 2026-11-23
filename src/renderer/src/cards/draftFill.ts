import type { CardAnswer } from "@shared/cards";
import { useEffect } from "react";
import type { FrameController } from "../plugins/frames/frameController";

/**
 * The bodies on screen for each card, so another window's change to a
 * card's draft reaches every body already showing it (docs/card-authoring.md,
 * "Unsent picks follow you"). A body born later takes the draft at its
 * birth, from the shell's `cardAnswers`.
 */
const shown = new Map<string, Set<React.RefObject<FrameController | null>>>();

/**
 * Applies another window's answers to every body showing the card: true when
 * a body on screen took them, whose next reading then carries them.
 */
export function fillShownBodies(cardId: string, answers: CardAnswer[]): boolean {
  let took = false;
  for (const controller of shown.get(cardId) ?? [])
    if (controller.current?.fill(answers)) took = true;
  return took;
}

export function useDraftFill(
  cardId: string | undefined,
  controllerRef: React.RefObject<FrameController | null>,
): void {
  useEffect(() => {
    if (!cardId) return;
    const bodies = shown.get(cardId) ?? new Set();
    bodies.add(controllerRef);
    shown.set(cardId, bodies);
    return () => {
      bodies.delete(controllerRef);
      if (bodies.size === 0 && shown.get(cardId) === bodies) shown.delete(cardId);
    };
  }, [cardId, controllerRef]);
}
