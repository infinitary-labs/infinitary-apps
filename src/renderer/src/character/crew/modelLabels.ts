import type { CrewmateFrame } from "./orbit";

/** The captain's reviewed model-name treatment, in actual screen pixels. */
export const CREW_MODEL_LABEL = { maxWidthPx: 128, gapPx: 4, edgePx: 8 };

/** Active painted orbits, not a copied roster threshold. Departing crew do not
 * keep an orbit active; historical ring-mode frames all share the same orbit.
 */
export function crewModelLabelsVisible(
  crew: readonly Pick<CrewmateFrame, "plane" | "phase" | "computerId">[],
): boolean {
  return (
    new Set(
      crew
        .filter((frame) => frame.phase !== "leaving")
        .map((frame) =>
          frame.computerId ? `${frame.computerId}:${frame.plane ?? 0}` : (frame.plane ?? 0),
        ),
    ).size === 1
  );
}

/** Fits names inside the existing canvas without shifting their character.
 * The crowded formation scales the character, not the 11 px label text.
 */
export function crewModelLabelPlacement(
  frame: Pick<CrewmateFrame, "x" | "y" | "size">,
  extent: number,
  scale: number,
  /** Half the crew canvas's width, px: the formation's square, or the window-wide scene's. */
  halfWidth: number = extent / 2,
) {
  return {
    x: extent / 2 + frame.x,
    y: extent / 2 + frame.y - frame.size * 0.4,
    width: Math.min(
      CREW_MODEL_LABEL.maxWidthPx,
      Math.max(1, (halfWidth - Math.abs(frame.x)) * 2 * scale - CREW_MODEL_LABEL.edgePx * 2),
    ),
  };
}
