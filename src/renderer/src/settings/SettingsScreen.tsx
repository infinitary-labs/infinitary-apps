import type { ThisMac } from "@shared/devices";
import * as m from "@shared/i18n/messages.generated";
import type { CommandId } from "@shared/keyboard";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { useCommandKeys } from "../app/keyHints";
import { useShellStore } from "../app/store";
import { useRestLabel } from "../design";
import { hasShellPainted } from "../design/reveals";
import { sectionWaitsForUpdate, showsSection, updateThereWords } from "../devices/viewWords";
import type { SettingsSectionContribution } from "../plugins/contributions";
import { FrameMount } from "../plugins/frames/FrameMount";
import { orderSettingsSections, pluginHost, useContributions } from "../plugins/host";
import { HomeUpdateRow } from "./HomeUpdateRow";
import { SharingAsk } from "./SharingSection";
import "./settingsScreen.css";
import { SETTINGS_TOP_PAD_PX } from "./settingRows";

/**
 * Settings as a shell state (not a route). The tabs are the
 * `settings-section` registry in display order (docs/ui-plugins.md): the
 * app's own General, Appearance, Panels, Keyboard, Projects, Intelligence
 * and the rest, and gated Observe, arrive through the built-in manifest
 * like any other contribution. They stand in one column on the left of the
 * page, the shown section beside them (design skill
 * `components/core/SettingsTabs.prompt.md`).
 */

/**
 * Each section's own width, its side gutters included: the room it takes
 * beside the tab column, never more.
 */
const SECTION_WIDTH: Record<SettingsSectionContribution["width"], number> = {
  standard: 760,
  wide: 1080,
};

/** The tab column on the left (design skill `components/core/SettingsTabs.prompt.md`). */
const TAB_COLUMN_PX = 168;
const TAB_GAP_PX = 32;
/** The column's side gutters, each. */
const GUTTER_PX = 20;

/**
 * The page's column: the tab column, the room after it and the widest
 * section, the same width whichever tab is shown, so the tabs never move
 * when the section changes.
 */
export const SETTINGS_COLUMN_PX = TAB_COLUMN_PX + TAB_GAP_PX + SECTION_WIDTH.wide;

export function settingsColumnStyle() {
  return {
    width: SETTINGS_COLUMN_PX,
    maxWidth: "100%" as const,
    // Include the side gutters in the width cap, even when a section's
    // intrinsic size keeps this flex item from shrinking further.
    boxSizing: "border-box" as const,
    padding: `8px ${GUTTER_PX}px 48px`,
  };
}

/** The most a section takes beside the tabs: its own width less the gutters it no longer has. */
export function sectionMaxWidth(width: SettingsSectionContribution["width"] = "wide"): number {
  return SECTION_WIDTH[width] - GUTTER_PX * 2;
}

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

/** The sections this app shows (`showsSection`, docs/view.md). */
export function sectionsFor<T extends Pick<SettingsSectionContribution, "onAView">>(
  sections: readonly T[],
  thisMac: ThisMac | null,
): T[] {
  return sections.filter((section) => showsSection(thisMac, section));
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
  // the arrows move to the next tab in the column and open it, Home and End
  // to the ends.
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
        paddingTop: SETTINGS_TOP_PAD_PX,
        display: "flex",
        justifyContent: "center",
        // The column grows with its section rather than stretching to the
        // window, so a long section still ends on the column's bottom padding.
        alignItems: "flex-start",
        overflowY: "auto",
        // A scroll bar that takes room keeps its room whether or not this
        // section scrolls, so the column, the tabs and the section never move
        // or narrow when it comes and goes (docs/renderer.md, "Card body sizing").
        scrollbarGutter: "stable",
      }}
    >
      <div data-settings-column style={settingsColumnStyle()}>
        <SharingAsk />
        <div style={{ display: "flex", alignItems: "flex-start", gap: TAB_GAP_PX }}>
          <div
            ref={tabList}
            role="tablist"
            aria-label={m.settingsScreenSections()}
            aria-orientation="vertical"
            // One of the window's parts F6 moves between (app/regions.ts).
            data-window-region="settings-tabs"
            data-settings-tabs=""
            onKeyDown={onTabKey}
            style={{ flex: `0 0 ${TAB_COLUMN_PX}px`, width: TAB_COLUMN_PX }}
          >
            {offered.map((section) => (
              <SettingsTab
                key={section.id}
                id={section.id}
                domId={tabDomId(section.id)}
                label={section.label}
                selected={tab?.id === section.id}
                controls={panelDomId}
                onPick={() => setTabId(section.id)}
              />
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
              style={{ flex: "1 1 0", minWidth: 0, maxWidth: sectionMaxWidth(tab.width) }}
            >
              {tab.frame ? (
                <FrameSection key={tab.id} section={tab} />
              ) : sectionWaitsForUpdate(thisMac, tab) ? (
                <div key={tab.id} style={{ display: "grid", gap: "var(--space-3)" }}>
                  <p
                    data-settings-waits-for-update=""
                    style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)", margin: 0 }}
                  >
                    {updateThereWords(thisMac)}
                  </p>
                  {/* The update that ends the wait, started from here where the first mate answers it. */}
                  {thisMac.homeUpdates && <HomeUpdateRow mac={thisMac} />}
                </div>
              ) : (
                <tab.Component key={tab.id} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** The command that opens each section of its own, whose key its tab names. */
const SECTION_COMMANDS: Readonly<Record<string, CommandId>> = {
  keyboard: "settings.keyboard",
  panels: "settings.panels",
  runbooks: "settings.runbooks",
  usage: "settings.usage",
  automation: "settings.automation",
  integrations: "settings.integrations",
};

/**
 * One section's tab. A section a command opens names that command's key in
 * the app's label on rest, once the command has one; its words alone need
 * no label, since the tab shows them (docs/keyboard.md, "Key hints").
 */
function SettingsTab({
  id,
  domId,
  label,
  selected,
  controls,
  onPick,
}: {
  id: string;
  domId: string;
  label: string;
  selected: boolean;
  controls: string;
  onPick: () => void;
}) {
  const {
    keys,
    "aria-keyshortcuts": ariaKeys,
    "data-key-command": keyCommand,
  } = useCommandKeys(SECTION_COMMANDS[id] ?? null);
  const rest = useRestLabel(keys ? label : undefined, { keys });
  return (
    <button
      {...rest}
      id={domId}
      type="button"
      role="tab"
      data-settings-tab={id}
      aria-selected={selected}
      aria-controls={controls}
      aria-keyshortcuts={ariaKeys}
      data-key-command={keyCommand}
      tabIndex={selected ? 0 : -1}
      onClick={onPick}
    >
      <span data-settings-tab-label="">{label}</span>
    </button>
  );
}

/**
 * Where an arrow, Home or End moves among `count` tabs from `at`, or null
 * for a key that moves nothing. The tabs stand in a column, so ↓ and ↑ go
 * to the next and previous; → and ← do the same, as they did when the tabs
 * stood in a row. The arrows wrap around, as tabs do.
 */
export function tabStep(key: string, at: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowDown":
    case "ArrowRight":
      return (at + 1) % count;
    case "ArrowUp":
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
 * section's height beside the tab column (top bar 64 + column pad 8 +
 * bottom pad 48 = 120), with the plugin's declared reads as its whole
 * data surface and no actions - a settings frame is display-only.
 */
function FrameSection({ section }: { section: SettingsSectionContribution }) {
  const theme = useShellStore((s) => s.theme);
  if (!section.frame) return null;
  return (
    <div data-settings-frame={section.id} style={{ height: "calc(100vh - 120px)", minHeight: 480 }}>
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
