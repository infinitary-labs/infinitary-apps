import { chordLabel } from "@shared/keyboard";
import {
  arrangePanels,
  defaultArrangement,
  RAIL_SLOTS,
  sameArrangement,
} from "@shared/panelArrangement";
import type { RailSide, RailY } from "@shared/plugins/manifest";
import { isPanelHidden } from "@shared/preferences";
import { builtinSurface } from "@shared/surfaces";
import type React from "react";
import { useEffect, useReducer, useState } from "react";
import { Button, focusWithRing, KeyCap, MicroLabel, Switch } from "../design";
import { thisDesktop } from "../design/core/desktop";
import type { SidePanelContribution } from "../plugins/contributions";
import { knownArrangedPanels, pluginHost, useContributions } from "../plugins/host";
import {
  columnTargets,
  type DropGroup,
  type PanelDropTarget,
  pressPanel,
} from "../plugins/panelDrag";
import { PANEL_MOVE_KEYS, panelStepOf } from "../plugins/panelMoveKeys";
import { panelRail } from "../plugins/panelRail";
import { railFolds } from "../plugins/railFolds";
import { railStore, useRailLayout } from "../plugins/railStore";
import {
  CONFIRM_RESET_PANELS,
  GROUP_WORDS,
  NO_PANELS,
  PANEL_STATE_WORDS,
  PANELS_INTRO,
  type PanelRowFacts,
  panelGroups,
  panelRowState,
  RAIL_WORDS,
  RESET_PANELS,
  rowStep,
} from "./panelsWords";
import { ROW_GAP, SECTION_GAP, SectionLabel } from "./settingRows";

/**
 * Settings → Panels (INF-2344; design skill
 * `components/core/PanelsSettings.prompt.md`): the saved arrangement as a
 * list, each rail's top and bottom groups in order, every panel in them,
 * hidden ones included, and the app's own panels still waiting on their
 * gate. A row moves by dragging or with ⌥ and an arrow, Space shows or
 * hides it, Enter opens or collapses it; Reset to defaults puts every panel
 * back where it asks to be. Every change is the rails' own (`railStore`), so
 * the rails and this list never disagree.
 */

const SIDES: readonly RailSide[] = ["left", "right"];
const ENDS: readonly RailY[] = ["top", "bottom"];

/** Re-renders on every record a row's state reads: the rails' room, what each panel said, and its data. */
function useRowFacts(panels: readonly SidePanelContribution[]): void {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const offs = [
      panelRail.subscribe(bump),
      railFolds.subscribe(bump),
      ...panels.map((panel) => panel.source.subscribe(bump)),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [panels]);
}

/** Whether this build keeps knowledge, so a shut Knowledge gate is worth a row. */
function useKnowledgeKept(): boolean {
  const [kept, setKept] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void window.infinitary?.knowledge
      ?.enabled()
      .then(({ enabled }) => {
        if (!cancelled) setKept(enabled);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return kept;
}

/** The places the tab's groups offer a held row, read from the list as drawn now. */
function listTargets(panelId: string): PanelDropTarget[] {
  return SIDES.flatMap((side) => {
    const block = document.querySelector<HTMLElement>(`[data-panels-rail="${side}"]`);
    if (!block) return [];
    const area = block.getBoundingClientRect();
    const groups = ENDS.map((y): DropGroup & { box: DOMRect | undefined } => {
      const list = block.querySelector<HTMLElement>(`[data-panels-group="${side}:${y}"]`);
      const box = list?.getBoundingClientRect();
      const items = list
        ? [...list.querySelectorAll<HTMLElement>("[data-panels-row]")].map((row) => {
            const at = row.getBoundingClientRect();
            return {
              id: row.getAttribute("data-panels-row") ?? "",
              top: at.top,
              bottom: at.bottom,
            };
          })
        : [];
      return {
        slot: { x: side, y },
        items,
        box,
        empty: {
          y: box ? (box.top + box.bottom) / 2 : area.top,
          ...(box
            ? { zone: { left: box.left, top: box.top, right: box.right, bottom: box.bottom } }
            : {}),
        },
      };
    });
    const across = groups.find((group) => group.box)?.box;
    return columnTargets(panelId, groups, {
      area: { left: area.left, top: area.top, right: area.right, bottom: area.bottom },
      left: across?.left ?? area.left,
      width: across?.width ?? area.width,
      gap: 0,
    });
  });
}

function focusRow(id: string): void {
  requestAnimationFrame(() => {
    const row = document.querySelector<HTMLElement>(`[data-panels-row="${CSS.escape(id)}"]`);
    if (row) focusWithRing(row);
  });
}

export function PanelsTab() {
  const registered = useContributions(pluginHost.sidePanels);
  const layout = useRailLayout();
  useRowFacts(registered);
  const knowledgeKept = useKnowledgeKept();
  const [focused, setFocused] = useState<string | null>(null);
  const [resetArmed, setResetArmed] = useState(false);

  const byId = new Map(registered.map((panel) => [panel.id, panel]));
  const known = knownArrangedPanels(registered);
  const waiting = (id: string): PanelRowFacts["present"] | null => {
    if (byId.has(id)) return true;
    if (id === "automation") return "automation";
    if (id === "knowledge" && knowledgeKept) return "knowledge";
    return null;
  };
  const listed = (id: string) => waiting(id) !== null;
  const arrangement = arrangePanels(layout, known);
  const groups = panelGroups(arrangement, listed);
  const order = groups.flatMap((group) => group.ids);
  const current = focused !== null && order.includes(focused) ? focused : (order[0] ?? null);

  const knownIds = new Set(known.map((panel) => panel.id));
  const onlyKnown = (ids: readonly string[]) => ids.filter((id) => knownIds.has(id));
  const reduced = (from: typeof arrangement) => ({
    left: { top: onlyKnown(from.left.top), bottom: onlyKnown(from.left.bottom) },
    right: { top: onlyKnown(from.right.top), bottom: onlyKnown(from.right.bottom) },
  });
  const atDefaults = sameArrangement(reduced(arrangement), defaultArrangement(known));

  const titleOf = (id: string) => byId.get(id)?.title ?? builtinSurface(id)?.title ?? id;
  const stateOf = (id: string) => {
    const panel = byId.get(id);
    const side = RAIL_SLOTS.find((slot) => arrangement[slot.x][slot.y].includes(id))?.x ?? "left";
    const said = panelRail.get(id);
    return panelRowState({
      hidden: isPanelHidden(layout, id),
      present: waiting(id) ?? true,
      empty:
        panel !== undefined &&
        (panel.source.get() === null || (panel.rail?.decides === true && said.shown !== true)),
      gathered: railFolds.of(side).hidden.has(id),
      collapsed: railStore.isCollapsed(id),
    });
  };

  const onRowKey = (event: React.KeyboardEvent<HTMLLIElement>, id: string) => {
    const step = panelStepOf(event);
    if (step) {
      event.preventDefault();
      if (railStore.step(id, step, known, listed)) focusRow(id);
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === " ") {
      event.preventDefault();
      if (isPanelHidden(layout, id)) railStore.show(id);
      else railStore.hide(id);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      railStore.toggleCollapsed(id);
      return;
    }
    const next = rowStep(event.key, order, id);
    if (next === null) return;
    event.preventDefault();
    setFocused(next);
    focusRow(next);
  };

  const onRowPress = (event: React.PointerEvent<HTMLLIElement>, id: string) => {
    pressPanel(event.nativeEvent, {
      panelId: id,
      handle: event.currentTarget,
      source: event.currentTarget,
      title: titleOf(id),
      targets: () => listTargets(id),
      drop: (move) => {
        railStore.move(id, move, known);
        setFocused(id);
      },
    });
  };

  const keys = thisDesktop().keys;
  const alt = (key: string) => chordLabel({ key, alt: true }, keys);

  return (
    <div data-panels-settings="">
      <SectionLabel>Panels</SectionLabel>
      <p
        style={{
          margin: `0 0 ${ROW_GAP}`,
          fontSize: "var(--text-sm)",
          color: "var(--fg-3)",
        }}
      >
        {PANELS_INTRO}
      </p>
      <div
        data-panels-rails=""
        style={{
          display: "grid",
          gap: "var(--space-6)",
        }}
      >
        {SIDES.map((side) => (
          <section
            key={side}
            data-panels-rail={side}
            aria-label={RAIL_WORDS[side]}
            style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}
          >
            <MicroLabel>{RAIL_WORDS[side]}</MicroLabel>
            {ENDS.map((y) => {
              const group = groups.find((one) => one.slot.x === side && one.slot.y === y);
              const ids = group?.ids ?? [];
              return (
                <div
                  key={y}
                  style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}
                >
                  <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
                    {GROUP_WORDS[y]}
                  </span>
                  <ul
                    data-panels-group={`${side}:${y}`}
                    aria-label={`${RAIL_WORDS[side]}, ${GROUP_WORDS[y].toLowerCase()}`}
                    style={{
                      listStyle: "none",
                      margin: 0,
                      padding: 0,
                      background: "var(--bg-1)",
                      borderRadius: "var(--radius-m)",
                      overflow: "hidden",
                    }}
                  >
                    {ids.length === 0 && (
                      <li
                        data-panels-empty=""
                        style={{
                          height: 40,
                          display: "flex",
                          alignItems: "center",
                          padding: "0 var(--space-3)",
                          fontSize: "var(--text-sm)",
                          color: "var(--fg-3)",
                        }}
                      >
                        {NO_PANELS}
                      </li>
                    )}
                    {ids.map((id) => {
                      const state = stateOf(id);
                      const hidden = state === "hidden";
                      const title = titleOf(id);
                      const attribution = byId.get(id)?.attribution ?? null;
                      return (
                        <li
                          key={id}
                          data-panels-row={id}
                          data-panels-state={state}
                          tabIndex={id === current ? 0 : -1}
                          aria-label={`${title}, ${PANEL_STATE_WORDS[state]}`}
                          aria-keyshortcuts={`${PANEL_MOVE_KEYS} Space Enter`}
                          onFocus={() => setFocused(id)}
                          onKeyDown={(event) => onRowKey(event, id)}
                          onPointerDown={(event) => onRowPress(event, id)}
                          style={{
                            boxSizing: "border-box",
                            height: 40,
                            display: "flex",
                            alignItems: "center",
                            gap: "var(--space-3)",
                            padding: "var(--space-2) var(--space-3)",
                            cursor: "grab",
                            outlineOffset: -1,
                          }}
                        >
                          <svg
                            aria-hidden="true"
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            style={{ flexShrink: 0, color: "var(--fg-3)" }}
                          >
                            <circle cx="9" cy="5" r="1" />
                            <circle cx="9" cy="12" r="1" />
                            <circle cx="9" cy="19" r="1" />
                            <circle cx="15" cy="5" r="1" />
                            <circle cx="15" cy="12" r="1" />
                            <circle cx="15" cy="19" r="1" />
                          </svg>
                          <span
                            style={{
                              fontSize: "var(--text-base)",
                              fontWeight: 500,
                              color: hidden ? "var(--fg-3)" : "var(--fg-1)",
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              minWidth: 0,
                            }}
                          >
                            {title}
                          </span>
                          {attribution !== null && (
                            <span
                              style={{
                                fontFamily: "var(--font-mono)",
                                fontSize: "var(--text-xs)",
                                color: "var(--fg-3)",
                                whiteSpace: "nowrap",
                                flexShrink: 0,
                              }}
                            >
                              {attribution}
                            </span>
                          )}
                          <span
                            data-panels-state-words=""
                            style={{
                              marginInlineStart: "auto",
                              fontSize: "var(--text-sm)",
                              color: "var(--fg-3)",
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              minWidth: 0,
                              textAlign: "end",
                            }}
                          >
                            {PANEL_STATE_WORDS[state]}
                          </span>
                          <Switch
                            tabIndex={-1}
                            checked={!hidden}
                            aria-label={`Show ${title}`}
                            onChange={(show) => (show ? railStore.show(id) : railStore.hide(id))}
                          />
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </section>
        ))}
      </div>
      <p
        data-panels-keys=""
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "var(--space-1) var(--space-2)",
          margin: `${ROW_GAP} 0 0`,
          fontSize: "var(--text-xs)",
          color: "var(--fg-3)",
        }}
      >
        <KeyCap>{alt("ArrowUp")}</KeyCap>
        <KeyCap>{alt("ArrowDown")}</KeyCap>
        <span>move ·</span>
        <KeyCap>{alt("ArrowLeft")}</KeyCap>
        <KeyCap>{alt("ArrowRight")}</KeyCap>
        <span>other rail ·</span>
        <KeyCap>{chordLabel({ key: " " }, keys)}</KeyCap>
        <span>show or hide ·</span>
        <KeyCap>{chordLabel({ key: "Enter" }, keys)}</KeyCap>
        <span>open or collapse</span>
      </p>
      <div style={{ marginTop: SECTION_GAP }}>
        <Button
          variant={resetArmed ? "danger" : "ghost"}
          size="sm"
          data-panels-reset=""
          disabled={atDefaults && !resetArmed}
          onClick={() => {
            if (!resetArmed) {
              setResetArmed(true);
              return;
            }
            setResetArmed(false);
            railStore.resetArrangement(known);
          }}
          onBlur={() => setResetArmed(false)}
        >
          {resetArmed ? CONFIRM_RESET_PANELS : RESET_PANELS}
        </Button>
      </div>
    </div>
  );
}
