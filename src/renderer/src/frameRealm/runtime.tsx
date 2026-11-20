import type { PanelProps } from "@shared/personal/contracts";
import type { FrameBridgeApi } from "@shared/plugins/bridge";
import {
  PANEL_BODY_ACTION,
  PANEL_CONFIG_ID,
  PANEL_ROOT_ID,
  type PanelBodySaid,
  type PanelDocumentConfig,
} from "@shared/plugins/frameDocument";
import { type ComponentType, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { stoppedWhy } from "../personal/panelBodies";
import { PanelBoundary, PanelStoppedLine } from "../personal/panelBoundary";
import { frameBridge } from "./bridge";
import { followKeyClicks } from "./keyClicks";
import {
  cardData,
  cardKept,
  cardRevision,
  firstState,
  frameKeep,
  frameKeys,
  framePanelProps,
  frameRail,
  frameView,
} from "./panelProps";

/**
 * The frame realm's runtime (one plugin vehicle, Phase A item 4; captain's
 * A1a): what the lib's boot module runs inside a panel document. It reads
 * the config the host wrote into the document, imports the panel's module
 * (a lib file for the app's own panels, the mount's own compiled files for
 * one the captain added), builds `PanelProps` over the bridge, and renders
 * the panel into the root inside the same boundary the app's window uses.
 *
 * A module that will not import, a default export that is not a component,
 * and a render that throws all end the same way: the quiet line, inside
 * the host's chrome, never a blank frame. A panel's page on its rail tells
 * the host how its body fared (`panel.body`): drawn once it committed, or
 * stopped and why, for the window's answer about its panels. The theme follows the bridge's
 * `onTheme`, so the panel re-renders on a theme change the way an
 * in-process panel does when the shell's theme moves; the keys its
 * commands have ride view state, so it re-renders when one changes.
 */
export type ModuleLoader = (url: string) => Promise<unknown>;

const importForReal: ModuleLoader = (url) => import(/* @vite-ignore */ url);

export function readPanelConfig(doc: Document): PanelDocumentConfig {
  const text = doc.getElementById(PANEL_CONFIG_ID)?.textContent;
  if (!text) throw new Error("this panel document carries no config");
  return JSON.parse(text) as PanelDocumentConfig;
}

export async function bootPanel(
  doc: Document = document,
  bridge: FrameBridgeApi = frameBridge(),
  load: ModuleLoader = importForReal,
): Promise<void> {
  const host = doc.getElementById(PANEL_ROOT_ID);
  if (!host) throw new Error("this panel document has no root");
  const root = createRoot(host);
  let Panel: unknown;
  let config: PanelDocumentConfig | null = null;
  // i18n-exempt: served to the crew (a stopped body's why)
  let why = "its module has no default export to draw";
  try {
    config = readPanelConfig(doc);
    Panel = ((await load(config.module)) as { default?: unknown } | null)?.default;
  } catch (error) {
    console.warn("panel module did not load:", error);
    // i18n-exempt: served to the crew (a stopped body's why)
    why = `its module would not import: ${stoppedWhy(error)}`;
  }
  if (!config || typeof Panel !== "function") {
    if (config && config.card === undefined) say(bridge, { state: "stopped", why });
    root.render(<PanelStoppedLine card={config?.card !== undefined} />);
    return;
  }
  const props = framePanelProps(config, bridge);
  // A mouse click on a control marked with one of its commands names that
  // command's key at the bottom of the window.
  followKeyClicks(doc, bridge);
  // A card's page starts from the place the card kept, which rides the
  // first view state the host pushes it.
  if (config.card) await firstState(bridge);
  root.render(
    <FramePanel
      Panel={Panel as ComponentType<PanelProps>}
      props={props}
      cardId={config.card?.id ?? null}
      bridge={bridge}
    />,
  );
}

function FramePanel({
  Panel,
  props,
  cardId,
  bridge,
}: {
  Panel: ComponentType<PanelProps>;
  props: Omit<PanelProps, "theme" | "card" | "view" | "keys" | "rail">;
  /** Set when this document draws one of the panel's cards. */
  cardId: string | null;
  bridge: FrameBridgeApi;
}) {
  const theme = useSyncExternalStore(
    (onChange) => bridge.onTheme(onChange),
    () => bridge.theme,
  );
  // A card's data is view state: a revised card is a new value here, so the
  // view hears it without a new document - one new value each time the card
  // was put up again, and not at every push of the view beside it.
  const state = useSyncExternalStore(
    (onChange) => bridge.onState(onChange),
    () => bridge.state,
  );
  const revision = cardId === null ? 0 : cardRevision(state);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the data is read anew only when the card was put up again
  const data = useMemo(() => (cardId === null ? null : cardData(state)), [cardId, revision]);
  // What the card kept, as this page was born: a later keep is for the next page.
  const [kept] = useState(() => (cardId === null ? null : cardKept(bridge.state)));
  const keep = useMemo(() => frameKeep(bridge), [bridge]);
  const card = useMemo(
    () => (cardId === null ? undefined : { id: cardId, data, revision, kept, keep }),
    [cardId, data, revision, kept, keep],
  );
  // The view and whether the panel is collapsed are view state: each is a
  // new value only when it moved, so the panel re-renders only then.
  const viewKey = JSON.stringify(frameView(state));
  const view = useMemo(() => JSON.parse(viewKey) as PanelProps["view"], [viewKey]);
  // The keys its commands have now, a new value only when one changed.
  const keysKey = JSON.stringify(frameKeys(state));
  const keys = useMemo(() => JSON.parse(keysKey) as PanelProps["keys"], [keysKey]);
  const collapsed = cardId === null && frameRail(state, bridge).collapsed;
  const rail = useMemo(
    () => (cardId === null ? frameRail({ collapsed }, bridge) : undefined),
    [cardId, collapsed, bridge],
  );
  const onRail = cardId === null;
  return (
    <PanelBoundary
      card={!onRail}
      {...(onRail
        ? { onStop: (error: unknown) => say(bridge, { state: "stopped", why: stoppedWhy(error) }) }
        : {})}
    >
      <Panel
        {...props}
        theme={theme}
        view={view}
        keys={keys}
        {...(card ? { card } : {})}
        {...(rail ? { rail } : {})}
      />
      {onRail && <Drawn bridge={bridge} />}
    </PanelBoundary>
  );
}

/**
 * Says the body drew once it committed: it sits after the panel inside the
 * boundary, so a throw replaces both before either commits.
 */
function Drawn({ bridge }: { bridge: FrameBridgeApi }) {
  useEffect(() => say(bridge, { state: "drawn" }), [bridge]);
  return null;
}

/** Tells the host how the body fared; a page the host did not ask goes unheard. */
function say(bridge: FrameBridgeApi, said: PanelBodySaid): void {
  bridge.action(PANEL_BODY_ACTION, said).catch(() => {});
}
