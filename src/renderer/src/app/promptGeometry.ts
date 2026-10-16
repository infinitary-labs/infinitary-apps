/**
 * The composer's room on the stage (docs/composer.md, "Growth and reflow").
 * The input is pinned by its bottom and grows upward; the Firstmate's frame
 * lifts by half the growth. The input's top may come down to the frame's
 * bottom and no further.
 */

/** The input's bottom sits this far above the floor (`--space-9`). */
export const PROMPT_FLOOR = 96;
/** One line: the pill (`--prompt-height`). */
export const PROMPT_HEIGHT = 52;
/** The Firstmate and the card are centred this far above the stage's middle. */
export const STAGE_LIFT = 60;
/** The Firstmate's frame (HomeMate's `size`). */
export const MATE_FRAME = 300;
/**
 * The last turn above the input (./LastTurn, docs/composer.md "The last
 * turn"): the captain's 18 px line, the 4 px under it, the reply's 18 px
 * line, and the 10 px above the input's top edge.
 */
export const LAST_TURN_LANE = 18 + 4 + 18 + 10;
/**
 * The stage's air between a tall card and the input already holds one 22 px
 * line and its 10 px gap above the input; the last turn takes the rest,
 * published with the composer's growth in `--prompt-rise` while a turn
 * shows. The Firstmate and the card lift by half of it, a tall card's cap
 * shrinks by all of it, and the input's own growth gives up as much.
 */
export const LAST_TURN_RISE = LAST_TURN_LANE - (22 + 10);

/** The air the input keeps from the docked rails, both sides together (2 × `--space-4`). */
export const PROMPT_RAIL_MARGIN = 32;
/**
 * The narrowest the input is drawn between docked rails: its width in the
 * smallest window at 100% with Activity and Tasks both expanded (960 px less
 * two 300 px rails less `PROMPT_RAIL_MARGIN`), where every hint has a form
 * that fits its one line beside Add files (docs/composer.md).
 */
export const PROMPT_MIN_WIDTH = 328;

/**
 * Whether the docked rails would leave the input narrower than
 * `PROMPT_MIN_WIDTH` in a page `windowWidth` wide, with `left` and `right`
 * the px the rails ask for (`--rail-docked-*`, 0 for a rail with no expanded
 * panel). Then they fold for it, as they do for a card (docs/renderer.md,
 * "Docked rails and the input's room"). A larger Size makes the page
 * narrower, so it holds only above 100%: at 100% the smallest window leaves
 * exactly this width.
 */
export function promptFoldsRails(windowWidth: number, left: number, right: number): boolean {
  return left + right > 0 && windowWidth - left - right - PROMPT_RAIL_MARGIN < PROMPT_MIN_WIDTH;
}

/**
 * The tallest the input's shell may be in a window `windowHeight` tall.
 *
 * With the shell `h` tall its top is at `H - PROMPT_FLOOR - h`, and the
 * frame's bottom at `H/2 - STAGE_LIFT - (h - PROMPT_HEIGHT)/2 + MATE_FRAME/2`.
 * Keeping the first at or below the second gives this bound: 376 px in an
 * 800 px window (8 lines fit), 216 px at the 640 px minimum (about 6).
 * A window a larger size makes shorter than that gives back the stage's air
 * (design/styles.css): the input's foot comes down and the frame's centre
 * follows only half of it, so this bound stays clear of the frame there too.
 * A foot that collapsed panel headers lift (./promptFoot) goes up by more
 * than the frame does, so HomePrompt takes the lift off this bound.
 */
export function promptShellMax(windowHeight: number): number {
  return windowHeight - 2 * PROMPT_FLOOR + 2 * STAGE_LIFT - MATE_FRAME - PROMPT_HEIGHT;
}
