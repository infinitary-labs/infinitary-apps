import type { FrameTheme } from "@shared/plugins/frameDocument";
import type { RailSide } from "@shared/plugins/manifest";
import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { hasShellPainted } from "../design/reveals";
import { CreatePanelSlot } from "./CreatePanelSlot";
import type { PanelSource, SidePanelContribution } from "./contributions";
import { FrameMount } from "./frames/FrameMount";
import { pluginHost } from "./host";
import { PanelHeaderButtons } from "./PanelHeaderButtons";
import { pushPanelFocus } from "./panelCards";
import { type RailSaid, summaryLine, useRailSaid } from "./panelRail";
import { railStore, useBodyFocusAsk, usePanelCollapsed } from "./railStore";
import { SaidLine } from "./SaidLine";
import { SidePanelChrome } from "./SidePanelChrome";

/**
 * One of the two dock rails (D5). The rail renders only its mounted
 * panels, and a panel whose source says `null` renders nothing at all - so
 * an empty rail is an empty element, and the stylesheet gives a rail with
 * no shown panel zero width, no padding, and no paint (design/styles.css).
 * That is the whole of "empty means invisible": no measurement, no flag, no
 * frame of chrome before the first data arrives. A panel whose own code
 * took it off its rail (piece 5) stays in it, hidden, so its page runs on;
 * a hidden panel is not a shown one, so it docks nothing. The left rail
 * opens with the create-your-own-panel slot while it shows (./CreatePanelSlot).
 */
export function Rail({
  side,
  panels,
  theme,
}: {
  side: RailSide;
  panels: readonly SidePanelContribution[];
  /** The shell's theme, pushed into every frame the rail mounts. */
  theme: FrameTheme;
}) {
  return (
    <div data-rail={side}>
      {side === "left" && <CreatePanelSlot />}
      {panels.map((panel) => (
        <PanelMount key={panel.id} panel={panel} theme={theme} />
      ))}
    </div>
  );
}

const notRunning: PanelSource<boolean> = { subscribe: () => () => {}, get: () => false };

/**
 * Gives a panel's frame focus, as a click on it would, before its document
 * is asked to put focus somewhere inside: a frame's own script cannot take
 * focus from elsewhere in the window (FRAME_ALLOW, docs/ui-plugins.md
 * "Focus and the frames"), but it may move focus inside a frame that holds it.
 */
function focusPanelFrame(id: string): void {
  document
    .querySelector<HTMLIFrameElement>(`[data-side-panel="${CSS.escape(id)}"] iframe`)
    ?.focus({ preventScroll: true });
}

function PanelMount({ panel, theme }: { panel: SidePanelContribution; theme: FrameTheme }) {
  const content = useSyncExternalStore(panel.source.subscribe, panel.source.get, panel.source.get);
  const running = panel.running ?? notRunning;
  const busy = useSyncExternalStore(running.subscribe, running.get, running.get) === true;
  const collapsed = usePanelCollapsed(panel.id);
  const [reveal, setReveal] = useState(hasShellPainted);
  // Asked by F6 to take focus (railStore.askBodyFocus): the window gives
  // the panel's frame focus, as a click on it would, and asks the panel
  // (`asks.onFocus`) to put focus where a person starts in it. Asks from
  // before this mount are not this mount's.
  const focusAsked = useBodyFocusAsk(panel.id);
  const focusAnswered = useRef(focusAsked);
  useEffect(() => {
    if (focusAsked === focusAnswered.current) return;
    focusAnswered.current = focusAsked;
    focusPanelFrame(panel.id);
    pushPanelFocus(panel.id);
  }, [focusAsked, panel.id]);
  // A panel that speaks for itself (piece 5): what it said it holds, and
  // whether its own code has it on its rail. Off it, the chrome stays in
  // place, hidden, so its page runs on and comes back as it was.
  const said = useRailSaid(panel.id);
  const speaks = panel.rail !== undefined;
  const offRail = panel.rail?.decides === true && said.shown !== true;
  const summary = collapsed && speaks ? said.summary : null;
  const toggle = () => {
    setReveal(true);
    railStore.toggleCollapsed(panel.id);
  };
  if (content === null) return null;
  return (
    <SidePanelChrome
      id={panel.id}
      hidden={offRail}
      keepBody={speaks}
      title={panel.title}
      attribution={panel.attribution}
      running={busy}
      size={panel.size}
      newestLast={panel.newestLast}
      placementY={panel.preferredPlacement.y}
      collapsed={collapsed}
      onToggleCollapsed={toggle}
      compact={
        summary ? (
          <SaidSummary summary={summary} panelTitle={panel.title} onOpen={toggle} />
        ) : undefined
      }
      compactReplacesTitle={summary !== null && summaryLine(summary) !== null}
      headerTool={
        panel.header?.length ? (
          <PanelHeaderButtons panel={panel} collapsed={collapsed} />
        ) : undefined
      }
    >
      {panel.frame ? (
        <TemplatePanelBody panel={panel} theme={theme} reveal={reveal} />
      ) : (
        panel.Body && <panel.Body content={content} />
      )}
    </SidePanelChrome>
  );
}

/**
 * A Tier-2 panel's template in the frame vehicle, inside the host's chrome
 * (docs/ui-plugins.md, phase 2). The mount lives as long as the panel has
 * something to show; its data is pushed over the bridge from the reads the
 * plugin declared, and it raises no action: a template is display. A
 * `fill` panel's frame takes the body's height; a `content` panel's
 * follows the document's own height as the bridge reports it, from zero,
 * rounded up to fit its viewport, with scrolling owned by the host.
 */
function TemplatePanelBody({
  panel,
  theme,
  reveal,
}: {
  panel: SidePanelContribution;
  theme: FrameTheme;
  reveal: boolean;
}) {
  if (!panel.frame) return null;
  return (
    <FrameMount
      title={panel.title}
      reveal={reveal}
      template={panel.frame}
      spec={{
        pluginId: panel.pluginId,
        reads: pluginHost.declaredReads(panel.pluginId),
        grant: pluginHost.grantOf(panel.pluginId),
        actions: [],
        onAction: () => undefined,
      }}
      theme={theme}
      layout={panel.size === "fill" ? "fill" : "auto"}
      minAutoHeight={0}
      maxAutoHeight={FRAME_PANEL_MAX_AUTO_HEIGHT}
    />
  );
}

/**
 * What a collapsed panel said it holds (`rail.summarize`), drawn as the
 * app's own chrome: its parts in a row, the one that matters in the
 * primary color, as the Tasks panel's waiting count is. A line among them
 * (`PanelSummaryLine`) leads in the title's place (./SaidLine.tsx), and
 * the short parts follow it at the right.
 */
function SaidSummary({
  summary,
  panelTitle,
  onOpen,
}: {
  summary: NonNullable<RailSaid["summary"]>;
  panelTitle: string;
  onOpen: () => void;
}) {
  const line = summaryLine(summary);
  const parts = summary.flatMap((part) => ("text" in part ? [part] : []));
  const shortParts = parts.map((part, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: the parts are a fixed row the panel says whole
    <Fragment key={index}>
      {index > 0 && " · "}
      <span
        data-panel-summary-part=""
        data-strong={part.strong ? "" : undefined}
        style={{ color: part.strong ? "var(--fg-1)" : undefined }}
      >
        {part.text}
      </span>
    </Fragment>
  ));
  if (!line) return <span data-panel-summary="">{shortParts}</span>;
  return (
    <>
      <SaidLine line={line} panelTitle={panelTitle} onOpen={onOpen} />
      {parts.length > 0 && (
        <span
          data-panel-summary=""
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            color: "var(--fg-3)",
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          {shortParts}
        </span>
      )}
    </>
  );
}

/** Content panels may consume all of the rail height their siblings leave. */
export const FRAME_PANEL_MAX_AUTO_HEIGHT = Number.POSITIVE_INFINITY;
