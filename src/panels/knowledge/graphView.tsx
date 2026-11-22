import type {
  PanelKnowledgeConnection,
  PanelKnowledgeEntryConnection,
  PanelKnowledgeGraph,
} from "@infinitary/contracts";
import { Button, focusWithRing } from "@infinitary/ui";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type Box,
  type Camera,
  DRAG_THRESHOLD_PX,
  depthOpacity,
  HOME_CAMERA,
  LABEL_HEIGHT,
  layoutGraph,
  lineEnd,
  ORBIT_KEY_STEP,
  orbitByDrag,
  orbitStep,
  type Projected,
  placeEdgeLabel,
  placeNodeLabel,
  project,
  tiltStep,
  zoomStep,
} from "./graph";
import * as m from "./messages.generated";
import type { Selection } from "./place";
import { connectionKindLine } from "./words";

/**
 * The knowledge browser's Graph tab (the design skill's
 * `components/knowledge/KnowledgeBrowser`, "The graph"): one collection's
 * concepts at their places in three dimensions, seen through a camera that
 * orbits the fixed center, with the claims and read-together links among
 * them, and under it the selected concept's connections as a list the
 * keyboard reads. The camera moves only on the captain's drag, button or
 * key, and nothing moves by itself.
 */

type ReadyGraph = Extract<PanelKnowledgeGraph, { state: "ready" }>;

/** The drawing's height; its width is the pane's. */
export const GRAPH_HEIGHT = 360;

export type GraphViewProps = {
  graph: ReadyGraph;
  /** The node's own connections, whole, once its entry is read; the drawn ones until then. */
  nodeConnections: PanelKnowledgeEntryConnection[] | null;
  camera: Camera;
  /** A new camera; `settled` once a drag ends or a step lands, so the browser keeps it. */
  onCamera: (camera: Camera, settled: boolean) => void;
  selection: Selection | null;
  /** The concept the arrows stand on, and whose connections the list shows. */
  node: string | null;
  /**
   * Selects a concept or a connection; `open` brings the inspector to it,
   * and `byKey` puts the keyboard's focus there too.
   */
  onPick: (selection: Selection, node: string | null, open: boolean, byKey: boolean) => void;
  nearby: boolean;
  hops: 1 | 2;
  onNearby: (nearby: boolean) => void;
  onHops: (hops: 1 | 2) => void;
  narrowed: boolean;
  say: (text: string) => void;
  /** The drawing: the one Tab stop the arrows walk, and what the wheel zooms while it has focus. */
  drawingRef: RefObject<HTMLDivElement | null>;
};

/** The concepts in the order the arrows walk them: by name. */
function walkOrder(graph: ReadyGraph): string[] {
  return graph.concepts
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title) || (a.id < b.id ? -1 : 1))
    .map((concept) => concept.id);
}

function countLine(graph: ReadyGraph): string {
  const concepts =
    graph.total.concepts > graph.shown.concepts
      ? m.knowledgePanelGraphConceptsOf({
          shown: String(graph.shown.concepts),
          count: graph.total.concepts,
        })
      : m.knowledgePanelConceptCount({ count: graph.shown.concepts });
  const connections =
    graph.total.connections > graph.shown.connections
      ? m.knowledgePanelGraphConnectionsOf({
          shown: String(graph.shown.connections),
          count: graph.total.connections,
        })
      : m.knowledgePanelConnectionCount({ count: graph.shown.connections });
  return `${concepts} · ${connections} · 3D`;
}

type Drag = {
  pointer: number;
  x: number;
  y: number;
  from: Camera;
  button: number;
  target: { node: string } | { connection: string } | null;
  moved: boolean;
};

export function GraphView({
  graph,
  nodeConnections,
  camera,
  onCamera,
  selection,
  node,
  onPick,
  nearby,
  hops,
  onNearby,
  onHops,
  narrowed,
  say,
  drawingRef,
}: GraphViewProps) {
  const holderRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useLayoutEffect(() => {
    const holder = holderRef.current;
    if (!holder) return;
    const measure = () => setWidth(Math.max(260, Math.round(holder.clientWidth)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(holder);
    return () => observer.disconnect();
  }, []);

  // The layout is the collection's: computed once per set of concepts and
  // connections, and kept while the camera moves.
  const shape = `${graph.concepts.map((c) => c.id).join(",")}|${graph.connections
    .map((c) => `${c.from}>${c.to}`)
    .join(",")}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the layout follows the graph's shape alone
  const places = useMemo(() => layoutGraph(graph.concepts, graph.connections), [shape]);
  const titles = useMemo(
    () => new Map(graph.concepts.map((concept) => [concept.id, concept.title])),
    [graph.concepts],
  );
  const projected = useMemo(() => {
    const out = new Map<string, Projected>();
    for (const concept of graph.concepts) {
      const at = places.get(concept.id);
      if (at) out.set(concept.id, { id: concept.id, ...project(at, camera, width, GRAPH_HEIGHT) });
    }
    return out;
  }, [graph.concepts, places, camera, width]);

  const chosen = selection?.kind === "connection" ? selection.id : null;
  const chosenLine = graph.connections.find((connection) => connection.id === chosen);
  const lit = new Set<string>(
    chosenLine ? [chosenLine.from, chosenLine.to] : node && projected.has(node) ? [node] : [],
  );
  const touchesNode = (connection: PanelKnowledgeConnection) =>
    node !== null && (connection.from === node || connection.to === node);
  const neighbors = new Set(
    graph.connections.filter(touchesNode).flatMap((connection) => [connection.from, connection.to]),
  );

  const drag = useRef<Drag | null>(null);
  const targetOf = (element: Element | null): Drag["target"] => {
    const nodeId = element?.closest("[data-knowledge-node]")?.getAttribute("data-knowledge-node");
    if (nodeId) return { node: nodeId };
    const line = element
      ?.closest("[data-knowledge-connection]")
      ?.getAttribute("data-knowledge-connection");
    return line ? { connection: line } : null;
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 2) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    try {
      // The drag keeps orbiting while the pointer leaves the drawing.
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A pointer the page no longer knows: the drag still runs while over it.
    }
    drag.current = {
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      from: camera,
      button: event.button,
      target: targetOf(event.target as Element),
      moved: false,
    };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const held = drag.current;
    if (!held || held.pointer !== event.pointerId) return;
    const dx = event.clientX - held.x;
    const dy = event.clientY - held.y;
    if (!held.moved && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD_PX) held.moved = true;
    if (held.moved) onCamera(orbitByDrag(held.from, dx, dy), false);
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const held = drag.current;
    if (!held || held.pointer !== event.pointerId) return;
    drag.current = null;
    if (held.moved) {
      onCamera(orbitByDrag(held.from, event.clientX - held.x, event.clientY - held.y), true);
      say(m.knowledgePanelCameraOrbited());
      return;
    }
    // A press that never moved is a click: the left button selects what it was on.
    if (held.button !== 0 || !held.target) return;
    if ("node" in held.target) {
      onPick({ kind: "concept", id: held.target.node }, held.target.node, true, false);
    } else {
      const line = graph.connections.find(
        (connection) => connection.id === (held.target as { connection: string }).connection,
      );
      if (line) onPick({ kind: "connection", id: line.id }, line.from, true, false);
    }
  };
  const onPointerCancel = () => {
    const held = drag.current;
    drag.current = null;
    if (held?.moved) onCamera(held.from, true);
  };

  // The wheel zooms only while the drawing has the keyboard's focus, and
  // never takes the window's own zoom (⌘ or Ctrl).
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  useEffect(() => {
    const drawing = drawingRef.current;
    if (!drawing) return;
    const onWheel = (event: WheelEvent) => {
      if (document.activeElement !== drawing || event.ctrlKey || event.metaKey || !event.deltaY) {
        return;
      }
      event.preventDefault();
      const next = zoomStep(cameraRef.current, event.deltaY < 0 ? "in" : "out");
      cameraRef.current = next;
      onCamera(next, true);
      say(m.knowledgePanelZoomSaid({ percent: String(Math.round(next.zoom * 100)) }));
    };
    drawing.addEventListener("wheel", onWheel, { passive: false });
    return () => drawing.removeEventListener("wheel", onWheel);
  }, [drawingRef, onCamera, say]);

  const walk = walkOrder(graph);
  // Each step starts from where the last one left the camera, so keys
  // pressed faster than the drawing redraws each count.
  const step = (move: (from: Camera) => Camera, words: (next: Camera) => string) => {
    const next = move(cameraRef.current);
    cameraRef.current = next;
    onCamera(next, true);
    say(words(next));
  };
  const zoomWords = (next: Camera) =>
    m.knowledgePanelZoomSaid({ percent: String(Math.round(next.zoom * 100)) });
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const key = event.key;
    // i18n-exempt: not shown (the arrow keys' names)
    if (event.shiftKey && key.startsWith("Arrow")) {
      event.preventDefault();
      if (key === "ArrowLeft") {
        step(
          (from) => orbitStep(from, "left", ORBIT_KEY_STEP),
          () => m.knowledgePanelCameraOrbitedLeft(),
        );
      }
      if (key === "ArrowRight") {
        step(
          (from) => orbitStep(from, "right", ORBIT_KEY_STEP),
          () => m.knowledgePanelCameraOrbitedRight(),
        );
      }
      if (key === "ArrowUp")
        step(
          (from) => tiltStep(from, "up"),
          () => m.knowledgePanelCameraTiltedUp(),
        );
      if (key === "ArrowDown")
        step(
          (from) => tiltStep(from, "down"),
          () => m.knowledgePanelCameraTiltedDown(),
        );
      return;
    }
    // i18n-exempt: not shown (the arrow keys' names)
    if (key.startsWith("Arrow")) {
      event.preventDefault();
      if (walk.length === 0) return;
      const at = node ? walk.indexOf(node) : -1;
      const forward = key === "ArrowRight" || key === "ArrowDown";
      const next =
        at < 0
          ? forward
            ? 0
            : walk.length - 1
          : (at + (forward ? 1 : walk.length - 1)) % walk.length;
      const id = walk[next];
      if (id) onPick({ kind: "concept", id }, id, false, true);
      return;
    }
    if (key === "Enter") {
      event.preventDefault();
      if (selection) onPick(selection, node, true, true);
      else if (node) onPick({ kind: "concept", id: node }, node, true, true);
      return;
    }
    if (key === "Home") {
      event.preventDefault();
      step(
        () => HOME_CAMERA,
        () => m.knowledgePanelCameraReset(),
      );
      return;
    }
    if (key === "+" || key === "=") {
      event.preventDefault();
      step((from) => zoomStep(from, "in"), zoomWords);
      return;
    }
    if (key === "-" || key === "_") {
      event.preventDefault();
      step((from) => zoomStep(from, "out"), zoomWords);
    }
  };

  const lines = graph.connections.flatMap((connection) => {
    const a = projected.get(connection.from);
    const b = projected.get(connection.to);
    if (!a || !b) return [];
    const isChosen = connection.id === chosen;
    const near = !chosen && touchesNode(connection);
    const end = connection.kind === "claim" ? lineEnd(a, b) : b;
    return [
      <g
        key={connection.id}
        data-knowledge-connection={connection.id}
        data-knowledge-kind={connection.kind}
        data-lit={isChosen ? "" : undefined}
        data-near={near ? "" : undefined}
      >
        <line className="fm-kg-hit" data-knowledge-hit="" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
        <line
          className="fm-kg-line"
          data-knowledge-line=""
          x1={a.x}
          y1={a.y}
          x2={end.x}
          y2={end.y}
          markerEnd={
            connection.kind === "claim"
              ? `url(#${isChosen ? "fm-kg-arrow-lit" : "fm-kg-arrow"})`
              : undefined
          }
        />
      </g>,
    ];
  });

  const ordered = [...projected.values()].sort((a, b) => b.depth - a.depth);
  const taken: Box[] = ordered.map((point) => ({
    x: point.x - point.radius - 2,
    y: point.y - point.radius - 2,
    width: point.radius * 2 + 4,
    height: point.radius * 2 + 4,
  }));
  // Labels in the order they matter, each where it covers nothing placed
  // before it: the selected connection's predicate (or the selected
  // concept's own claims'), then the lit concepts' names, then the
  // neighbors' names, then the rest, nearest first.
  const nodeLabels = new Map<string, Box>();
  const placeName = (point: Projected) => {
    const box = placeNodeLabel(point, titles.get(point.id) ?? "", taken, width, GRAPH_HEIGHT);
    if (!box) return;
    taken.push(box);
    nodeLabels.set(point.id, box);
  };
  const byDepth = [...projected.values()].sort((a, b) => a.depth - b.depth);
  const named = graph.connections.filter((connection) =>
    chosen ? connection.id === chosen : connection.kind === "claim" && touchesNode(connection),
  );
  const edgeLabels = named.flatMap((connection) => {
    const a = projected.get(connection.from);
    const b = projected.get(connection.to);
    if (!a || !b) return [];
    const text =
      connection.kind === "claim" ? connection.predicate : m.knowledgePanelReadWithLabel();
    const box = placeEdgeLabel(a, b, text, taken, width, GRAPH_HEIGHT);
    if (!box) return [];
    taken.push(box);
    return [{ connection, a, b, box, text }];
  });
  for (const point of byDepth) if (lit.has(point.id)) placeName(point);
  for (const point of byDepth) if (!lit.has(point.id) && neighbors.has(point.id)) placeName(point);
  for (const point of byDepth) if (!lit.has(point.id) && !neighbors.has(point.id)) placeName(point);

  const nodeTitle = node ? titles.get(node) : undefined;
  const listed: { id: string; line: PanelKnowledgeConnection | PanelKnowledgeEntryConnection }[] = (
    nodeConnections ?? graph.connections.filter(touchesNode)
  ).map((line) => ({
    id: line.id,
    line,
  }));
  const endName = (end: string | { title: string }) =>
    typeof end === "string" ? (titles.get(end) ?? m.knowledgePanelConceptNotDrawn()) : end.title;

  const listRef = useRef<HTMLDivElement>(null);
  const listStop = listed.some((row) => row.id === chosen) ? chosen : (listed[0]?.id ?? null);
  const pickLine = (row: (typeof listed)[number], open: boolean, byKey: boolean) =>
    onPick({ kind: "connection", id: row.id }, node, open, byKey);
  const onListKey = (event: ReactKeyboardEvent<HTMLElement>, index: number) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const next =
      event.key === "ArrowDown"
        ? Math.min(listed.length - 1, index + 1)
        : event.key === "ArrowUp"
          ? Math.max(0, index - 1)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? listed.length - 1
              : -1;
    if (event.key === "Enter") {
      event.preventDefault();
      const row = listed[index];
      if (row) pickLine(row, true, true);
      return;
    }
    if (next < 0) return;
    event.preventDefault();
    const row = listed[next];
    if (!row) return;
    pickLine(row, false, true);
    // The row is drawn already: focus moves with the key, before the next one.
    const element = listRef.current?.querySelector<HTMLElement>(
      `[data-knowledge-row="${CSS.escape(row.id)}"]`,
    );
    if (element) focusWithRing(element);
  };

  return (
    <div className="fm-kg" data-knowledge-graph="">
      <div className="fm-kb-pane-head">
        <span className="fm-kb-count" data-knowledge-count="">
          {countLine(graph)}
        </span>
        <span className="fm-kb-spacer" />
        <Button
          variant="secondary"
          size="sm"
          aria-pressed={nearby}
          disabled={!node && !nearby}
          onClick={() => onNearby(!nearby)}
        >
          {m.knowledgePanelFocusNearby()}
        </Button>
        <select
          className="fm-kb-select"
          aria-label={m.knowledgePanelNearbyReach()}
          value={hops}
          onChange={(event) => onHops(event.target.value === "2" ? 2 : 1)}
        >
          <option value="1">{m.knowledgePanelHops({ count: 1 })}</option>
          <option value="2">{m.knowledgePanelHops({ count: 2 })}</option>
        </select>
      </div>
      {graph.total.concepts > graph.shown.concepts ? (
        <p className="fm-kb-note" data-knowledge-omitted="">
          {m.knowledgePanelConceptsNotDrawn({ count: graph.total.concepts - graph.shown.concepts })}
        </p>
      ) : null}
      <div ref={holderRef} className="fm-kg-holder">
        {graph.concepts.length === 0 ? (
          <p className="fm-kb-quiet fm-kg-empty">
            {narrowed ? m.knowledgePanelNoConceptMatches() : m.knowledgePanelNoConceptYet()}
          </p>
        ) : null}
        <div
          ref={drawingRef}
          className="fm-kg-drawing"
          data-knowledge-drawing=""
          role="listbox"
          tabIndex={0}
          aria-label={m.knowledgePanelGraphLabel()}
          aria-describedby="fm-kg-keys"
          aria-activedescendant={node && projected.has(node) ? `fm-kg-node-${node}` : undefined}
          data-knowledge-camera={`${camera.yaw.toFixed(4)},${camera.pitch.toFixed(4)},${camera.zoom.toFixed(2)}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onLostPointerCapture={() => {
            if (drag.current && !drag.current.moved) drag.current = null;
          }}
          onContextMenu={(event) => event.preventDefault()}
          onKeyDown={onKeyDown}
        >
          <svg
            className="fm-kg-svg"
            width={width}
            height={GRAPH_HEIGHT}
            viewBox={`0 0 ${width} ${GRAPH_HEIGHT}`}
            role="none"
          >
            <defs>
              <marker
                id="fm-kg-arrow"
                markerWidth="7"
                markerHeight="7"
                refX="6"
                refY="3.5"
                orient="auto"
              >
                <path className="fm-kg-arrowhead" d="M0 0L7 3.5L0 7Z" />
              </marker>
              <marker
                id="fm-kg-arrow-lit"
                markerWidth="7"
                markerHeight="7"
                refX="6"
                refY="3.5"
                orient="auto"
              >
                <path className="fm-kg-arrowhead-lit" d="M0 0L7 3.5L0 7Z" />
              </marker>
            </defs>
            <g data-dim={chosen ? "" : undefined}>{lines}</g>
            {ordered.map((point) => {
              const isLit = lit.has(point.id);
              return (
                <g
                  key={point.id}
                  id={`fm-kg-node-${point.id}`}
                  role="option"
                  aria-selected={isLit}
                  aria-label={titles.get(point.id)}
                  data-knowledge-node={point.id}
                  data-lit={isLit ? "" : undefined}
                  data-x={point.x.toFixed(1)}
                  data-y={point.y.toFixed(1)}
                  data-depth={point.depth.toFixed(1)}
                >
                  <circle
                    className="fm-kg-hit"
                    data-knowledge-hit=""
                    cx={point.x}
                    cy={point.y}
                    r={14}
                  />
                  <circle
                    className="fm-kg-dot"
                    cx={point.x}
                    cy={point.y}
                    r={isLit ? point.radius + 3 : point.radius}
                    fillOpacity={isLit ? 1 : depthOpacity(point.depth)}
                  />
                  {isLit ? (
                    <circle className="fm-kg-ring" cx={point.x} cy={point.y} r={point.radius + 9} />
                  ) : null}
                </g>
              );
            })}
            {[...nodeLabels].map(([id, box]) => {
              const point = projected.get(id);
              if (!point) return null;
              return (
                <g
                  key={id}
                  className="fm-kg-label"
                  data-knowledge-label={id}
                  data-lit={lit.has(id) ? "" : undefined}
                >
                  <line
                    className="fm-kg-leader"
                    x1={point.x}
                    y1={point.y}
                    x2={Math.max(box.x, Math.min(box.x + box.width, point.x))}
                    y2={Math.max(box.y, Math.min(box.y + box.height, point.y))}
                  />
                  <rect
                    className="fm-kg-tag"
                    x={box.x}
                    y={box.y}
                    width={box.width}
                    height={LABEL_HEIGHT}
                    rx={6}
                  />
                  <text className="fm-kg-text" x={box.x + box.width / 2} y={box.y + 15}>
                    {titles.get(id)}
                  </text>
                </g>
              );
            })}
            {edgeLabels.map(({ connection, a, b, box, text }) => (
              <g
                key={`label:${connection.id}`}
                className="fm-kg-predicate"
                data-knowledge-predicate={connection.id}
                data-lit={connection.id === chosen ? "" : undefined}
              >
                <line
                  className="fm-kg-leader"
                  x1={(a.x + b.x) / 2}
                  y1={(a.y + b.y) / 2}
                  x2={box.x + box.width / 2}
                  y2={box.y + LABEL_HEIGHT / 2}
                />
                <rect
                  className="fm-kg-predicate-tag"
                  x={box.x}
                  y={box.y}
                  width={box.width}
                  height={LABEL_HEIGHT}
                  rx={6}
                />
                <text className="fm-kg-text" x={box.x + box.width / 2} y={box.y + 15}>
                  {text}
                </text>
              </g>
            ))}
          </svg>
        </div>
      </div>
      <p className="fm-kb-legend">{m.knowledgePanelGraphLegend()}</p>
      <div className="fm-kb-controls">
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            step(
              (from) => orbitStep(from, "left"),
              () => m.knowledgePanelCameraOrbitedLeft(),
            )
          }
        >
          {m.knowledgePanelOrbitLeft()}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            step(
              (from) => orbitStep(from, "right"),
              () => m.knowledgePanelCameraOrbitedRight(),
            )
          }
        >
          {m.knowledgePanelOrbitRight()}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => step((from) => zoomStep(from, "in"), zoomWords)}
        >
          {m.knowledgePanelZoomIn()}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => step((from) => zoomStep(from, "out"), zoomWords)}
        >
          {m.knowledgePanelZoomOut()}
        </Button>
        <span className="fm-kb-count" data-knowledge-zoom="">
          {Math.round(camera.zoom * 100)}%
        </span>
        <span className="fm-kb-spacer" />
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            step(
              () => HOME_CAMERA,
              () => m.knowledgePanelCameraReset(),
            )
          }
        >
          {m.knowledgePanelResetView()}
        </Button>
      </div>
      <p id="fm-kg-keys" className="fm-kb-hint">
        {m.knowledgePanelPointerHint()}
        <br />
        {m.knowledgePanelKeyHint()}
      </p>
      <section className="fm-kb-connections" data-knowledge-connections={node ?? ""}>
        <h4>
          {nodeTitle
            ? m.knowledgePanelConnectionsFor({ title: nodeTitle })
            : m.knowledgePanelConnections()}
        </h4>
        {!nodeTitle ? (
          <p className="fm-kb-quiet">{m.knowledgePanelSelectConceptPrompt()}</p>
        ) : listed.length === 0 ? (
          <p className="fm-kb-quiet">{m.knowledgePanelNoConnection()}</p>
        ) : (
          <div
            ref={listRef}
            className="fm-kb-rows"
            role="listbox"
            aria-label={m.knowledgePanelConnections()}
          >
            {listed.map((row, index) => {
              const line = row.line;
              const from = endName(line.from);
              const to = endName(line.to);
              const standing = line.kind === "claim" ? line.standing : undefined;
              return (
                <div
                  key={row.id}
                  role="option"
                  aria-selected={row.id === chosen}
                  tabIndex={row.id === listStop ? 0 : -1}
                  className="fm-kb-row"
                  data-knowledge-row={row.id}
                  onClick={() => pickLine(row, true, false)}
                  onKeyDown={(event) => onListKey(event, index)}
                >
                  <span className="fm-kb-row-title">
                    {line.kind === "claim" ? (
                      <>
                        {from} <strong>{line.predicate}</strong> → {to}
                      </>
                    ) : (
                      <>
                        {from} <strong>{m.knowledgePanelReadWithLabel()}</strong> {to}
                      </>
                    )}
                  </span>
                  <span className="fm-kb-row-detail">
                    {connectionKindLine({ kind: line.kind, ...(standing ? { standing } : {}) })}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
