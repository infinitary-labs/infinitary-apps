import { type PluginManifest, parsePluginManifest } from "@shared/plugins/manifest";
import {
  APP_PANEL_FOLDERS,
  type AppPanelFolder,
  type AppPanelGate,
  builtinSurface,
} from "@shared/surfaces";

/**
 * The app's own UI, declared as the first plugin (docs/ui-plugins.md).
 * Everything here is data the registries read; the React that serves the
 * settings sections is bound in ./index.ts. Parsing at module load means a
 * malformed built-in manifest fails the first render and the unit test,
 * never a user's session.
 *
 * Card kinds: the three PRESENTATIONS a wire card derives (cards/tasks/
 * agents P1, `cardPresentation` in cards.ts - a decision has actions, a
 * note none, an attention is the host's own), plus the host-owned
 * `task-record` (task-system P4). Nothing on the wire declares a kind: the
 * card layer derives the presentation and reads its dress here. The chrome
 * and body policy that used to be three switch statements in the card
 * layer live here as rows; every card renders its frame from the first
 * byte. A row says only how a STREAMING body is shown - there is no body
 * profile any more, because there is no sanitizer (captain decision,
 * 2026-09-15): every body renders as its author wrote it, inside the
 * unchanged sandbox and CSP. `task-record` is never persisted in `cards` and never emitted by an
 * agent (`cardsSnapshotSchema` refuses anything but the one card shape),
 * so its body policy is moot - the body is a template the host mounts for
 * the open task (./record).
 *
 * Side panels: the app's own panel folders (`src/panels/<id>/`,
 * docs/ui-plugins.md "The app's own panels are ordinary folders") - the
 * activity feed on the left rail, and on the right the Tasks panel (P4):
 * what IS, minimal by default, the one panel the captain chose for it
 * (decision D3). Each entry is its folder's manifest: its title and place,
 * and the cards, header buttons and commands it declares.
 *
 * Capabilities: the reads the frames subscribe to, the app's own panels'
 * among them. Declared like any plugin would, so the host refuses a frame
 * anything it did not ask for.
 */
export const BUILTIN_PLUGIN_ID = "firstmate";

/**
 * The app's own panels that wait on a gate (`AppPanelFolder.gate`): each
 * gate's folders registered as one more first-party plugin while it is
 * open, so where it is shut there is no panel, card or command of theirs,
 * one gate coming or going never remounts another's panel, and the
 * built-in plugin's own panels keep their place in the order commands take
 * their keys.
 */
export const GATED_PLUGIN_ID = "firstmate-gated";

/** The plugin one gate's folders are registered as. */
export function gatedPluginId(gate: AppPanelGate): string {
  return `${GATED_PLUGIN_ID}-${gate}`;
}

/** The folders with no gate: always the app's. */
export const UNGATED_FOLDERS: readonly AppPanelFolder[] = APP_PANEL_FOLDERS.filter(
  (folder) => !folder.gate,
);

/** Each folder as a side panel: its surface, and the cards, header buttons and commands it declares. */
function sidePanelsOf(folders: readonly AppPanelFolder[]) {
  return folders.flatMap((folder) => {
    const surface = builtinSurface(folder.id);
    if (!surface) return [];
    const { cards, header, commands } = folder.manifest;
    return [
      {
        ...surface,
        cardViews: [...folder.views],
        ...(cards ? { cards } : {}),
        ...(header ? { header } : {}),
        ...(commands ? { commands } : {}),
      },
    ];
  });
}

/** What the folders read, as they declare it. */
function readsOf(folders: readonly AppPanelFolder[]): string[] {
  return [...new Set(folders.flatMap((folder) => folder.manifest.reads ?? []))];
}

export const builtinManifest: PluginManifest = parsePluginManifest({
  id: BUILTIN_PLUGIN_ID,
  name: "Infinitary",
  // Versions with the app; the field earns its keep on installed plugins,
  // where a capability diff between versions re-runs consent.
  version: "1.0.0",
  contributes: {
    cardKinds: [
      { kind: "decision", chrome: "decision", body: { streaming: "html" } },
      { kind: "note", chrome: "note", body: { streaming: "html" } },
      { kind: "attention", chrome: "attention", body: { streaming: "html" } },
      { kind: "task-record", chrome: "record", body: { streaming: "html" } },
    ],
    settingsSections: [
      { id: "general", label: "General", order: 10, width: "wide" },
      { id: "appearance", label: "Appearance", order: 12, width: "wide" },
      // Where each panel sits on the rails, in order (INF-2344; docs/ui-plugins.md).
      { id: "panels", label: "Panels", order: 13, width: "wide" },
      // Every command's keys, and the way to change them (docs/keyboard.md).
      { id: "keyboard", label: "Keyboard", order: 14, width: "wide" },
      { id: "projects", label: "Projects", order: 15, width: "wide" },
      // "Intelligence", not "Subscriptions" (the captain's Q1 note, S7):
      // the tab holds the accounts, the model board and the Decisions
      // group, and only some of that is a subscription. The id, the
      // `open subscriptions` card effect and the e2e ids are unchanged.
      { id: "subscriptions", label: "Intelligence", order: 20, width: "wide" },
      { id: "runbooks", label: "Runbooks", order: 21, width: "wide" },
      // Recorded model usage across the fleet, in tokens or estimated
      // dollars (docs/usage.md). This Mac's own: a Mac that controls it has none.
      { id: "usage", label: "Usage", order: 22, width: "wide" },
      // The schedules Firstmate runs, as rules (docs/automation.md). A Mac
      // that controls it reads and changes the same rules.
      { id: "automation", label: "Automation", order: 23, width: "wide" },
      // What the first mate and the crew reach outside the projects, signed
      // in as the person (docs/integrations.md); GitHub's sign-in lives here.
      { id: "integrations", label: "Integrations", order: 24, width: "wide" },
      { id: "secrets", label: "Secrets", order: 25, width: "wide" },
      // Your devices (docs/devices.md): what was added, each with Remove,
      // the link that adds a Mac, and the address a link sends it to.
      { id: "devices", label: "Devices", order: 26, width: "wide" },
      // Development and alpha builds (docs/dev-observe.md); the binding's gate decides.
      { id: "observe", label: "Observe", order: 30, width: "wide" },
    ],
    // Declared once for the renderer and the core alike (src/shared/
    // surfaces.ts): the Firstmate's "your surfaces" section and its
    // `personalize` tool name these panels by the same ids.
    sidePanels: sidePanelsOf(UNGATED_FOLDERS),
  },
  capabilities: {
    reads: [
      "observe.sessions",
      "observe.session",
      "observe.live",
      // Observe's fourth kind (Step 5): the personal mounts, and whether
      // the host-owned switch has them off at all.
      "personal.mounts",
      "shell.preferences",
      // What a task's work declared it used, which the record reads only
      // where the window has knowledge (docs/knowledge.md).
      "knowledge.uses",
      // What the app's own panels read, as their folders declare it.
      ...readsOf(UNGATED_FOLDERS),
    ],
  },
});

/** The folders waiting on one gate, as one first-party plugin; null when none waits on it. */
export function gatedManifest(gate: AppPanelGate): PluginManifest | null {
  const folders = APP_PANEL_FOLDERS.filter((folder) => folder.gate === gate);
  if (folders.length === 0) return null;
  return parsePluginManifest({
    id: gatedPluginId(gate),
    name: "Infinitary",
    version: "1.0.0",
    contributes: { cardKinds: [], settingsSections: [], sidePanels: sidePanelsOf(folders) },
    capabilities: { reads: readsOf(folders) },
  });
}
