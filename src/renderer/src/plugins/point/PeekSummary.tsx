import type { TaskDetail, TaskView } from "@shared/tasks";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useModelNames } from "../../app/useModelNames";
import { CrewSummary } from "../../character/crew/CrewSummary";
import {
  type Box,
  CREW_HOVER,
  placeKeySummary,
  placeRowSummary,
  type SummaryPlacement,
  type SummaryRoom,
} from "../../character/crew/hover";
import {
  moveSummary,
  openSummary,
  poseOf,
  useSummaryFade,
  useSummaryPresence,
} from "../../character/crew/summaryMotion";
import { useBoardTasks } from "../../character/crew/useCrewBoard";
import { appReadExecutor } from "../reads/appExecutor";
import { type TaskPeek, taskPeek, useTaskPeek } from "./taskPeek";

/**
 * The summary beside a task a panel rests on, or a task key
 * (FI3-565 piece 3, FI3-594, FI3-1271; the design skill's NowPanel, Row
 * hover, the core rule Task keys, and TaskBoard): resting on any of them
 * opens the crew summary for that task - the same panel, facts and beat a
 * crewmate opens on the stage - with the same hairline joining them. A
 * task in a panel on its rail - a Tasks row - sits outside the panel on the
 * stage's side, level with the task; a task in a panel's card - a task
 * board tile - and a key sit outside their card, level with the task or the
 * key. It lives in a window-wide layer above the rails and the cards, and
 * never takes the pointer.
 *
 * A panel's page reports its task (`point.peekTask`, ../panelPoint.ts), a
 * card body's frame reports the key (`../../cards/taskLinks.ts`), and a key
 * the window draws reports itself (`../../cards/TaskKey.tsx`), sitting
 * outside its card or Settings section like a card's key; each lets it go
 * when the pointer leaves it, on Esc in the page, on a press, or when what
 * it is in moves under it. Everything outside the frames lets it
 * go here: the pointer moving anywhere in the window itself other than over
 * that frame (it is then off every task and key), Esc, a scroll that
 * carries the frame, a resize, and the window losing focus - and, for a
 * card's key, any other key press in the window, which may page the card
 * away, and its frame leaving the window or taking a new document. The
 * stage is not told: no crewmate is pointed at.
 */

/** Clear air between the summary and the edge of where it may sit, px, as on the stage. */
const SUMMARY_MARGIN_PX = 8;

/**
 * Where a summary may sit: under the top bar, inside the window, and clear
 * of the input and of every rail panel - for a task in a panel's page, every
 * panel but its own (`own`), which it sits beside.
 */
function summaryRoom(own?: Element | null): SummaryRoom {
  const m = SUMMARY_MARGIN_PX;
  const grown = (element: Element): Box => {
    const { left, top, right, bottom } = element.getBoundingClientRect();
    return { left: left - m, top: top - m, right: right + m, bottom: bottom + m };
  };
  const obstacles = [
    ...document.querySelectorAll("[data-prompt-dock]"),
    ...[...document.querySelectorAll("[data-side-panel]")].filter((panel) => panel !== own),
  ];
  return {
    within: {
      left: m,
      top: (document.querySelector("[data-topbar]")?.getBoundingClientRect().bottom ?? 0) + m,
      right: window.innerWidth - m,
      bottom: window.innerHeight - m,
    },
    avoid: obstacles.map(grown),
  };
}

/**
 * The rested task: the board's own row, or, for one the board no longer
 * lists (a Tasks search's `earlier` group, a card naming older work), the
 * record's read. Read from the moment the pointer lands, so it is there by
 * the end of the beat.
 */
function useRestedTask(taskId: string | null): TaskView | undefined {
  const tasks = useBoardTasks();
  const listed = taskId ? tasks.find((row) => row.id === taskId) : undefined;
  const [read, setRead] = useState<TaskView>();
  const onBoard = listed !== undefined;
  useEffect(() => {
    if (!taskId || onBoard) return;
    return appReadExecutor().subscribe(
      "tasks.detail",
      { id: taskId },
      { onValue: (value) => setRead(value as TaskDetail), onError: () => {} },
    );
  }, [taskId, onBoard]);
  return listed ?? (read?.id === taskId ? read : undefined);
}

/** The frame a peek's task or key is in: its page's, or none for a page or a key in the window. */
function frameOf(peek: NonNullable<TaskPeek>): Element | null {
  if ("page" in peek) return peek.pageFrame;
  return "anchor" in peek ? null : peek.frame;
}

/** The element a peek's task or key is drawn in, which a scroll may carry away. */
function holderOf(peek: NonNullable<TaskPeek>): Element {
  if ("page" in peek) return peek.pageFrame ?? peek.page;
  return "anchor" in peek ? peek.anchor : peek.frame;
}

/** What a peek rests on: a task key, in a card's body or in the window, or a task in a panel's page. */
type PeekKind = "key" | "page";
const kindOf = (peek: NonNullable<TaskPeek>): PeekKind => ("page" in peek ? "page" : "key");

export function PeekSummary() {
  const pointed = useTaskPeek();
  // The summary opens a beat after the pointer lands, moves to the next task
  // or key at once, and fades as it goes (../../character/crew/summaryMotion).
  const { shown: peek, leaving } = useSummaryPresence(pointed);
  const rested = useRestedTask(pointed?.taskId ?? peek?.taskId ?? null);
  const modelName = useModelNames();
  const task = peek && rested?.id === peek.taskId ? rested : undefined;

  const open = peek !== null && task !== undefined;
  const openRef = useRef(open);
  openRef.current = open;
  const resting = pointed === null ? null : kindOf(pointed);
  useEffect(() => {
    if (!resting) return;
    const letGo = () => taskPeek.set(null);
    // Esc closes the summary it can see, and only that: a record open under
    // it stays. With nothing showing yet, Esc means what it always meant.
    // Any other key press lets a card's key go, since it may page the card away.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        if (resting === "key") letGo();
        return;
      }
      if (openRef.current) event.stopPropagation();
      letGo();
    };
    const onScroll = (event: Event) => {
      const at = taskPeek.get();
      const anchor = at && holderOf(at);
      if (anchor && event.target instanceof Node && event.target.contains(anchor)) letGo();
    };
    const onVisibility = () => {
      if (document.hidden) letGo();
    };
    // Crossing into a frame hands the window one move aimed at the frame
    // itself, often just after the frame reported the row or key: that
    // pointer is on it, not off it, and the frame does not report it again.
    const onMove = (event: PointerEvent) => {
      const at = taskPeek.get();
      // A panel's page in this document is under the pointer while over it;
      // one in a frame, while the window's move is aimed at that frame.
      if (at && "page" in at && !at.pageFrame) {
        if (!(event.target instanceof Node && at.page.contains(event.target))) letGo();
        return;
      }
      // A key the window draws is under the pointer while over it.
      if (at && "anchor" in at) {
        if (!(event.target instanceof Node && at.anchor.contains(event.target))) letGo();
        return;
      }
      if (!at || event.target !== frameOf(at)) letGo();
    };
    // A card's frame that leaves the window, or takes a new document (a
    // revision), takes the key it showed with it; so does a key the window
    // drew that leaves it.
    const frameWatch = new MutationObserver((records) => {
      const at = taskPeek.get();
      if (at && "anchor" in at && !at.anchor.isConnected) taskPeek.release(at.anchor);
      if (!at || !("frame" in at)) return;
      if (!at.frame.isConnected || records.some((record) => record.target === at.frame)) {
        taskPeek.release(at.frame);
      }
    });
    if (resting === "key") {
      frameWatch.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "srcdoc"],
      });
    }
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("keydown", onKey, { capture: true });
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", letGo);
    window.addEventListener("blur", letGo);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      frameWatch.disconnect();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("keydown", onKey, { capture: true });
      document.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", letGo);
      window.removeEventListener("blur", letGo);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [resting]);

  const layerRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const peekRef = useRef(peek);
  peekRef.current = peek;
  /** The hairline's angle as last placed: the way the summary slides in. */
  const angleRef = useRef(0);
  /** The panel last placed and the anchor it was placed for, so a new anchor moves it. */
  const placedFor = useRef<{ panel: HTMLElement; target: string } | null>(null);
  const place = useCallback(() => {
    const at = peekRef.current;
    const layer = layerRef.current;
    const line = lineRef.current;
    const panel = panelRef.current;
    if (!at || !layer || !line || !panel) return;
    const size = { width: panel.offsetWidth, height: panel.offsetHeight };
    let placed: SummaryPlacement;
    if ("page" in at) {
      // A page that left the window takes its task with it.
      if (!at.page.isConnected) {
        taskPeek.release(at.page);
        return;
      }
      const panel = at.page.closest("[data-side-panel]");
      // On its rail, beside the panel, as a Tasks row's summary sits; on the
      // stack, beside the very row or tile the page rests on, as the task
      // board's always has.
      placed = panel
        ? placeRowSummary(at.box, at.page.getBoundingClientRect(), size, summaryRoom(panel))
        : placeKeySummary(at.box, at.box, size, summaryRoom());
    } else if ("anchor" in at) {
      // A key that left the window takes its summary with it.
      if (!at.anchor.isConnected) {
        taskPeek.release(at.anchor);
        return;
      }
      placed = placeKeySummary(at.key, at.card, size, summaryRoom());
    } else {
      // A card that left the window takes its key with it.
      if (!at.frame.isConnected) {
        taskPeek.release(at.frame);
        return;
      }
      placed = placeKeySummary(at.key, at.card, size, summaryRoom());
    }
    const px = (value: number) => `${Math.round(value * 10) / 10}px`;
    panel.style.transform = `translate(${Math.round(placed.x)}px, ${Math.round(placed.y)}px)`;
    line.style.width = px(placed.line.length);
    line.style.transform = `translate(${px(placed.line.x)}, ${px(placed.line.y)}) rotate(${Math.round(placed.line.angle * 1000) / 1000}rad)`;
    angleRef.current = placed.line.angle;
    if (!layer.hasAttribute("data-placed")) layer.setAttribute("data-placed", "");
  }, []);
  // Placed before its first paint, and again when its text changes its size
  // (the record's own read fills the facts in). A first placement slides it
  // in; a new anchor moves it from where it stood.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const line = lineRef.current;
    if (!peek || !task || !panel || !line) return;
    const from = poseOf(panel, line);
    place();
    const target = `${kindOf(peek)}:${peek.taskId}`;
    const before = placedFor.current?.panel === panel ? placedFor.current.target : null;
    if (before === null) openSummary(panel, line, angleRef.current);
    else if (before !== target) moveSummary(panel, line, from, true);
    placedFor.current = { panel, target };
    const observer = new ResizeObserver(place);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [peek, task, place]);
  useSummaryFade(layerRef, leaving);

  if (!open) return null;
  const kind = kindOf(peek);
  return (
    <div
      ref={layerRef}
      className="fm-row-summary-layer"
      data-key-summary={kind === "key" ? peek.taskId : undefined}
      data-point-summary={kind === "page" ? peek.taskId : undefined}
      aria-hidden={leaving || undefined}
      style={{ "--crew-summary-max": `${CREW_HOVER.maxWidthPx}px` } as CSSProperties}
    >
      <div
        ref={lineRef}
        className="fm-crew-summary-line"
        data-key-summary-tie={kind === "key" ? "" : undefined}
        data-point-summary-tie={kind === "page" ? "" : undefined}
        aria-hidden="true"
      />
      <div ref={panelRef}>
        <CrewSummary taskId={peek.taskId} facts={{ task, modelName }} />
      </div>
    </div>
  );
}
