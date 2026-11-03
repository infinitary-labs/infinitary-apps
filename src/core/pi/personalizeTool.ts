import {
  CREATE_PANEL_SLOT_ID,
  CREATE_PANEL_SLOT_PLACEMENT,
  CREATE_PANEL_SLOT_TITLE,
} from "@shared/createPanelSlot";
import type { FmEvent } from "@shared/events";
import type { PersonalExtensionView, PersonalSnapshot } from "@shared/personal/manifest";
import type { PanelMounts } from "@shared/personal/mounts";
import type { SidePanelPlacement } from "@shared/plugins/manifest";
import {
  effectivePlacement,
  isPanelHidden,
  type Layout,
  type PersonalPanels,
  type ShellPreferences,
} from "@shared/preferences";
import { type AppPanelGates, builtinSurfacesFor } from "@shared/surfaces";
import { Type } from "typebox";
import {
  appPanelHiddenLine,
  panelRemovedLine,
  personalPanelRemovedLine,
} from "../personal/panelLines";
import { mountOf, surfaceWord } from "../personal/panelMounts";
import type { ShellPreferencesService } from "../preferences/shellPreferences";
import { boundTool, stringEnum } from "../session/tools";

/**
 * The Firstmate's `personalize` tool (talk-to-personalize Step 1, plan
 * sections 5.2 and 5.3; Tier A). Removing a panel stays here after catalog
 * piece 4. Theme and arrangement use app_change, and a standing instruction
 * for the captain's panels is an ordinary direction scoped to the personal
 * workspace (app_change direction; primitives/standing-directions.md).
 * Applied changes leave one feed line, never a card. Anything that needs a
 * new panel or a change to how one draws is crewmate work, not this tool.
 *
 * What it writes:
 * - Theme and panel arrangement now use the action catalog (piece 4).
 * - `remove` hides an app panel and forgets its records, takes a
 *   personal extension out of the workspace in one commit, or takes a
 *   panel the captain added away - its files, its record and its data
 *   (one plugin vehicle, Phase A, A2a).
 *
 * A surface is named by the id the context block's "your surfaces" section
 * lists; an unknown id is refused with the list, never guessed. Refusals
 * are tool text, never throws. Removing a surface is the captain's word
 * alone (captain-turn gated like a note's creation); the theme and a panel's place may follow a schedule the
 * captain set ("dark in the evening").
 */

export type SurfaceView = {
  id: string;
  title: string;
  /** The app's own panel, the captain's own, or one he added (`by` names who it is by). */
  kind: "app" | "personal" | "installed";
  by: string | null;
  /** Where it sits once the captain's layout record is applied. */
  placement: SidePanelPlacement;
  /** The placement the panel itself asked for. */
  preferred: SidePanelPlacement;
  hidden: boolean;
  collapsed: boolean;
};

/** The most personal panels the context section lists; the rest are a count. */
export const SURFACES_CONTEXT_LIMIT = 12;

export type PersonalizeDelegate = {
  preferences: ShellPreferencesService;
  /** The personal extensions the core serves right now (Step 2's snapshot). */
  personal: () => PersonalSnapshot;
  /** Takes a personal extension out of the workspace; `removed: false` when the id is not one. */
  removePersonal: (id: string) => Promise<{ removed: boolean; committed: boolean }>;
  /** Takes a panel the captain added away; `removed: false` when the id is not one. */
  uninstallPlugin: (id: string) => Promise<{ removed: boolean }>;
  /** `userData/fleet/personal`, the personal workspace. */
  personalWorkspaceDir: string;
  isCaptainTurn: () => boolean;
  broadcastEvent: (event: FmEvent) => void;
  /** The gates open now: a gated app panel is a surface only while its gate is. */
  gates: () => AppPanelGates;
  /**
   * What the window did with each panel, as it last said
   * (docs/personal-panels.md, "Placed on the rail"); null before it has.
   */
  mounts?: () => PanelMounts | null;
};

/**
 * Every surface the captain can name, in one shape: the app's own panels
 * (src/shared/surfaces.ts), the create-your-own-panel slot
 * (src/shared/createPanelSlot.ts), and the personal extensions the core
 * serves, each with its effective placement and visibility under the layout.
 */
export function listSurfaces(
  layout: Layout,
  personal: PersonalSnapshot,
  gates: AppPanelGates,
): SurfaceView[] {
  const app = [
    ...builtinSurfacesFor(gates).map((entry) =>
      surfaceView(layout, entry.id, entry.title, "app", entry.preferredPlacement, null),
    ),
    surfaceView(
      layout,
      CREATE_PANEL_SLOT_ID,
      CREATE_PANEL_SLOT_TITLE,
      "app",
      CREATE_PANEL_SLOT_PLACEMENT,
      null,
    ),
  ];
  const yours = personal.extensions.map((extension) =>
    surfaceView(
      layout,
      extension.id,
      extension.title,
      extension.source === "installed" ? "installed" : "personal",
      extension.placement,
      extension.by,
    ),
  );
  return [...app, ...yours];
}

function surfaceView(
  layout: Layout,
  id: string,
  title: string,
  kind: SurfaceView["kind"],
  preferred: SidePanelPlacement,
  by: string | null,
): SurfaceView {
  return {
    id,
    title,
    kind,
    by,
    placement: effectivePlacement(layout, id, preferred),
    preferred,
    hidden: isPanelHidden(layout, id),
    collapsed: layout.collapsedPanels[id] === true,
  };
}

/**
 * A surface's state as the window last answered for it
 * (docs/personal-panels.md, "Placed on the rail"), never read off the
 * layout: a panel the layout places can still be refused, off its rail,
 * stopped, or folded or gathered into its rail's More row for room. With
 * no answer for it, the layout's hidden is still a fact; a shown one is
 * not, so it says the window has not answered.
 */
export function surfaceState(surface: SurfaceView, mounts: PanelMounts | null): string {
  const mount = mounts ? mountOf(mounts, surface.id, surface.kind) : undefined;
  if (!mount) return surface.hidden ? "hidden" : "no word from the window";
  return surfaceWord(mount);
}

/**
 * What the app says about the captain's own panels being off (Step 5), in
 * the Firstmate's context and in a refusal alike. The switch is host-owned:
 * there is no tool action for it, so the honest answer is to say where it
 * is rather than to reach for one.
 */
export function panelsOffLine(panels: PersonalPanels): string | null {
  if (panels.enabled) return null;
  const because =
    panels.offReason === "safe-mode"
      ? "the app closed twice just after starting, so it came up with them off"
      : "the captain turned them off";
  return `the captain's panels are off right now (${because}). Nothing built for them and nothing they added is mounted, and a new one will not show until they are back on. Only the switch in Settings turns them on - you have no tool for it, so say where it is.`;
}

/** A panel whose `server.ts` the app refused for an older panel API, on its surfaces row (INF-2470). */
function pausedWords(paused: NonNullable<PersonalExtensionView["paused"]>): string {
  return `; background work paused: its server.ts is written for panel API ${paused.api} and this app serves ${paused.serves.join(" or ")}${paused.asked ? "; the captain pressed Update panel" : ""}`;
}

/**
 * The bounded "your surfaces" section of the Firstmate's context block:
 * the theme, every app panel, the personal panels up to a cap, each with
 * the window's word on it (`surfaceState`), and whether the
 * captain's own panels are on at all. Each row carries the id `personalize` takes.
 */
export function renderSurfacesSection(
  preferences: ShellPreferences,
  personal: PersonalSnapshot,
  gates: AppPanelGates,
  mounts: PanelMounts | null = null,
): string[] {
  const surfaces = listSurfaces(preferences.layout, personal, gates);
  const yours = surfaces.filter((surface) => surface.kind !== "app");
  const shown = [
    ...surfaces.filter((surface) => surface.kind === "app"),
    ...yours.slice(0, SURFACES_CONTEXT_LIMIT),
  ];
  const more = yours.length - Math.min(yours.length, SURFACES_CONTEXT_LIMIT);
  const off = panelsOffLine(preferences.panels);
  return [
    `your surfaces (app_change panel and personalize remove act on these ids; theme: ${preferences.appearance.theme}):`,
    ...shown.map((surface) => {
      const where = `${surface.placement.x} rail, ${surface.placement.y}`;
      const state = surfaceState(surface, mounts);
      const mark =
        surface.kind === "personal"
          ? " (yours)"
          : surface.kind === "installed"
            ? ` (added, by ${surface.by})`
            : "";
      const paused =
        surface.kind === "personal"
          ? personal.extensions.find((extension) => extension.id === surface.id)?.paused
          : undefined;
      return `- ${surface.id} "${surface.title}"${mark}: ${where}; ${state}${paused ? pausedWords(paused) : ""}`;
    }),
    ...(more > 0 ? [`- and ${more} more personal panel${more === 1 ? "" : "s"}`] : []),
    ...(off ? [off] : []),
  ];
}

type Params = {
  action: "remove";
  evidence: string;
  surface?: string;
};

export function createPersonalizeTool(delegate: PersonalizeDelegate) {
  return boundTool({
    name: "personalize",
    label: "Personalize",
    description:
      "Remove a surface, only on the captain's own turn, with evidence of their words. remove hides an app panel and forgets its records, removes a personal panel from the workspace in one commit, or takes an added panel away with its data. Name a surface by id from your-surfaces.",
    parameters: Type.Object({
      action: stringEnum(["remove"]),
      evidence: Type.String({ description: "The captain's words that asked for this" }),
      surface: Type.Optional(Type.String({ description: "A surface id from your-surfaces" })),
    }),
    run: async (params) => ({ text: await run(delegate, params as Params) }),
  });
}

async function run(delegate: PersonalizeDelegate, params: Params): Promise<string> {
  switch (params.action) {
    case "remove":
      return runRemove(delegate, params);
    default:
      return "Use app_change for theme and panel, and app_change direction for a standing instruction; personalize only removes surfaces.";
  }
}

async function runRemove(delegate: PersonalizeDelegate, params: Params): Promise<string> {
  if (!delegate.isCaptainTurn()) {
    return "Only the captain's own turn removes a surface. Surface it to the captain instead.";
  }
  const found = resolveSurface(delegate, params.surface);
  if ("refusal" in found) return found.refusal;
  const { surface } = found;
  if (surface.kind === "app") {
    // An app panel cannot leave; hidden with its records forgotten is what
    // "remove" means for it, and "show it again" undoes it.
    delegate.preferences.clearPanel(surface.id);
    delegate.preferences.setPanelHidden(surface.id, true);
    delegate.broadcastEvent({ type: "personalized", text: appPanelHiddenLine(surface.title) });
    return `${surface.title} is an app panel, so it is hidden rather than removed; app_change panel with visible true brings it back.`;
  }
  if (surface.kind === "installed") {
    const taken = await delegate.uninstallPlugin(surface.id);
    if (!taken.removed) {
      return `${surface.id} is not a panel the captain added; check your surfaces.`;
    }
    delegate.preferences.clearPanel(surface.id);
    delegate.broadcastEvent({
      type: "personalized",
      text: panelRemovedLine(surface.title, surface.by),
    });
    return `${surface.title} is taken away with its data; install_plugin adds it again.`;
  }
  const result = await delegate.removePersonal(surface.id);
  if (!result.removed) {
    return `${surface.id} is not a personal panel the app serves right now; check your surfaces.`;
  }
  delegate.preferences.clearPanel(surface.id);
  delegate.broadcastEvent({ type: "personalized", text: personalPanelRemovedLine(surface.title) });
  return `${surface.title} removed from your workspace${
    result.committed ? " in one commit; git keeps its history" : ""
  }.`;
}

function resolveSurface(
  delegate: PersonalizeDelegate,
  id: string | undefined,
): { surface: SurfaceView; surfaces: SurfaceView[] } | { refusal: string } {
  const preferences = delegate.preferences.get();
  const surfaces = listSurfaces(preferences.layout, delegate.personal(), delegate.gates());
  const ids = surfaces.map((surface) => surface.id).join(", ");
  // Off (Step 5), the captain's own panels are not in the list at all, so
  // an id that names one must be refused with the reason rather than as a
  // typo.
  const off = preferences.panels.enabled
    ? ""
    : " The captain's panels - their own and the ones they added - are off right now, so none of them is listed; the switch is in Settings.";
  if (!id?.trim()) return { refusal: `Name a surface by id. Your surfaces: ${ids}.${off}` };
  const wanted = id.trim();
  const surface =
    surfaces.find((entry) => entry.id === wanted) ??
    surfaces.find((entry) => entry.title.toLowerCase() === wanted.toLowerCase());
  if (!surface) return { refusal: `No surface "${wanted}". Your surfaces: ${ids}.${off}` };
  return { surface, surfaces };
}
