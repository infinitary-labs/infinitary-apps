/**
 * One reading of recorded "blocked by" edges for the center stage and the
 * Tasks list (captain's FI3-1680 choice). Both surfaces consume this
 * projection. Neither infers a relationship from a title, a parent or prose.
 *
 * Satellites are only an idle dependency wait with one visible crewmate on
 * the same computer, and at most three of them. Everything else that still
 * has both crewmates keeps its slot and uses a tether. A missing or remote
 * blocker is not a cue here: the summary names that key, and no crewmate is
 * invented.
 */

export const DEPENDENCY_VISUAL = {
  /** Scene pixels, before the stage's existing fit. */
  radiusPx: 64,
  /** Satellite travel on the stage clock. Main orbits keep their own pace. */
  degPerSec: 24,
  maxCompanions: 3,
  edgeLanes: 3,
  /** Reserved beside Tasks rows, in addition to their existing padding. */
  gutterPx: 36,
} as const;

export type CenterNode = {
  id: string;
  key: string;
  blockedBy: readonly string[];
  /** Null is this computer. */
  deviceId: string | null;
  /** Host-proven idle wait on a dependency, never a cool color alone. */
  idleDependency: boolean;
  /** An active work crewmate, so the stage has a glyph for it. */
  crewed: boolean;
};

export type CenterCue = {
  waiterId: string;
  mode: "satellite" | "tether";
  blockerId: string;
  index: number;
  count: number;
  /** Blockers to connect with a tether. Empty while the waiter is a satellite. */
  arrows: string[];
};

/** What the stage may draw. Named and remote waits are absent, on purpose. */
export function centerCues(nodes: readonly CenterNode[]): CenterCue[] {
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const blocksSomeone = (key: string) => nodes.some((node) => node.blockedBy.includes(key));
  const sameCrew = (waiter: CenterNode, blocker: CenterNode) =>
    waiter.crewed && blocker.crewed && waiter.deviceId === blocker.deviceId;
  const groups = new Map<string, CenterNode[]>();
  const cues: CenterCue[] = [];
  for (const waiter of nodes) {
    if (!waiter.crewed || waiter.blockedBy.length === 0) continue;
    const blockers = waiter.blockedBy.flatMap((key) => {
      const blocker = byKey.get(key);
      return blocker && sameCrew(waiter, blocker) ? [blocker] : [];
    });
    if (blockers.length === 0) continue;
    const only = blockers.length === 1 ? blockers[0] : undefined;
    const eligible =
      only !== undefined &&
      waiter.idleDependency &&
      waiter.blockedBy.length === 1 &&
      only.blockedBy.length === 0 &&
      !blocksSomeone(waiter.key);
    if (eligible && only) {
      const list = groups.get(only.id) ?? [];
      list.push(waiter);
      groups.set(only.id, list);
      continue;
    }
    cues.push({
      waiterId: waiter.id,
      mode: "tether",
      blockerId: blockers[0]?.id ?? waiter.id,
      index: 0,
      count: 1,
      arrows: blockers.map((blocker) => blocker.id),
    });
  }
  for (const [blockerId, waiters] of groups) {
    waiters.sort((a, b) => a.key.localeCompare(b.key));
    const satellite = waiters.length <= DEPENDENCY_VISUAL.maxCompanions;
    waiters.forEach((waiter, index) => {
      cues.push({
        waiterId: waiter.id,
        mode: satellite ? "satellite" : "tether",
        blockerId,
        index,
        count: waiters.length,
        arrows: satellite ? [] : [blockerId],
      });
    });
  }
  return cues;
}

export type ListTask = { id: string; key: string; blockedBy: readonly string[] };

export type ListEdge = {
  fromId: string;
  toId: string;
  lane: number;
  /** Drawn only because a row of this relationship is inspected. */
  overflow: boolean;
};

/**
 * Margin edges for rows that are actually on screen. A folded, filtered or
 * offscreen end is simply absent: the caller does not pass it in `placed`,
 * and nothing here invents a line to it. `placed` is row id to its center.
 */
export function listEdges(
  tasks: readonly ListTask[],
  placed: ReadonlyMap<string, number>,
  inspectedId: string | null,
): ListEdge[] {
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  const candidates: { fromId: string; toId: string; blockerId: string }[] = [];
  for (const task of tasks) {
    if (!placed.has(task.id)) continue;
    for (const key of task.blockedBy) {
      const blocker = byKey.get(key);
      if (!blocker || !placed.has(blocker.id)) continue;
      candidates.push({ fromId: task.id, toId: blocker.id, blockerId: blocker.id });
    }
  }
  const laneOf = new Map<string, number>();
  for (const edge of candidates) {
    if (laneOf.has(edge.blockerId) || laneOf.size >= DEPENDENCY_VISUAL.edgeLanes) continue;
    laneOf.set(edge.blockerId, laneOf.size);
  }
  const edges: ListEdge[] = [];
  for (const edge of candidates) {
    const lane = laneOf.get(edge.blockerId);
    const inspected = inspectedId === edge.fromId || inspectedId === edge.toId;
    if (lane === undefined) {
      if (!inspected) continue;
      edges.push({ ...edge, lane: DEPENDENCY_VISUAL.edgeLanes - 1, overflow: true });
    } else {
      edges.push({ ...edge, lane, overflow: false });
    }
  }
  return edges;
}
