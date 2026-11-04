import type { SavedKeymap, SavedKeymapRead } from "@shared/keymap";
import {
  type ArrangedPanel,
  arrangePanels,
  sameArrangement,
  withoutPanel,
} from "@shared/panelArrangement";
import type {
  Appearance,
  Layout,
  PersonalPanels,
  ShellPreferences as ShellPreferencesValue,
  Theme,
} from "@shared/preferences";
import type { CoreEventSink } from "../events";
import type { SettingsStore } from "../storage/settingsStore";

/**
 * The one writer of the captain's presentation preferences (talk-to-
 * personalize Step 1; `src/shared/preferences.ts`). Two callers share it -
 * the window's own controls over `inf:settings:appearance|layout:set`, and
 * the Firstmate's `personalize` tool - and every write ends the same way:
 * the row is stored and the WHOLE value is pushed as `inf:shell:preferences`,
 * the `shell.preferences` read's value, so the host applies a change the
 * moment it lands whoever made it. Nothing else writes the two rows.
 *
 * A per-panel record holds only a deviation from the panel's default (the
 * shared schema's rule): hiding a panel writes `true`, showing it again
 * deletes the key rather than writing `false`, and a cleared panel has no
 * record at all. The arrangement is the exception (INF-2344): it lists
 * every panel the app knows, in its slot and in order, and `reconcile`
 * writes each new panel in.
 *
 * Step 5 added the third row, `panels`: the host-owned switch over the
 * captain's own panels. It has no Firstmate caller - only the window's
 * control and the safe-mode boot write it - and the core's personal
 * extension host follows it through `subscribe`, which every write calls
 * after the push, so "off" reaches the renderer as an empty snapshot in
 * the same tick as the preference itself.
 *
 * The keys a person changed (docs/keyboard.md) are kept here too, in their
 * own row, but are not part of the `shell.preferences` read: they belong
 * to the Mac whose keyboard pressed them, so no paired device reads them.
 * The window's main process is their one reader and writer; it installs
 * each change itself, so a write pushes nothing.
 */
export class ShellPreferencesService {
  private readonly listeners = new Set<(value: ShellPreferencesValue) => void>();

  constructor(
    private readonly settings: SettingsStore,
    private readonly emit: CoreEventSink,
  ) {}

  get(): ShellPreferencesValue {
    return {
      appearance: this.settings.getAppearance(),
      layout: this.settings.getLayout(),
      panels: this.settings.getPersonalPanels(),
    };
  }

  /**
   * Every write, for the core services that must follow one. The personal
   * extension host is the only subscriber today; it is notified after the
   * push, so a client that reacts to either sees the same value.
   */
  subscribe(listener: (value: ShellPreferencesValue) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setAppearance(appearance: Appearance): Appearance {
    this.settings.setAppearance(appearance);
    this.push();
    return this.settings.getAppearance();
  }

  setLayout(layout: Layout): Layout {
    this.settings.setLayout(layout);
    this.push();
    return this.settings.getLayout();
  }

  setTheme(theme: Theme): Appearance {
    return this.setAppearance({ ...this.settings.getAppearance(), theme });
  }

  /**
   * The host-owned switch (Step 5). Off unmounts every personal panel and
   * stops every server module; the reason is what the app says instead of
   * letting the panels vanish without explanation.
   */
  setPersonalPanels(enabled: boolean, offReason: PersonalPanels["offReason"]): PersonalPanels {
    this.settings.setPersonalPanels({ enabled, offReason: enabled ? null : offReason });
    this.push();
    return this.settings.getPersonalPanels();
  }

  /** The keys a person changed on this Mac, as saved (docs/keyboard.md). */
  keymap(): SavedKeymapRead {
    return this.settings.getKeymap();
  }

  setKeymap(keymap: SavedKeymap): void {
    this.settings.setKeymap(keymap);
  }

  /** Keeps a panel off its rail (`true`) or lets its own data decide again. */
  setPanelHidden(panelId: string, hidden: boolean): Layout {
    return this.updateLayout((layout) => {
      const hiddenPanels = { ...layout.hiddenPanels };
      if (hidden) hiddenPanels[panelId] = true;
      else delete hiddenPanels[panelId];
      return { ...layout, hiddenPanels };
    });
  }

  /**
   * Writes in every panel the arrangement does not list yet
   * (`arrangePanels`): the first time, the whole arrangement, built from
   * where the rails drew each panel before it existed, so nothing moves;
   * after that, each new panel at its slot's middle. A panel the app no
   * longer knows keeps its place, so one that comes back returns there;
   * only `clearPanel` forgets one. The first write also keeps the newest
   * More pick, which the saved priority list led with, so a full rail keeps
   * that header on screen as before. Writes and pushes only on a change.
   */
  reconcile(panels: readonly ArrangedPanel[]): Layout {
    const layout = this.settings.getLayout();
    const arrangement = arrangePanels(layout, panels);
    if (layout.arrangement && sameArrangement(layout.arrangement, arrangement)) return layout;
    const morePick = layout.morePick ?? (layout.arrangement ? undefined : layout.panelOrder?.[0]);
    return this.setLayout({ ...layout, arrangement, ...(morePick ? { morePick } : {}) });
  }

  /** Forgets every record about a panel: collapse, visibility, its place and a More pick of it. */
  clearPanel(panelId: string): Layout {
    return this.updateLayout((layout) => {
      const collapsedPanels = { ...layout.collapsedPanels };
      const hiddenPanels = { ...layout.hiddenPanels };
      const placements = { ...layout.placements };
      delete collapsedPanels[panelId];
      delete hiddenPanels[panelId];
      delete placements[panelId];
      const { morePick, ...rest } = layout;
      return {
        ...rest,
        collapsedPanels,
        hiddenPanels,
        placements,
        ...(layout.panelOrder
          ? { panelOrder: layout.panelOrder.filter((id) => id !== panelId) }
          : {}),
        ...(layout.arrangement ? { arrangement: withoutPanel(layout.arrangement, panelId) } : {}),
        ...(morePick && morePick !== panelId ? { morePick } : {}),
      };
    });
  }

  private updateLayout(change: (layout: Layout) => Layout): Layout {
    return this.setLayout(change(this.settings.getLayout()));
  }

  private push(): void {
    const value = this.get();
    this.emit("inf:shell:preferences", value);
    for (const listener of this.listeners) listener(value);
  }
}
