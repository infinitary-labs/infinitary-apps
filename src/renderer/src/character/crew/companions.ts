// Companions: crewmates drawn off their own slots beside the crewmate they
// relate to. A crewmate that waits on another, or reviews it, circles it on
// a little perpendicular circle (./satellites.ts); a program's running part
// circles its program's mark (./programs.ts); and every wait and
// review keeps its arrow, circling or on a slot. Here each one's target is
// worked out, as an offset from its own slot in scene space; the orbit model
// (./orbit.ts) eases it there on its springs and draws it.

import { type CenterCue, DEPENDENCY_VISUAL } from "@shared/dependencyVisual";
import type { CrewPhase } from "./orbit";
import type { SceneSlot } from "./orbitPaths";
import type { Seat } from "./programs";
import { satelliteFits, satelliteOffset, satellitePhase, satelliteRadius } from "./satellites";

/** What the companions read of a crewmate: its phase, and the plane and angle its slot rides. */
type Rider = { phase: CrewPhase; plane: number; angle: { readonly x: number } };

/** A companion's offset from its own slot, scene px, and the crewmates its arrows point at. */
export type CompanionTarget = { x: number; y: number; z: number; arrows: string[] };

/** A circling companion's blocker, and where the blocker sat in scene space this frame. */
export type CircleBase = { blocker: string; origin: { x: number; y: number; z: number } };

/**
 * The recorded waits plus each live review: a reviewer circles its builder
 * like a satellite does. A real dependency keeps its place; the reviewers
 * and satellites of one builder share up to three seats, and more than that
 * (or a builder that is itself a satellite) leaves reviewers on their slots.
 * Every reviewer keeps its arrow to the builder, wherever it is drawn. A
 * builder or reviewer off this orbit draws nothing: `live` says whether a
 * crewmate is orbiting here.
 */
export function withReviewCues(
  dependencies: ReadonlyMap<string, CenterCue>,
  reviews: ReadonlyMap<string, string>,
  live: (id: string) => boolean,
): Map<string, CenterCue> {
  const cues = new Map(dependencies);
  // A wait recorded from a reviewer onto its builder (an earlier release's
  // review hold, INF-1876) is the reviewer's circle seen from the other
  // side: the builder never orbits or tethers to its reviewer.
  for (const [reviewer, builder] of reviews) {
    const hold = cues.get(builder);
    if (hold?.blockerId !== reviewer && !hold?.arrows.includes(reviewer)) continue;
    const arrows = hold.arrows.filter((id) => id !== reviewer);
    if (hold.mode === "tether" && arrows.length > 0) cues.set(builder, { ...hold, arrows });
    else cues.delete(builder);
  }
  const byBuilder = new Map<string, string[]>();
  for (const [reviewer, builder] of reviews) {
    if (cues.has(reviewer) || reviewer === builder || !live(reviewer) || !live(builder)) continue;
    const list = byBuilder.get(builder) ?? [];
    list.push(reviewer);
    byBuilder.set(builder, list);
  }
  for (const [builder, reviewers] of byBuilder) {
    reviewers.sort();
    const seated = [...cues.values()]
      .filter((cue) => cue.mode === "satellite" && cue.blockerId === builder)
      .sort((a, b) => a.index - b.index);
    const count = seated.length + reviewers.length;
    const nested = cues.get(builder)?.mode === "satellite";
    const satellite = !nested && count <= DEPENDENCY_VISUAL.maxCompanions;
    if (satellite) {
      for (const [index, cue] of seated.entries()) cues.set(cue.waiterId, { ...cue, index, count });
    }
    reviewers.forEach((reviewer, i) => {
      cues.set(reviewer, {
        waiterId: reviewer,
        mode: satellite ? "satellite" : "tether",
        blockerId: builder,
        index: seated.length + i,
        count: satellite ? count : 1,
        arrows: [builder],
      });
    });
  }
  return cues;
}

/**
 * A part circles its program's mark and never its blocker: its waits keep
 * their arrows, a sibling part's included (the captain's INF-5365 answer),
 * and a wait on a part keeps its slot. Edits `cues` in place.
 */
export function seatParts(cues: Map<string, CenterCue>, seats: ReadonlyMap<string, Seat>): void {
  for (const [id, cue] of cues) {
    if (seats.has(id)) {
      if (cue.arrows.length > 0) cues.set(id, { ...cue, mode: "tether", index: 0, count: 1 });
      else cues.delete(id);
    } else if (cue.mode === "satellite" && seats.has(cue.blockerId))
      cues.set(id, { ...cue, mode: "tether", index: 0, count: 1 });
  }
}

/**
 * Where every companion wants to be this frame. A satellite cue circles its
 * blocker once the planes have settled in (not `blending`) and the whole
 * group fits the scene; otherwise it keeps its slot, arrow and all. A
 * program's part circles its mark. `fallback` holds the groups whose circle
 * already failed its bounds check this frame; `failed` names this pass's.
 */
export function companionTargets(input: {
  cues: ReadonlyMap<string, CenterCue>;
  seats: ReadonlyMap<string, Seat>;
  scenes: ReadonlyMap<string, SceneSlot>;
  crew: ReadonlyMap<string, Rider>;
  blending: boolean;
  fallback: ReadonlySet<string>;
  now: number;
  settled: boolean;
}): {
  wanted: Map<string, CompanionTarget>;
  /** Who is drawn off the main orbit: every seated part and every circle that fits. */
  offMain: Set<string>;
  circleBases: Map<string, CircleBase>;
  failed: string[];
} {
  const { cues, seats, scenes, crew, now, settled } = input;
  const wanted = new Map<string, CompanionTarget>();
  const groups = new Map<string, string[]>();
  const offMain = new Set<string>(seats.keys());
  const circleBases = new Map<string, CircleBase>();
  const failed: string[] = [];
  for (const [id, cue] of cues) {
    if (cue.mode !== "satellite" || input.blending) {
      wanted.set(id, { x: 0, y: 0, z: 0, arrows: cue.arrows });
      continue;
    }
    const list = groups.get(cue.blockerId) ?? [];
    list.push(id);
    groups.set(cue.blockerId, list);
  }
  for (const [blockerId, ids] of groups) {
    const blocker = crew.get(blockerId);
    const origin = blocker ? scenes.get(blockerId) : undefined;
    if (blocker?.phase !== "orbiting" || !origin) {
      for (const id of ids) wanted.set(id, { x: 0, y: 0, z: 0, arrows: [blockerId] });
      continue;
    }
    // Near the edge the circle shrinks rather than throwing its group back to the main orbit.
    const radius = satelliteRadius(blocker.plane, blocker.angle.x, origin);
    const placed = ids.flatMap((id) => {
      const cue = cues.get(id);
      const mate = crew.get(id);
      if (!cue || !mate || mate.phase !== "orbiting") return [];
      const offset = satelliteOffset(
        blocker.plane,
        blocker.angle.x,
        satellitePhase(cue.index, cue.count, now, settled),
        radius,
      );
      return [{ id, x: origin.x + offset[0], y: origin.y + offset[1], z: offset[2] }];
    });
    const fits =
      !ids.some((id) => input.fallback.has(id)) &&
      placed.length === ids.length &&
      satelliteFits(origin);
    if (!fits) failed.push(...ids);
    else
      for (const id of ids) {
        offMain.add(id);
        circleBases.set(id, {
          blocker: blockerId,
          origin: { x: origin.x, y: origin.y, z: origin.z },
        });
      }
    for (const id of ids) {
      const point = placed.find((item) => item.id === id);
      const slot = scenes.get(id);
      // Circling or on its slot, the companion keeps its arrow to the blocker.
      wanted.set(
        id,
        fits && point && slot
          ? {
              x: point.x - slot.x,
              y: point.y - slot.y,
              z: point.z - (slot.z ?? 0),
              arrows: [blockerId],
            }
          : { x: 0, y: 0, z: 0, arrows: [blockerId] },
      );
    }
  }
  for (const [id, seat] of seats) {
    const slot = scenes.get(id);
    if (!slot) continue;
    wanted.set(id, {
      x: seat.x - slot.x,
      y: seat.y - slot.y,
      z: seat.z - slot.z,
      arrows: cues.get(id)?.arrows ?? [],
    });
  }
  return { wanted, offMain, circleBases, failed };
}
