import { CONSTELLATION } from "./constellation";
import type { CrewmateFrame, OrbitFrame } from "./orbit";

/** Something painted on the stage that the pointer and the keyboard can reach. */
export type StageMark = Pick<
  CrewmateFrame,
  "id" | "x" | "y" | "size" | "depth" | "phase" | "unfold"
>;

/**
 * Every mark the stage paints, each by the task it stands for (INF-999): a
 * crewmate, a program's root ring and a part's own node where no crewmate
 * sits on it. Each is pointed at, summarised and opened the same way, so
 * nothing painted is a mark without a name.
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
    for (const node of program.nodes) {
      if (node.crewed) continue;
      marks.push({
        id: node.id,
        x: node.x,
        y: node.y,
        size: CONSTELLATION.rootMarkPx,
        depth: program.depth,
        phase,
        unfold: 1,
      });
    }
  }
  return marks;
}

/** The marks that are not crewmates: the ones the crew's own names do not reach. */
export function programMarks(frame: Pick<OrbitFrame, "crew" | "programs">): StageMark[] {
  const crew = new Set(frame.crew.map((c) => c.id));
  return stageMarks(frame).filter((mark) => !crew.has(mark.id));
}
