import type {
  PanelKnowledgeCollections,
  PanelKnowledgeConcepts,
  PanelKnowledgeDirectionRead,
  PanelKnowledgeDirections,
  PanelKnowledgeEntryRead,
  PanelKnowledgeFindings,
  PanelKnowledgeGraph,
  PanelProps,
} from "@infinitary/contracts";
import { focusWithRing, usePanelTaskKeys } from "@infinitary/ui";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import styles from "../browser.css";
import { DirectionInspector } from "../directionInspector";
import type { Camera } from "../graph";
import { GraphView } from "../graphView";
import { Inspector, InspectorTaskKeysContext } from "../inspector";
import { ConceptList, DirectionList, FindingList } from "../lists";
import {
  askOf,
  entryIdOf,
  type Place,
  placeOf,
  type Section,
  type Selection,
  startOf,
  TABS,
  type Tab,
} from "../place";
import { askWords } from "../words";

/**
 * The knowledge browser (docs/knowledge.md, "The browser"; the design
 * skill's `components/knowledge/KnowledgeBrowser`): the Knowledge panel's
 * one card view, put up by its header's Open Knowledge, its command and its
 * rows, and drawn in its own page like any panel's card. Under the app's
 * title row: Find and Directions, Graph, Concepts and Findings tabs,
 * with a Project filter only on Directions and the selection and one
 * inspector beside them. It reads; it never writes.
 *
 * What it keeps while it pages - everything in `Place` - is the card's
 * kept place (`card.keep`); Hide lets it go. A key or a row that put it up
 * names where focus goes and, from a row, a collection; a card's reference
 * or a task record's Knowledge used row names an entry - at an earlier
 * revision too - which the inspector opens on: answered once per time the
 * card was put up (`card.revision`). Ask about this starts the captain's
 * next message (`point.draft`), and sends nothing.
 *
 * Under 720px of card it is one column: opening something puts the
 * inspector in the pane's place with Back. Escape leaves that, then clears
 * Find; an Escape it did not use hides the card.
 */

/** The width under which the inspector takes the pane's place instead of sitting beside it. */
const NARROW_PX = 720;

/** How long typing in Find waits before it reads. */
const FIND_WAIT_MS = 200;

const TAB_WORDS: Record<Tab, string> = {
  graph: "Graph",
  concepts: "Concepts",
  findings: "Findings",
  directions: "Directions",
};

/** A read held while its arguments stay the same: a new key lets the last value go. */
function useRead<T>(
  key: string | null,
  subscribe: (listener: (value: T) => void) => () => void,
): T | null {
  const [held, setHeld] = useState<{ key: string; value: T } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a read is its key
  useEffect(() => {
    if (key === null) return;
    let live = true;
    const stop = subscribe((value) => {
      if (live) setHeld({ key, value });
    });
    return () => {
      live = false;
      stop();
    };
  }, [key]);
  return held && held.key === key ? held.value : null;
}

export default function KnowledgeBrowser({ card, reads, point, view }: PanelProps) {
  const born = useMemo(() => placeOf(card?.kept ?? null), [card?.kept]);
  const [place, setPlace] = useState<Place>(born);
  const patch = useCallback(
    (next: Partial<Place>) => setPlace((current) => ({ ...current, ...next })),
    [],
  );
  // The camera moves on every pointer move; only a settled camera is kept.
  const [camera, setCamera] = useState<Camera>(born.camera);
  const [live, setLive] = useState("");
  const say = useCallback((text: string) => setLive(text), []);

  const rootRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const drawingRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => setNarrow(root.clientWidth < NARROW_PX);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  // Kept on the card as it moves, so paging away and back finds it.
  const answered = useRef(born.answered);
  const keepPlace = useRef<() => void>(() => {});
  keepPlace.current = () => {
    void card?.keep({ ...place, answered: answered.current }).catch(() => {});
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: every move of the place is kept
  useEffect(() => keepPlace.current(), [place]);

  // -- the reads ----------------------------------------------------------------
  const collections = useRead<PanelKnowledgeCollections>("collections", (listener) =>
    reads.subscribe("knowledge.collections", listener),
  );
  const listed = collections?.state === "ready" ? collections.collections : [];
  // Facts belong to one captain-owned graph; scope is only the Directions filter.
  const scope = "captain";
  const directionScope =
    place.scope === "captain" || listed.some((item) => item.scope === place.scope)
      ? (place.scope ?? "all")
      : "all";
  const tabs = TABS;
  const collection = listed.find((candidate) => candidate.scope === scope);
  const empty = collection ? collection.concepts + collection.findings === 0 : false;

  // Typing in Find reads after a short pause; the field shows every key at once.
  const [searched, setSearched] = useState(born.query);
  useEffect(() => {
    const timer = setTimeout(() => setSearched(place.query), FIND_WAIT_MS);
    return () => clearTimeout(timer);
  }, [place.query]);
  const query = searched.trim();

  const focus = place.nearby && place.node ? place.node : undefined;
  const graphArgs =
    scope && place.tab === "graph"
      ? {
          scope,
          ...(focus ? { focus, hops: place.hops } : {}),
          ...(query ? { query } : {}),
        }
      : null;
  const graph = useRead<PanelKnowledgeGraph>(
    graphArgs ? JSON.stringify(graphArgs) : null,
    (listener) => reads.subscribe("knowledge.graph", graphArgs ?? { scope: "" }, listener),
  );
  const conceptArgs =
    scope && place.tab === "concepts"
      ? { scope, page: place.pages.concepts, ...(query ? { query } : {}) }
      : null;
  const concepts = useRead<PanelKnowledgeConcepts>(
    conceptArgs ? JSON.stringify(conceptArgs) : null,
    (listener) => reads.subscribe("knowledge.concepts", conceptArgs ?? { scope: "" }, listener),
  );
  const findingArgs =
    scope && place.tab === "findings"
      ? {
          scope,
          page: place.pages.findings,
          filter: place.filter,
          ...(query ? { query } : {}),
        }
      : null;
  const findings = useRead<PanelKnowledgeFindings>(
    findingArgs ? JSON.stringify(findingArgs) : null,
    (listener) => reads.subscribe("knowledge.findings", findingArgs ?? { scope: "" }, listener),
  );
  const directionArgs =
    scope && place.tab === "directions"
      ? { scope: directionScope, page: place.pages.directions, ...(query ? { query } : {}) }
      : null;
  const directions = useRead<PanelKnowledgeDirections>(
    directionArgs ? JSON.stringify(directionArgs) : null,
    (listener) => reads.subscribe("knowledge.directions", directionArgs ?? { scope: "" }, listener),
  );
  const directionId = place.selection?.kind === "direction" ? place.selection.id : null;
  const directionPage = place.directionPage;
  const directionRead = useRead<PanelKnowledgeDirectionRead>(
    directionId ? `${directionId}:${directionPage}` : null,
    (listener) =>
      reads.subscribe(
        "knowledge.direction",
        { id: directionId ?? "", page: directionPage },
        listener,
      ),
  );
  const inspected = entryIdOf(place.selection);
  const readRevision = place.selection?.revision;
  const entry = useRead<PanelKnowledgeEntryRead>(
    inspected && readRevision ? `${inspected}@${readRevision}` : inspected,
    (listener) =>
      reads.subscribe(
        "knowledge.entry",
        { id: inspected ?? "", ...(readRevision ? { revision: readRevision } : {}) },
        listener,
      ),
  );
  // The current revision beside an earlier one, for the inspector's comparison.
  const currentId = inspected && readRevision ? inspected : null;
  const currentEntry = useRead<PanelKnowledgeEntryRead>(currentId, (listener) =>
    reads.subscribe("knowledge.entry", { id: currentId ?? "" }, listener),
  );
  // The graph's own concept, whole, for its Connections list.
  const nodeId = place.tab === "graph" && place.node !== inspected ? place.node : null;
  const nodeEntry = useRead<PanelKnowledgeEntryRead>(nodeId, (listener) =>
    reads.subscribe("knowledge.entry", { id: nodeId ?? "" }, listener),
  );
  const nodeRead = place.node === inspected ? entry : nodeEntry;
  // The tasks the inspected entry's words name, so each key in them links (FI3-1271).
  const entryWords = useMemo(
    () => [...wordsOf(entry), ...wordsOf(directionRead)],
    [entry, directionRead],
  );
  const taskOf = usePanelTaskKeys(reads, entryWords);
  const litTaskId = view.litTaskId;
  const taskKeys = useMemo(() => ({ taskOf, point, litTaskId }), [taskOf, point, litTaskId]);

  // -- choosing ---------------------------------------------------------------
  // Opening something by key, or in a narrow card where the inspector takes
  // the pane's place, puts the keyboard on the inspector's selected section,
  // from where the arrows choose another and Tab reads on.
  const openInspector = useCallback(
    (byKey: boolean) => {
      if (narrow) patch({ detail: true });
      if (narrow || byKey) {
        const land = (frames: number) => {
          const section =
            rootRef.current?.querySelector<HTMLElement>(
              '[data-knowledge-section][aria-selected="true"]',
            ) ??
            (narrow
              ? rootRef.current?.querySelector<HTMLElement>("[data-knowledge-aside] button")
              : null);
          if (section) focusWithRing(section);
          else if (frames > 0) requestAnimationFrame(() => land(frames - 1));
        };
        requestAnimationFrame(() => land(30));
      }
    },
    [narrow, patch],
  );
  const nameOfRef = useRef<(selection: Selection) => string | null>(() => null);
  /** What a selection is called, from whatever the browser has read of it. */
  const nameOf = (selection: Selection): string | null => {
    const graphRead = graph?.state === "ready" ? graph : null;
    const title = (id: string) =>
      graphRead?.concepts.find((concept) => concept.id === id)?.title ??
      (concepts?.state === "ready"
        ? concepts.rows.find((row) => row.id === id)?.title
        : undefined) ??
      (findings?.state === "ready"
        ? findings.rows.find((row) => row.id === id)?.statement
        : undefined) ??
      (entry?.state === "ready" && entry.entry.id === id ? entry.entry.title : undefined);
    if (selection.kind === "direction") {
      return directions?.state === "ready"
        ? (directions.rows.find((row) => row.id === selection.id)?.text ?? null)
        : null;
    }
    if (selection.kind !== "connection") return title(selection.id) ?? null;
    const line = graphRead?.connections.find((connection) => connection.id === selection.id);
    if (!line) return null;
    const from = title(line.from) ?? "a concept";
    const to = title(line.to) ?? "a concept";
    return line.kind === "claim" ? `${from} ${line.predicate} ${to}` : `${from} read with ${to}`;
  };
  nameOfRef.current = nameOf;
  const pick = useCallback(
    (selection: Selection, node: string | null, open: boolean, byKey = false) => {
      setPlace((current) => ({
        ...current,
        selection,
        directionPage: current.selection?.id === selection.id ? current.directionPage : 0,
        node: node ?? startOf(selection) ?? current.node,
        section:
          current.selection?.id === selection.id &&
          current.selection.kind === selection.kind &&
          current.selection.revision === selection.revision
            ? current.section
            : "overview",
      }));
      const name = nameOfRef.current(selection)?.replace(/[.\s]+$/, "");
      say(`${name ? `${name} selected` : "Selected"}. Browsing changes no record.`);
      if (open) openInspector(byKey);
    },
    [openInspector, say],
  );

  // Every tab is always drawn, so the key moves focus to its tab at once: a
  // frame later can come after focus has moved on, into the tab's list, and
  // take it back (INF-699).
  const setTab = (tab: Tab, byKey: boolean) => {
    patch({ tab, detail: false });
    if (byKey) {
      const button = rootRef.current?.querySelector<HTMLElement>(`[data-knowledge-tab="${tab}"]`);
      if (button) focusWithRing(button);
    }
  };
  const onTabKey = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const at = tabs.indexOf(place.tab);
    const next = tabs[(at + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    if (next) setTab(next, true);
  };

  const onCamera = useCallback(
    (next: Camera, settled: boolean) => {
      setCamera(next);
      if (settled) patch({ camera: next });
    },
    [patch],
  );

  // -- a key or a row that put the browser up ---------------------------------
  const revision = card?.revision ?? 0;
  const ask = askOf(card?.data ?? null);
  const [asked, setAsked] = useState<"pane" | "find" | "inspector" | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: an ask is answered once, as it comes
  useEffect(() => {
    if (!collections || revision <= answered.current) return;
    answered.current = revision;
    const otherScope =
      ask.scope !== null &&
      (!ask.entry || ask.entry.kind === "direction") &&
      ask.scope !== place.scope;
    if (otherScope) {
      patch({
        scope: ask.scope,
        selection: null,
        node: null,
        nearby: false,
        detail: false,
        pages: { concepts: 0, findings: 0, directions: 0 },
      });
    }
    if (ask.tab)
      patch({
        tab: ask.tab,
        query: "",
        detail: false,
        selection: null,
        pages: { concepts: 0, findings: 0, directions: 0 },
      });
    if (ask.entry) {
      // A reference or a Knowledge used row: the inspector opens on that
      // entry, at the revision it names, over whatever the pane shows.
      const opened = ask.entry;
      setPlace((current) => ({
        ...current,
        selection: opened,
        ...(opened.kind === "direction" ? { tab: "directions" as const } : {}),
        directionPage: 0,
        node: opened.kind === "concept" ? opened.id : otherScope ? null : current.node,
        section: "overview",
        detail: narrow,
      }));
      const said = opened.revision ? `Revision ${opened.revision} opened` : "Opened";
      say(`${said} in the inspector. Browsing changes no record.`);
    }
    keepPlace.current();
    setAsked(ask.focus);
  }, [collections, revision]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: an ask lands on what is drawn
  useEffect(() => {
    if (!asked) return;
    const target = (): HTMLElement | null => {
      if (asked === "find") return findRef.current;
      if (asked === "inspector") {
        return (
          rootRef.current?.querySelector<HTMLElement>(
            '[data-knowledge-aside] [data-knowledge-section][aria-selected="true"]',
          ) ?? null
        );
      }
      if (place.tab === "graph") return drawingRef.current;
      return (
        rootRef.current?.querySelector<HTMLElement>('[data-knowledge-row][tabindex="0"]') ??
        rootRef.current?.querySelector<HTMLElement>(`[data-knowledge-tab="${place.tab}"]`) ??
        null
      );
    };
    const land = (frames: number) => {
      const element = target();
      if (element) {
        focusWithRing(element, { preventScroll: true });
        if (document.activeElement === element) {
          setAsked(null);
          return;
        }
      }
      if (frames > 0) requestAnimationFrame(() => land(frames - 1));
      // An entry still being read keeps its ask: the inspector draws its
      // sections once the read answers, and this runs again then.
      else if (asked !== "inspector" || entry !== null) setAsked(null);
    };
    requestAnimationFrame(() => land(120));
  }, [asked, graph, concepts, findings, entry, directions, directionRead]);

  // -- Ask about this ---------------------------------------------------------
  // The question names what is shown by its id and revision, so the message
  // is about exactly that record; the captain finishes it, and only sending
  // it asks Firstmate. Nothing is recorded here.
  const askAbout = (): string | null => {
    const selection = place.selection;
    if (!selection) return null;
    if (selection.kind === "direction") {
      const note = directionRead?.state === "ready" ? directionRead.direction : null;
      return note ? askWords({ kind: selection.kind, text: note.text, id: note.id }) : null;
    }
    if (entry?.state !== "ready") return null;
    const shown = entry.entry;
    if (selection.kind === "connection") {
      if (selection.id.startsWith("claim:") && shown.relationship) {
        return askWords({
          kind: "claim",
          sentence: `${shown.relationship.from.title} ${shown.relationship.predicate} ${shown.relationship.to.title}`,
          finding: shown.id,
          revision: shown.revision,
        });
      }
      const link = shown.connections.find((connection) => connection.id === selection.id);
      return link ? askWords({ kind: "context", from: link.from, to: link.to }) : null;
    }
    return askWords({
      kind: shown.kind,
      title: shown.title,
      id: shown.id,
      revision: shown.revision,
    });
  };
  const onAsk = () => {
    const words = askAbout();
    if (!words) return;
    void point
      .draft(words)
      .then((started) => {
        if (started) say("A question about this is ready in the message field. Nothing was sent.");
      })
      .catch(() => {});
  };

  /**
   * Back from the inspector to the pane, where the keyboard was: the graph,
   * or the list's selected row; in a narrow card the pane takes the
   * inspector's place again.
   */
  const backToPane = () => {
    patch({ detail: false });
    const land = (frames: number) => {
      const target =
        place.tab === "graph"
          ? drawingRef.current
          : (rootRef.current?.querySelector<HTMLElement>(
              '[data-knowledge-pane] [data-knowledge-row][tabindex="0"]',
            ) ?? null);
      if (target) focusWithRing(target, { preventScroll: true });
      else if (frames > 0) requestAnimationFrame(() => land(frames - 1));
    };
    requestAnimationFrame(() => land(30));
  };

  // Esc, in its order: from the inspector back to the pane (Back, in a
  // narrow card), then clear Find; an Escape neither used hides the card.
  const onEscapeKey = useRef<(event: KeyboardEvent) => void>(() => {});
  onEscapeKey.current = (event) => {
    if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
    const inInspector =
      rootRef.current?.querySelector("[data-knowledge-aside]")?.contains(document.activeElement) ===
      true;
    if (inInspector || (narrow && place.detail)) {
      event.preventDefault();
      backToPane();
      return;
    }
    if (place.query) {
      event.preventDefault();
      patch({ query: "", pages: { concepts: 0, findings: 0, directions: 0 } });
      setSearched("");
    }
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => onEscapeKey.current(event);
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // -- drawing ----------------------------------------------------------------
  const showInspector = !narrow || place.detail;
  const showPane = !narrow || !place.detail;

  const pane = () => {
    if (!collections) return <p className="fm-kb-quiet">Reading…</p>;
    if (collections.state === "unavailable") {
      return (
        <p className="fm-kb-quiet" data-knowledge-unavailable="">
          {collections.reason}
        </p>
      );
    }
    if (place.tab === "directions") {
      if (!directions) return <p className="fm-kb-quiet">Reading…</p>;
      if (directions.state === "unavailable")
        return <p className="fm-kb-quiet">{directions.reason}</p>;
      return (
        <DirectionList
          read={directions}
          selection={place.selection}
          onPick={pick}
          onPage={(page) => patch({ pages: { ...place.pages, directions: page } })}
        />
      );
    }
    if (empty && !query) {
      return (
        <div className="fm-kb-empty" data-knowledge-empty="">
          <p>
            Nothing is recorded yet. Tell your first mate about yourself or share an article you
            want to keep.
          </p>
        </div>
      );
    }
    if (place.tab === "graph") {
      if (!graph) return <p className="fm-kb-quiet">Reading…</p>;
      if (graph.state === "unavailable") return <p className="fm-kb-quiet">{graph.reason}</p>;
      const nodeConnections =
        nodeRead?.state === "ready" && nodeRead.entry.kind === "concept"
          ? nodeRead.entry.connections
          : null;
      return (
        <GraphView
          graph={graph}
          nodeConnections={nodeConnections}
          camera={camera}
          onCamera={onCamera}
          selection={place.selection}
          node={place.node}
          onPick={pick}
          nearby={place.nearby}
          hops={place.hops}
          onNearby={(nearby) => {
            patch({ nearby });
            say(
              nearby
                ? "Showing the selected concept and its neighborhood."
                : "Showing the collection.",
            );
          }}
          onHops={(hops) => patch({ hops })}
          narrowed={query.length > 0}
          say={say}
          drawingRef={drawingRef}
        />
      );
    }
    if (place.tab === "concepts") {
      if (!concepts) return <p className="fm-kb-quiet">Reading…</p>;
      if (concepts.state === "unavailable") return <p className="fm-kb-quiet">{concepts.reason}</p>;
      return (
        <ConceptList
          read={concepts}
          query={query}
          selection={place.selection}
          onPick={pick}
          onPage={(page) => patch({ pages: { ...place.pages, concepts: page } })}
        />
      );
    }
    if (!findings) return <p className="fm-kb-quiet">Reading…</p>;
    if (findings.state === "unavailable") return <p className="fm-kb-quiet">{findings.reason}</p>;
    return (
      <FindingList
        read={findings}
        query={query}
        filter={place.filter}
        onFilter={(filter) => patch({ filter, pages: { ...place.pages, findings: 0 } })}
        selection={place.selection}
        onPick={pick}
        onPage={(page) => patch({ pages: { ...place.pages, findings: page } })}
      />
    );
  };

  return (
    <div
      ref={rootRef}
      className="fm-kb"
      data-knowledge-browser=""
      data-narrow={narrow ? "" : undefined}
      data-knowledge-scope={scope}
      data-knowledge-project={directionScope}
      data-knowledge-tab-shown={place.tab}
    >
      <style>{styles}</style>
      <div className="fm-kb-chrome">
        <label className="fm-kb-field fm-kb-find">
          <span>Find</span>
          <input
            ref={findRef}
            type="search"
            className="fm-kb-input"
            placeholder={place.tab === "directions" ? "Direction" : "Concept, alias or finding"}
            data-knowledge-find=""
            value={place.query}
            onChange={(event) =>
              patch({
                query: event.target.value,
                pages: { concepts: 0, findings: 0, directions: 0 },
              })
            }
          />
        </label>
      </div>
      <div className="fm-kb-tabs" role="tablist" aria-label="Knowledge views">
        {tabs.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={place.tab === tab}
            tabIndex={place.tab === tab ? 0 : -1}
            data-knowledge-tab={tab}
            onClick={() => setTab(tab, false)}
            onKeyDown={onTabKey}
          >
            {TAB_WORDS[tab]}
          </button>
        ))}
        <span className="fm-kb-spacer" />
        {place.tab === "directions" ? (
          <label className="fm-kb-field">
            <span>Project</span>
            <select
              className="fm-kb-select"
              data-knowledge-scope-select=""
              value={directionScope}
              disabled={listed.length === 0}
              onChange={(event) => {
                patch({
                  scope: event.target.value,
                  selection: null,
                  detail: false,
                  pages: { ...place.pages, directions: 0 },
                });
                say("Showing directions for this project.");
              }}
            >
              <option value="all">All projects</option>
              {listed.map((option) => (
                <option key={option.scope} value={option.scope}>
                  {option.private ? "Everywhere" : option.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      <div className="fm-kb-body">
        {showPane ? (
          <section
            className="fm-kb-pane"
            role="tabpanel"
            aria-label={TAB_WORDS[place.tab]}
            data-knowledge-pane={place.tab}
          >
            {pane()}
          </section>
        ) : null}
        {showInspector ? (
          <aside className="fm-kb-inspector" aria-label="Inspector" data-knowledge-aside="">
            <InspectorTaskKeysContext.Provider value={taskKeys}>
              {place.selection?.kind === "direction" ? (
                <DirectionInspector
                  read={directionRead}
                  section={place.section}
                  onSection={(section) => patch({ section })}
                  onPage={(directionPage) => patch({ directionPage })}
                  onBack={narrow ? backToPane : null}
                  onAsk={onAsk}
                />
              ) : (
                <Inspector
                  selection={place.selection}
                  read={place.selection ? entry : null}
                  section={place.section}
                  onSection={(section: Section) => patch({ section })}
                  onSelect={(selection) => pick(selection, null, true, false)}
                  onShowOnGraph={(concept) => {
                    patch({
                      tab: "graph",
                      selection: { kind: "concept", id: concept },
                      node: concept,
                      section: "overview",
                      detail: false,
                      nearby: true,
                      query: "",
                    });
                    setSearched("");
                    say("Shown on the graph with its neighborhood.");
                    requestAnimationFrame(() => {
                      const land = (frames: number) => {
                        const drawing = drawingRef.current;
                        if (drawing) focusWithRing(drawing, { preventScroll: true });
                        else if (frames > 0) requestAnimationFrame(() => land(frames - 1));
                      };
                      land(60);
                    });
                  }}
                  onBack={narrow ? backToPane : null}
                  current={readRevision ? currentEntry : null}
                  onAsk={place.selection ? onAsk : null}
                />
              )}
            </InspectorTaskKeysContext.Provider>
          </aside>
        ) : null}
      </div>
      <p className="fm-kb-live" role="status" data-knowledge-live="">
        {live}
      </p>
    </div>
  );
}

/** Every string an entry's read holds, one per item, for the task keys in them. */
function wordsOf(
  read: PanelKnowledgeEntryRead | PanelKnowledgeDirectionRead | null | undefined,
): string[] {
  const words: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") words.push(value);
    else if (Array.isArray(value)) for (const item of value) walk(item);
    else if (value && typeof value === "object")
      for (const item of Object.values(value)) walk(item);
  };
  walk(read);
  return words;
}
