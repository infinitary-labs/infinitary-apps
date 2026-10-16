import type {
  PanelKnowledgeConcepts,
  PanelKnowledgeDirections,
  PanelKnowledgeFindings,
} from "@infinitary/contracts";
import { Button, focusWithRing } from "@infinitary/ui";
import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useRef } from "react";
import type { Filter, Selection } from "./place";
import { counted, directionOrigin, rangeOf, STANDING_WORDS, standingWarns, whenOf } from "./words";

/**
 * The knowledge browser's two lists (the design skill's
 * `components/knowledge/KnowledgeBrowser`, "Concepts" and "Findings"):
 * twenty rows a page, each a pointing gesture that opens the inspector on
 * what it names. A list is one Tab stop: ↑ ↓ Home End move and select, and
 * Enter opens; Previous and Next turn its page.
 */

const PAGE = 20;

type ReadyConcepts = Extract<PanelKnowledgeConcepts, { state: "ready" }>;
type ReadyFindings = Extract<PanelKnowledgeFindings, { state: "ready" }>;

/** A list's rows as one Tab stop, the arrows walking them. */
function useRows(
  ids: readonly string[],
  selected: string | null,
  pick: (id: string, open: boolean, byKey: boolean) => void,
) {
  const listRef = useRef<HTMLDivElement>(null);
  const stop = ids.includes(selected ?? "") ? selected : (ids[0] ?? null);
  const onKey = (event: ReactKeyboardEvent<HTMLElement>, index: number) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Enter") {
      event.preventDefault();
      const id = ids[index];
      if (id) pick(id, true, true);
      return;
    }
    const next =
      event.key === "ArrowDown"
        ? Math.min(ids.length - 1, index + 1)
        : event.key === "ArrowUp"
          ? Math.max(0, index - 1)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? ids.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    const id = ids[next];
    if (!id) return;
    pick(id, false, true);
    // The row is drawn already: focus moves with the key, before the next one.
    const element = listRef.current?.querySelector<HTMLElement>(
      `[data-knowledge-row="${CSS.escape(id)}"]`,
    );
    if (element) focusWithRing(element);
  };
  return { listRef, stop, onKey };
}

/** Previous and Next with the range between them: the same above and below a list. */
export function Pager({
  page,
  shown,
  total,
  onPage,
  where,
}: {
  page: number;
  shown: number;
  total: number;
  onPage: (page: number) => void;
  where: "head" | "foot";
}) {
  if (total <= PAGE) return null;
  const last = Math.ceil(total / PAGE) - 1;
  return (
    <div className="fm-kb-pager" data-knowledge-pager={where}>
      <span className="fm-kb-count">{rangeOf(page, PAGE, shown, total)}</span>
      <Button variant="secondary" size="sm" disabled={page <= 0} onClick={() => onPage(page - 1)}>
        Previous
      </Button>
      <Button
        variant="secondary"
        size="sm"
        disabled={page >= last}
        onClick={() => onPage(page + 1)}
      >
        Next
      </Button>
    </div>
  );
}

export type ConceptListProps = {
  read: ReadyConcepts;
  query: string;
  selection: Selection | null;
  onPick: (selection: Selection, node: string | null, open: boolean, byKey: boolean) => void;
  onPage: (page: number) => void;
};

export function ConceptList({ read, query, selection, onPick, onPage }: ConceptListProps) {
  const ids = read.rows.map((row) => row.id);
  const selected = selection?.kind === "concept" ? selection.id : null;
  const { listRef, stop, onKey } = useRows(ids, selected, (id, open, byKey) =>
    onPick({ kind: "concept", id }, id, open, byKey),
  );
  const head = query.trim()
    ? `${counted(read.total, "concept matches", "concepts match")}`
    : counted(read.total, "concept", "concepts");
  return (
    <div className="fm-kb-list" data-knowledge-list="concepts">
      <div className="fm-kb-pane-head">
        <span className="fm-kb-count" data-knowledge-count="">
          {head}
        </span>
        <span className="fm-kb-spacer" />
        <Pager
          page={read.page}
          shown={read.rows.length}
          total={read.total}
          onPage={onPage}
          where="head"
        />
      </div>
      {read.rows.length === 0 ? (
        <p className="fm-kb-quiet">
          {query.trim()
            ? `Nothing here matches "${query.trim()}".`
            : "No concept is recorded here yet."}
        </p>
      ) : (
        <div ref={listRef} className="fm-kb-rows" role="listbox" aria-label="Concepts">
          <div className="fm-kb-columns" aria-hidden="true">
            <span>Concept</span>
            <span>Findings</span>
          </div>
          {read.rows.map((row, index) => (
            <div
              key={row.id}
              role="option"
              aria-selected={row.id === selected}
              tabIndex={row.id === stop ? 0 : -1}
              className="fm-kb-row fm-kb-row-wide"
              data-knowledge-row={row.id}
              onClick={() => onPick({ kind: "concept", id: row.id }, row.id, true, false)}
              onKeyDown={(event) => onKey(event, index)}
            >
              <span className="fm-kb-row-main">
                <span className="fm-kb-row-name">{row.title}</span>
                <span className="fm-kb-row-detail">{row.explanation}</span>
              </span>
              <span className="fm-kb-count">{counted(row.findings, "finding", "findings")}</span>
            </div>
          ))}
        </div>
      )}
      <Pager
        page={read.page}
        shown={read.rows.length}
        total={read.total}
        onPage={onPage}
        where="foot"
      />
    </div>
  );
}

const FILTER_WORDS: Record<Filter, string> = {
  all: "All findings",
  recheck: "Needs rechecking",
  differing: "Differing evidence",
};

export type FindingListProps = {
  read: ReadyFindings;
  query: string;
  filter: Filter;
  onFilter: (filter: Filter) => void;
  selection: Selection | null;
  onPick: (selection: Selection, node: string | null, open: boolean, byKey: boolean) => void;
  onPage: (page: number) => void;
};

export function FindingList({
  read,
  query,
  filter,
  onFilter,
  selection,
  onPick,
  onPage,
}: FindingListProps) {
  const ids = read.rows.map((row) => row.id);
  const selected = selection?.kind === "finding" ? selection.id : null;
  const nodeOf = (id: string) => read.rows.find((row) => row.id === id)?.about[0]?.id ?? null;
  const { listRef, stop, onKey } = useRows(ids, selected, (id, open, byKey) =>
    onPick({ kind: "finding", id }, nodeOf(id), open, byKey),
  );
  const empty: ReactNode = query.trim()
    ? `Nothing here matches "${query.trim()}".`
    : filter === "recheck"
      ? "No finding here cites a source that changed since it was kept."
      : filter === "differing"
        ? "No finding here has differing evidence."
        : "No finding is recorded here yet.";
  return (
    <div className="fm-kb-list" data-knowledge-list="findings">
      <div className="fm-kb-pane-head">
        <span className="fm-kb-count" data-knowledge-count="">
          {counted(read.total, "finding", "findings")}
        </span>
        <span className="fm-kb-spacer" />
        <label className="fm-kb-field">
          <span>Show</span>
          <select
            className="fm-kb-select"
            value={filter}
            data-knowledge-filter=""
            onChange={(event) => onFilter(event.target.value as Filter)}
          >
            {(Object.keys(FILTER_WORDS) as Filter[]).map((name) => (
              <option key={name} value={name}>
                {FILTER_WORDS[name]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Pager
        page={read.page}
        shown={read.rows.length}
        total={read.total}
        onPage={onPage}
        where="head"
      />
      {read.rows.length === 0 ? (
        <p className="fm-kb-quiet">{empty}</p>
      ) : (
        <div ref={listRef} className="fm-kb-rows" role="listbox" aria-label="Findings">
          <div className="fm-kb-columns" aria-hidden="true">
            <span>Finding and context</span>
            <span>Evidence and attention</span>
          </div>
          {read.rows.map((row, index) => (
            <div
              key={row.id}
              role="option"
              aria-selected={row.id === selected}
              tabIndex={row.id === stop ? 0 : -1}
              className="fm-kb-row fm-kb-row-wide"
              data-knowledge-row={row.id}
              data-knowledge-standing={row.standing}
              onClick={() => onPick({ kind: "finding", id: row.id }, nodeOf(row.id), true, false)}
              onKeyDown={(event) => onKey(event, index)}
            >
              <span className="fm-kb-row-main">
                <span className="fm-kb-row-name">{row.statement}</span>
                <span className="fm-kb-row-detail">
                  {row.conditions || row.about.map((concept) => concept.title).join(", ")}
                </span>
              </span>
              <span className="fm-kb-row-side">
                <span
                  className="fm-kb-chip"
                  data-knowledge-standing={row.standing}
                  data-warn={standingWarns(row.standing) ? "" : undefined}
                >
                  {STANDING_WORDS[row.standing]}
                </span>
                <span className="fm-kb-row-detail">
                  {counted(row.sources, "source", "sources")}
                  {row.checks > 0 ? ` · ${counted(row.checks, "check", "checks")}` : ""}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
      <Pager
        page={read.page}
        shown={read.rows.length}
        total={read.total}
        onPage={onPage}
        where="foot"
      />
    </div>
  );
}

export function DirectionList({
  read,
  selection,
  onPick,
  onPage,
}: {
  read: Extract<PanelKnowledgeDirections, { state: "ready" }>;
  selection: Selection | null;
  onPick: ConceptListProps["onPick"];
  onPage: (page: number) => void;
}) {
  const selected = selection?.kind === "direction" ? selection.id : null;
  const { listRef, stop, onKey } = useRows(
    read.rows.map((row) => row.id),
    selected,
    (id, open, byKey) => onPick({ kind: "direction", id }, null, open, byKey),
  );
  return (
    <div className="fm-kb-list" data-knowledge-list="directions">
      <div className="fm-kb-pane-head">
        <span className="fm-kb-count">{counted(read.total, "direction", "directions")}</span>
      </div>
      <p className="fm-kb-quiet">
        Knowledge supplies these directions on every turn. Reading them changes nothing and grants
        no permission.
      </p>
      <Pager
        page={read.page}
        shown={read.rows.length}
        total={read.total}
        onPage={onPage}
        where="head"
      />
      {read.rows.length === 0 ? (
        <p className="fm-kb-quiet">No direction matches this view.</p>
      ) : (
        <div ref={listRef} className="fm-kb-rows" role="listbox" aria-label="Directions">
          {read.rows.map((row, index) => (
            <div
              key={row.id}
              role="option"
              aria-selected={selected === row.id}
              tabIndex={stop === row.id ? 0 : -1}
              className="fm-kb-row"
              data-knowledge-row={row.id}
              onClick={() => onPick({ kind: "direction", id: row.id }, null, true, false)}
              onKeyDown={(event) => onKey(event, index)}
            >
              <span className="fm-kb-row-main">
                <span className="fm-kb-row-name">{row.text}</span>
                <span className="fm-kb-row-detail">
                  {row.scopeName} · {directionOrigin(row.origin)} ·{" "}
                  {row.authority === "instruction" ? "Instruction" : "Advice"}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
      <Pager
        page={read.page}
        shown={read.rows.length}
        total={read.total}
        onPage={onPage}
        where="foot"
      />
    </div>
  );
}
