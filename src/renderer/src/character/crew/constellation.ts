import type { TaskLinkView, TaskView } from "@shared/tasks";

/**
 * A program the host runs, drawn on the stage as a branching constellation
 * (the captain's INF-799 choice). Everything here is read from the graph's
 * own facts: a task the board marks as running a program (`TaskView.program`,
 * its `shape.program`), its children, and the recorded "blocks" links among
 * them. A part hangs from the parts it waits on, so parallel parts are
 * siblings under the root, a pipeline is a chain and a part after a barrier
 * joins several branches. No link is inferred from a title, a script or an
 * order, and a task that only holds children is no program (INF-999): its
 * parts orbit as every crewmate does.
 */

/**
 * The captain's staged settings (INF-799, `program_animation.tree`):
 * branches of 60 px, 70 degrees of spread at each layer, and a finished
 * tree that folds into its root. The shape and the demo's parts and pace
 * were the preview's only.
 */
export const CONSTELLATION = {
  /** The first layer's distance from the root, scene px. */
  branchPx: 60,
  /** Each later layer is this share of the one before, as in the preview. */
  branchDecay: 0.82,
  /** A layer's whole spread round the root's outward direction, degrees. */
  spreadDeg: 70,
  collapse: "fold" as "fold" | "fade",
  /** The program's mark, a hollow ring, px. */
  rootMarkPx: 5,
  /** A wide layer shrinks its glyphs, as the preview did past nine. */
  comfortableLayer: 9,
} as const;

export type PartState = "live" | "done" | "open";

export type ProgramPart = {
  id: string;
  /** The sibling parts it waits on; empty hangs it from the root. */
  parents: string[];
  state: PartState;
};

export type Program = {
  /** The parent task's id; the root is its node. */
  id: string;
  /** Live while the parent is open or underway; its close says how it goes. */
  state: "live" | "done" | "dropped";
  /** In the order they were filed. */
  parts: ProgramPart[];
};

function partState(task: TaskView): PartState | null {
  if (task.status === "active") return "live";
  if (task.status === "open") return "open";
  if (task.status === "done") return "done";
  // A dropped part dims and drifts off as today; it leaves no node.
  return null;
}

/**
 * Every program on the board with work parts, and how each part hangs. A
 * host-commissioned review is the builder's own cue, never a part.
 */
export function programsOf(tasks: readonly TaskView[], links: readonly TaskLinkView[]): Program[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const children = new Map<string, TaskView[]>();
  for (const task of tasks) {
    if (!task.parentId || task.kind !== "work" || task.reviewOf) continue;
    if (!byId.has(task.parentId)) continue;
    const list = children.get(task.parentId) ?? [];
    list.push(task);
    children.set(task.parentId, list);
  }
  const waitsOn = new Map<string, string[]>();
  for (const link of links) {
    if (link.type !== "blocks") continue;
    const list = waitsOn.get(link.toId) ?? [];
    list.push(link.fromId);
    waitsOn.set(link.toId, list);
  }
  const programs: Program[] = [];
  for (const [parentId, kids] of children) {
    const parent = byId.get(parentId);
    // Only a program the host runs is a constellation; any other parent's
    // children orbit as they always have (INF-999).
    if (!parent?.program) continue;
    const ordered = [...kids].sort(
      (a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key),
    );
    const parts: ProgramPart[] = [];
    for (const kid of ordered) {
      const state = partState(kid);
      if (!state) continue;
      parts.push({ id: kid.id, parents: [], state });
    }
    const siblings = new Set(parts.map((part) => part.id));
    for (const part of parts)
      part.parents = (waitsOn.get(part.id) ?? []).filter(
        (id) => siblings.has(id) && id !== part.id,
      );
    if (parts.length === 0) continue;
    const state =
      parent.status === "done" ? "done" : parent.status === "dropped" ? "dropped" : "live";
    programs.push({ id: parentId, state, parts });
  }
  return programs.sort((a, b) => a.id.localeCompare(b.id));
}

export type NodePlace = { x: number; y: number; layer: number; angle: number };

/**
 * The layered layout from the root (scene px, y down): a layer per distance
 * from the root, each layer spread evenly across the spread and ordered by
 * its parents' angles so a chain stays straight, and the whole graph
 * scaled about its root when a node would leave `half` (a square half-size).
 */
export function layoutProgram(
  parts: readonly ProgramPart[],
  root: { x: number; y: number },
  half: number,
): Map<string, NodePlace> {
  const out = Math.atan2(root.y, root.x);
  const byId = new Map(parts.map((part) => [part.id, part]));
  const layer = new Map<string, number>();
  const layerOf = (id: string, seen: Set<string>): number => {
    const known = layer.get(id);
    if (known !== undefined) return known;
    const part = byId.get(id);
    if (!part || seen.has(id)) return 0;
    seen.add(id);
    let deepest = 0;
    for (const parent of part.parents) deepest = Math.max(deepest, layerOf(parent, seen));
    layer.set(id, deepest + 1);
    return deepest + 1;
  };
  for (const part of parts) layerOf(part.id, new Set());
  const layers: ProgramPart[][] = [];
  for (const part of parts) {
    const l = layer.get(part.id) ?? 1;
    const members = layers[l] ?? [];
    members.push(part);
    layers[l] = members;
  }
  const spread = (CONSTELLATION.spreadDeg * Math.PI) / 180;
  const placed = new Map<string, NodePlace>();
  let distance = 0;
  for (let l = 1; l < layers.length; l++) {
    distance += CONSTELLATION.branchPx * CONSTELLATION.branchDecay ** (l - 1);
    const members = layers[l] ?? [];
    const keyed = members.map((part, order) => {
      const angles = part.parents.map((id) => placed.get(id)?.angle ?? out);
      const key = angles.length ? angles.reduce((a, b) => a + b, 0) / angles.length : out;
      return { part, key, order };
    });
    keyed.sort((a, b) => a.key - b.key || a.order - b.order);
    keyed.forEach(({ part }, j) => {
      const angle = keyed.length > 1 ? out + spread * (j / (keyed.length - 1) - 0.5) : out;
      placed.set(part.id, {
        x: root.x + Math.cos(angle) * distance,
        y: root.y + Math.sin(angle) * distance,
        layer: l,
        angle,
      });
    });
  }
  let fit = 1;
  for (const place of placed.values()) {
    for (const [p, r] of [
      [place.x, root.x],
      [place.y, root.y],
    ] as const) {
      const d = p - r;
      if (Math.abs(p) <= half || d === 0) continue;
      fit = Math.min(fit, (Math.sign(d) * half - r) / d);
    }
  }
  if (fit < 1) {
    fit = Math.max(0, fit);
    for (const place of placed.values()) {
      place.x = root.x + (place.x - root.x) * fit;
      place.y = root.y + (place.y - root.y) * fit;
    }
  }
  return placed;
}

/** A wide layer's glyph share, as the preview drew it. */
export function layerGlyphShare(
  parts: readonly ProgramPart[],
  places: Map<string, NodePlace>,
): number {
  const widths = new Map<number, number>();
  for (const part of parts) {
    const l = places.get(part.id)?.layer;
    if (l !== undefined) widths.set(l, (widths.get(l) ?? 0) + 1);
  }
  const widest = Math.max(1, ...widths.values());
  return Math.min(1, Math.sqrt(CONSTELLATION.comfortableLayer / widest));
}
