import type {
  PanelKnowledgeCollections,
  PanelKnowledgeDirectionRow,
  PanelKnowledgeDirections,
  PanelProps,
} from "@infinitary/contracts";
import { Empty, focusWithRing, useOverflowTitle, useRestLabel } from "@infinitary/ui";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from "react";
import styles from "./panel.css";
import { counted, UNREADABLE_SUMMARY } from "./words";

/** Accepted direction-first rail; the host supplies its one Knowledge heading. */
export default function KnowledgePanel({ reads, cards, rail, asks }: PanelProps) {
  const [collections, setCollections] = useState<PanelKnowledgeCollections | null>(null);
  const [directions, setDirections] = useState<PanelKnowledgeDirections | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [stop, setStop] = useState<string | null>(null);
  useEffect(() => reads.subscribe("knowledge.collections", setCollections), [reads]);
  useEffect(
    () => reads.subscribe("knowledge.directions", { scope: "all" }, setDirections),
    [reads],
  );

  const unavailable =
    collections?.state === "unavailable"
      ? collections
      : directions?.state === "unavailable"
        ? directions
        : null;
  const concepts =
    collections?.state === "ready"
      ? (collections.collections.find((item) => item.private)?.concepts ?? 0)
      : 0;
  const findings =
    collections?.state === "ready"
      ? (collections.collections.find((item) => item.private)?.findings ?? 0)
      : 0;
  const total = directions?.state === "ready" ? directions.total : 0;
  const held = directions?.state === "ready" ? directions.rows.slice(0, 4) : [];
  const hasGraph = concepts + findings > 0;
  const hasSomething = total > 0 || hasGraph;
  useEffect(() => {
    if (!rail || !collections || !directions) return;
    rail.show(Boolean(unavailable) || hasSomething, "Nothing is recorded yet");
    // A short part beside the title, never a line in its place. A rail
    // wide holds the title and one count: directions lead, concepts stand
    // in while there are none.
    rail.summarize(
      unavailable
        ? [{ text: UNREADABLE_SUMMARY }]
        : total
          ? [{ text: counted(total, "direction", "directions") }]
          : hasGraph
            ? [{ text: counted(concepts, "concept", "concepts") }]
            : null,
    );
  }, [rail, collections, directions, unavailable, hasSomething, total, concepts, hasGraph]);

  const keys = [
    ...held.map((row) => `direction:${row.id}`),
    ...(total ? ["directions"] : []),
    ...(hasGraph ? ["graph"] : []),
  ];
  const current = stop && keys.includes(stop) ? stop : keys[0];
  const open = (tab: "directions" | "graph", direction?: string) => {
    void cards
      .emit({
        id: "browser",
        view: "browser",
        title: "Knowledge",
        width: "wide",
        height: "fill",
        data: {
          tab,
          scope: "all",
          ...(direction ? { direction } : {}),
          focus: direction ? "inspector" : "pane",
        },
      })
      .catch(() => {});
  };
  useEffect(
    () =>
      asks.onFocus(() => {
        const row = listRef.current?.querySelector<HTMLElement>('[tabindex="0"]');
        if (row) focusWithRing(row);
      }),
    [asks],
  );
  const onKey = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return;
    const at = keys.indexOf(current ?? "");
    const next =
      event.key === "ArrowDown"
        ? Math.min(keys.length - 1, at + 1)
        : event.key === "ArrowUp"
          ? Math.max(0, at - 1)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? keys.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    const key = keys[next];
    if (!key) return;
    setStop(key);
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-knowledge-stop="${CSS.escape(key)}"]`,
    );
    if (row) focusWithRing(row);
  };
  return (
    <div className="fm-knowledge-panel" data-knowledge-panel="">
      <style>{styles}</style>
      {unavailable ? (
        <p className="fm-knowledge-panel-said" data-knowledge-unavailable="">
          {unavailable.reason}
        </p>
      ) : !hasSomething ? (
        <Empty>Tell your first mate about yourself or share an article you want to keep.</Empty>
      ) : (
        <div ref={listRef} className="fm-knowledge-panel-list">
          {held.map((row) => (
            <DirectionLine
              key={row.id}
              row={row}
              tabIndex={current === `direction:${row.id}` ? 0 : -1}
              onKeyDown={onKey}
              onFocus={() => setStop(`direction:${row.id}`)}
              onClick={() => open("directions", row.id)}
            />
          ))}
          <div className="fm-knowledge-panel-links">
            {total > 0 ? (
              <button
                type="button"
                data-knowledge-stop="directions"
                data-knowledge-open="directions"
                tabIndex={current === "directions" ? 0 : -1}
                onFocus={() => setStop("directions")}
                onKeyDown={onKey}
                onClick={() => open("directions")}
              >
                All {counted(total, "direction", "directions")}
              </button>
            ) : null}
            {hasGraph ? (
              <button
                type="button"
                data-knowledge-stop="graph"
                data-knowledge-open="graph"
                tabIndex={current === "graph" ? 0 : -1}
                onFocus={() => setStop("graph")}
                onKeyDown={onKey}
                onClick={() => open("graph")}
              >
                Graph · {counted(concepts, "concept", "concepts")}
              </button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

function DirectionLine({
  row,
  tabIndex,
  onFocus,
  onKeyDown,
  onClick,
}: {
  row: PanelKnowledgeDirectionRow;
  tabIndex: number;
  onFocus: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  onClick: () => void;
}) {
  const fit = useOverflowTitle(row.text);
  const rest = useRestLabel(fit.title, { fact: true });
  return (
    <button
      {...rest}
      type="button"
      className="fm-knowledge-panel-row"
      data-knowledge-stop={`direction:${row.id}`}
      data-knowledge-direction={row.id}
      tabIndex={tabIndex}
      aria-label={`${row.text}${row.scope !== "captain" ? ` · ${row.scopeName}` : ""} · Open Knowledge`}
      onFocus={(event) => {
        rest.onFocus(event);
        onFocus();
      }}
      onKeyDown={(event) => {
        rest.onKeyDown(event);
        onKeyDown(event);
      }}
      onClick={onClick}
    >
      <span ref={fit.ref} className="fm-knowledge-panel-name">
        {row.text}
      </span>
      {row.scope !== "captain" ? (
        <span className="fm-knowledge-panel-tag">{row.scopeName}</span>
      ) : null}
    </button>
  );
}
