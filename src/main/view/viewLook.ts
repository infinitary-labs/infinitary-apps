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
  type ShellPreferences,
} from "@shared/preferences";
import type { PreferenceSource } from "../windowSize";

/**
 * This Mac's own look while it controls Firstmate on another Mac
 * (captain's pick on FI3-681, docs/view.md): size, theme, wash, crew model
 * names and how the panels sit are set here, starting from the other Mac's
 * when it joins, and the other Mac keeps its own. Its panels the captain
 * added stay there, so they are off here. The keys a person changes here
 * are this Mac's too (docs/keyboard.md): they start on a new profile's
 * preset, and the other Mac never hears of them. A look kept from a version
 * before presets, which saved no keys, stays on Legacy.
 */
export class ViewLook implements PreferenceSource {
  private look: OwnLook | null;
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
      panels: { enabled: false, offReason: null },
    };
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
    const value = this.get();
    this.emit(value);
    for (const listener of this.listeners) listener(value);
  }
}
