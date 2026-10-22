import type { ThisMac } from "@shared/devices";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { useShellStore } from "../app/store";
import { hasShellPainted } from "../design/reveals";
import { isView } from "../devices/viewWords";
import type { SettingsSectionContribution } from "../plugins/contributions";
import { FrameMount } from "../plugins/frames/FrameMount";
import { orderSettingsSections, pluginHost, useContributions } from "../plugins/host";
import { SharingAsk } from "./SharingSection";

/**
 * Settings as a shell state (not a route). The tabs are the
 * `settings-section` registry in display order (docs/ui-plugins.md): the
 * app's own General, Appearance, Keyboard, Projects, Intelligence, Usage,
 * Devices, and gated Observe sections arrive through the built-in
 * manifest like any other contribution.
 */

const COLUMN_WIDTH: Record<SettingsSectionContribution["width"], number> = {
  standard: 760,
  wide: 1080,
};

/** Intelligence's wide shell. */
export const SETTINGS_COLUMN_PX = COLUMN_WIDTH.wide;

export function settingsColumnStyle(width: SettingsSectionContribution["width"] = "wide") {
  return {
    width: COLUMN_WIDTH[width],
    maxWidth: "100%" as const,
    // Include the side gutters in the width cap, even when a section's
    // intrinsic size keeps this flex item from shrinking further.
    boxSizing: "border-box" as const,
    padding: "8px 20px 48px",
  };
}

/** Resolves each section's gate; sections without one are always offered. */
function useOfferedSections(sections: readonly SettingsSectionContribution[]) {
  const [gates, setGates] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let cancelled = false;
    for (const section of sections) {
      if (!section.enabled) continue;
      void Promise.resolve()
        .then(() => section.enabled?.() ?? true)
        .catch(() => false)
        .then((enabled) => {
          if (!cancelled) setGates((prev) => ({ ...prev, [section.id]: enabled }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [sections]);
  return orderSettingsSections(sections).filter(
    (section) => !section.enabled || gates[section.id] === true,
  );
}

/** On a Mac that controls another, only the sections it keeps (docs/view.md); otherwise all. */
export function sectionsFor<T extends Pick<SettingsSectionContribution, "onAView">>(
  sections: readonly T[],
  thisMac: ThisMac | null,
): T[] {
  return isView(thisMac) ? sections.filter((section) => section.onAView === true) : [...sections];
}

export function SettingsScreen() {
  const thisMac = useShellStore((s) => s.thisMac);
  const offered = sectionsFor(
    useOfferedSections(useContributions(pluginHost.settingsSections)),
    thisMac,
  );
  const requestedSection = useShellStore((s) => s.settingsSection);
  const [tabId, setTabId] = useState<string | null>(null);
  useEffect(() => {
    if (!requestedSection) return;
    setTabId(requestedSection);
    useShellStore.getState().clearSettingsSection();
  }, [requestedSection]);
  const previousTab = useRef<string | undefined>(undefined);
  const changed = useRef(hasShellPainted());
  const tab = offered.find((section) => section.id === tabId) ?? offered[0];
  if (previousTab.current !== undefined && previousTab.current !== tab?.id) changed.current = true;
  useEffect(() => {
    previousTab.current = tab?.id;
  }, [tab?.id]);
  const ids = useId();
  const tabDomId = (id: string) => `${ids}-tab-${id}`;
  const panelDomId = `${ids}-panel`;
  const tabList = useRef<HTMLDivElement>(null);
  // The tabs pattern (docs/keyboard.md, "Lists and Settings"): one Tab stop,
  // the arrows move to the next tab and open it, Home and End to the ends.
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || offered.length === 0) return;
    const at = Math.max(
      0,
      offered.findIndex((section) => section.id === tab?.id),
    );
    const next = tabStep(event.key, at, offered.length);
    if (next === null) return;
    event.preventDefault();
    const section = offered[next];
    if (!section) return;
    setTabId(section.id);
    tabList.current?.querySelector<HTMLElement>(`#${CSS.escape(tabDomId(section.id))}`)?.focus();
  };
  return (
    <div
      data-screen-label="Settings"
      style={{
        // The scroll region starts where the top bar ends (52px), so a row
        // never slides under the title; the column still begins at 64.
        position: "absolute",
        top: 52,
        right: 0,
        bottom: 0,
        left: 0,
        paddingTop: 12,
        display: "flex",
        justifyContent: "center",
        overflowY: "auto",
      }}
    >
      <div data-settings-column style={settingsColumnStyle(tab?.width ?? "wide")}>
        <SharingAsk />
        <div
          ref={tabList}
          role="tablist"
          aria-label="Settings sections"
          aria-orientation="horizontal"
          // One of the window's parts F6 moves between (app/regions.ts).
          data-window-region="settings-tabs"
          onKeyDown={onTabKey}
          style={{
            display: "flex",
            // A row too long for a narrow window wraps rather than scroll sideways.
            flexWrap: "wrap",
            gap: 4,
            marginBottom: 28,
            borderBottom: "1px solid var(--line-1)",
            paddingBottom: 0,
          }}
        >
          {offered.map((section) => (
            <button
              key={section.id}
              id={tabDomId(section.id)}
              type="button"
              role="tab"
              aria-selected={tab?.id === section.id}
              aria-controls={panelDomId}
              tabIndex={tab?.id === section.id ? 0 : -1}
              onClick={() => setTabId(section.id)}
              style={{
                background: "transparent",
                border: "none",
                cursor: "pointer",
                fontFamily: "var(--font-ui)",
                fontSize: "var(--text-base)",
                fontWeight: 500,
                color: tab?.id === section.id ? "var(--fg-1)" : "var(--fg-3)",
                padding: "10px 14px",
                transition: "color var(--dur-fast) var(--ease-out)",
                borderBottom:
                  tab?.id === section.id ? "2px solid var(--accent)" : "2px solid transparent",
                // The focus ring's corners; the chosen tab's line stays square under it.
                borderRadius: "var(--radius-s) var(--radius-s) 0 0",
                marginBottom: -1,
              }}
            >
              {section.label}
            </button>
          ))}
        </div>
        {tab && (
          <div
            key={tab.id}
            id={panelDomId}
            role="tabpanel"
            aria-labelledby={tabDomId(tab.id)}
            tabIndex={-1}
            data-settings-section={tab.id}
            // One of the window's parts F6 moves between (app/regions.ts).
            data-window-region="settings-section"
            data-in-place-reveal={changed.current ? "fade" : undefined}
          >
            {tab.frame ? (
              <FrameSection key={tab.id} section={tab} />
            ) : (
              <tab.Component key={tab.id} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Where an arrow, Home or End moves among `count` tabs from `at`, or null
 * for a key that moves nothing. The arrows wrap around, as tabs do.
 */
export function tabStep(key: string, at: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
      return (at + 1) % count;
    case "ArrowLeft":
      return (at - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/**
 * A Tier-2 section: its template mounted in the frame vehicle, filling the
 * column below the tab strip (top bar 64 + column pad 8 + tab strip 69 +
 * bottom pad 48 = 189), with the plugin's declared reads as its whole
 * data surface and no actions - a settings frame is display-only.
 */
function FrameSection({ section }: { section: SettingsSectionContribution }) {
  const theme = useShellStore((s) => s.theme);
  if (!section.frame) return null;
  return (
    <div data-settings-frame={section.id} style={{ height: "calc(100vh - 189px)", minHeight: 480 }}>
      <FrameMount
        title={section.label}
        template={section.frame}
        spec={{
          pluginId: section.pluginId,
          reads: pluginHost.declaredReads(section.pluginId),
          grant: pluginHost.grantOf(section.pluginId),
          actions: [],
          onAction: () => {},
        }}
        theme={theme}
        layout="fill"
      />
    </div>
  );
}
