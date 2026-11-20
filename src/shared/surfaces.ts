import activityManifest from "../panels/activity/manifest.json" with { type: "json" };
import automationManifest from "../panels/automation/manifest.json" with { type: "json" };
import knowledgeManifest from "../panels/knowledge/manifest.json" with { type: "json" };
import nowManifest from "../panels/now/manifest.json" with { type: "json" };
import type { PersonalManifest } from "./personal/contracts";
import {
  DEFAULT_PERSONAL_ORDER,
  DEFAULT_PERSONAL_PLACEMENT,
  personalManifestSchema,
} from "./personal/manifest";
import type { BuiltinFramePanel } from "./plugins/frameLib";
import type { SidePanelEntry } from "./plugins/manifest";

/**
 * The app's own side panels, as the Firstmate and the renderer both know
 * them (talk-to-personalize Step 1). Each is an ordinary panel folder,
 * `src/panels/<id>/` (docs/ui-plugins.md, "The app's own panels are
 * ordinary folders"), and its `manifest.json` is the one place that says
 * its title, its place on a rail and what it asks for: the renderer
 * registers the panels from these folders, and the core lists them in the
 * Firstmate's "your surfaces" context section by the same ids, so "hide
 * tasks" resolves to `now` in one place and `personalize` writes a layout
 * record the rails will honour. A personal panel (Step 2) joins the list
 * from the core's own snapshot; it never appears here.
 */
export type AppPanelFolder = {
  id: BuiltinFramePanel;
  manifest: PersonalManifest;
  /**
   * Its card views, the files of its `cards/` the compiler builds beside its
   * panel: what `cards.emit` may name (`appPanels.test.ts` holds this list
   * to what the compiler finds).
   */
  views: readonly string[];
  /**
   * The gate it waits on, when it has one: its panel, cards, commands and
   * surface exist only while that gate is open, and nowhere else names it.
   */
  gate?: AppPanelGate;
};

/**
 * A gate an app panel can wait on: `knowledge` is open while there is some
 * to show, in every build (docs/knowledge.md, "Who has it"); `automation`
 * while a saved automation rule exists (docs/automation.md, "The Automation
 * panel").
 */
export type AppPanelGate = "knowledge" | "automation";

/** Which gates are open now: the core knows, and tells the window. An absent gate is shut. */
export type AppPanelGates = Readonly<Partial<Record<AppPanelGate, boolean>>>;

/**
 * The folders, by id: Activity on the left rail, whose dock shows from the
 * start, and Tasks on the right, which shows only while the board has a row
 * to list. Both are bottom-docked, on opposite rails. Knowledge sits under
 * Tasks while there is some to show, and Automation under them while a rule
 * is saved. A manifest the panel schema
 * refuses fails at load, so a broken folder never reaches a session.
 */
export const APP_PANEL_FOLDERS: readonly AppPanelFolder[] = [
  { id: "activity", manifest: personalManifestSchema.parse(activityManifest), views: [] },
  { id: "now", manifest: personalManifestSchema.parse(nowManifest), views: ["board"] },
  {
    id: "knowledge",
    manifest: personalManifestSchema.parse(knowledgeManifest),
    views: ["browser"],
    gate: "knowledge",
  },
  {
    id: "automation",
    manifest: personalManifestSchema.parse(automationManifest),
    views: [],
    gate: "automation",
  },
];

/** The folders this build has: every ungated one, and each gated one whose gate is open. */
export function appPanelFoldersFor(gates: AppPanelGates): AppPanelFolder[] {
  return APP_PANEL_FOLDERS.filter((folder) => !folder.gate || gates[folder.gate] === true);
}

/** A folder's manifest as the rails read it: the panel's title, place, order and size. */
function surfaceOf({ id, manifest }: AppPanelFolder): SidePanelEntry {
  return {
    id,
    title: manifest.title ?? id,
    preferredPlacement: manifest.placement ?? DEFAULT_PERSONAL_PLACEMENT,
    order: manifest.order ?? DEFAULT_PERSONAL_ORDER,
    size: manifest.size ?? "content",
    newestLast: manifest.newestLast === true,
  };
}

/**
 * Every app panel's surface, gated or not: the ids no panel added from
 * elsewhere may take. What a build shows is `builtinSurfacesFor` its gates.
 */
export const BUILTIN_SURFACES: readonly SidePanelEntry[] = APP_PANEL_FOLDERS.map(surfaceOf);

/** The app's own surfaces this build has, as the rails and the Firstmate know them. */
export function builtinSurfacesFor(gates: AppPanelGates): SidePanelEntry[] {
  return appPanelFoldersFor(gates).map(surfaceOf);
}

export function builtinSurface(id: string): SidePanelEntry | undefined {
  return BUILTIN_SURFACES.find((surface) => surface.id === id);
}
