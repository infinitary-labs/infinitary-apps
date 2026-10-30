import type { Scenario } from "../mockProvider";

/**
 * INF-1713: a crewmate whose turn is still going when the captain asks to
 * move its task. A commission carrying this phrase is held on its first
 * step - the model still working - until the spec calls `releaseHeldCrew`;
 * the step after that reports and ends the turn.
 */
export const HELD_MOVE_TURN_MARKER = "while the move waits";
export const HELD_MOVE_TURN_REPORT = "The header is fixed.";

export const heldMoveTurn: Scenario = () => {
  let held = false;
  return ({ body, isFirstmate }) => {
    if (isFirstmate || !body.includes(HELD_MOVE_TURN_MARKER)) return undefined;
    if (!held) {
      held = true;
      return { held: true };
    }
    return { text: HELD_MOVE_TURN_REPORT };
  };
};
