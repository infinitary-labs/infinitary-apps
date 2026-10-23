import { CONSTELLATION } from "./constellation";
import type { CrewmateFrame, OrbitFrame } from "./orbit";

/** Something painted on the stage that the pointer and the keyboard can reach. */
export type StageMark = Pick<
  CrewmateFrame,
  "id" | "x" | "y" | "size" | "depth" | "phase" | "unfold"
>;

/**
 * Every mark the stage paints, each by the task it stands for (INF-999): a
 * crewmate and a program's root ring. A program's running parts are its
 * crewmates and nothing else of it is painted (INF-1037). Each is pointed
 * at, summarised and opened the same way, so nothing painted is a mark
 * without a name.
 */
export function stageMarks(frame: Pick<OrbitFrame, "crew" | "programs">): StageMark[] {
  const marks: StageMark[] = [...frame.crew];
  for (const program of frame.programs) {
    // A program folding away is going, as a departing crewmate is.
    const phase = program.alpha < 0.5 ? "leaving" : "orbiting";
    marks.push({
      id: program.id,
      x: program.x,
      y: program.y,
      size: CONSTELLATION.rootMarkPx * 2,
      depth: program.depth,
      phase,
      unfold: 1,
    });
  }
  return marks;
}

/**
 * The marks that are not crewmates: the ones the crew's own names do not
 * reach. A program running parts on several computers has a ring in each
 * group (INF-1037); the keyboard reaches its first, since every copy opens
 * the same task.
 */
export function programMarks(frame: Pick<OrbitFrame, "crew" | "programs">): StageMark[] {
  const crew = new Set(frame.crew.map((c) => c.id));
  const seen = new Set<string>();
  return stageMarks(frame).filter((mark) => {
    if (crew.has(mark.id) || seen.has(mark.id)) return false;
    seen.add(mark.id);
    return true;
  });
}

/**
 * The painted mark for a task: the one nearest `near` when a program's ring
 * is drawn on more than one computer, so a summary opens beside the copy
 * pointed at; otherwise the first.
 */
export function markOf(
  marks: readonly StageMark[],
  id: string | null,
  near?: { x: number; y: number } | null,
): StageMark | undefined {
  let best: StageMark | undefined;
  let bestD = Number.POSITIVE_INFINITY;
  for (const mark of marks) {
    if (mark.id !== id) continue;
    if (!near) return mark;
    const d = Math.hypot(mark.x - near.x, mark.y - near.y);
    if (d < bestD) {
      best = mark;
      bestD = d;
    }
  }
  return best;
}
