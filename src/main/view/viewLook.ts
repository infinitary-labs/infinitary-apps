import type { JoinedHome, OwnLook } from "@core/devices/joinedHome";
import {
  presetKeymap,
  readSavedKeymap,
  type SavedKeymap,
  type SavedKeymapRead,
} from "@shared/keymap";
import { NEW_PROFILE_PRESET } from "@shared/keyPresets";
import {
  type Appearance,
  DEFAULT_APPEARANCE,
  DEFAULT_LAYOUT,
  type Layout,
  type PersonalPanels,
  type ShellPreferences,
} from "@shared/preferences";
import type { PreferenceSource } from "../windowSize";

/** No word yet from the first mate on its panels switch: none are drawn. */
const PANELS_UNHEARD: PersonalPanels = { enabled: false, offReason: null };

/**
 * This Mac's own look while it controls Firstmate on another Mac
 * (captain's pick on FI3-681, docs/view.md): size, theme, wash, crew model
 * names and how the panels sit are set here, starting from the other Mac's
 * when it joins, and the other Mac keeps its own. Whether the captain's
 * panels run at all is the first mate's switch, heard from it and never
 * kept here (docs/view.md, "Panels in every window"). The keys a person changes here
 * are this Mac's too (docs/keyboard.md): they start on a new profile's
 * preset, and the other Mac never hears of them. A look kept from a version
 * before presets, which saved no keys, stays on Legacy.
 */
export class ViewLook implements PreferenceSource {
  private look: OwnLook | null;
  /** The first mate's panels switch as last heard; off until it is. */
  private panels: PersonalPanels = PANELS_UNHEARD;
  private readonly listeners = new Set<(value: ShellPreferences) => void>();

  constructor(
    private readonly store: JoinedHome,
    private readonly emit: (value: ShellPreferences) => void,
  ) {
    this.look = store.look();
  }

  /** Whether this Mac has a look of its own yet; until then it takes the other Mac's once. */
  seeded(): boolean {
    return this.look !== null;
  }

  /** Starts from the other Mac's look, once, with this Mac's keys on a new profile's preset. */
  seed(from: OwnLook): void {
    if (this.look) return;
    this.save({ ...from, keyboard: from.keyboard ?? presetKeymap(NEW_PROFILE_PRESET) });
  }

  get(): ShellPreferences {
    return {
      appearance: this.look?.appearance ?? DEFAULT_APPEARANCE,
      layout: this.look?.layout ?? DEFAULT_LAYOUT,
      panels: this.panels,
    };
  }

  /**
   * The first mate's panels switch, which is the first mate's alone
   * (docs/view.md, "Panels in every window"): heard at each welcome and
   * whenever it changes there, never kept, and off until it is heard.
   */
  heardPanels(panels: PersonalPanels | null): void {
    const next = panels ?? PANELS_UNHEARD;
    if (next.enabled === this.panels.enabled && next.offReason === this.panels.offReason) return;
    this.panels = next;
    this.tell();
  }

  /**
   * Takes the first mate's look whole, and its keys when given: the window
   * opened beside a first mate a command started follows that first mate's
   * look and keys, on its computer only (docs/run.md, "The window opened
   * beside it"). The copy kept here is what the window draws with before
   * that first mate answers and while it is down.
   */
  follow(theirs: ShellPreferences, keys?: SavedKeymap): void {
    this.panels = theirs.panels;
    const keyboard = keys ?? this.look?.keyboard;
    this.save({
      appearance: theirs.appearance,
      layout: theirs.layout,
      ...(keyboard === undefined ? {} : { keyboard }),
    });
  }

  subscribe(listener: (value: ShellPreferences) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setAppearance(appearance: Appearance): Appearance {
    this.save({ ...this.own(), appearance });
    return appearance;
  }

  setLayout(layout: Layout): Layout {
    this.save({ ...this.own(), layout });
    return layout;
  }

  /** The keys a person changed on this Mac while it controls another. */
  keymap(): SavedKeymapRead {
    // A look saved before presets kept no keys: Legacy, as every key was then.
    return readSavedKeymap(this.look?.keyboard, this.look ? "legacy" : NEW_PROFILE_PRESET);
  }

  /**
   * Kept with the look, but not pushed as it: the keys are not part of what
   * the window's look shows, and the window's installed map reads them
   * again itself after its own write (./keyboard.ts).
   */
  setKeymap(keymap: SavedKeymap): void {
    const look: OwnLook = { ...this.own(), keyboard: keymap };
    this.store.setLook(look);
    this.look = look;
  }

  private own(): OwnLook {
    const { appearance, layout } = this.get();
    return this.look?.keyboard === undefined
      ? { appearance, layout }
      : { appearance, layout, keyboard: this.look.keyboard };
  }

  private save(look: OwnLook): void {
    this.look = look;
    try {
      this.store.setLook(look);
    } catch {
      // Kept for this run; the next one starts from the other Mac's again.
    }
    this.tell();
  }

  private tell(): void {
    const value = this.get();
    this.emit(value);
    for (const listener of this.listeners) listener(value);
  }
}
