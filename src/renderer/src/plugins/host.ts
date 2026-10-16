import {
  type HostCapabilitySupport,
  type PluginCapabilities,
  type PluginManifest,
  type RailSide,
  type RailY,
  unservableGrants,
} from "@shared/plugins/manifest";
import {
  DEFAULT_LAYOUT,
  effectivePlacement,
  isPanelHidden,
  type Layout,
} from "@shared/preferences";
import { READ_NAMES, type ReadGrant } from "@shared/reads";
import { SQL_VIEWS } from "@shared/sql";
import { RAIL_MOUNT_CAP } from "@shared/surfaces";
import { useSyncExternalStore } from "react";
import type {
  CardKindContribution,
  PluginBindings,
  SettingsSectionContribution,
  SidePanelContribution,
} from "./contributions";
import { type Contribution, ContributionError, ContributionRegistry } from "./registry";

/**
 * The renderer's plugin host (phase 0, docs/ui-plugins.md): three
 * registries, one per hosted slot, and the one door through which a
 * manifest and its bindings become contributions. The app's own UI is the
 * first plugin through that door (./builtin), which is what keeps the
 * registries honest at zero installed plugins.
 *
 * What this host can serve is also declared here, once: the read catalog
 * (phase 1) and nothing else, so a manifest that asks for any other grant
 * is refused at registration rather than left believing it has it. The
 * capabilities a plugin was admitted with are kept, because a frame's
 * controller enforces them per mount.
 */

/** The cap is shared with the core, which refuses a `personalize` move past it. */
export { RAIL_MOUNT_CAP };

export class PluginCapabilityError extends Error {
  constructor(
    readonly pluginId: string,
    readonly refused: readonly string[],
  ) {
    super(`plugin "${pluginId}" asks for ${refused.join(", ")}, which this host does not serve`);
    this.name = "PluginCapabilityError";
  }
}

function admitSidePanel(
  candidate: SidePanelContribution,
  existing: readonly SidePanelContribution[],
): void {
  const onSide = existing.filter(
    (panel) => panel.preferredPlacement.x === candidate.preferredPlacement.x,
  );
  if (onSide.length >= RAIL_MOUNT_CAP) {
    throw new ContributionError(
      "side-panel",
      `the ${candidate.preferredPlacement.x} rail already holds ${RAIL_MOUNT_CAP} panels ` +
        `(${onSide.map((panel) => panel.id).join(", ")}); ` +
        `"${candidate.id}" from "${candidate.pluginId}" was refused`,
    );
  }
}

/** Dress and body policy for a kind no plugin described. */
function fallbackCardKind(kind: string): CardKindContribution {
  return {
    id: kind,
    pluginId: "host",
    kind,
    chrome: "note",
    body: { streaming: "html" },
  };
}

function byOrder<T extends Contribution & { order: number }>(a: T, b: T): number {
  return a.order - b.order || a.id.localeCompare(b.id);
}

const RAIL_Y_RANK: Record<RailY, number> = { top: 0, bottom: 1 };

/** Within a rail, top-placed panels stack above bottom-placed ones; order and id break ties. */
function bySidePanelPlacement(a: SidePanelContribution, b: SidePanelContribution): number {
  return RAIL_Y_RANK[a.preferredPlacement.y] - RAIL_Y_RANK[b.preferredPlacement.y] || byOrder(a, b);
}

export class PluginHost {
  readonly cardKinds = new ContributionRegistry<CardKindContribution>("card-kind");
  readonly settingsSections = new ContributionRegistry<SettingsSectionContribution>(
    "settings-section",
  );
  readonly sidePanels = new ContributionRegistry<SidePanelContribution>(
    "side-panel",
    admitSidePanel,
  );

  /** Grants this host can honour: the read catalog, and nothing else yet. */
  readonly support: HostCapabilitySupport;
  private readonly capabilities = new Map<string, PluginCapabilities>();

  constructor(support: HostCapabilitySupport = {}) {
    this.support = support;
  }

  /** The declaration a registered plugin was admitted with. */
  capabilitiesOf(pluginId: string): PluginCapabilities | undefined {
    return this.capabilities.get(pluginId);
  }

  /**
   * The read-catalog names a registered plugin may subscribe to: what it
   * declared, plus `sql` when its `sql` grant names a view to query.
   */
  declaredReads(pluginId: string): readonly string[] {
    const capabilities = this.capabilities.get(pluginId);
    const reads = capabilities?.reads ?? [];
    return (capabilities?.sql?.length ?? 0) > 0 ? [...reads, "sql"] : reads;
  }

  /** What the host adds to a plugin's reads from its grant: the views its queries reach. */
  grantOf(pluginId: string): ReadGrant {
    return { sql: [...(this.capabilities.get(pluginId)?.sql ?? [])] };
  }

  /**
   * Registers every contribution a manifest declares, bound to the code
   * that serves it. All or nothing: a refusal anywhere unwinds what landed.
   * Returns a function that removes the plugin's contributions again.
   *
   * `firstParty` marks the host's own UI (the built-in plugin): its panels
   * carry no attribution, because the app never names itself in its own
   * chrome. Every other plugin is attributed by its manifest name.
   */
  registerPlugin(
    manifest: PluginManifest,
    bindings: PluginBindings = {},
    options: { firstParty?: boolean } = {},
  ): () => void {
    const refused = unservableGrants(manifest.capabilities, this.support);
    if (refused.length > 0) {
      throw new PluginCapabilityError(manifest.id, refused);
    }
    const { id: pluginId, contributes } = manifest;
    const attribution = options.firstParty ? null : manifest.name;
    if (this.capabilities.has(pluginId)) {
      throw new ContributionError("settings-section", `plugin "${pluginId}" is already registered`);
    }
    checkBindingsCover(
      pluginId,
      "settings-section",
      contributes.settingsSections.map((entry) => entry.id),
      Object.keys(bindings.settingsSections ?? {}),
    );
    checkBindingsCover(
      pluginId,
      "side-panel",
      contributes.sidePanels.map((entry) => entry.id),
      Object.keys(bindings.sidePanels ?? {}),
    );

    const undo: (() => void)[] = [];
    try {
      for (const entry of contributes.cardKinds) {
        undo.push(this.cardKinds.register({ ...entry, id: entry.kind, pluginId }));
      }
      for (const entry of contributes.settingsSections) {
        const binding = bindings.settingsSections?.[entry.id];
        if (!binding) continue;
        undo.push(this.settingsSections.register({ ...entry, ...binding, pluginId }));
      }
      for (const entry of contributes.sidePanels) {
        const binding = bindings.sidePanels?.[entry.id];
        if (!binding) continue;
        undo.push(this.sidePanels.register({ ...entry, ...binding, pluginId, attribution }));
      }
    } catch (error) {
      for (const remove of undo.reverse()) remove();
      throw error;
    }
    this.capabilities.set(pluginId, manifest.capabilities);
    return () => {
      this.capabilities.delete(pluginId);
      for (const remove of undo.reverse()) remove();
    };
  }

  /** Never throws: an undescribed kind gets the neutral note dress. */
  describeCardKind(kind: string): CardKindContribution {
    return this.cardKinds.get(kind) ?? fallbackCardKind(kind);
  }
}

function checkBindingsCover(
  pluginId: string,
  slot: "settings-section" | "side-panel",
  declared: string[],
  bound: string[],
): void {
  const declaredSet = new Set(declared);
  const boundSet = new Set(bound);
  const unbound = declared.filter((id) => !boundSet.has(id));
  const undeclared = bound.filter((id) => !declaredSet.has(id));
  if (unbound.length > 0) {
    throw new ContributionError(
      slot,
      `plugin "${pluginId}" declares ${unbound.join(", ")} but binds no implementation`,
    );
  }
  if (undeclared.length > 0) {
    throw new ContributionError(
      slot,
      `plugin "${pluginId}" binds ${undeclared.join(", ")} without declaring it in its manifest`,
    );
  }
}

/**
 * Final placement (D5): a contribution's `preferredPlacement` is a
 * preference the host honours - `x` picks the rail, `y` stacks it top or
 * bottom within that rail; order sorts within a `y` group, ties on id -
 * unless the captain's layout says otherwise (talk-to-personalize Step 1):
 * a panel with a `placements` record sits where that record says, and a
 * panel in `hiddenPanels` is on no rail at all, whatever its data says. The
 * returned contributions carry the placement actually applied, so the
 * chrome's top/bottom docking follows the move. Both rails come back even
 * when empty, because empty is a state the rail renders (as nothing), not
 * an absence.
 */
export function placeSidePanels(
  panels: readonly SidePanelContribution[],
  layout: Layout = DEFAULT_LAYOUT,
): Record<RailSide, SidePanelContribution[]> {
  const placed = panels
    .filter((panel) => !isPanelHidden(layout, panel.id))
    .map((panel) => {
      const applied = effectivePlacement(layout, panel.id, panel.preferredPlacement);
      return applied === panel.preferredPlacement
        ? panel
        : { ...panel, preferredPlacement: applied };
    })
    .sort(bySidePanelPlacement);
  return {
    left: placed.filter((panel) => panel.preferredPlacement.x === "left"),
    right: placed.filter((panel) => panel.preferredPlacement.x === "right"),
  };
}

/** Settings tabs in display order. */
export function orderSettingsSections(
  sections: readonly SettingsSectionContribution[],
): SettingsSectionContribution[] {
  return [...sections].sort(byOrder);
}

/** The live contents of a registry, re-rendering on registration changes. */
export function useContributions<T extends Contribution>(
  registry: ContributionRegistry<T>,
): readonly T[] {
  return useSyncExternalStore(registry.subscribe, registry.list, registry.list);
}

/** The app's one host, serving the read catalog. Tests build their own `new PluginHost()`. */
export const pluginHost = new PluginHost({
  reads: new Set(READ_NAMES),
  sql: new Set(SQL_VIEWS),
});

/**
 * A kind's description from the app host, subscribed: a description that
 * arrives after first render (a plugin loaded later) re-dresses the card.
 */
export function useCardKind(kind: string): CardKindContribution {
  useContributions(pluginHost.cardKinds);
  return pluginHost.describeCardKind(kind);
}
