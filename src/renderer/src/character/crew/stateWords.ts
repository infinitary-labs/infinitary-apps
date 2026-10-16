import type { CrewWord } from "@shared/firstRun";

/**
 * The crewmate's state words (captain's call of 2026-10-01, task FI3-436;
 * docs/first-launch.md "The crewmate's state words"): for someone new, a word
 * directly under a crewmate says what its color means - "Working" while ember,
 * "Idle" once cyan - and each word is taught once per profile.
 *
 * A word counts as taught only when it was shown in full: `shownMs` at full
 * strength with the stage visible. Anything that cuts a showing short (the
 * crewmate closes or leaves, its color changes, a card covers the stage, its
 * summary opens, the window is hidden) cancels it and writes nothing, and the
 * word is offered again on the next crewmate that qualifies.
 *
 * DOM-free and time-injected, like the character machine. The caller feeds
 * it the painted frames on a clock and reads the one word to draw.
 */
export const CREW_STATE_WORD = {
  words: { working: "Working", idle: "Idle" } satisfies Record<CrewWord, string>,
  /** A crewmate must have held its settled state this long before a word appears. */
  holdMs: 1000,
  /** A showing counts after this long at full strength. */
  shownMs: 6000,
  /** The fade in is the design system's --dur-med; the fade out its --dur-slow. */
  fadeInMs: 360,
  fadeOutMs: 700,
  /** Its top edge sits this far under the solid's edge, px. */
  gapPx: 4,
  /** A gap between two reads longer than this is a stall (a hidden window), not time seen. */
  stallMs: 1500,
} as const;

/** A crewmate's blend within this of its target counts as settled. */
const SETTLED = 0.02;

/** The fields of an orbit frame's crewmate the rule reads (./orbit.ts `CrewmateFrame`). */
export type StateWordCrew = {
  id: string;
  status: "working" | "idle";
  phase: "spawning" | "orbiting" | "leaving";
  /** 0..1 eased working blend. */
  work: number;
  activityUnknown?: boolean;
};

export type StateWordInput = {
  now: number;
  crew: readonly StateWordCrew[];
  /** Words already taught on this profile. */
  taught: Readonly<Record<CrewWord, boolean>>;
  /** The home stage is uncovered and the window is showing. */
  visible: boolean;
  /** The crewmate whose summary is open, if any. */
  summaryOf: string | null;
  /** Reduced motion has no blend to wait for. */
  reducedMotion: boolean;
};

export type StateWordState = {
  /** When each crewmate began holding its settled state. */
  held: Readonly<Record<string, { word: CrewWord; since: number }>>;
  showing: { id: string; word: CrewWord; since: number } | null;
  /** A showing that just ended, still fading out. */
  leaving: { id: string; word: CrewWord; since: number } | null;
  lastAt: number | null;
};

export const NO_STATE_WORD: StateWordState = {
  held: {},
  showing: null,
  leaving: null,
  lastAt: null,
};

/** What to draw: the crewmate carrying a word, which word, and whether it is fading in. */
export type StateWordView = { id: string; word: CrewWord; on: boolean };

export type StateWordStep = {
  state: StateWordState;
  view: StateWordView | null;
  /** Set once, on the read that completes a showing. */
  taught: CrewWord | null;
};

/** The word a crewmate could carry now: settled on its orbit in a state. */
function settledWord(crew: StateWordCrew, reducedMotion: boolean): CrewWord | null {
  if (crew.phase !== "orbiting" || crew.activityUnknown) return null;
  const target = crew.status === "working" ? 1 : 0;
  if (!reducedMotion && Math.abs(crew.work - target) > SETTLED) return null;
  return crew.status;
}

export function stepStateWord(state: StateWordState, input: StateWordInput): StateWordStep {
  const { now } = input;
  const stalled = state.lastAt !== null && now - state.lastAt > CREW_STATE_WORD.stallMs;
  const eligible = new Map<string, CrewWord>();
  for (const crew of input.crew) {
    const word = settledWord(crew, input.reducedMotion);
    if (word !== null && !input.taught[word]) eligible.set(crew.id, word);
  }
  const held: Record<string, { word: CrewWord; since: number }> = {};
  for (const [id, word] of eligible) {
    const before = state.held[id];
    held[id] = before && before.word === word && !stalled ? before : { word, since: now };
  }

  let showing = state.showing;
  let leaving = state.leaving;
  let taught: CrewWord | null = null;
  if (leaving && now >= leaving.since + CREW_STATE_WORD.fadeOutMs) leaving = null;
  if (showing) {
    const cut =
      stalled ||
      !input.visible ||
      input.summaryOf === showing.id ||
      eligible.get(showing.id) !== showing.word;
    if (cut) {
      leaving = { ...showing, since: now };
      showing = null;
    } else if (now - showing.since >= CREW_STATE_WORD.shownMs) {
      leaving = { ...showing, since: now };
      taught = showing.word;
      showing = null;
    }
  }
  if (!showing && taught === null && input.visible) {
    // The earliest crewmate in the state carries the word; the roster's order is its age.
    for (const crew of input.crew) {
      const mine = held[crew.id];
      if (mine && input.summaryOf !== crew.id && now - mine.since >= CREW_STATE_WORD.holdMs) {
        showing = { id: crew.id, word: mine.word, since: now };
        leaving = leaving?.id === crew.id ? null : leaving;
        break;
      }
    }
  }
  const view = showing
    ? { id: showing.id, word: showing.word, on: true }
    : leaving
      ? { id: leaving.id, word: leaving.word, on: false }
      : null;
  return { state: { held, showing, leaving, lastAt: now }, view, taught };
}

/**
 * Where the word's anchor sits, in the formation's own pixels: the solid's
 * bottom edge, mirroring the model name above it (./modelLabels.ts).
 */
export function crewStateWordPlacement(
  frame: { x: number; y: number; size: number },
  extent: number,
) {
  return { x: extent / 2 + frame.x, y: extent / 2 + frame.y + frame.size * 0.4 };
}
