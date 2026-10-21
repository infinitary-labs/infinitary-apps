import { z } from "zod";
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

/** How the app looks. The default handles records written before the wash control existed. */
export const appearanceSchema = z.strictObject({
  theme: themeSchema,
  /** Missing on older installs keeps content-based sizing. */
  defaultCardSize: defaultCardSizeSchema.optional(),
  size: uiSizeSchema.optional(),
  washStrength: washStrengthSchema.optional(),
  /** Missing on older installs means on, as on a fresh install. */
  showCrewModelNames: z.boolean().optional(),
  /** How Settings → Usage shows every amount (docs/usage.md); missing means tokens. */
  usageUnit: usageUnitSchema.optional(),
});
export type Appearance = z.infer<typeof appearanceSchema>;

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
 * How the app is arranged. Every record is keyed by side-panel contribution
 * id and holds only a DEVIATION from that panel's own default: a missing
 * key means the default, so a panel that later changes its default is not
 * pinned by a stale row.
 *
 * - `collapsedPanels`: the header-only state (`DEFAULT_COLLAPSED_PANELS`).
 * - `hiddenPanels`: `true` keeps the panel off its rail entirely, whatever
 *   its data says - the rail stays zero-width for it. "hide tasks".
 * - `panelOrder`: optional most-recent More picks first, nearest each anchored end.
 * - `placements`: which rail and which end of it, overriding the panel's
 *   `preferredPlacement`. "put activity on the right".
 *
 * The two newer records default to empty so a `layout` row written before
 * them still parses (a strict object would otherwise refuse it and lose the
 * collapse choices with it).
 */
export const layoutSchema = z.strictObject({
  collapsedPanels: z.record(panelIdSchema, z.boolean()),
  hiddenPanels: z.record(panelIdSchema, z.boolean()).default({}),
  placements: z.record(panelIdSchema, sidePanelPlacementSchema).default({}),
  /** Most recently chosen in More first; nearest its anchored end within its group. */
  panelOrder: z.array(panelIdSchema).optional(),
});
export type Layout = z.infer<typeof layoutSchema>;

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

/** The panels the captain asked for run unless something turned them off. */
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

/** Whether the layout keeps a panel off its rail. A missing key means shown. */
export function isPanelHidden(layout: Layout, panelId: string): boolean {
  return layout.hiddenPanels[panelId] === true;
}

/**
 * Where a panel sits once the captain's choice is applied: the layout's
 * record for it, else the placement the panel asked for.
 */
export function effectivePlacement(
  layout: Layout,
  panelId: string,
  preferred: SidePanelPlacement,
): SidePanelPlacement {
  return layout.placements[panelId] ?? preferred;
}
