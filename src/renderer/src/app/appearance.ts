import type { SavedOwnStyle } from "@shared/ambientOwn";
import type { FontChoices, FontSlot } from "@shared/fonts";
import {
  type Appearance,
  DEFAULT_AMBIENT_STYLE,
  DEFAULT_AMBIENT_VOLUME,
  DEFAULT_APPEARANCE,
  type DefaultCardSize,
  type Theme,
  type UiSize,
} from "@shared/preferences";
import { DEFAULT_USAGE_UNIT, type UsageUnit } from "@shared/usage";
import { SettingSave } from "../settings/settingSave";
import type { ShellGet, ShellSet, ShellState } from "./store";

/** One appearance choice, named as the control that writes it. */
export type AppearanceChoice = keyof Appearance;

/**
 * The window's look. The theme and the rest are a persisted PREFERENCE, not
 * window state: the core defines and holds them (src/shared/preferences.ts),
 * and they are only mirrored here so the tree can read them synchronously.
 */
export type AppearanceSlice = {
  theme: Theme;
  defaultCardSize: DefaultCardSize;
  setDefaultCardSize: (size: DefaultCardSize) => void;
  /** Keep cards maximized: a maximize or restore carries to every card (docs/renderer.md). */
  keepCardsMaximized: boolean;
  setKeepCardsMaximized: (on: boolean) => void;
  /** Whether the last maximize or restore, while Keep cards maximized is on, maximized a card. */
  cardsMaximized: boolean;
  setCardsMaximized: (maximized: boolean) => void;
  size: UiSize;
  setSize: (size: UiSize) => void;
  washStrength: number;
  showCrewModelNames: boolean;
  /** Whether the ambient music plays, and how loud, 0-100 (docs/ambient-music.md). */
  ambientMusic: boolean;
  ambientPaused: boolean;
  ambientPlaysWhenAway: boolean;
  ambientVolume: number;
  /**
   * The style it plays, as saved: a name this build lacks stays saved and
   * plays the default (`ambientStyleOf`).
   */
  ambientStyle: string;
  /** The person's own styles, which the first mate writes (docs/ambient-music.md, "Your own styles"). */
  ambientOwnStyles: SavedOwnStyle[];
  /** How Settings → Usage shows every amount, remembered by the core (docs/usage.md). */
  usageUnit: UsageUnit;
  /**
   * The language the captain chose in Settings → Appearance, or null to
   * follow the computer (docs/i18n.md, "The language choice").
   */
  language: string | null;
  setLanguage: (language: string | null) => void;
  /**
   * The fonts the captain chose for the app, reading and code; a slot left
   * out is Infinitary's own (docs/fonts.md).
   */
  fonts: FontChoices;
  /** Chooses one slot's font, or Infinitary's own for null. */
  setFont: (slot: FontSlot, family: string | null) => void;
  /**
   * Why the last appearance write was refused, beside the control that made
   * it, while the window shows the saved look again. The next write clears it.
   */
  appearanceError: { choice: AppearanceChoice; message: string } | null;
  /** The core's saved look, pushed or read: the one way it reaches the window. */
  applyAppearance: (appearance: Appearance) => void;
  /** Reads the saved look again, as each Settings view that shows it opens. */
  refreshAppearance: () => void;
  setTheme: (theme: Theme) => void;
  setWashStrength: (strength: number) => void;
  setShowCrewModelNames: (shown: boolean) => void;
  setAmbientMusic: (on: boolean) => void;
  setAmbientPlaysWhenAway: (plays: boolean) => void;
  toggleAmbientPlayback: () => void;
  setAmbientVolume: (volume: number) => void;
  setAmbientStyle: (style: string) => void;
  /** Removes one of the person's own styles; the default plays if it was playing. */
  removeAmbientOwnStyle: (id: string) => void;
  setUsageUnit: (unit: UsageUnit) => void;
};

/** The window's state for a saved look. Idempotent, so an echo of its own write is a no-op. */
function lookOf(s: ShellState, appearance: Appearance): Partial<ShellState> {
  const look = {
    theme: appearance.theme,
    defaultCardSize: appearance.defaultCardSize ?? "usual",
    keepCardsMaximized: appearance.keepCardsMaximized ?? false,
    cardsMaximized: appearance.cardsMaximized ?? false,
    size: appearance.size ?? 100,
    washStrength: appearance.washStrength ?? DEFAULT_APPEARANCE.washStrength ?? 0,
    showCrewModelNames: appearance.showCrewModelNames ?? true,
    ambientMusic: appearance.ambientMusic ?? false,
    ambientPaused: appearance.ambientPaused ?? false,
    ambientPlaysWhenAway: appearance.ambientPlaysWhenAway ?? false,
    ambientVolume: appearance.ambientVolume ?? DEFAULT_AMBIENT_VOLUME,
    ambientStyle: appearance.ambientStyle ?? DEFAULT_AMBIENT_STYLE,
    ambientOwnStyles: appearance.ambientOwnStyles ?? NO_OWN_STYLES,
    usageUnit: appearance.usageUnit ?? DEFAULT_USAGE_UNIT,
    language: appearance.language ?? null,
    fonts: appearance.fonts ?? NO_FONTS,
  } satisfies Partial<ShellState>;
  return Object.fromEntries(
    Object.entries(look).filter(([key, value]) =>
      key === "fonts" || key === "ambientOwnStyles"
        ? JSON.stringify(s[key]) !== JSON.stringify(value)
        : s[key as keyof typeof look] !== value,
    ),
  );
}

const NO_FONTS: FontChoices = {};
/** No own style saved. */
const NO_OWN_STYLES: SavedOwnStyle[] = [];

export function appearanceSlice(set: ShellSet, get: ShellGet): AppearanceSlice {
  /** The choice whose write is running, so a refusal is told beside its own control. */
  let appearanceChoice: AppearanceChoice | null = null;

  /**
   * The one ordered writer of the look (../settings/settingSave.ts). A control
   * shows its choice at once; a refused write says why beside it, and the
   * window takes the saved look again. Only the last answer of a run of writes
   * is applied - the wash slider sends one per step - and a push from the core
   * gives way to the answers still owed.
   */
  const appearanceSave = new SettingSave<Appearance>(
    () => window.infinitary.settings.getAppearance(),
    (state) => {
      const s = get();
      const appearanceError =
        state.error && appearanceChoice ? { choice: appearanceChoice, message: state.error } : null;
      const change: Partial<ShellState> = {
        ...(!state.saving && state.value ? lookOf(s, state.value) : {}),
        ...(appearanceError?.choice !== s.appearanceError?.choice ||
        appearanceError?.message !== s.appearanceError?.message
          ? { appearanceError }
          : {}),
      };
      if (Object.keys(change).length > 0) set(change);
      if (!state.saving && state.value) {
        const { washStrength } = get();
        document.documentElement.style.setProperty("--wash-strength", `${washStrength}%`);
      }
    },
  );

  /**
   * Writes one choice over the whole saved look (a Mac controlling another
   * keeps the look as sent, src/main/view/viewLook.ts), never over a choice
   * still shown but not saved: the wash after a refused theme keeps the saved theme.
   */
  function saveAppearance(choice: AppearanceChoice, change: Partial<Appearance>): void {
    void appearanceSave.save(() => {
      appearanceChoice = choice;
      const s = get();
      const saved = appearanceSave.state.value ?? {
        theme: s.theme,
        defaultCardSize: s.defaultCardSize,
        keepCardsMaximized: s.keepCardsMaximized,
        cardsMaximized: s.cardsMaximized,
        size: s.size,
        washStrength: s.washStrength,
        showCrewModelNames: s.showCrewModelNames,
        ambientMusic: s.ambientMusic,
        ambientPaused: s.ambientPaused,
        ambientPlaysWhenAway: s.ambientPlaysWhenAway,
        ambientVolume: s.ambientVolume,
        ambientStyle: s.ambientStyle,
        ambientOwnStyles: s.ambientOwnStyles,
        usageUnit: s.usageUnit,
        ...(s.language ? { language: s.language } : {}),
        ...(Object.keys(s.fonts).length > 0 ? { fonts: s.fonts } : {}),
      };
      return window.infinitary.settings.setAppearance({ ...saved, ...change });
    });
  }

  return {
    // Replaced before the first render by the core's own value
    // (./preferences); the default is only what an unread core would say.
    theme: DEFAULT_APPEARANCE.theme,
    defaultCardSize: "usual",
    keepCardsMaximized: false,
    cardsMaximized: false,
    size: 100,
    washStrength: DEFAULT_APPEARANCE.washStrength ?? 0,
    showCrewModelNames: DEFAULT_APPEARANCE.showCrewModelNames ?? true,
    ambientMusic: false,
    ambientPaused: false,
    ambientPlaysWhenAway: false,
    ambientVolume: DEFAULT_AMBIENT_VOLUME,
    ambientStyle: DEFAULT_AMBIENT_STYLE,
    ambientOwnStyles: NO_OWN_STYLES,
    usageUnit: DEFAULT_USAGE_UNIT,
    language: null,
    fonts: NO_FONTS,
    appearanceError: null,
    applyAppearance: (appearance) => appearanceSave.apply(appearance),
    refreshAppearance: () => {
      void appearanceSave.refresh();
    },
    // The picker shows the choice at once, as every other control does; the
    // window's zoom follows only the size the core saved (src/main/windowSize.ts).
    setSize: (size) => {
      set({ size });
      saveAppearance("size", { size });
    },
    setDefaultCardSize: (defaultCardSize) => {
      set({ defaultCardSize });
      saveAppearance("defaultCardSize", { defaultCardSize });
    },
    // Turning it either way starts from restored, so it never maximizes a card on its own.
    setKeepCardsMaximized: (keepCardsMaximized) => {
      set({ keepCardsMaximized, cardsMaximized: false });
      saveAppearance("keepCardsMaximized", { keepCardsMaximized, cardsMaximized: false });
    },
    setCardsMaximized: (cardsMaximized) => {
      set({ cardsMaximized });
      saveAppearance("cardsMaximized", { cardsMaximized });
    },
    setTheme: (theme) => {
      set({ theme });
      saveAppearance("theme", { theme });
    },
    setWashStrength: (washStrength) => {
      set({ washStrength });
      document.documentElement.style.setProperty("--wash-strength", `${washStrength}%`);
      saveAppearance("washStrength", { washStrength });
    },
    setShowCrewModelNames: (showCrewModelNames) => {
      set({ showCrewModelNames });
      saveAppearance("showCrewModelNames", { showCrewModelNames });
    },
    setAmbientMusic: (ambientMusic) => {
      set({ ambientMusic, ambientPaused: false });
      saveAppearance("ambientMusic", { ambientMusic, ambientPaused: false });
    },
    setAmbientPlaysWhenAway: (ambientPlaysWhenAway) => {
      set({ ambientPlaysWhenAway });
      saveAppearance("ambientPlaysWhenAway", { ambientPlaysWhenAway });
    },
    toggleAmbientPlayback: () => {
      const s = get();
      if (!s.ambientMusic) return s.setAmbientMusic(true);
      const ambientPaused = !s.ambientPaused;
      set({ ambientPaused });
      saveAppearance("ambientPaused", { ambientPaused });
    },
    setAmbientVolume: (ambientVolume) => {
      set({ ambientVolume });
      saveAppearance("ambientVolume", { ambientVolume });
    },
    setAmbientStyle: (ambientStyle) => {
      set({ ambientStyle });
      saveAppearance("ambientStyle", { ambientStyle });
    },
    removeAmbientOwnStyle: (id) => {
      const s = get();
      const ambientOwnStyles = s.ambientOwnStyles.filter((style) => style.id !== id);
      const ambientStyle = s.ambientStyle === id ? DEFAULT_AMBIENT_STYLE : s.ambientStyle;
      set({ ambientOwnStyles, ambientStyle });
      saveAppearance("ambientOwnStyles", { ambientOwnStyles, ambientStyle });
    },
    setUsageUnit: (usageUnit) => {
      set({ usageUnit });
      saveAppearance("usageUnit", { usageUnit });
    },
    // Following the computer is a look with no language: the core removes
    // the saved choice (src/core/storage/settingsStore.ts).
    setLanguage: (language) => {
      set({ language });
      saveAppearance("language", { language: language ?? undefined });
    },
    // A look with no fonts takes Infinitary's own: the core removes the row.
    setFont: (slot, family) => {
      const { [slot]: _was, ...others } = get().fonts;
      const fonts: FontChoices = family ? { ...others, [slot]: family } : others;
      set({ fonts });
      saveAppearance("fonts", { fonts: Object.keys(fonts).length > 0 ? fonts : undefined });
    },
  };
}
