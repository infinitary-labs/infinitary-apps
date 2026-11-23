import { z } from "zod";
import { ownStylesSchema } from "./ambientOwn";
import { AMBIENT_STYLES, type AmbientStyle, DEFAULT_AMBIENT_STYLE } from "./ambientStyles";
import { fontChoicesSchema } from "./fonts";
import { type SidePanelPlacement, sidePanelPlacementSchema } from "./plugins/manifest";
import { usageUnitSchema } from "./usage";

/**
 * The captain's own presentation choices, persisted by the CORE as two
 * `settings` KV rows (`appearance`, `layout`) rather than by the renderer.
 *
 * They used to live in the window: the theme only in the shell store, so it
 * was forgotten at every launch, and the rail collapse in `localStorage`, so
 * it was forgotten whenever the window profile was. Neither is a window
 * detail - they are preferences about the app, they belong beside the rest
 * of the app's settings, and only a core-held value can ever be read or
 * written by anything but the renderer.
 *
 * Step 5 added a third: whether the captain's own panels run at all
 * (`personalPanelsSchema`), the host-owned switch and the safe-mode boot's
 * one lever.
 *
 * Both are read once before the first render (`renderer/src/app/preferences`)
 * and written through on every change, so a value is never painted twice.
 * Since talk-to-personalize Step 1 the Firstmate writes them too, through
 * the action catalog (`app_change` theme, window-size and panel, among others), and every write is pushed to the window as the
 * `shell.preferences` read (`inf:shell:preferences`), which the host applies:
 * the theme on the body, the rail layout on the rails.
 */

export const themeSchema = z.enum(["dark", "light"]);
export type Theme = z.infer<typeof themeSchema>;

/** Window wash is the actual opacity percentage of the theme tint (0–100). */
export const washStrengthSchema = z.number().int().min(0).max(100);

export const UI_SIZES = [100, 110, 125, 150] as const;
export const uiSizeSchema = z.union([
  z.literal(100),
  z.literal(110),
  z.literal(125),
  z.literal(150),
]);
export type UiSize = z.infer<typeof uiSizeSchema>;

export const defaultCardSizeSchema = z.enum(["usual", "wide", "full", "maximized"]);
export type DefaultCardSize = z.infer<typeof defaultCardSizeSchema>;

/**
 * The language the captain chose for the app's words (docs/i18n.md, "The
 * language choice"): a catalog language's tag, such as `zh-Hans`. A tag the
 * catalog does not have, such as one a newer build wrote, reads as following
 * the computer.
 */
export const languageChoiceSchema = z
  .string()
  .min(2)
  .max(35)
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/);

/** How loud the ambient music plays, in whole percent. */
export const ambientVolumeSchema = z.number().int().min(0).max(100);
export const DEFAULT_AMBIENT_VOLUME = 40;
export { AMBIENT_STYLES, type AmbientStyle, DEFAULT_AMBIENT_STYLE };
/**
 * A saved style: any short name, so a style a newer build saved still reads
 * here, where it plays as the default (`ambientStyleOf`).
 */
export const ambientStyleSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9-]+$/);
export function ambientStyleOf(saved: string | undefined): AmbientStyle {
  return (AMBIENT_STYLES as readonly string[]).includes(saved ?? "")
    ? (saved as AmbientStyle)
    : DEFAULT_AMBIENT_STYLE;
}
/**
 * The style a saved name plays, among the shipped ones and the person's own
 * (`ambientOwnStyles`): the default when it is missing, removed or one this
 * build lacks.
 */
export function ambientStyleIn(
  saved: string | undefined,
  own: readonly { id: string }[] | undefined,
): string {
  return own?.some((style) => style.id === saved) ? (saved as string) : ambientStyleOf(saved);
}

/** How the app looks. The default handles records written before the wash control existed. */
export const appearanceSchema = z.strictObject({
  theme: themeSchema,
  /** Missing on older installs keeps content-based sizing. */
  defaultCardSize: defaultCardSizeSchema.optional(),
  /**
   * Keep cards maximized: after a maximize, every card shows maximized until
   * one is restored. Missing means off. The core keeps it and
   * `cardsMaximized` in a row of their own, so an older build, which reads
   * the `appearance` row strictly, never meets them.
   */
  keepCardsMaximized: z.boolean().optional(),
  /** Whether the captain's last size change maximized a card; read only while Keep cards maximized is on. */
  cardsMaximized: z.boolean().optional(),
  size: uiSizeSchema.optional(),
  washStrength: washStrengthSchema.optional(),
  /** Missing on older installs means on, as on a fresh install. */
  showCrewModelNames: z.boolean().optional(),
  /**
   * Whether the ambient music plays in this window (docs/ambient-music.md);
   * missing means off, as on a fresh install. The core keeps it and
   * `ambientVolume` in a row of their own, so an older build never meets them.
   */
  ambientMusic: z.boolean().optional(),
  /**
   * The sound button's pause from before its on/off became the switch's
   * (docs/ambient-music.md): no build writes it true any more, and a look
   * that still has it reads through `foldAmbientPause`. It stays in the
   * shape so an older build's look and a view's still parse.
   */
  ambientPaused: z.boolean().optional(),
  /**
   * Whether the ambient music keeps playing while nobody is at the computer;
   * missing means it pauses then and plays again once someone is back.
   */
  ambientPlaysWhenAway: z.boolean().optional(),
  /** How loud the ambient music plays, 0-100 percent; missing means 40. */
  ambientVolume: ambientVolumeSchema.optional(),
  /**
   * Which style the ambient music plays (`AMBIENT_STYLES`); missing, or one
   * this build lacks, means Star cruise. The core keeps it in a row of its own.
   */
  ambientStyle: ambientStyleSchema.optional(),
  /**
   * The person's own styles, written by the first mate from their words
   * (src/shared/ambientOwn.ts); missing means none. The core keeps them in a
   * row of their own, so an older build never meets them.
   */
  ambientOwnStyles: ownStylesSchema.optional(),
  /** How Settings → Usage shows every amount (docs/usage.md); missing means tokens. */
  usageUnit: usageUnitSchema.optional(),
  /**
   * The language the app speaks; missing means it follows the computer's
   * own languages. The core keeps it in a row of its own, as it does Keep
   * cards maximized, so an older build never meets it.
   */
  language: languageChoiceSchema.optional(),
  /**
   * The fonts the app, what the crew writes and code are written in
   * (docs/fonts.md); missing means Infinitary's own. The core keeps them in a
   * row of their own, as it does the language, so an older build never meets
   * them.
   */
  fonts: fontChoicesSchema.optional(),
});
export type Appearance = z.infer<typeof appearanceSchema>;

/**
 * A look saved paused reads as off, without the pause, so music paused
 * before the update stays silent; its next save writes it off.
 */
export function foldAmbientPause(look: Appearance): Appearance {
  if (look.ambientPaused === undefined) return look;
  const { ambientPaused, ...rest } = look;
  return ambientPaused && rest.ambientMusic ? { ...rest, ambientMusic: false } : rest;
}

/** Dark is the app's own look; light is the choice. */
export const DEFAULT_APPEARANCE: Appearance = {
  theme: "dark",
  size: 100,
  washStrength: 0,
  showCrewModelNames: true,
};

/** A side-panel contribution id: the key every per-panel record uses. */
const panelIdSchema = z.string().min(1).max(64);

/**
 * Where every panel sits, slot by slot (INF-2344): each rail's top and
 * bottom group, every panel the app knows listed once, in the order the
 * rail draws it from top to bottom. A hidden panel keeps its place, so
 * showing it again puts it back; a panel listed here that the app no
 * longer has is skipped wherever the arrangement is read. The shared
 * functions over it are in `src/shared/panelArrangement.ts`.
 */
const railGroupsSchema = z.strictObject({
  top: z.array(panelIdSchema),
  bottom: z.array(panelIdSchema),
});
export const panelArrangementSchema = z.strictObject({
  left: railGroupsSchema,
  right: railGroupsSchema,
});
export type PanelArrangement = z.infer<typeof panelArrangementSchema>;

/**
 * How the app is arranged. The per-panel records are keyed by side-panel
 * contribution id and hold only a DEVIATION from that panel's own default:
 * a missing key means the default.
 *
 * - `collapsedPanels`: the header-only state (`DEFAULT_COLLAPSED_PANELS`).
 * - `hiddenPanels`: `true` keeps the panel off its rail entirely, whatever
 *   its data says - the rail stays zero-width for it. "hide tasks".
 * - `arrangement`: where every panel sits, in order (`PanelArrangement`).
 *   The core fills it once from what the rails drew before it existed and
 *   writes each new panel in; a set without it keeps the saved one.
 * - `morePick`: the panel last chosen from a full rail's More row, whose
 *   header the rail keeps on screen (docs/ui-plugins.md, "When a rail runs
 *   out of room"). The pick's move itself is in `arrangement`.
 * - `placements` and `panelOrder`: where a panel sat and the More picks
 *   before the arrangement existed. Nothing writes them any more; they
 *   place only a panel the arrangement does not list yet, and an older
 *   build still reads them (docs/saved-data-compatibility.md).
 * - `focusedProjectId`: the project the window is focused on (the top bar's
 *   project pill, docs/project-focus.md); absent means All projects. It is
 *   presentation only: no task is written to for it.
 *
 * The records added after the first default to empty or are optional so a
 * `layout` row written before them still parses (a strict object would
 * otherwise refuse it and lose the collapse choices with it). The core keeps
 * `arrangement` and `morePick` in a row of their own, so an older build,
 * which reads the `layout` row strictly, never meets them.
 */
export const layoutSchema = z.strictObject({
  collapsedPanels: z.record(panelIdSchema, z.boolean()),
  hiddenPanels: z.record(panelIdSchema, z.boolean()).default({}),
  placements: z.record(panelIdSchema, sidePanelPlacementSchema).default({}),
  /** Before the arrangement: More picks, most recent first. Read, never written. */
  panelOrder: z.array(panelIdSchema).optional(),
  /** Where every panel sits, in order; absent until the core fills it. */
  arrangement: panelArrangementSchema.optional(),
  /** The panel last chosen from a full rail's More row. */
  morePick: panelIdSchema.optional(),
  /** The focused project's id; absent is All projects. */
  focusedProjectId: z.string().min(1).max(64).optional(),
});
export type Layout = z.infer<typeof layoutSchema>;

/**
 * What the captain's own write of the layout moved, when it moved one
 * panel: the panel they dragged, stepped or picked from a full rail's More
 * row. Two neighbours that trade places read the same either way, so the
 * Activity line names the one the captain moved from this, never from the
 * two arrangements (INF-2344).
 */
export const layoutMoveSchema = z.strictObject({ moved: panelIdSchema });
export type LayoutMove = z.infer<typeof layoutMoveSchema>;

export const DEFAULT_LAYOUT: Layout = { collapsedPanels: {}, hiddenPanels: {}, placements: {} };

/**
 * Whether the panels the captain asked for are running at all
 * (talk-to-personalize Step 5, the hardening step).
 *
 * A personal panel is a React module in the renderer and, when it ships a
 * `server.ts`, a module in the core with the core's privilege - the trust
 * the app already extends to the crewmate that wrote it (plan section 5.5).
 * This is the one switch that takes all of it back: off, the core seeds
 * nothing, compiles nothing, loads no server module, and pushes an empty
 * snapshot, which is what unmounts every panel.
 *
 * It is HOST-OWNED. The window's own control in Settings writes it with
 * reason `captain`; a safe-mode boot writes it with reason `safe-mode`
 * after two launches that ended before the app had settled. The Firstmate
 * never writes it - `personalize` has no action for it - and the reason is
 * what lets the app say why the panels are gone instead of losing them
 * silently.
 */
export const personalPanelsSchema = z.strictObject({
  enabled: z.boolean(),
  /** Why they are off; null while they are on. */
  offReason: z.enum(["captain", "safe-mode"]).nullable(),
});
export type PersonalPanels = z.infer<typeof personalPanelsSchema>;

export const DEFAULT_PERSONAL_PANELS: PersonalPanels = { enabled: true, offReason: null };

/**
 * The `shell.preferences` read: everything the host applies to the window
 * on the captain's behalf, in one value, pushed whole on every write.
 */
export const shellPreferencesSchema = z.strictObject({
  appearance: appearanceSchema,
  layout: layoutSchema,
  /** Defaulted so a value written before Step 5 still parses. */
  panels: personalPanelsSchema.default(DEFAULT_PERSONAL_PANELS),
});
export type ShellPreferences = z.infer<typeof shellPreferencesSchema>;

export const DEFAULT_SHELL_PREFERENCES: ShellPreferences = {
  appearance: DEFAULT_APPEARANCE,
  layout: DEFAULT_LAYOUT,
  panels: DEFAULT_PERSONAL_PANELS,
};

export function isPanelHidden(layout: Layout, panelId: string): boolean {
  return layout.hiddenPanels[panelId] === true;
}

/**
 * Which rail and which end a panel sits at once the captain's layout is
 * applied: its slot in the arrangement, else - for a panel the arrangement
 * does not list yet - the placement saved before the arrangement existed,
 * else the placement the panel asked for.
 */
export function effectivePlacement(
  layout: Layout,
  panelId: string,
  preferred: SidePanelPlacement,
): SidePanelPlacement {
  const arrangement = layout.arrangement;
  if (arrangement) {
    for (const x of ["left", "right"] as const)
      for (const y of ["top", "bottom"] as const)
        if (arrangement[x][y].includes(panelId)) return { x, y };
  }
  return layout.placements[panelId] ?? preferred;
}
