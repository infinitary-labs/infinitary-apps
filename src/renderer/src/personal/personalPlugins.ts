import {
  INSTALLED_PLUGIN_PREFIX,
  PERSONAL_ATTRIBUTION,
  PERSONAL_PLUGIN_PREFIX,
  type PersonalExtensionView,
  type PersonalSnapshot,
} from "@shared/personal/manifest";
import { mountKindOf, type PanelMountKind } from "@shared/personal/mounts";
import { parsePluginManifest } from "@shared/plugins/manifest";
import { useShellStore } from "../app/store";
import { sidePanelBinding } from "../plugins/contributions";
import { createPanelSlot } from "../plugins/createPanelSlotStore";
import type { PluginHost } from "../plugins/host";
import { noteMountSnapshot } from "../plugins/panelMounts";
import { panelRail } from "../plugins/panelRail";
import { createPanelSource } from "../plugins/panelSource";
import { railRefusals, refusalWords } from "../plugins/railRefusals";
import { FramedPanelBody, type FramedPanelContent, framedCardBody } from "./FramedPanelBody";
import { panelDrafts } from "./PanelDrafts";
import { personalCardBody } from "./PersonalCardBody";
import { PersonalPanelBody, type PersonalPanelContent } from "./PersonalPanelBody";

/**
 * Registers every personal extension in the core's snapshot as a plugin of
 * the renderer's host (talk-to-personalize Step 2), through the same door
 * the built-in UI and any third-party plugin use: `registerPlugin` with a
 * manifest and a Tier-1 side-panel binding. Nothing about the rails learns
 * a new concept - a personal panel is a side-panel contribution whose
 * attribution reads "yours".
 *
 * The snapshot is the whole truth: a new extension registers, one that is
 * gone unregisters, one whose manifest data moved (title, placement, order,
 * size) re-registers, and the two data-driven bits ride sources - the
 * panel's content (`null` while its presence rule is unsatisfied or it has
 * no compiled panel, so the rail shows no chrome) and `running` (the busy
 * dot). A rail holds every panel registered to it; a panel the host
 * refuses for a real error (an id another plugin holds, a grant it does
 * not serve) is logged here and kept with its words
 * (../plugins/railRefusals.ts), which is what the window's answer about its
 * panels reads (docs/personal-panels.md, "Placed on the rail"), never a crash.
 *
 * One snapshot carries both sources (one plugin vehicle, Phase A item 5):
 * the captain's own panels register as `personal-<id>` and read "yours",
 * the ones he added as `installed-<id>` and read the plugin's own name.
 * Both register through the same door with the grants they are served. An
 * added panel's code never runs in this window: its body is a frame in the
 * frame realm (./FramedPanelBody.tsx), served exactly those grants.
 *
 * Each panel's cards ride the same registration (docs/ui-plugins.md, "A
 * panel's cards"): its card views, named cards, header buttons and
 * commands are its side panel's manifest data, and its `CardBody` draws a
 * card where the panel runs. A panel that leaves the snapshot - removed, or
 * every panel taken back by the switch or safe mode - takes its cards off
 * the stack with it.
 *
 * A panel a crewmate is building stays on its rail as its last commit
 * holds it; the version being built rides the snapshot's `drafts`, which
 * go to ./PanelDrafts.tsx and never register (docs/personal-panels.md,
 * "Built apart").
 */
export type PersonalPluginsApi = {
  list: () => Promise<PersonalSnapshot>;
  onSnapshot: (listener: (snapshot: PersonalSnapshot) => void) => () => void;
};

type Mounted = {
  key: string;
  unregister: () => void;
  setContent: (view: PersonalExtensionView) => void;
  setRunning: (running: boolean | null) => void;
};

/** A panel's compiled code, for its cards: present or not, while it compiles. */
function codeOf(view: PersonalExtensionView): PersonalPanelContent | null {
  if (view.source !== "yours" || !view.panel) return null;
  return {
    id: view.id,
    title: view.title,
    url: view.panel.url,
    version: view.panel.version,
    reads: view.reads,
    sql: view.sql,
    moves: view.moves,
    decides: view.ownPresence,
  };
}

/** What the rail draws: the panel's code while its presence rule holds. */
function contentOf(view: PersonalExtensionView): PersonalPanelContent | null {
  return view.present ? codeOf(view) : null;
}

/** An added panel's pinned version, for its cards: present or not, while it is served. */
function installedCodeOf(view: PersonalExtensionView): FramedPanelContent | null {
  if (view.source !== "installed" || !view.frame) return null;
  return {
    id: view.id,
    pluginId: `${INSTALLED_PLUGIN_PREFIX}${view.id}`,
    title: view.title,
    size: view.size,
    code: { source: "installed", version: view.frame.version },
    reads: view.reads,
    sql: view.sql,
    moves: view.moves,
    decides: view.ownPresence,
  };
}

function installedContentOf(view: PersonalExtensionView): FramedPanelContent | null {
  return view.present ? installedCodeOf(view) : null;
}

/** The registration-time data; a change here is a re-register. */
function keyOf(view: PersonalExtensionView): string {
  return JSON.stringify([
    view.source,
    view.by,
    view.title,
    view.placement,
    view.order,
    view.size,
    view.newestLast,
    view.reads,
    view.sql,
    view.moves,
    view.ownPresence,
    view.cardViews,
    view.cards,
    view.header,
    view.commands,
  ]);
}

export class PersonalPlugins {
  private readonly mounted = new Map<string, Mounted>();
  /** The panels the host refused, by id with their kind, until they mount or leave the snapshot. */
  private readonly refused = new Map<string, PanelMountKind>();

  constructor(
    private readonly host: PluginHost,
    private readonly warn: (message: string) => void = (message) => console.warn(message),
  ) {}

  apply(snapshot: PersonalSnapshot): void {
    // Unmount first, so a slot a removed or re-placed panel held is free
    // for whatever the same snapshot mounts.
    const next = new Map(snapshot.extensions.map((view) => [view.id, view]));
    for (const [id, entry] of this.mounted) {
      const view = next.get(id);
      if (view && entry.key === keyOf(view)) continue;
      entry.unregister();
      this.mounted.delete(id);
      // Gone, not re-registered: its cards go with it.
      if (!view) this.closeCards(id);
    }
    for (const [id, kind] of [...this.refused]) {
      if (next.has(id)) continue;
      this.refused.delete(id);
      railRefusals.clear(kind, id);
    }
    for (const view of snapshot.extensions) {
      const entry = this.mounted.get(view.id) ?? this.mount(view);
      if (!entry) continue;
      entry.setContent(view);
      entry.setRunning(view.running);
    }
    panelDrafts.set(snapshot.drafts ?? []);
  }

  /** Removes every personal panel from the host, and its cards from the stack. */
  clear(): void {
    for (const [id, entry] of this.mounted) {
      entry.unregister();
      this.closeCards(id);
    }
    this.mounted.clear();
    for (const [id, kind] of this.refused) railRefusals.clear(kind, id);
    this.refused.clear();
    panelDrafts.set([]);
  }

  private mount(view: PersonalExtensionView): Mounted | null {
    const installed = view.source === "installed";
    const content = createPanelSource<PersonalPanelContent>(null);
    const frame = createPanelSource<FramedPanelContent>(null);
    const code = createPanelSource<PersonalPanelContent>(null);
    const pinned = createPanelSource<FramedPanelContent>(null);
    const running = createPanelSource<boolean>(false);
    const manifest = parsePluginManifest({
      id: `${installed ? INSTALLED_PLUGIN_PREFIX : PERSONAL_PLUGIN_PREFIX}${view.id}`,
      name: installed ? (view.by ?? view.id) : PERSONAL_ATTRIBUTION,
      version: "1.0.0",
      contributes: {
        sidePanels: [
          {
            id: view.id,
            title: view.title,
            preferredPlacement: view.placement,
            order: view.order,
            size: view.size,
            newestLast: view.newestLast,
            cardViews: view.cardViews,
            cards: view.cards,
            header: view.header,
            commands: view.commands,
          },
        ],
      },
      // The grants it is served, so the host's own record of the plugin
      // matches what its body reads (the one manifest, folded).
      capabilities: {
        ...(view.reads.length > 0 ? { reads: view.reads } : {}),
        ...(view.sql.length > 0 ? { sql: view.sql } : {}),
      },
    });
    let unregister: () => void;
    try {
      unregister = this.host.registerPlugin(manifest, {
        sidePanels: {
          [view.id]: installed
            ? sidePanelBinding<FramedPanelContent>({
                source: frame.source,
                running: running.source,
                rail: { decides: view.ownPresence },
                Body: FramedPanelBody,
                CardBody: framedCardBody(pinned.source),
              })
            : sidePanelBinding<PersonalPanelContent>({
                source: content.source,
                running: running.source,
                rail: { decides: view.ownPresence },
                Body: PersonalPanelBody,
                CardBody: personalCardBody(code.source),
              }),
        },
      });
    } catch (error) {
      this.warn(`personal panel "${view.id}" was not mounted: ${String(error)}`);
      const kind = mountKindOf(view.source);
      this.refused.set(view.id, kind);
      railRefusals.refuse(kind, view.id, refusalWords(error));
      return null;
    }
    const kind = this.refused.get(view.id);
    if (kind && this.refused.delete(view.id)) railRefusals.clear(kind, view.id);
    const entry: Mounted = {
      key: keyOf(view),
      unregister,
      setContent: (next) => {
        content.set(contentOf(next));
        frame.set(installedContentOf(next));
        code.set(codeOf(next));
        pinned.set(installedCodeOf(next));
      },
      setRunning: running.set,
    };
    this.mounted.set(view.id, entry);
    return entry;
  }

  /** A panel that left the app: its cards come off the stack, and what it said on its rail goes. */
  private closeCards(id: string): void {
    useShellStore.getState().closePanelCards(id);
    panelRail.forget(id);
  }
}

/**
 * Starts the reconciler against the app: the boot snapshot, then every
 * push. `booted` runs once the boot snapshot's panels are registered (or it
 * could not be read), for what should take a rail's place only after them.
 * Returns the stop function.
 */
export function startPersonalPlugins(
  host: PluginHost,
  api: PersonalPluginsApi = window.infinitary.plugins.personal,
  booted: () => void = () => {},
): () => void {
  const plugins = new PersonalPlugins(host);
  let stopped = false;
  let first = true;
  const boot = () => {
    if (!first) return;
    first = false;
    booted();
  };
  // The create-your-own-panel slot leaves once a panel of the captain's exists.
  const apply = (snapshot: PersonalSnapshot) => {
    if (stopped) return;
    plugins.apply(snapshot);
    createPanelSlot.noteSnapshot(snapshot);
    noteMountSnapshot(snapshot);
    boot();
  };
  const off = api.onSnapshot(apply);
  api
    .list()
    .then(apply)
    .catch(() => {
      // The push will bring the first snapshot the core sends.
      boot();
    });
  return () => {
    stopped = true;
    off();
    plugins.clear();
    noteMountSnapshot({ extensions: [] });
  };
}
