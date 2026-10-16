import type { SidePanelSize } from "@shared/plugins/manifest";
import type React from "react";
import { IconButton, PanelExpandChevron, StatusDot } from "../design";

export type SidePanelChromeProps = {
  id: string;
  title: string;
  /** The contributing plugin's name; `null` for the host's own panels. */
  attribution: string | null;
  size: SidePanelSize;
  /** Reads newest last: a body squeezed below its content shows the end. */
  newestLast?: boolean;
  placementY: "top" | "bottom";
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Work in flight on this panel: a busy dot beside the title. */
  running?: boolean;
  /** Header-inline summary, shown only while collapsed. */
  compact?: React.ReactNode;
  /**
   * The summary is a line that takes the title's place while it shows
   * (`PanelSummaryLine`): the title steps aside, the section keeps its name.
   */
  compactReplacesTitle?: boolean;
  headerAction?: React.ReactNode;
  /** A control beside the chevron in both states, after the header action and the compact summary. */
  headerTool?: React.ReactNode;
  /**
   * Off its rail while its own code says so: drawn nowhere, its body still
   * mounted so its page runs on (a panel whose presence is its code's).
   */
  hidden?: boolean;
  /** The body stays mounted, out of sight, while collapsed: its page keeps running. */
  keepBody?: boolean;
  children?: React.ReactNode;
};

/**
 * The host-owned frame around a side panel (D5 rule 4): title, attribution,
 * and collapse are rendered here from manifest data; the plugin's body is
 * placed inside `[data-side-panel-body]` and can style only that region.
 * Sizing rules - the rail width, and how a `fill` panel takes the rail
 * height its siblings leave - live in design/styles.css next to the rail's,
 * keyed on the data attributes set here.
 */
export function SidePanelChrome({
  id,
  title,
  attribution,
  size,
  newestLast = false,
  placementY,
  collapsed,
  onToggleCollapsed,
  running = false,
  compact,
  compactReplacesTitle = false,
  headerAction,
  headerTool,
  hidden = false,
  keepBody = false,
  children,
}: SidePanelChromeProps) {
  const showCompact = collapsed && compact != null;
  const showTitle = !(showCompact && compactReplacesTitle);
  return (
    <section
      hidden={hidden}
      data-side-panel={id}
      data-side-panel-size={size}
      data-side-panel-newest-last={newestLast ? "" : undefined}
      data-side-panel-placement-y={placementY}
      data-side-panel-collapsed={collapsed ? "" : undefined}
      aria-label={title}
      // One of the window's parts F6 moves between (app/regions.ts).
      data-window-region="panel"
      style={{
        background: "transparent",
        borderRadius: "var(--radius-l)",
        overflow: "hidden",
        display: hidden ? "none" : "flex",
        flexDirection: "column",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          padding: "var(--space-2) var(--space-2) var(--space-2) var(--space-4)",
          flexShrink: 0,
        }}
      >
        {showTitle && (
          <span
            style={{
              fontSize: "var(--text-xs)",
              fontWeight: 500,
              letterSpacing: "var(--tracking-label)",
              textTransform: "uppercase",
              color: "var(--fg-2)",
              whiteSpace: "nowrap",
              flex: showCompact ? undefined : attribution === null ? 1 : undefined,
            }}
          >
            {title}
          </span>
        )}
        {!collapsed && headerAction}
        {running && (
          <span data-side-panel-running="" style={{ display: "inline-flex", flexShrink: 0 }}>
            <StatusDot tone="busy" label="Still working on this" />
          </span>
        )}
        {attribution !== null && (
          <span
            data-side-panel-attribution=""
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              color: "var(--fg-3)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              minWidth: 0,
              // Collapsed with a summary, the maker's name stays beside the
              // title at its own width, and the summary takes the room left.
              flex: showCompact ? "0 1 auto" : 1,
            }}
          >
            {attribution}
          </span>
        )}
        {showCompact && (
          <span
            data-side-panel-compact=""
            style={
              compactReplacesTitle
                ? {
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--space-2)",
                    minWidth: 0,
                    flex: 1,
                  }
                : {
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-xs)",
                    color: "var(--fg-3)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    minWidth: 0,
                    flex: 1,
                    textAlign: "right",
                  }
            }
          >
            {compact}
          </span>
        )}
        {headerTool}
        <IconButton
          label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
          size={24}
          aria-expanded={!collapsed}
          onClick={onToggleCollapsed}
          style={{ flexShrink: 0 }}
        >
          <PanelExpandChevron collapsed={collapsed} />
        </IconButton>
      </header>
      {(!collapsed || keepBody) && (
        <div
          data-side-panel-body=""
          hidden={collapsed}
          style={{
            // The body lays out from its end, so a body given less room than its
            // content scrolls to the end and the newest line stays in sight.
            ...(newestLast && !collapsed
              ? { display: "flex", flexDirection: "column-reverse" }
              : {}),
            ...(collapsed ? { display: "none" } : {}),
            padding: "0 var(--space-4) var(--space-4)",
            fontSize: "var(--text-sm)",
            lineHeight: "var(--leading-body)",
            color: "var(--fg-2)",
            minHeight: 0,
            overflowY: "auto",
            // Auto-height content can shrink with a scrollbar's width until
            // overflow disappears, then widen and grow again. Reserve that
            // width at the outer surface; fill panels keep their own sizing.
            scrollbarGutter: size === "content" ? "stable" : undefined,
          }}
        >
          {children}
        </div>
      )}
    </section>
  );
}
