import { formatNumber } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";
import type { FrameTheme } from "@shared/plugins/frameDocument";
import type { RailSide } from "@shared/plugins/manifest";
import {
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { RowMenu } from "../design/core/RowMenu";
import { focusWithRing } from "../design/focus";
import { hasShellPainted } from "../design/reveals";
import { CreatePanelSlot } from "./CreatePanelSlot";
import type { PanelSource, SidePanelContribution } from "./contributions";
import { FrameMount } from "./frames/FrameMount";
import { knownArrangedPanels, pluginHost } from "./host";
import { PanelHeaderButtons } from "./PanelHeaderButtons";
import { pushPanelFocus } from "./panelCards";
import { pressPanel, railTargets, railZones, shownOnRail } from "./panelDrag";
import { PANEL_MOVE_KEYS, panelStepOf } from "./panelMoveKeys";
import { panelRail, type RailSaid, summaryLine, useRailSaid } from "./panelRail";
import { railFolds, useRailFolds } from "./railFolds";
import { railRoom } from "./railRoom";
import { railStore, useBodyFocusAsk, usePanelCollapsed, useRailLayout } from "./railStore";
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
  theme: FrameTheme;
}) {
  const root = useRef<HTMLDivElement>(null);
  const layout = useRailLayout();
  const [, setSaidVersion] = useState(0);
  useEffect(() => panelRail.subscribe(() => setSaidVersion((version) => version + 1)), []);
  // The ladder's folds live in one store, which the window's answer about
  // its panels reads too (./railFolds.ts); a rail no longer drawn folds nothing.
  const room = useRailFolds(side);
  useEffect(() => () => railFolds.clear(side), [side]);
  const bodyHeights = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const rail = root.current;
    if (!rail) return;
    let frame = 0;
    const measure = () => {
      const style = getComputedStyle(rail);
      const px = (name: string) => Number.parseFloat(style.getPropertyValue(name)) || 0;
      const gap = px("row-gap");
      // Resolve design tokens through a physical probe, including calc() and zoom.
      const probe = document.createElement("div");
      probe.style.cssText =
        "position:absolute;visibility:hidden;height:var(--rail-body-min-height);width:var(--rail-header-height)";
      rail.append(probe);
      const minimum = probe.getBoundingClientRect().height;
      const header = probe.getBoundingClientRect().width;
      probe.remove();
      const readings = panels.flatMap((panel) => {
        const node = rail.querySelector<HTMLElement>(`[data-side-panel="${CSS.escape(panel.id)}"]`);
        if (!node || node.hasAttribute("data-side-panel-off-rail")) return [];
        const body = node.querySelector<HTMLElement>("[data-side-panel-body]");
        if (body && !body.hidden && !node.hidden)
          bodyHeights.current.set(panel.id, body.scrollHeight);
        const natural = bodyHeights.current.get(panel.id) ?? minimum;
        return [
          {
            id: panel.id,
            end: panel.preferredPlacement.y,
            header,
            body: Math.min(natural, minimum + px("--space-4")),
            collapsed: railStore.isCollapsed(panel.id),
            pinned: layout.collapsedPanels[panel.id] === false,
          },
        ];
      });
      const slot = rail.querySelector<HTMLElement>("[data-create-panel-slot]:not([hidden])");
      const height =
        rail.clientHeight -
        px("padding-top") -
        px("padding-bottom") -
        (slot ? slot.offsetHeight + gap : 0);
      for (const element of rail.querySelectorAll(
        "[data-side-panel-body], [data-side-panel-body] > *, [data-side-panel-body] iframe",
      ))
        observer.observe(element);
      // Before the core writes the arrangement, the newest More pick still
      // leads the saved priority list.
      railFolds.note(
        side,
        railRoom(readings, height, gap, header, layout.morePick ?? layout.panelOrder?.[0]),
      );
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(rail);
    const mutations = new MutationObserver((changes) => {
      if (changes.some((change) => change.target !== rail)) schedule();
    });
    mutations.observe(rail, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-side-panel-off-rail"],
    });
    measure();
    return () => {
      observer.disconnect();
      mutations.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [panels, layout, side]);
  const hidden = panels.filter((panel) => room.hidden.has(panel.id));
  return (
    <div data-rail={side} ref={root}>
      {side === "left" && <CreatePanelSlot />}
      {panels.map((panel) => (
        <PanelMount
          key={panel.id}
          panel={panel}
          theme={theme}
          folded={room.folded.has(panel.id)}
          overflow={room.hidden.has(panel.id)}
        />
      ))}
      {hidden.length > 0 && (
        <div data-rail-more="" data-window-region="panel">
          <RowMenu
            label={m.panelRailFolded()}
            word={m.panelRailMore({ count: formatNumber(hidden.length) })}
            items={hidden.map((panel) => ({
              id: panel.id,
              label: panel.title,
              detail: panelRail
                .get(panel.id)
                .summary?.map((part) => ("text" in part ? part.text : part.line))
                .join(" · "),
              onSelect: () => {
                railStore.promote(panel.id, knownArrangedPanels(pluginHost.sidePanels.list()));
                requestAnimationFrame(() =>
                  document
                    .querySelector<HTMLButtonElement>(
                      `[data-side-panel="${CSS.escape(panel.id)}"] header [data-side-panel-chevron]`,
                    )
                    ?.focus(),
                );
              },
            }))}
          />
          <span data-rail-more-titles="">{hidden.map((panel) => panel.title).join(" · ")}</span>
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            style={{ flexShrink: 0, marginInlineStart: "auto", color: "var(--fg-3)" }}
          >
            <path d="m9 6 6 6-6 6" />
          </svg>
        </div>
      )}
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

function PanelMount({
  panel,
  theme,
  folded,
  overflow,
}: {
  panel: SidePanelContribution;
  theme: FrameTheme;
  folded: boolean;
  overflow: boolean;
}) {
  const content = useSyncExternalStore(panel.source.subscribe, panel.source.get, panel.source.get);
  const running = panel.running ?? notRunning;
  const busy = useSyncExternalStore(running.subscribe, running.get, running.get) === true;
  const chosenCollapsed = usePanelCollapsed(panel.id);
  const collapsed = chosenCollapsed || folded;
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
    if (folded) railStore.expand(panel.id);
    else railStore.toggleCollapsed(panel.id);
  };
  // The header is the panel's handle (INF-2344): a press that travels
  // picks it up, ⌥ and an arrow on its controls moves it one place.
  const onHeaderPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    const section = event.currentTarget.closest<HTMLElement>("[data-side-panel]");
    if (!section) return;
    pressPanel(event.nativeEvent, {
      panelId: panel.id,
      handle: event.currentTarget,
      source: section,
      title: panel.title,
      targets: () => railTargets(panel.id),
      zones: railZones,
      drop: (move) =>
        railStore.move(panel.id, move, knownArrangedPanels(pluginHost.sidePanels.list())),
    });
  };
  const onHeaderKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const step = panelStepOf(event);
    if (!step) return;
    event.preventDefault();
    const moved = railStore.step(
      panel.id,
      step,
      knownArrangedPanels(pluginHost.sidePanels.list()),
      shownOnRail,
    );
    // The chevron is drawn again in its new place: focus follows it there.
    if (!moved) return;
    requestAnimationFrame(() => {
      const chevron = document.querySelector<HTMLButtonElement>(
        `[data-side-panel="${CSS.escape(panel.id)}"] header [data-side-panel-chevron]`,
      );
      if (chevron) focusWithRing(chevron);
    });
  };
  if (content === null) return null;
  return (
    <SidePanelChrome
      id={panel.id}
      onHeaderPointerDown={onHeaderPointerDown}
      onHeaderKeyDown={onHeaderKeyDown}
      moveKeys={PANEL_MOVE_KEYS}
      hidden={offRail || overflow}
      offRail={offRail}
      folded={folded}
      keepBody={speaks || folded || overflow}
      title={panel.title}
      attribution={panel.attribution}
      running={busy}
      status={panel.Status ? <panel.Status content={content} title={panel.title} /> : undefined}
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
            // Trimmed to its x-height, as the line's words are (FeedLine).
            textBox: "trim-both ex alphabetic",
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
