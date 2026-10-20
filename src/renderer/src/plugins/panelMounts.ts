import {
  CREATE_PANEL_SLOT_ID,
  CREATE_PANEL_SLOT_PLACEMENT,
  showsCreatePanelSlot,
} from "@shared/createPanelSlot";
import {
  INSTALLED_PLUGIN_PREFIX,
  PERSONAL_PLUGIN_PREFIX,
  type PersonalExtensionView,
  type PersonalSnapshot,
} from "@shared/personal/manifest";
import {
  mountKindOf,
  PANEL_MOUNT_WHY_MAX,
  type PanelMount,
  type PanelMountKind,
  type PanelMounts,
} from "@shared/personal/mounts";
import type { RailSide } from "@shared/plugins/manifest";
import { effectivePlacement, isPanelHidden, type Layout } from "@shared/preferences";
import { useShellStore } from "../app/store";
import { type PanelBodyState, panelBodies } from "../personal/panelBodies";
import type { SidePanelContribution } from "./contributions";
import { createPanelSlot } from "./createPanelSlotStore";
import type { PluginHost } from "./host";
import { panelRail, type RailSaid } from "./panelRail";
import { type RailRefusal, railRefusals, refusalKey } from "./railRefusals";
import { railStore } from "./railStore";

/**
 * The window's answer about its panels (docs/personal-panels.md, "Placed on
 * the rail"): for every panel it knows, whether it drew it, and if not why,
 * read from the same records the rails draw from - the registered panels,
 * the captain's layout, what each panel's own code said, what refused one,
 * and how each of the captain's own bodies fared. Sent to the core whenever
 * it changes, where a crewmate's `place_panel` waits on it and the
 * Firstmate's surfaces list reads it.
 */
export type MountFacts = {
  panels: readonly SidePanelContribution[];
  layout: Layout;
  /** The panels of the captain's and the ones he added, as the core's snapshot has them. */
  views: readonly PersonalExtensionView[];
  /** What refused a panel, by `refusalKey`. */
  refusals: ReadonlyMap<string, RailRefusal>;
  bodies: ReadonlyMap<string, PanelBodyState>;
  said: (id: string) => RailSaid;
  isCollapsed: (id: string) => boolean;
  /** The create-your-own-panel slot: drawn, or why not. */
  slot: { shows: true } | { shows: false; why: string };
};

function cut(why: string): string {
  return why.length > PANEL_MOUNT_WHY_MAX ? `${why.slice(0, PANEL_MOUNT_WHY_MAX - 3)}...` : why;
}

function versionOf(view: PersonalExtensionView | undefined): string | null {
  return view?.panel?.version ?? view?.frame?.version ?? null;
}

/** Why a registered panel has nothing on its rail: its compile, or its presence rule. */
function emptyWhy(view: PersonalExtensionView | undefined): string {
  if (!view) return "it has nothing to show right now";
  if (view.error) return view.error.message;
  if (!view.panel && !view.frame) return "it has no compiled panel";
  return "its presence rule finds nothing to show (no data in the store key it names)";
}

/** Whose a registered panel is, by the plugin that registered it. */
function kindOfPlugin(pluginId: string): PanelMountKind {
  if (pluginId.startsWith(PERSONAL_PLUGIN_PREFIX)) return "personal";
  if (pluginId.startsWith(INSTALLED_PLUGIN_PREFIX)) return "installed";
  return "app";
}

/** One registered panel, from the records its rail draws from. */
function mountOf(panel: SidePanelContribution, facts: MountFacts): PanelMount {
  const kind = kindOfPlugin(panel.pluginId);
  // The app's own panels are not in the core's snapshot; a panel of the
  // captain's sharing an app panel's id is not this one.
  const view =
    kind === "app"
      ? undefined
      : facts.views.find((entry) => entry.id === panel.id && mountKindOf(entry.source) === kind);
  const rail: RailSide = effectivePlacement(facts.layout, panel.id, panel.preferredPlacement).x;
  const base = { id: panel.id, kind, version: versionOf(view), rail };
  if (isPanelHidden(facts.layout, panel.id)) return { ...base, state: "hidden", why: null };
  if (panel.source.get() === null) return { ...base, state: "off", why: cut(emptyWhy(view)) };
  const said = facts.said(panel.id);
  if (panel.rail?.decides === true && said.shown !== true) {
    const why =
      said.shown === false
        ? `its own code has it off its rail${said.why ? `: ${said.why}` : ""}`
        : "its own code has not put it on its rail yet";
    return { ...base, state: "off", why: cut(why) };
  }
  // The captain's own panel draws in this window: its body says how it fared.
  if (kind === "personal") {
    const body = facts.bodies.get(panel.id);
    if (!body || body.version !== base.version) return { ...base, state: "loading", why: null };
    if (body.state === "stopped") return { ...base, state: "stopped", why: cut(body.why) };
  }
  if (facts.isCollapsed(panel.id)) return { ...base, state: "collapsed", why: null };
  return { ...base, state: "drawn", why: null };
}

/**
 * The window's whole answer: every panel it registered, refused, or keeps
 * in the slot, each named by its kind and id, since a refused panel of the
 * captain's and the app's panel holding its id share the id.
 */
export function readPanelMounts(facts: MountFacts): PanelMount[] {
  const mounts = facts.panels.map((panel) => mountOf(panel, facts));
  const named = new Set(mounts.map((mount) => refusalKey(mount.kind, mount.id)));
  // A panel the core has that no rail took: refused, with the refusal's words.
  for (const view of facts.views) {
    const kind = mountKindOf(view.source);
    const key = refusalKey(kind, view.id);
    if (named.has(key)) continue;
    named.add(key);
    mounts.push({
      id: view.id,
      kind,
      version: versionOf(view),
      state: "refused",
      rail: effectivePlacement(facts.layout, view.id, view.placement).x,
      why: cut(facts.refusals.get(key)?.why ?? "the window did not mount it"),
    });
  }
  for (const [key, refusal] of facts.refusals) {
    if (named.has(key)) continue;
    named.add(key);
    mounts.push({
      id: refusal.id,
      kind: refusal.kind,
      version: null,
      state: "refused",
      rail: null,
      why: cut(refusal.why),
    });
  }
  const slotRail = effectivePlacement(
    facts.layout,
    CREATE_PANEL_SLOT_ID,
    CREATE_PANEL_SLOT_PLACEMENT,
  ).x;
  const slot = { id: CREATE_PANEL_SLOT_ID, kind: "app", version: null, rail: slotRail } as const;
  mounts.push(
    isPanelHidden(facts.layout, CREATE_PANEL_SLOT_ID)
      ? { ...slot, state: "hidden", why: null }
      : facts.slot.shows
        ? { ...slot, state: "drawn", why: null }
        : { ...slot, state: "off", why: facts.slot.why },
  );
  return mounts;
}

/** The create-your-own-panel slot's four facts, as the window holds them now. */
function slotNow(layout: Layout): MountFacts["slot"] {
  const thirdCrewmateDoneAt = useShellStore.getState().firstRun?.thirdCrewmateDoneAt;
  const { panelsOn, ownPanel } = createPanelSlot.facts();
  const hidden = isPanelHidden(layout, CREATE_PANEL_SLOT_ID);
  if (showsCreatePanelSlot({ thirdCrewmateDoneAt, panelsOn, ownPanel, hidden })) {
    return { shows: true };
  }
  if (!panelsOn) return { shows: false, why: "the captain's own panels are switched off" };
  if (ownPanel !== false)
    return { shows: false, why: "it shows only until he has a panel of his own" };
  return { shows: false, why: "it shows once his third task has finished" };
}

let views: readonly PersonalExtensionView[] = [];
const viewListeners = new Set<() => void>();

/** The panels the core's newest snapshot carries, which the answer names even when no rail took one. */
export function noteMountSnapshot(snapshot: PersonalSnapshot): void {
  views = snapshot.extensions;
  for (const listener of [...viewListeners]) listener();
}

export type PanelMountsApi = { reportMounts: (mounts: PanelMounts) => Promise<unknown> };

/**
 * Sends the window's answer whenever any record it reads changes, once per
 * change of the answer itself, coalesced to one send per task. Returns the
 * stop function.
 */
export function startPanelMounts(
  host: PluginHost,
  api: PanelMountsApi | undefined = window.infinitary?.plugins?.personal,
): () => void {
  if (!api?.reportMounts) return () => {};
  let last = "";
  let queued = false;
  let stopped = false;
  const send = () => {
    queued = false;
    if (stopped) return;
    const layout = railStore.layout();
    const panels = readPanelMounts({
      panels: host.sidePanels.list(),
      layout,
      views,
      refusals: railRefusals.list(),
      bodies: panelBodies.list(),
      said: (id) => panelRail.get(id),
      isCollapsed: (id) => railStore.isCollapsed(id),
      slot: slotNow(layout),
    });
    const text = JSON.stringify(panels);
    if (text === last) return;
    last = text;
    // A window the core does not take the answer from (a view of another
    // Mac) is simply not heard; the rails are unaffected.
    void api.reportMounts({ panels }).catch(() => {});
  };
  const changed = () => {
    if (queued || stopped) return;
    queued = true;
    queueMicrotask(send);
  };
  // Each panel's own source moves its presence without a registration.
  let sources: (() => void)[] = [];
  const follow = () => {
    for (const off of sources) off();
    sources = host.sidePanels.list().map((panel) => panel.source.subscribe(changed));
    changed();
  };
  viewListeners.add(changed);
  const offs = [
    host.sidePanels.subscribe(follow),
    railStore.subscribe(changed),
    railRefusals.subscribe(changed),
    panelBodies.subscribe(changed),
    panelRail.subscribe(changed),
    createPanelSlot.subscribe(changed),
    useShellStore.subscribe((state, before) => {
      if (state.firstRun?.thirdCrewmateDoneAt !== before.firstRun?.thirdCrewmateDoneAt) changed();
    }),
  ];
  follow();
  return () => {
    stopped = true;
    viewListeners.delete(changed);
    for (const off of [...offs, ...sources]) off();
  };
}
