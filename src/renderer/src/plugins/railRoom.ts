/** The physical readings of one shown panel, in display order. */
export type RailRoomPanel = {
  id: string;
  end: "top" | "bottom";
  header: number;
  body: number;
  collapsed: boolean;
  pinned: boolean;
};

/** INF-609: fold the middle, then reserve one More header for those that cannot fit. */
export function railRoom(
  panels: readonly RailRoomPanel[],
  height: number,
  gap: number,
  moreHeight: number,
  picked?: string,
) {
  const folded = new Set<string>();
  const hidden = new Set<string>();
  const top = panels.filter((panel) => panel.end === "top");
  const bottom = panels.filter((panel) => panel.end === "bottom");
  const distances = new Map([
    ...top.map((panel, index) => [panel.id, index] as const),
    ...bottom.map((panel, index) => [panel.id, bottom.length - 1 - index] as const),
  ]);
  // Stable ties keep the top group first. No panel-count limit or quadratic
  // re-summing: each fold/hide spends exactly the physical room it releases.
  const candidates = [...panels].sort(
    (a, b) =>
      Number(a.pinned) - Number(b.pinned) ||
      (distances.get(b.id) ?? 0) - (distances.get(a.id) ?? 0),
  );
  let required =
    panels.reduce((sum, panel) => sum + panel.header + (panel.collapsed ? 0 : panel.body), 0) +
    Math.max(0, panels.length - 1) * gap;
  for (const panel of candidates) {
    if (required <= height) break;
    if (!panel.collapsed) {
      folded.add(panel.id);
      required -= panel.body;
    }
  }
  // Choosing More promises this header back, even when earlier expands are pinned.
  const hideOrder = picked
    ? [...candidates].sort((a, b) => Number(a.id === picked) - Number(b.id === picked))
    : candidates;
  for (const panel of hideOrder) {
    if (required <= height) break;
    required += hidden.size ? -panel.header - gap : moreHeight - panel.header;
    hidden.add(panel.id);
  }
  return { folded, hidden };
}
