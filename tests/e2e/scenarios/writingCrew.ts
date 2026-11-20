import type { Scenario } from "../mockProvider";

/**
 * Crewmates that keep writing (INF-2078's approved plan; the latency check,
 * tests/e2e/latency.check.spec.ts). Each crewmate the first mate
 * commissions with this marker in its title notes its progress once every
 * `WRITING_CREW_PERIOD_MS`, for as long as the app runs, the way a crewmate
 * at work keeps its task's record moving: every line is a change the Tasks
 * list redraws for. It never reports, so its task stays active and its
 * writes never stop.
 */
export const WRITING_CREW_MARKER = "keep writing progress";
/** The crew the plan names: six crewmates writing at once. */
export const WRITING_CREW_SIZE = 6;
/** How long each crewmate takes between one progress line and the next. */
export const WRITING_CREW_PERIOD_MS = 1_000;

export const writingCrew: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) => {
    if (isFirstmate || !wantsStream || !body.includes(WRITING_CREW_MARKER)) return undefined;
    // The lines already written are in the turn's own transcript.
    const part = body.split("Checked part ").length;
    return {
      afterMs: WRITING_CREW_PERIOD_MS,
      calls: [{ name: "note_progress", args: { text: `Checked part ${part} of the change.` } }],
    };
  };
