import type { RailSide, RailY } from "@shared/plugins/manifest";
import {
  DEFAULT_LAYOUT,
  effectivePlacement,
  isPanelHidden,
  type Layout,
} from "@shared/preferences";
import { useSyncExternalStore } from "react";

/**
 * The rail layout as the window applies it, keyed by contribution id.
 * Host-owned state (D5 rule 4): a plugin never toggles it. It outlives the
 * rails themselves so a trip through Settings, where the rails are not
 * rendered, keeps the choice, and the CORE holds it (the `layout` KV,
 * src/shared/preferences.ts) so a relaunch keeps it too - even one with a
 * fresh window profile, which is what the `localStorage` copy this replaced
 * could not survive. Since talk-to-personalize Step 1 the Firstmate writes
 * it too ("hide tasks", "put activity on the right"), and every write comes
 * back through `hydrate` with the core's push, so the same record serves a
 * click here and a sentence to the Firstmate.
 *
 * A plain external store, read through `useSyncExternalStore` like a
 * PanelSource, so the same snapshot serves client and static renders.
 *
 * Activity, Tasks and Knowledge start collapsed; every other panel starts open. A
 * missing key means that default. Only the captain's own clicks are
 * persisted from here - a collapse toggle, the whisper's reveal, the
 * create-your-own-panel slot's Hide and the project focus; otherwise
 * visibility and placement are written by the core alone.
 */

/** Built-in bottom docks start collapsed. */
export const DEFAULT_COLLAPSED_PANELS: ReadonlySet<string> = new Set([
  "activity",
  "now",
  "knowledge",
  "automation",
]);

/** null means not hydrated yet; DEFAULT_LAYOUT means every key uses its default. */
let layout: Layout | null = null;
/** How many times each panel was asked to put focus in its body (`askBodyFocus`). */
const bodyFocusAsks = new Map<string, number>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * The core, when the preload has installed it. Absent under vitest and in a
 * static render, where the in-memory record is the whole of the session.
 */
function persist(next: Layout): void {
  const settings = globalThis.window?.infinitary?.settings;
  if (!settings) return;
  void settings
    .setLayout({
      collapsedPanels: { ...next.collapsedPanels },
      hiddenPanels: { ...next.hiddenPanels },
      placements: { ...next.placements },
      ...(next.panelOrder ? { panelOrder: [...next.panelOrder] } : {}),
      ...(next.focusedProjectId ? { focusedProjectId: next.focusedProjectId } : {}),
    })
    .catch(() => {
      // The in-memory record still serves this session.
    });
}

function current(): Layout {
  return layout ?? DEFAULT_LAYOUT;
}

export const railStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /**
   * Adopt the core's record: once before the first render, so a collapsed
   * or hidden panel is never painted on the way to being so, and again on
   * every push, so a change the Firstmate made lands as it is written.
   */
  hydrate(next: Layout): void {
    layout = {
      collapsedPanels: { ...next.collapsedPanels },
      hiddenPanels: { ...next.hiddenPanels },
      placements: { ...next.placements },
      ...(next.panelOrder ? { panelOrder: [...next.panelOrder] } : {}),
      ...(next.focusedProjectId ? { focusedProjectId: next.focusedProjectId } : {}),
    };
    notify();
  },
  /** The record as applied now; the same identity until the next change. */
  layout(): Layout {
    return current();
  },
  isCollapsed(panelId: string): boolean {
    const stored = current().collapsedPanels;
    if (Object.hasOwn(stored, panelId)) return stored[panelId] === true;
    return DEFAULT_COLLAPSED_PANELS.has(panelId);
  },
  /** More is a lasting move to the anchored end, not a collapse or hide. */
  promote(panelId: string): void {
    layout = {
      ...current(),
      panelOrder: [panelId, ...(current().panelOrder ?? []).filter((id) => id !== panelId)],
    };
    persist(layout);
    notify();
  },
  expand(panelId: string): void {
    layout = { ...current(), collapsedPanels: { ...current().collapsedPanels, [panelId]: false } };
    persist(layout);
    notify();
  },
  toggleCollapsed(panelId: string): void {
    const next = !railStore.isCollapsed(panelId);
    layout = { ...current(), collapsedPanels: { ...current().collapsedPanels, [panelId]: next } };
    persist(layout);
    notify();
  },
  /**
   * A user gesture that must END with the panel on screen (the whisper's
   * click): clears the panel's hidden and collapsed deviations together.
   * Hidden is normally the core's write (personalize); this and `hide` are
   * the renderer-side exceptions, and each is still the captain's own click.
   */
  reveal(panelId: string): void {
    const hidden = { ...current().hiddenPanels };
    delete hidden[panelId];
    layout = {
      ...current(),
      hiddenPanels: hidden,
      collapsedPanels: { ...current().collapsedPanels, [panelId]: false },
    };
    persist(layout);
    notify();
  },
  /**
   * The captain's own click on a Hide (the create-your-own-panel slot's):
   * hidden in the same record "hide it" to the Firstmate writes, so "show
   * it again" brings it back.
   */
  hide(panelId: string): void {
    layout = { ...current(), hiddenPanels: { ...current().hiddenPanels, [panelId]: true } };
    persist(layout);
    notify();
  },
  /**
   * F6 (docs/keyboard.md, "Parts of the window"): the panel's mount gives
   * its frame focus, as a click on it would, and asks the panel to put
   * focus where a person starts in it (`asks.onFocus`) - the Tasks list's
   * row. A mount answers only the asks made while it is up.
   */
  askBodyFocus(panelId: string): void {
    bodyFocusAsks.set(panelId, (bodyFocusAsks.get(panelId) ?? 0) + 1);
    notify();
  },
  /** The asks so far for one panel's body to take focus; a mount answers each new one once. */
  bodyFocusAsk(panelId: string): number {
    return bodyFocusAsks.get(panelId) ?? 0;
  },
  /** Kept off its rail by the captain's word, whatever its data says. */
  isHidden(panelId: string): boolean {
    return isPanelHidden(current(), panelId);
  },
  /** Where the panel sits: the captain's record, else what it asked for. */
  placementOf(panelId: string, preferred: { x: RailSide; y: RailY }): { x: RailSide; y: RailY } {
    return effectivePlacement(current(), panelId, preferred);
  },
  /** The project the window is focused on, as saved; null is All projects. */
  focusedProject(): string | null {
    return current().focusedProjectId ?? null;
  },
  /**
   * Focus the window on one project, or on All projects with null: the
   * captain's own pick on the top bar's pill, a Tasks or board chip, or a
   * command (docs/project-focus.md). Saved with the layout, so it outlives
   * a relaunch.
   */
  focusProject(projectId: string | null): void {
    if (railStore.focusedProject() === projectId) return;
    const { focusedProjectId: _was, ...rest } = current();
    layout = projectId === null ? rest : { ...rest, focusedProjectId: projectId };
    persist(layout);
    notify();
  },
  /** Tests only: forget every choice so defaults apply. */
  reset(): void {
    layout = null;
    notify();
  },
};

/** The asks for one panel's body to take focus, read as they change. */
export function useBodyFocusAsk(panelId: string): number {
  const read = () => railStore.bodyFocusAsk(panelId);
  return useSyncExternalStore(railStore.subscribe, read, read);
}

/** The saved focus, read as it changes; null is All projects. */
export function useSavedFocus(): string | null {
  return useSyncExternalStore(
    railStore.subscribe,
    railStore.focusedProject,
    railStore.focusedProject,
  );
}

export function usePanelCollapsed(panelId: string): boolean {
  const read = () => railStore.isCollapsed(panelId);
  return useSyncExternalStore(railStore.subscribe, read, read);
}

/** The whole record, for the placement pass over every registered panel. */
export function useRailLayout(): Layout {
  return useSyncExternalStore(railStore.subscribe, railStore.layout, railStore.layout);
}
