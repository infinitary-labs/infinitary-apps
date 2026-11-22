import * as m from "@shared/i18n/messages.generated";
import type { PanelAskVia } from "@shared/personal/contracts";
import {
  type PanelIntegrationsRequest,
  type PersonalExtensionView,
  personalDraftPanelId,
} from "@shared/personal/manifest";
import type { PanelBodySaid, PanelFrameConfig, PanelModule } from "@shared/plugins/frameDocument";
import type { BuiltinFramePanel } from "@shared/plugins/frameLib";
import type { SidePanelSize } from "@shared/plugins/manifest";
import { frameReads } from "@shared/reads";
import type React from "react";
import {
  type ComponentType,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { usePanelKeys } from "../app/keyHints";
import { useShellStore } from "../app/store";
import type { PanelCardBodyProps, PanelSource } from "../plugins/contributions";
import { FrameMount, PANEL_UNRESPONSIVE_LINE } from "../plugins/frames/FrameMount";
import { focusFrame } from "../plugins/frames/frameFocus";
import { framePanelActions } from "../plugins/panelActions";
import { onPanelAsk, onPanelFocus } from "../plugins/panelCards";
import { usePanelView } from "../plugins/panelPoint";
import { panelRail } from "../plugins/panelRail";
import { FRAME_PANEL_MAX_AUTO_HEIGHT } from "../plugins/Rail";
import { usePanelCollapsed } from "../plugins/railStore";
import { BackgroundAsking } from "./BackgroundAsking";
import { BackgroundPaused } from "./BackgroundPaused";
import { BackgroundStopped } from "./BackgroundStopped";
import { panelBodies } from "./panelBodies";
import { PanelStoppedLine } from "./panelBoundary";

/**
 * The body of every panel, drawn in the FRAME REALM (one plugin vehicle,
 * Phase A item 4; captain's A1a; INF-2205 piece C): a sandboxed frame at a
 * host of its own - so a renderer process of its own - loading React and
 * the app's components from the shell's pinned lib, and the panel's own
 * compiled code - the app's own panels' from the lib, built with the bundle
 * (docs/ui-plugins.md, "The app's own panels are ordinary folders"); the
 * captain's own, and one he added from elsewhere, from the files the shell
 * read and hashed at mount - with everything it reads host-mediated. One
 * body for every source: whoever made a panel decides only where its code
 * comes from and what it was granted, never how it is drawn. No panel's
 * code runs in the app's own window.
 *
 * What the frame is served is exactly what the panel was granted, as the
 * host holds it: the reads and the views it declared (for one added from
 * elsewhere, the ones the captain agreed to), and its own store slice,
 * which the host binds by id - the frame names a key, never whose slice.
 * Its gestures are declared from what it asked for (`framePanelActions`):
 * the card actions every panel has, pointing for one that reads the board,
 * its moves, and its rail; the asks its header buttons press and F6's ask
 * for focus, the view, whether it is collapsed and the keys its commands
 * have now reach it as view state.
 * Its watchdog is armed: a panel that wedges its own process while it is
 * showing is torn down to a quiet line with a Retry, and its header stops
 * showing the counts that page last sent. A collapsed panel, one off its
 * rail, or any frame while the window is hidden is not stopped for missed
 * pings, so it keeps refreshing when it can run again.
 *
 * A panel of the captain's own may have background work (`server`), which
 * its `invoke` reaches through the host; when the app stopped that work
 * (INF-2205 piece B) the window draws the status and a Retry above the
 * frame, outside the panel's code. Its page on the rail says how its body
 * fared (`panel.body`), for the window's answer about its panels. The
 * version a crewmate is building (`draft`) is drawn by the same body bound
 * apart: its own store and background work, the rail of its out-of-sight
 * copy, and cards, asks, pointing and moves that reach nothing.
 */
export type FramedPanelContent = {
  id: string;
  /** The plugin id it registered under, for the controller's refusals. */
  pluginId: string;
  title: string;
  size: SidePanelSize;
  /** Where its compiled code comes from: the app's own lib, or the version of one of the captain's or one added from elsewhere. */
  code:
    | { source: "builtin" }
    | { source: "installed"; version: string }
    | { source: "personal"; version: string };
  /** The reads it was granted; its frame is served these and no other. */
  reads: string[];
  /** The views of the record it was granted (`sql`); its queries reach these and no other. */
  sql: string[];
  /** It may move the captain's tasks (`moves`): its manifest asks, and for an added one he agreed. */
  moves: boolean;
  /** The settings it may change (`actions`): its manifest names them, and for an added one he agreed. */
  actions?: string[];
  /** Its own code decides whether it shows (`presence` `{ "code": true }`). */
  decides: boolean;
  /** It has background work of its own (`server.ts`), which its `invoke` reaches. */
  server?: boolean;
  /** The app stopped its background work (INF-2205 piece B): the window draws why, and Retry. */
  stopped?: "unresponsive" | "exited";
  /**
   * The app refused its background work for an earlier panel API (INF-2470):
   * the window draws why, and Update panel; `asked` once the update was asked.
   */
  paused?: { asked: boolean };
  /** Its integration calls waiting on the captain or turned down: the window draws each, and Ask again. */
  integrationAsks?: NonNullable<PersonalExtensionView["integrationAsks"]>;
  /** The version a crewmate is building, drawn out of sight ("Built apart"). */
  draft?: true;
};

/**
 * The page can no longer refresh what it last said. The header says the
 * panel stopped, never those counts as if they were current. Retry mounts
 * a fresh page, which says the counts again.
 */
function notePanelStopped(panel: string): void {
  panelRail.summarize(panel, [{ text: m.panelUnresponsiveLine() }]);
}

/** The compiled version a page draws: the lib's own, or a pinned version of a panel's graph. */
function versionOf(content: FramedPanelContent): string {
  return content.code.source === "builtin" ? "builtin" : content.code.version;
}

/** The module a page of the panel draws: the panel, or one of its card views. */
function moduleOf(
  source: FramedPanelContent["code"]["source"],
  id: string,
  version: string,
  draft: boolean,
  view?: string,
): PanelModule {
  const viewed = view === undefined ? {} : { view };
  if (source === "builtin") return { source, id: id as BuiltinFramePanel, ...viewed };
  if (source === "installed") return { source, id, version, ...viewed };
  return { source, id, version, ...(draft ? { draft: true as const } : {}), ...viewed };
}

/** A call into the panel's background work, which the host runs where that work runs. */
/** The frame inside `holder`, found when asked: the mount renders it after this does. */
function useFrameOf(holder: React.RefObject<HTMLDivElement | null>) {
  return useMemo(() => () => holder.current?.querySelector("iframe") ?? null, [holder]);
}

function serverCall(id: string, draft: boolean) {
  return async (action: string, input: unknown): Promise<unknown> => {
    const { plugins } = window.infinitary;
    const result = draft
      ? await plugins.invoke(id, action, input, { draft: true })
      : await plugins.invoke(id, action, input);
    if (!result.ok) throw new Error(result.error);
    return result.result;
  };
}

/** A page's calls on its panel's integrations; the core reads what it may reach from its manifest. */
function integrationsCall(id: string, draft: boolean) {
  return (request: PanelIntegrationsRequest): Promise<unknown> =>
    draft
      ? window.infinitary.plugins.integrations(id, request, { draft: true })
      : window.infinitary.plugins.integrations(id, request);
}

/** What one page of the panel may ask the host, declared from what it was granted. */
function usePage(
  content: FramedPanelContent,
  frame: () => HTMLIFrameElement | null,
  card?: string,
) {
  const { id, title, moves, decides } = content;
  const own = content.code.source === "builtin";
  const personal = content.code.source === "personal";
  const draft = content.draft === true;
  const server = content.server === true;
  const version = versionOf(content);
  const reads = content.reads.join(",");
  const changes = useChanges(content).join(",");
  return useMemo(() => {
    // Only the captain's own panel on its rail answers how its body fared.
    const onBody =
      personal && !draft && card === undefined
        ? (said: PanelBodySaid) => panelBodies.note(id, { version, ...said })
        : undefined;
    return framePanelActions({
      panel: { id, title, own },
      frame,
      ...(card === undefined ? {} : { card }),
      reads: reads ? reads.split(",") : [],
      moves,
      ...(changes ? { settings: changes.split(",") } : {}),
      decides,
      ...(server ? { server: serverCall(id, draft) } : {}),
      ...(own ? {} : { integrations: integrationsCall(id, draft) }),
      ...(onBody ? { onBody } : {}),
      ...(draft ? { draft: { id: personalDraftPanelId(id) } } : {}),
    });
  }, [
    id,
    title,
    own,
    personal,
    draft,
    server,
    version,
    frame,
    card,
    reads,
    moves,
    changes,
    decides,
  ]);
}

/**
 * The settings a page may change: its grant, only in the window of the
 * computer holding the first mate, since the change reaches no other
 * (docs/ui-plugins.md, "Changing settings"); a view of another one gets none.
 */
function useChanges(content: FramedPanelContent): readonly string[] {
  const view = useShellStore((s) => s.thisMac?.role === "view");
  return view ? [] : (content.actions ?? []);
}

/** The frame config's reads and views, and the controller's, from a content's lists. */
function useGrants(content: FramedPanelContent) {
  const readsKey = content.reads.join(",");
  const viewsKey = content.sql.join(",");
  return useMemo(
    () => ({
      config: {
        reads: readsKey ? (readsKey.split(",") as PanelFrameConfig["reads"]) : [],
        sql: viewsKey ? (viewsKey.split(",") as PanelFrameConfig["sql"]) : [],
      },
      ...frameReads(readsKey ? readsKey.split(",") : [], viewsKey ? viewsKey.split(",") : []),
    }),
    [readsKey, viewsKey],
  );
}

/** The presses of each header button, counted, and how the latest of each came. */
type AskCounts = { counts: Record<string, number>; via: Record<string, PanelAskVia> };

export function FramedPanelBody({ content }: { content: FramedPanelContent }) {
  const theme = useShellStore((s) => s.theme);
  const { id, pluginId, title, size } = content;
  const version = versionOf(content);
  const grants = useGrants(content);
  const moves = content.moves;
  const settings = useChanges(content).length > 0;
  const server = content.server === true;
  const source = content.code.source;
  const draft = content.draft === true;
  /** Where its rail is kept: its own panel's, or its draft's out-of-sight copy. */
  const drawn = draft ? personalDraftPanelId(id) : id;
  const panel = useMemo(
    () => ({
      module: moduleOf(source, id, version, draft),
      config: {
        id,
        ...grants.config,
        ...(moves ? { moves } : {}),
        ...(settings ? { settings } : {}),
        ...(server ? { server } : {}),
      },
    }),
    [id, version, source, draft, grants, moves, settings, server],
  );
  const store = useMemo(
    () => ({ extensionId: id, ...(draft ? { draft: true as const } : {}) }),
    [id, draft],
  );
  const holder = useRef<HTMLDivElement>(null);
  const frame = useFrameOf(holder);
  const page = usePage(content, frame);
  const [born, setBorn] = useState(false);
  const [asks, setAsks] = useState<AskCounts>({ counts: {}, via: {} });
  const [focus, setFocus] = useState(0);
  // A press of a header button that puts up no card, heard once the panel's
  // document is born, drawn or not: a page that lists nothing draws nothing
  // until the press opens something in it. The window gives its frame focus,
  // as a click on it would, and the count pushed as view state after the
  // birth tells the document which.
  useEffect(() => {
    if (!born || draft) return;
    return onPanelAsk(id, (button, via) => {
      // The press may have just brought the panel out of its collapse, and
      // its page kept running out of sight: its frame takes focus once it shows.
      requestAnimationFrame(() => {
        focusFrame(frame());
        setAsks((now) => ({
          counts: { ...now.counts, [button]: (now.counts[button] ?? 0) + 1 },
          via: { ...now.via, [button]: via },
        }));
      });
    });
  }, [born, draft, id, frame]);
  // F6 into the panel: the window gave its frame focus; the count tells its
  // document to put focus where a person starts in it.
  useEffect(() => {
    if (!born || draft) return;
    return onPanelFocus(id, () => setFocus((n) => n + 1));
  }, [born, draft, id]);
  const view = usePanelView(content.reads.includes("tasks.board"));
  // A draft is never collapsed: there is nothing of the captain's to fold.
  const collapsed = usePanelCollapsed(id) && !draft;
  // The keys its commands have now; a draft's commands reach nothing, so it has none.
  const keys = usePanelKeys(draft ? null : id);
  const state = useMemo(
    () => ({ asks: asks.counts, askedBy: asks.via, focus, view, collapsed, keys }),
    [asks, focus, view, collapsed, keys],
  );
  return (
    <div
      ref={holder}
      data-framed-panel={id}
      data-personal-panel={source === "personal" ? id : undefined}
      data-installed-panel={source === "installed" ? id : undefined}
      data-installed-version={source === "installed" ? version : undefined}
      style={{ display: "contents" }}
    >
      {content.stopped && <BackgroundStopped id={id} draft={draft} reason={content.stopped} />}
      {content.paused && !draft && <BackgroundPaused id={id} asked={content.paused.asked} />}
      {content.integrationAsks?.length ? (
        <BackgroundAsking id={id} asks={content.integrationAsks} />
      ) : null}
      <FrameMount
        title={title}
        panel={panel}
        spec={{
          pluginId,
          reads: grants.reads,
          grant: grants.grant,
          actions: page.actions,
          onAction: (actionId, value) => page.onAction(actionId, value),
          store,
          state,
          onBorn: () => setBorn(true),
          onUnresponsive: () => {
            notePanelStopped(drawn);
            if (source === "personal" && !draft) {
              panelBodies.note(id, {
                version,
                state: "stopped",
                why: PANEL_UNRESPONSIVE_LINE,
              });
            }
          },
        }}
        theme={theme}
        layout={size === "fill" ? "fill" : "auto"}
        minAutoHeight={0}
        maxAutoHeight={FRAME_PANEL_MAX_AUTO_HEIGHT}
      />
    </div>
  );
}

/**
 * One card of a panel drawn in the frame realm, on the stack: its card view
 * drawn like its panel - a frame of its own, from the same compiled code
 * and served the same reads, views and store slice - with the card's id in
 * its config and its data, revision and kept place pushed as view state,
 * so a revised card is heard without a new document. An Escape nothing in
 * it used hides the card. The code is a source of its own, not the rail's,
 * so a card stays drawable while its panel shows nothing.
 */
export function framedCardBody(
  source: PanelSource<FramedPanelContent>,
): ComponentType<PanelCardBodyProps> {
  return function FramedCardBody(props: PanelCardBodyProps) {
    const content = useSyncExternalStore(source.subscribe, source.get, source.get);
    if (!content) return <Unloaded onDrawn={props.onDrawn} />;
    return <FramedCard content={content} {...props} />;
  };
}

/** The panel's code is not here this moment: the card says so, quietly. */
function Unloaded({ onDrawn }: { onDrawn: () => void }) {
  useEffect(() => onDrawn(), [onDrawn]);
  return <PanelStoppedLine card />;
}

function FramedCard({
  content,
  card,
  theme,
  onDrawn,
  onEscape,
}: PanelCardBodyProps & { content: FramedPanelContent }) {
  const { id, pluginId } = content;
  const version = versionOf(content);
  const source = content.code.source;
  const grants = useGrants(content);
  const cardId = card.id;
  const cardView = card.view;
  const moves = content.moves;
  const settings = useChanges(content).length > 0;
  const server = content.server === true;
  const panel = useMemo(
    () => ({
      module: moduleOf(source, id, version, false, cardView),
      config: {
        id,
        ...grants.config,
        card: { id: cardId },
        ...(moves ? { moves } : {}),
        ...(settings ? { settings } : {}),
        ...(server ? { server } : {}),
      },
    }),
    [id, version, source, cardView, cardId, grants, moves, settings, server],
  );
  const holder = useRef<HTMLDivElement>(null);
  const frame = useFrameOf(holder);
  const page = usePage(content, frame, cardId);
  // The frame's name is the card's title as it opened: a new name would be a new document.
  const [title] = useState(card.title);
  // Its data, revision and kept place ride view state: the runtime hands the
  // page the place it finds at its birth, so a page born again finds the latest.
  const view = usePanelView(content.reads.includes("tasks.board"));
  const keys = usePanelKeys(id);
  const state = useMemo(
    () => ({ card: { data: card.data, kept: card.kept, revision: card.revision }, view, keys }),
    [card.data, card.kept, card.revision, view, keys],
  );
  const fill = card.height === "fill";
  return (
    <div
      ref={holder}
      data-panel-card-page=""
      data-framed-panel={id}
      data-personal-panel={source === "personal" ? id : undefined}
      data-installed-panel={source === "installed" ? id : undefined}
      data-installed-version={source === "installed" ? version : undefined}
      style={fill ? { height: "100%" } : undefined}
    >
      <FrameMount
        title={title}
        panel={panel}
        spec={{
          pluginId,
          reads: grants.reads,
          grant: grants.grant,
          actions: page.actions,
          onAction: (actionId, value) => page.onAction(actionId, value),
          store: { extensionId: id },
          state,
          onEscape,
          onUnresponsive: () => {
            // A card has no rail summary. The callback still arms the watchdog.
          },
        }}
        theme={theme}
        layout={fill ? "fill" : "auto"}
        minAutoHeight={0}
        maxAutoHeight={Number.POSITIVE_INFINITY}
        onDrawn={onDrawn}
        onMountError={onDrawn}
      />
    </div>
  );
}
