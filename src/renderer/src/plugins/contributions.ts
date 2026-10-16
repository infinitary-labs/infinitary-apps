import type { FrameTemplate, FrameTheme } from "@shared/plugins/frameDocument";
import type { CardKindEntry, SettingsSectionEntry, SidePanelEntry } from "@shared/plugins/manifest";
import type { ComponentType } from "react";
import type { PanelCardEntry } from "../app/store";
import type { Contribution } from "./registry";

/**
 * What a registered contribution looks like once the manifest's data is
 * bound to the code that serves it (docs/ui-plugins.md). Tier 1 binds
 * React components; Tier 2 binds a frame template in exactly the same
 * slots - the registries never know which.
 */

/** A card kind is pure data: dress and body policy for one wire kind. */
export type CardKindContribution = Contribution & CardKindEntry;

export type SettingsSectionBinding = {
  /** A gate the host resolves before offering the tab (Observe: development and alpha builds). */
  enabled?: () => Promise<boolean> | boolean;
  /**
   * Offered on an app that controls Firstmate on another Mac too
   * (docs/view.md); every other section stays on the Mac where Firstmate lives.
   */
  onAView?: boolean;
} & (
  | { Component: ComponentType; frame?: undefined }
  /** Tier 2: a template mounted in the frame vehicle, fed by declared reads. */
  | { frame: FrameTemplate; Component?: undefined }
);

export type SettingsSectionContribution = Contribution &
  SettingsSectionEntry &
  SettingsSectionBinding;

/**
 * A panel's content as a plain subscribable value. `null` means "nothing to
 * show" - visibility is data, not a verb (D5): the host renders no chrome
 * for a null panel, and a rail with only null panels is empty. Methods must
 * not depend on `this`; the host calls them unbound.
 */
export type PanelSource<T> = {
  subscribe: (onChange: () => void) => () => void;
  get: () => T | null;
};

/**
 * What a side panel binds (phase 2): its visibility source, and either a
 * React body (Tier 1) or a template for the frame vehicle (Tier 2). A
 * Tier-2 panel's DATA reaches its frame over the bridge from the reads its
 * plugin declared; the source only decides whether there is anything to
 * show. Every panel of the one shape - the app's own, the captain's own
 * and one added from elsewhere - binds a `Body` (its panel's page, in the
 * window or in a frame) and speaks for itself on its rail (`rail`); what
 * it may do is its API's (docs/ui-plugins.md, "A panel's cards"), never a
 * field only one binding sets.
 */
export type SidePanelBinding<T> = {
  source: PanelSource<T>;
  /**
   * Work in flight on this panel: while `true` the host draws a busy dot in
   * the header (a personal panel whose building task is still active,
   * talk-to-personalize Step 2). Host chrome, from data - a panel never
   * draws its own.
   */
  running?: PanelSource<boolean>;
  /**
   * The panel speaks for itself on its rail (docs/ui-plugins.md, "A panel's
   * cards", piece 5): its body stays mounted while the dock is collapsed,
   * the header draws what its code said it holds (`panelRail`), and with
   * `decides` it is on its rail only while its code says so - off it, its
   * body runs on out of sight. Every panel of the one shape has it.
   */
  rail?: { decides: boolean };
  /**
   * Draws one of the panel's cards on the main card stack (docs/ui-plugins.md,
   * "A panel's cards"), where its panel runs: in the app's window for the
   * captain's own, in a frame of its own for one from elsewhere. The host
   * draws the card's title row and Hide around it; which views there are,
   * and the cards its header buttons and commands put up, are the panel's
   * manifest data (`cardViews`, `cards`, `header`, `commands`).
   */
  CardBody?: ComponentType<PanelCardBodyProps>;
} & (
  | {
      /** Renders inside the host-owned body region and styles only that. */
      Body: ComponentType<{ content: T }>;
      frame?: undefined;
    }
  | { frame: FrameTemplate; Body?: undefined }
);

export type SidePanelContribution<T = unknown> = Contribution &
  SidePanelEntry &
  SidePanelBinding<T> & {
    /**
     * Host-rendered, from the manifest's plugin name - never plugin-authored.
     * `null` for the host's own UI: the app does not attribute itself.
     */
    readonly attribution: string | null;
  };

/** What a panel's `CardBody` is handed for one card on the stack. */
export type PanelCardBodyProps = {
  card: PanelCardEntry;
  theme: FrameTheme;
  /** Its body has drawn, or will not: the stage reveals the card then. */
  onDrawn: () => void;
  /** An Escape nothing in the card used: the card hides. */
  onEscape: () => void;
};

/** Erases a binding's content type so registries can hold mixed panels. */
export function sidePanelBinding<T>(binding: SidePanelBinding<T>): SidePanelBinding<unknown> {
  return binding as unknown as SidePanelBinding<unknown>;
}

/** Everything a plugin binds to its manifest, keyed by contribution id. */
export type PluginBindings = {
  settingsSections?: Record<string, SettingsSectionBinding>;
  sidePanels?: Record<string, SidePanelBinding<unknown>>;
};
