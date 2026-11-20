import type { PersonalManifest } from "@shared/personal/contracts";
import type { PersonalError } from "@shared/personal/manifest";
import { canonicalCapabilities, type PluginCapabilities } from "@shared/plugins/manifest";
import { checkPluginTree } from "../plugins/pluginInstaller";

/*
 * The panels the panel service serves as added panels are
 * (`PersonalExtensions`, docs/ui-plugins.md "One plugin vehicle"): the
 * plugins the captain added, and the panels of the runbooks that are on
 * (docs/runbooks.md, "Panels"). Nothing of them runs in the core: each tree
 * is checked the way the installer checks one and compiled for the frame
 * realm.
 */
/** One plugin the captain added, as its record says: its name and what he agreed to. */
export type InstalledPluginEntry = {
  id: string;
  name: string;
  capabilities: PluginCapabilities;
};

export type InstalledRoot = {
  /** `userData/plugins`: one directory per added plugin. */
  dir: string;
  /** Where an added panel is compiled; never served in-process. */
  cacheRoot: string;
  /** The record's list; a directory it does not name is never mounted. */
  list: () => InstalledPluginEntry[];
  /**
   * The third root (docs/runbooks.md, "Panels"): the panels of the runbooks
   * you made or added that are on, served as added panels are. Absent, none.
   */
  runbooks?: () => RunbookPanelEntry[];
};

/**
 * One panel a runbook that is on shows. `grants` is what it is served: `own`
 * for a runbook in your workspace, which is served what its manifest asks;
 * what you agreed to on an added runbook's card; or `unasked` for an added
 * runbook whose record holds no agreement for it, which mounts nothing.
 */
export type RunbookPanelEntry = {
  id: string;
  /** Where its saved data is kept: its runbook's, never its shown id (`runbookPanelSlice`). */
  slice: string;
  dir: string;
  /** The runbook it comes with, by id and name. */
  runbook: { id: string; name: string };
  grants: "own" | "unasked" | PluginCapabilities;
};

/** A runbook panel left off, as the snapshot's `refused` list names it, each field within its bound. */
export function runbookRefusal(panel: RunbookPanelEntry, why: string) {
  const cut = (text: string) => text.slice(0, 100);
  return { id: cut(panel.id), runbook: cut(panel.runbook.id), by: cut(panel.runbook.name), why };
}

/**
 * What the captain agreed to for one folder of an added runbook, from its
 * record's own entries only, so a folder named like an object's built-in
 * member reads as not agreed rather than as a grant.
 */
export function agreedGrant(
  panels: Record<string, PluginCapabilities> | null | undefined,
  folder: string,
): PluginCapabilities | "unasked" {
  return panels && Object.hasOwn(panels, folder) ? (panels[folder] ?? "unasked") : "unasked";
}

/** What one check of a served-as-added panel found, for the panel service's entry. */
export type FramedCheck = {
  manifest: PersonalManifest;
  granted: PluginCapabilities;
  frameVersion: string | null;
  views: string[];
  error: PersonalError | null;
};

/**
 * One panel served as an added one: the tree is checked the way the
 * installer checked it - a manifest, a panel whose imports the compiler
 * admits, no server code - and must ask for exactly what the captain agreed
 * to, or it mounts nothing with the reason named. `own` serves what its
 * manifest asks, as a runbook of the captain's own does; `unasked` mounts
 * nothing.
 */
export async function checkFramed(
  panel: { id: string; dir: string; runbook: string | null },
  grants: PluginCapabilities | "own" | "unasked",
  cacheRoot: string,
): Promise<FramedCheck> {
  const result: FramedCheck = {
    manifest: {},
    // Nothing is granted until the check passes: a refused panel hears no
    // integration event and writes nothing through one.
    granted: {},
    frameVersion: null,
    views: [],
    error: null,
  };
  const checked = await checkPluginTree(panel.dir, panel.id, cacheRoot, {
    inRunbook: panel.runbook !== null,
  });
  if ("refusal" in checked) {
    result.error = { stage: "manifest", message: `${panel.id}: ${checked.refusal}` };
  } else if (grants === "unasked") {
    // An added runbook's record holds no agreement for this panel, as one
    // added before runbooks showed panels: adding it again asks.
    result.manifest = { title: checked.manifest.title ?? panel.id };
    result.error = {
      stage: "manifest",
      message: `${panel.id}: the captain has not agreed to this panel; add its runbook again to ask them`,
    };
  } else if (
    grants !== "own" &&
    canonicalCapabilities(checked.capabilities) !== canonicalCapabilities(grants)
  ) {
    // The files on disk changed after the captain agreed: he is asked
    // again by adding it again, never by the host reading the new ask.
    result.manifest = { title: checked.manifest.title ?? panel.id };
    result.error = {
      stage: "manifest",
      // i18n-exempt: a panel error served to the agent and shown in the developer-only Observe view, which stays English
      message: `${panel.id}: its files now ask for something different from what the captain agreed to; add ${panel.runbook ? "its runbook" : "it"} again to ask them`,
    };
  } else {
    result.manifest = checked.manifest;
    result.granted = checked.capabilities;
    result.frameVersion = checked.panelVersion;
    result.views = checked.views;
  }
  return result;
}
