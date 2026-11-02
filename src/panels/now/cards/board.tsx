import type {
  PanelDropReview,
  PanelProps,
  PanelReads,
  PanelTaskBoard,
  PanelTaskDetail,
  PanelTaskMove,
  PanelTaskRow,
  StoreValue,
} from "@infinitary/contracts";
import {
  Button,
  focusWithRing,
  KeyCap,
  nowGroupOf,
  RowMenu,
  type RowMenuItem,
  TaskStatusMark,
  taskStatusLabel,
  taskStatusOf,
  taskWaitSummary,
  useMinute,
  waitRecordedTime,
} from "@infinitary/ui";
import {
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import styles from "../board.css";
import { type TileDrag, useTileDrag } from "../boardDrag";
import {
  type BoardAsk,
  type BoardMenuEntry,
  type BoardMove,
  type BoardTarget,
  boardDoneText,
  boardMenuOf,
  boardMovable,
  boardMoveOf,
  DRAG_STARTED,
  dropAskOf,
  MOVE_CANCELLED,
  moveContextOf,
} from "../boardMoves";
import {
  BOARD_COLUMN_PAGE,
  BOARD_EMPTY_WORDS,
  BOARD_FOCUS_COLUMNS,
  BOARD_LANE_LABELS,
  BOARD_LIST_PAGE,
  BOARD_WAITING_SHOWN,
  type BoardEarlier,
  type BoardLane,
  type BoardNavLayout,
  type BoardPage,
  type BoardTile,
  type BoardView,
  boardChipsOf,
  boardCountOf,
  boardEarlierOf,
  boardNavMove,
  boardPageOf,
  boardTilesOf,
  newInBacklog,
  type TilePoint,
} from "../boardTiles";

/**
 * The task board (docs/task-board.md; the design skill's
 * `components/now/TaskBoard`): the Tasks panel's one card view, put up on
 * the stack by its header's Open task board, its key and its commands, and
 * drawn in its own page like any panel's card. It is a focused board:
 * under the app's title row, one row of its own (the count, the project
 * chips, Find) and the views - Board, Backlog, Done · 7d, and Earlier
 * matches while Find has words - then Waiting on you, at most three tiles
 * of it, above the view: the Board's three columns of work not yet done,
 * Backlog, Queued and Working, five tiles a page, or one lane as a list
 * of twenty rows a page. The foot's Dropped · N opens dropped work as a
 * list too. Nothing draws more than a page, and every count is the whole
 * lane's. It reads the same board the Tasks panel paints, and names its
 * lanes and every tile's status with the panel's words.
 *
 * A click or Enter on a tile opens its task as a Tasks row does
 * (`point.openTask`), and resting on it opens the crew summary beside the
 * tile (`point.peekTask`). The selected tile is the turn's hint while the
 * card is shown (`point.aim`). The tiles are one Tab stop and the arrows
 * move through them, turning a lane's page to reach the tile they name
 * (../boardTiles.ts, `boardNavMove`).
 *
 * A tile on the Board moves by dragging it onto a column or the Drop task
 * tray (../boardDrag.ts), and any tile or row by its ⋯ menu, which Space
 * opens: each move is one of the panel API's moves (`tasks.run`,
 * ../boardMoves.ts). A move that asks once asks on the tile where it
 * landed - dashed in its destination column when the view draws it, else
 * in place, its status unchanged, with Cancel focused - and nothing is
 * written until the confirm. The live line under the foot says what each
 * move did or why it was refused; focus follows an accepted move and stays
 * after a refusal, and when a live change takes the focused tile away it
 * goes to the task where it is now, or the nearest row, and says so.
 *
 * What the board keeps while it pages with the cards - Find, view, each
 * lane's page, the selected tile and its scroll - is the card's kept place
 * (`card.keep`); Hide lets go of it. The project chips are the window's
 * project focus (`view.focusedProjectId`, the top bar's pill,
 * docs/project-focus.md), so the board opens on the focused project and
 * keeps it after Hide. Where a key that put it up
 * asks focus to go - its tiles, Find, a list, or the selected tile's menu -
 * is the card's data, answered once per time it was put up
 * (`card.revision`).
 */

/** What the board keeps on its card while it pages: its place, and the last ask it answered. */
type Place = {
  query: string;
  view: BoardView;
  /** Each lane's page, from 0, as its view last showed it. */
  pages: Partial<Record<PageKey, number>>;
  /** The tinted tile: the turn's hint while the board is shown. */
  selectedTaskId: string | null;
  scroll: { top: number; left: number };
  /** The card's revision whose focus ask this board answered. */
  answered: number;
};

const VIEWS: readonly BoardView[] = ["board", "backlog", "landed", "waiting", "dropped", "earlier"];
const LANES: readonly BoardLane[] = [
  "waiting",
  "backlog",
  "queued",
  "working",
  "landed",
  "dropped",
  "earlier",
];

/**
 * Where a lane's page is kept: by its lane, but the Board's Backlog column
 * apart from the Backlog list, whose pages are four times as long.
 */
type PageKey = BoardLane | "board-backlog";
const PAGE_KEYS: readonly PageKey[] = [...LANES, "board-backlog"];
const pageKeyOf = (view: BoardView, lane: BoardLane): PageKey =>
  view === "board" && lane === "backlog" ? "board-backlog" : lane;

const FRESH: Place = {
  query: "",
  view: "board",
  pages: {},
  selectedTaskId: null,
  scroll: { top: 0, left: 0 },
  answered: 0,
};

/** The place a card kept, read back as this page was born; anything else is a fresh board. */
function placeOf(kept: StoreValue): Place {
  if (!kept || typeof kept !== "object" || Array.isArray(kept)) return FRESH;
  const k = kept as Record<string, unknown>;
  const scroll = (k.scroll ?? {}) as Record<string, unknown>;
  const keptPages = (k.pages ?? {}) as Record<string, unknown>;
  const pages: Partial<Record<PageKey, number>> = {};
  for (const key of PAGE_KEYS) {
    const page = keptPages[key];
    if (typeof page === "number" && page > 0) pages[key] = page;
  }
  return {
    query: typeof k.query === "string" ? k.query : "",
    view: VIEWS.includes(k.view as BoardView) ? (k.view as BoardView) : "board",
    pages,
    selectedTaskId: typeof k.selectedTaskId === "string" ? k.selectedTaskId : null,
    scroll: {
      top: typeof scroll.top === "number" ? scroll.top : 0,
      left: typeof scroll.left === "number" ? scroll.left : 0,
    },
    answered: typeof k.answered === "number" ? k.answered : 0,
  };
}

/** Where a key that put the board up asks focus to go, and which view it opens. */
type FocusAsk = "tiles" | "find" | "dropped" | "menu" | "backlog" | "done";

const ASKS: readonly FocusAsk[] = ["tiles", "find", "dropped", "menu", "backlog", "done"];
/** The view a key's ask opens; the others keep the view the board is on. */
const ASK_VIEWS: Partial<Record<FocusAsk, BoardView>> = {
  dropped: "dropped",
  backlog: "backlog",
  done: "landed",
};

function focusAskOf(data: StoreValue): FocusAsk | null {
  const focus = (data as { focus?: unknown } | null)?.focus;
  return ASKS.includes(focus as FocusAsk) ? (focus as FocusAsk) : null;
}

/** A lane's name in a sentence: "Done · 7d", "Waiting on you". */
function laneName(lane: BoardLane): string {
  const label = BOARD_LANE_LABELS[lane];
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** How long Find waits for the earlier matches before saying they cannot be read. */
const EARLIER_WAIT_MS = 5_000;

/** A task board tile's element, by its task id. */
const tileSelector = (taskId: string) => `[data-board-tile="${CSS.escape(taskId)}"]`;

/**
 * Focuses what `find` names once this page may take focus - the app gives
 * it focus once a key has put the card up and it is drawn; until then a
 * page's own script cannot take it - trying each frame for up to two
 * seconds. A press of the header's button gives the page no focus, so focus
 * stays where it was.
 */
function focusWhenAble(find: () => HTMLElement | null, frames = 120): void {
  const element = find();
  if (element) {
    focusWithRing(element);
    if (document.activeElement === element) return;
  }
  if (frames > 0) requestAnimationFrame(() => focusWhenAble(find, frames - 1));
}

/** One task in full, read once: what Drop task's question names. Null when it cannot be read. */
function readDetail(reads: PanelReads, taskId: string): Promise<PanelTaskDetail | null> {
  return new Promise((resolve) => {
    let stop: (() => void) | null = null;
    let done = false;
    const finish = (detail: PanelTaskDetail | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      queueMicrotask(() => stop?.());
      resolve(detail);
    };
    const timer = setTimeout(() => finish(null), 5_000);
    stop = reads.subscribe("tasks.detail", { id: taskId }, finish);
    if (done) stop();
  });
}

/** A move waiting on its confirm, drawn on the tile where it landed. */
type PendingMove = BoardAsk & {
  taskId: string;
  key: string;
  from: BoardLane;
  /** Where its tile stood in `from`: a live change that takes it away puts focus on the nearest row. */
  index: number;
  target: BoardTarget;
  /** The reviewed effects a never-started Drop task sends. */
  review?: PanelDropReview;
  /** Start was accepted: keep the tile in Working until the board agrees. */
  held?: boolean;
  /** The task as it stood when it asked: a live change to it cancels the move. */
  signature: string;
  busy: boolean;
};

/** The live line: the last move's effect or refusal, announced once. */
type LiveLine = { text: string; tone: "said" | "refused" };

/** What Find's words found earlier: the answer once it came, or that none came. */
type Found = { query: string; tasks: PanelTaskRow[] | null; failed: boolean };

/** Where the focused tile was: a live change that takes it away puts focus on the nearest one. */
type FocusedAt = { taskId: string; key: string; lane: BoardLane; index: number };

/** What a live change to a task would make a pending move stale on. */
function signatureOf(task: PanelTaskRow): string {
  return JSON.stringify([
    task.status,
    task.activity,
    task.startPolicy,
    task.flags,
    task.blockedBy,
    task.children,
    task.waitingCardId,
    task.captainWait ?? false,
    task.startedAt,
    task.updatedAt,
  ]);
}

/** The newest write among the tiles the board lists, for the lag measure. */
function newestWrite(board: PanelTaskBoard, tiles: ReadonlyMap<BoardLane, BoardTile[]>): number {
  let newest = 0;
  for (const lane of tiles.values()) {
    for (const { task } of lane) if (task.updatedAt > newest) newest = task.updatedAt;
  }
  return board.tasks.length > 0 ? newest : 0;
}

/** One lane as its view draws it: the page shown, and how many a page holds. */
type DrawnLane = { lane: BoardLane; page: BoardPage; size: number };

export default function TaskBoardCard({ card, reads, point, tasks, view: windowView }: PanelProps) {
  const [board, setBoard] = useState<PanelTaskBoard | null>(null);
  // The place this page was born with, then the board's own as it moves.
  const born = useMemo(() => placeOf(card?.kept ?? null), [card?.kept]);
  const [place, setPlace] = useState<Place>(born);
  const rootRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<PendingMove | null>(null);
  const [live, setLive] = useState<LiveLine>({ text: "", tone: "said" });
  const [found, setFound] = useState<Found | null>(null);
  /** A task an accepted move is carrying elsewhere: focus follows its tile there. */
  const follow = useRef<{ taskId: string; from: BoardLane; index: number } | null>(null);
  /** Counts accepted moves, so focus follows one at once when the board already drew it. */
  const [followed, setFollowed] = useState(0);
  /** The tile focus is on, while it is. */
  const focusedAt = useRef<FocusedAt | null>(null);
  /** Where the body is scrolled, kept with the place without a render per scroll. */
  const scrolled = useRef(born.scroll);
  const answered = useRef(born.answered);

  useEffect(() => reads.subscribe("tasks.board", setBoard), [reads]);

  // The card keeps the board's place, so paging away and back finds it as it was.
  const keepPlace = useRef<() => void>(() => {});
  keepPlace.current = () => {
    void card
      ?.keep({ ...place, scroll: scrolled.current, answered: answered.current })
      .catch(() => {});
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: every move of the place is kept
  useEffect(() => keepPlace.current(), [place]);
  const scrollKept = useRef<number | null>(null);
  const keepScroll = () => {
    if (scrollKept.current !== null) return;
    scrollKept.current = window.setTimeout(() => {
      scrollKept.current = null;
      keepPlace.current();
    }, 150);
  };

  const patch = useCallback(
    (next: Partial<Place>) => setPlace((current) => ({ ...current, ...next })),
    [],
  );

  // Typed words ask the app for earlier done work; clearing them lets go,
  // and no answer in time says the earlier matches cannot be read.
  const typed = place.query.trim();
  useEffect(() => {
    if (!typed) {
      setFound(null);
      return;
    }
    let live = true;
    setFound({ query: typed, tasks: null, failed: false });
    const timer = setTimeout(() => {
      if (live) {
        setFound((last) =>
          last?.query === typed && last.tasks === null ? { ...last, failed: true } : last,
        );
      }
    }, EARLIER_WAIT_MS);
    const stop = reads.subscribe("tasks.search", { query: typed }, (rows) => {
      if (!live) return;
      clearTimeout(timer);
      setFound({ query: typed, tasks: rows, failed: false });
    });
    return () => {
      live = false;
      clearTimeout(timer);
      stop();
    };
  }, [reads, typed]);

  const chips = useMemo(() => (board ? boardChipsOf(board) : []), [board]);
  // The window's project focus is the board's project (the top bar's pill,
  // docs/project-focus.md): a chip here picks it, All projects clears it.
  const projectId = windowView.focusedProjectId;
  // A new focus, from here or anywhere, turns every lane back to its first page.
  const focusSeen = useRef(projectId);
  useEffect(() => {
    if (focusSeen.current === projectId) return;
    focusSeen.current = projectId;
    patch({ pages: {} });
  }, [projectId, patch]);
  const earlier: BoardEarlier | null = useMemo(
    () =>
      board && found?.tasks && found.query === typed
        ? boardEarlierOf(found.tasks, board, { query: typed, projectId })
        : null,
    [board, found, typed, projectId],
  );
  const listed = useMemo(() => {
    if (!board) return new Map<BoardLane, BoardTile[]>();
    const lanes = boardTilesOf(board, { query: place.query, projectId });
    lanes.set("earlier", earlier?.tiles ?? []);
    return lanes;
  }, [board, place.query, projectId, earlier]);

  // Earlier matches is a view only while Find has words.
  const view: BoardView = place.view === "earlier" && !typed ? "board" : place.view;
  const columnsOfView: readonly BoardLane[] = useMemo(
    () => (view === "board" ? BOARD_FOCUS_COLUMNS : [view]),
    [view],
  );

  // A move asking on its tile draws that tile in the column it landed on,
  // when this view draws that column; otherwise it asks where it is.
  const tiles = useMemo(() => {
    if (!pending) return listed;
    // A confirmed Start is Starting, which the board lists under Queued.
    const to = pending.held ? "queued" : pending.target;
    if (to === pending.from || to === "drop" || !columnsOfView.includes(to)) return listed;
    const moving = listed.get(pending.from)?.find((tile) => tile.task.id === pending.taskId);
    if (!moving) return listed;
    const moved = new Map(listed);
    moved.set(
      pending.from,
      (listed.get(pending.from) ?? []).filter((tile) => tile.task.id !== pending.taskId),
    );
    const there = [...(listed.get(to) ?? [])];
    const at = there.findIndex(
      (tile) =>
        tile.depth === 0 &&
        (tile.task.priority > moving.task.priority ||
          (tile.task.priority === moving.task.priority &&
            tile.task.createdAt > moving.task.createdAt)),
    );
    there.splice(at < 0 ? there.length : at, 0, { ...moving, depth: 0 });
    moved.set(to, there);
    return moved;
  }, [listed, pending, columnsOfView]);
  const lane = (name: BoardLane) => tiles.get(name) ?? [];
  const showProject = chips.length > 0 && projectId === null;
  const projectName = (task: PanelTaskRow) =>
    board?.projects.find((project) => project.id === task.projectId)?.name ?? "";

  // What this view draws: up to three of Waiting on you above it (none in
  // its own list), then its lanes, a page each. A lane turns to the page
  // that holds a move asking on it.
  const band = view === "waiting" ? [] : lane("waiting").slice(0, BOARD_WAITING_SHOWN);
  const drawn: DrawnLane[] = columnsOfView.map((name) => {
    const size = view === "board" ? BOARD_COLUMN_PAGE : BOARD_LIST_PAGE;
    const whole = lane(name);
    const asking = pending ? whole.findIndex((tile) => tile.task.id === pending.taskId) : -1;
    const page =
      asking >= 0 ? Math.floor(asking / size) : (place.pages[pageKeyOf(view, name)] ?? 0);
    return { lane: name, page: boardPageOf(whole, page, size), size };
  });
  /** A lane's tiles the keys walk: the whole lane, its other pages too. */
  const walkOf = (entry: DrawnLane) => lane(entry.lane).map((tile) => tile.task.id);
  const layout: BoardNavLayout = {
    row: band.map((tile) => tile.task.id),
    columns: drawn.map(walkOf),
  };
  const shownIds = [
    ...layout.row,
    ...drawn.flatMap((entry) => entry.page.tiles.map((tile) => tile.task.id)),
  ];
  const listedIds = useMemo(
    () => new Set([...listed.values()].flatMap((list) => list.map((tile) => tile.task.id))),
    [listed],
  );
  const selected =
    place.selectedTaskId && listedIds.has(place.selectedTaskId) ? place.selectedTaskId : null;
  // The tiles' one Tab stop: the selected tile while it is drawn, else the first.
  const stop = selected && shownIds.includes(selected) ? selected : (shownIds[0] ?? null);

  // A selected task the board no longer lists is no longer the turn's hint.
  useEffect(() => {
    if (!board || !place.selectedTaskId || selected) return;
    patch({ selectedTaskId: null });
    void point.aim(null).catch(() => {});
  }, [board, place.selectedTaskId, selected, point, patch]);

  // One paint of the board, measured when it lands; the lag from the app's
  // write is measured only for a write after this page was born.
  const newestSeen = useRef(0);
  if (board) performance.mark("board:render:start");
  useLayoutEffect(() => {
    if (board) performance.measure("board:render", "board:render:start");
  });
  useLayoutEffect(() => {
    if (!board) return;
    const newest = newestWrite(board, listed);
    if (newest > newestSeen.current && newestSeen.current > 0 && newest >= performance.timeOrigin) {
      performance.measure("board:lag", {
        start: Math.max(0, newest - performance.timeOrigin),
        end: performance.now(),
      });
    }
    if (newest > newestSeen.current) newestSeen.current = newest;
  }, [board, listed]);

  // Where the body was scrolled comes back when the board is born again;
  // another view starts at its top.
  const restored = useRef(false);
  const lastView = useRef(view);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!board || !body) return;
    if (!restored.current) {
      restored.current = true;
      body.scrollTop = scrolled.current.top;
      body.scrollLeft = scrolled.current.left;
    } else if (lastView.current !== view) {
      body.scrollTop = 0;
    }
    lastView.current = view;
  }, [board, view]);

  const tileOf = (taskId: string) =>
    rootRef.current?.querySelector<HTMLElement>(tileSelector(taskId)) ?? null;
  const menuOf = (taskId: string) =>
    rootRef.current?.querySelector<HTMLElement>(
      `[data-board-more="${CSS.escape(taskId)}"] button`,
    ) ?? null;

  const showView = (next: BoardView) => {
    focusedAt.current = null;
    follow.current = null;
    if (next !== place.view) patch({ view: next });
  };
  const setPage = (name: BoardLane, page: number) => {
    focusedAt.current = null;
    follow.current = null;
    patch({ pages: { ...place.pages, [pageKeyOf(view, name)]: page } });
  };

  const say = (text: string, tone: LiveLine["tone"] = "said") => setLive({ text, tone });
  /**
   * Focus back on a tile once it is drawn again - after a refusal, a cancel,
   * a drop that changed nothing, or a turn to its page - as soon as the
   * board has drawn.
   */
  const [refocus, setRefocus] = useState<{ taskId: string; n: number } | null>(null);
  const backTo = (taskId: string) => setRefocus((last) => ({ taskId, n: (last?.n ?? 0) + 1 }));
  /** Turns the lane that holds `taskId` in this view to its page, and focuses its tile there. */
  const turnTo = (taskId: string) => {
    for (const entry of drawn) {
      const index = walkOf(entry).indexOf(taskId);
      if (index < 0) continue;
      const page = Math.floor(index / entry.size);
      if (page !== entry.page.page) {
        patch({ pages: { ...place.pages, [pageKeyOf(view, entry.lane)]: page } });
      }
      break;
    }
    backTo(taskId);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: each ask to come back is answered once, against the tiles as drawn
  useLayoutEffect(() => {
    if (!refocus) return;
    focusWhenAble(() => tileOf(refocus.taskId), 30);
  }, [refocus]);

  /**
   * Where focus goes when the tile it was on is no longer drawn: the task
   * where this view draws it now, else the row now nearest its old place in
   * the same lane, else the tiles' stop. Null when its lane is not in this view.
   */
  const nearestTo = (was: { taskId: string; lane: BoardLane; index: number }) => {
    if (shownIds.includes(was.taskId) || drawn.some((e) => walkOf(e).includes(was.taskId))) {
      return was.taskId;
    }
    const entry = drawn.find((e) => e.lane === was.lane);
    if (!entry && !(was.lane === "waiting" && band.length > 0)) return stop;
    const walk = entry ? walkOf(entry) : layout.row;
    return walk[Math.min(was.index, walk.length - 1)] ?? stop;
  };
  /** The lane that lists a task now, or null when the board no longer does. */
  const laneHolding = (taskId: string): BoardLane | null => {
    for (const [name, list] of tiles) {
      if (list.some((tile) => tile.task.id === taskId)) return name;
    }
    return null;
  };

  // A key that put the board up, or brought it forward, puts focus in it
  // once its tiles are drawn: on the tiles' stop, in Find, or on a list it
  // opens; Move the selected task also opens that tile's menu. Each time
  // the card is put up is answered once, and a page born again does not
  // answer an ask its card already answered.
  const [asked, setAsked] = useState<FocusAsk | null>(null);
  const revision = card?.revision ?? 0;
  const ask = focusAskOf(card?.data ?? null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: an ask is answered once, as it comes
  useEffect(() => {
    if (!board || revision <= answered.current) return;
    answered.current = revision;
    keepPlace.current();
    if (!ask) return;
    const opens = ASK_VIEWS[ask];
    if (opens) showView(opens);
    setAsked(ask);
  }, [board, revision, ask]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: an ask is answered against the tiles as drawn
  useEffect(() => {
    if (!asked) return;
    setAsked(null);
    // A key that opens a list lands on its rows: the selected one, else the first.
    const rows = ASK_VIEWS[asked] ? (drawn[0]?.page.tiles ?? []) : [];
    const landing = rows.some((row) => row.task.id === selected)
      ? selected
      : (rows[0]?.task.id ?? stop);
    const target =
      asked === "find" || !landing ? () => findRef.current : () => tileOf(landing as string);
    focusWhenAble(target);
    if (asked === "menu" && stop) {
      const open = (frames: number) => {
        if (document.activeElement === tileOf(stop)) menuOf(stop)?.click();
        else if (frames > 0) requestAnimationFrame(() => open(frames - 1));
      };
      requestAnimationFrame(() => open(60));
    }
  }, [asked]);

  // Resting on a tile, with the pointer or the keyboard: the app opens the
  // crew summary beside it, level with the tile. The board lets it go when
  // the pointer leaves, on a press, on Esc, and when the tile moves or
  // leaves - a scroll of the body or a list among them. A scroll that left
  // the tile where the summary was placed keeps it: the event can come a
  // frame after the summary read the tile's box, which already held it.
  const peeked = useRef<{ taskId: string; tile: HTMLElement; box: string } | null>(null);
  const peek = (tile: HTMLElement | null, taskId?: string) => {
    if (!tile || !taskId) {
      if (!peeked.current) return;
      peeked.current = null;
      point.peekTask(null);
      return;
    }
    const { top, right, bottom, left } = tile.getBoundingClientRect();
    peeked.current = { taskId, tile, box: boxKey(tile) };
    point.peekTask({ taskId, box: { top, right, bottom, left } });
  };
  const letGo = (tile: HTMLElement) => {
    if (peeked.current?.tile === tile) peek(null);
  };
  const letGoIfMoved = () => {
    const at = peeked.current;
    if (at && (!at.tile.isConnected || boxKey(at.tile) !== at.box)) peek(null);
  };
  useLayoutEffect(letGoIfMoved);

  // An accepted move carries its tile to another lane, or off this view:
  // focus follows it there, or lands on the row now nearest where it was.
  // biome-ignore lint/correctness/useExhaustiveDependencies: an accepted move or the board's push triggers the follow; the tiles are read as drawn
  useEffect(() => {
    const going = follow.current;
    if (!going || !board) return;
    const element = tileOf(going.taskId);
    const now = element?.getAttribute("data-board-lane");
    if (element && now === going.from) return;
    const root = rootRef.current;
    const active = document.activeElement;
    follow.current = null;
    if (active && active !== document.body && !root?.contains(active)) return;
    if (element) {
      focusWithRing(element);
      return;
    }
    const next = nearestTo({ taskId: going.taskId, lane: going.from, index: going.index });
    if (next) turnTo(next);
  }, [tiles, followed]);

  // A live change took the focused tile away - another surface moved its
  // task, or a page shrank under it: focus goes to the task where this view
  // draws it now, else to the nearest row, and the live line says where the
  // task went.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the tiles as drawn are the trigger; the rest is read as it stands
  useLayoutEffect(() => {
    const was = focusedAt.current;
    if (!was || follow.current || !document.hasFocus()) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    focusedAt.current = null;
    const next = nearestTo(was);
    if (next) turnTo(next);
    const where = laneHolding(was.taskId);
    if (where !== was.lane) {
      say(
        where ? `${was.key} moved to ${laneName(where)}.` : `${was.key} is no longer on the board.`,
      );
    }
  }, [tiles, board]);

  // A live change to the task a move is asking about cancels the move, and
  // focus goes where a live change sends it: to the task where this view
  // draws it now, else to the row now nearest where it stood - at once,
  // never later onto a tile another view draws.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new board or move is the trigger; say and turnTo only write
  useEffect(() => {
    if (!pending || pending.busy || pending.held || !board) return;
    const task = board.tasks.find((row) => row.id === pending.taskId);
    if (task && signatureOf(task) === pending.signature) return;
    setPending(null);
    say(`${pending.key} changed, so the move was cancelled. Nothing was written.`, "refused");
    const next = nearestTo({ taskId: pending.taskId, lane: pending.from, index: pending.index });
    if (next) turnTo(next);
  }, [board, pending]);

  const open = (task: PanelTaskRow) => {
    void point.openTask(task.id).catch(() => {});
  };

  /** Runs one of the moves on the task: null when the app took it, else why not. */
  const run = async (
    task: PanelTaskRow,
    move: PanelTaskMove,
    review?: PanelDropReview,
  ): Promise<string | null> => {
    if (!tasks) return "This board cannot move tasks here.";
    try {
      const result = await tasks.run(task.id, move, review);
      return result.ok ? null : result.text;
    } catch (caught) {
      return caught instanceof Error ? caught.message : String(caught);
    }
  };
  const accepted = (task: PanelTaskRow, from: BoardLane, text: string) => {
    const index = lane(from).findIndex((tile) => tile.task.id === task.id);
    follow.current = { taskId: task.id, from, index: Math.max(0, index) };
    setFollowed((n) => n + 1);
    say(text);
  };
  const refused = (taskId: string, text: string) => {
    say(text, "refused");
    backTo(taskId);
  };

  /** A tile dropped on a lane or the tray, or the menu entry that does the same. */
  const perform = async (task: PanelTaskRow, from: BoardLane, target: BoardTarget) => {
    const move: BoardMove = boardMoveOf(task, from, target, moveContextOf(task));
    switch (move.kind) {
      case "none":
        say(move.text);
        backTo(task.id);
        return;
      case "refused":
        refused(task.id, move.text);
        return;
      case "card":
        // A pointing gesture: the card's own button merges, never the drop.
        if (await point.showCard(move.cardId).catch(() => false)) {
          say("Brought its completion card forward. Only the card's own button merges.");
        } else {
          refused(task.id, "Its completion card is no longer up.");
        }
        return;
      case "now": {
        const why = await run(task, move.op);
        if (why) refused(task.id, why);
        else accepted(task, from, move.done);
        return;
      }
      case "ask": {
        let asking: PendingMove = {
          ...move,
          taskId: task.id,
          key: task.key,
          from,
          index: Math.max(
            0,
            lane(from).findIndex((tile) => tile.task.id === task.id),
          ),
          target,
          signature: signatureOf(task),
          busy: false,
        };
        // A never-started Drop task asks in its record's own words, from the
        // effects its record lists, and the app checks them again.
        if (move.op === "drop-task") {
          const detail = await readDetail(reads, task.id);
          const reviewed = dropAskOf(task.key, detail?.dropEffects);
          if (reviewed.kind === "refused") {
            refused(task.id, reviewed.text);
            return;
          }
          asking = { ...asking, sentence: reviewed.sentence, review: reviewed.review };
        }
        setPending(asking);
        say(
          move.op === "drop-task" || move.op === "stop-task"
            ? "Drop task asks once. Cancel writes nothing."
            : "The tile landed and asks once. Cancel returns it.",
        );
        return;
      }
    }
  };

  // The tile that landed and asks is brought into view whole.
  const askedOn = pending ? `${pending.taskId}:${pending.target}` : null;
  useEffect(() => {
    if (!askedOn) return;
    requestAnimationFrame(() =>
      rootRef.current
        ?.querySelector("[data-board-pending]")
        ?.scrollIntoView({ block: "nearest", inline: "nearest" }),
    );
  }, [askedOn]);

  const cancelPending = () => {
    if (!pending) return;
    setPending(null);
    say(MOVE_CANCELLED);
    backTo(pending.taskId);
  };
  const confirmPending = async () => {
    if (!pending || pending.busy) return;
    const task = board?.tasks.find((row) => row.id === pending.taskId);
    if (!task) return;
    setPending({ ...pending, busy: true });
    const why = await run(task, pending.op, pending.review);
    if (why) {
      setPending(null);
      refused(task.id, why);
      return;
    }
    if (pending.op === "start-task") {
      setPending({ ...pending, busy: true, held: true });
      accepted(task, pending.from, boardDoneText(task.key, pending.op));
      return;
    }
    setPending(null);
    accepted(task, pending.from, boardDoneText(task.key, pending.op));
  };
  // A held Start stays in Queued until the shared board agrees, or the attempt fails.
  useEffect(() => {
    if (!pending?.held || !board) return;
    const task = board.tasks.find((row) => row.id === pending.taskId) as
      | (PanelTaskRow & {
          startAttempt?: { phase: "preparing" | "checking"; since: number };
          startNotice?: { reason: string };
        })
      | undefined;
    if (!task) {
      setPending(null);
      return;
    }
    if (
      task.startAttempt?.phase === "preparing" ||
      task.startAttempt?.phase === "checking" ||
      task.startNotice ||
      nowGroupOf(task) === "working" ||
      task.status === "active"
    ) {
      setPending(null);
    }
  }, [board, pending]);

  const byId = (taskId: string) => board?.tasks.find((row) => row.id === taskId);
  const drag = useTileDrag(bodyRef, {
    onOver: ({ taskId, from, over }: TileDrag) => {
      const task = byId(taskId);
      if (!task) return;
      if (!over) {
        say(DRAG_STARTED);
        return;
      }
      const move = boardMoveOf(task, from, over, moveContextOf(task));
      say(
        move.kind === "ask" ? move.sentence : move.text,
        move.kind === "refused" ? "refused" : "said",
      );
    },
    onDrop: ({ taskId, from }, target) => {
      const task = byId(taskId);
      if (!task) return;
      if (!target) {
        say(MOVE_CANCELLED);
        backTo(taskId);
        return;
      }
      void perform(task, from, target);
    },
    onCancel: ({ taskId }) => {
      say(MOVE_CANCELLED);
      backTo(taskId);
    },
  });
  const dragging = drag.drag;
  const dragged = dragging ? byId(dragging.taskId) : undefined;

  // Esc, in its order: an open menu closes, then the summary, then a move
  // that asks lets go, then Find clears; an Escape none of them used hides
  // the card. A drag lets go of its own Escape first.
  const onEscapeKey = useRef<(event: KeyboardEvent) => void>(() => {});
  onEscapeKey.current = (event) => {
    if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
    if (dragging) return;
    if (document.querySelector('[role="menu"]')) {
      // The menu closes itself; the card stays.
      event.preventDefault();
      return;
    }
    if (peeked.current) {
      event.preventDefault();
      peek(null);
      return;
    }
    if (pending) {
      event.preventDefault();
      cancelPending();
      return;
    }
    if (place.query) {
      event.preventDefault();
      patch({ query: "", pages: {} });
    }
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => onEscapeKey.current(event);
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  /**
   * How a lane or the tray answers the tile in the air: it takes it, or it
   * refuses; the tile's own lane says neither, since a drop there changes nothing.
   */
  const answers = (target: BoardTarget): "yes" | "no" | undefined => {
    if (!dragging || !dragged) return undefined;
    const move = boardMoveOf(dragged, dragging.from, target, moveContextOf(dragged));
    return move.kind === "none" ? undefined : move.kind === "refused" ? "no" : "yes";
  };
  const dropProps = (target: BoardTarget) =>
    view === "board"
      ? {
          "data-board-drop": target,
          "data-board-accepts": answers(target),
          "data-board-over": dragging?.over === target ? "" : undefined,
        }
      : {};

  const pointAt = (taskId: string): TilePoint | undefined => {
    const tile = tileOf(taskId);
    if (!tile) return undefined;
    const { left, top, width, height } = tile.getBoundingClientRect();
    return { x: left + width / 2, y: top + height / 2 };
  };
  const onTileKey = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const from = (event.target as HTMLElement)
      .closest("[data-board-tile]")
      ?.getAttribute("data-board-tile");
    if (!from || !(event.target as HTMLElement).matches("[data-board-tile]")) return;
    // Space opens the tile's menu, the keyboard's way to do what a drag does.
    if (event.key === " ") {
      event.preventDefault();
      menuOf(from)?.click();
      return;
    }
    const next = boardNavMove(layout, from, event.key, pointAt);
    if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") {
      event.preventDefault();
    }
    if (!next) return;
    // A tile on another page of its lane: the lane turns to it.
    const there = tileOf(next);
    if (there) there.focus();
    else turnTo(next);
  };

  const menuItems = (task: PanelTaskRow, tileLane: BoardLane): RowMenuItem[] =>
    boardMenuOf(task, tileLane, moveContextOf(task)).map((entry: BoardMenuEntry) => {
      if ("separator" in entry) return { separator: true };
      const pick = () => {
        // The menu hands focus back to the tile before an entry runs.
        if (entry.id === "open") {
          void point.openRecord(task.id).catch(() => {});
        } else if (entry.id === "card") {
          open(task);
        } else if (entry.id === "continue") {
          void run(task, "continue-task").then((why) =>
            why ? refused(task.id, why) : say(boardDoneText(task.key, "continue-task")),
          );
        } else if (entry.target) {
          void perform(task, tileLane, entry.target);
        }
      };
      return {
        id: entry.id,
        label: entry.label,
        ...(entry.detail ? { detail: entry.detail } : {}),
        ...(entry.disabled ? { disabled: true } : {}),
        ...(entry.danger ? { tone: "danger" as const } : {}),
        onSelect: pick,
      };
    });

  /** A tile's face: its mark and key, its one word, the project, the title and the status. */
  const face = (task: PanelTaskRow, word: string, row = false) => {
    const reading = taskStatusOf(task);
    const project = projectName(task);
    const wait = showsKanbanWait(task, row);
    return (
      <>
        <span className="fm-board-tile-head">
          <TaskStatusMark reading={reading} nativeTitle={false} />
          <span className="fm-board-tile-key">{task.key}</span>
          {word && (
            <span
              className="fm-board-tile-word"
              data-board-word={word === "urgent" ? "urgent" : word.split(" ")[0]}
            >
              {`· ${word}`}
            </span>
          )}
          {showProject && project && (
            <span className="fm-board-tile-project" data-board-project="">
              {project}
            </span>
          )}
        </span>
        <span className="fm-board-tile-title" data-board-title="">
          {task.title}
        </span>
        <span
          className="fm-board-tile-status"
          data-board-status=""
          data-board-structured-wait={wait ? "" : undefined}
          data-board-queue-wait={task.queueWait?.line === reading.reason ? "" : undefined}
          data-board-failed={reading.reason === "Could not start" ? "" : undefined}
        >
          {wait ? (
            <KanbanWait task={task} word={reading.word} />
          ) : (
            <>
              <span className="fm-board-tile-word-status">{reading.word}</span>
              {task.program &&
                ` · ${task.children.closed} of ${task.children.total} parts finished`}
              {reading.reason && ` · ${reading.reason}`}
            </>
          )}
        </span>
        {!wait &&
          task.queueWait &&
          (reading.mark === "queued" || reading.mark === "backlog") &&
          reading.reason !== task.queueWait.line && (
            <span className="fm-board-tile-status" data-board-queue-wait="">
              {task.queueWait.line}
            </span>
          )}
        {!wait && reading.since !== undefined && (
          // When the one wait was recorded, never when work stopped (INF-38).
          <span className="fm-board-tile-since" data-board-wait-since="">
            {`Wait recorded ${waitRecordedTime(reading.since, Date.now())}`}
          </span>
        )}
      </>
    );
  };

  /** A tile in a column, or a row of a list or of Waiting on you (`row`). */
  const tile = ({ task, depth, word }: BoardTile, tileLane: BoardLane, row = false) => {
    const reading = taskStatusOf(task);
    const label = taskStatusLabel(reading);
    const project = projectName(task);
    const asking = pending?.taskId === task.id ? pending : null;
    // Only the Board's tiles are picked up; a list moves by its rows' menus.
    const movable = Boolean(task.key) && view === "board" && boardMovable(tileLane) && !asking;
    const items = asking ? [] : menuItems(task, tileLane);
    return (
      <div
        key={task.id}
        className="fm-board-card"
        data-board-card={task.id}
        data-board-pending={asking ? "" : undefined}
        data-board-lifted={dragging?.taskId === task.id ? "" : undefined}
        style={
          depth > 0
            ? ({ marginLeft: `calc(${depth} * var(--space-3))` } as CSSProperties)
            : undefined
        }
      >
        <button
          type="button"
          className="fm-board-tile"
          data-board-tile={task.id}
          data-board-key={task.key}
          data-board-lane={tileLane}
          data-board-row={row ? "" : undefined}
          data-board-selected={selected === task.id ? "" : undefined}
          // A rest anywhere in the window lights the tile as its own rest does (INF-237).
          data-board-lit={windowView.litTaskId === task.id ? "" : undefined}
          data-board-movable={movable ? "" : undefined}
          tabIndex={stop === task.id ? 0 : -1}
          aria-label={`${task.key} · ${task.title} · ${project} · ${showsKanbanWait(task, row) ? reading.word : label}`}
          aria-describedby={showsKanbanWait(task, row) ? `wait-${task.id}` : undefined}
          aria-keyshortcuts={items.length > 0 ? "Space" : undefined}
          onClick={() => {
            if (drag.swallowsClick() || asking) return;
            open(task);
          }}
          onPointerEnter={(event) => {
            if (!dragging) peek(event.currentTarget, task.id);
          }}
          onPointerLeave={(event) => letGo(event.currentTarget)}
          onPointerDown={(event) => {
            letGo(event.currentTarget);
            if (movable && !pending) drag.begin(event, task.id, tileLane);
          }}
          // The tile focus is on is the selected one, the turn's hint; the
          // keyboard rests on it as the pointer does: its summary opens beside
          // it. A focus that scrolled the body to show the tile sends that
          // scroll before the next frame's callbacks, so the summary is asked
          // for then.
          onFocus={(event: FocusEvent<HTMLButtonElement>) => {
            focusedAt.current = {
              taskId: task.id,
              key: task.key,
              lane: tileLane,
              index: Math.max(
                0,
                (tileLane === "waiting" && view !== "waiting" ? band : lane(tileLane)).findIndex(
                  (entry) => entry.task.id === task.id,
                ),
              ),
            };
            if (place.selectedTaskId !== task.id) {
              patch({ selectedTaskId: task.id });
              void point.aim(task.id).catch(() => {});
            }
            const focused = event.currentTarget;
            if (!focused.matches(":focus-visible")) return;
            requestAnimationFrame(() => {
              if (document.activeElement === focused) peek(focused, task.id);
            });
          }}
          onBlur={(event) => {
            // Focus moved on to something else here; a tile that left the
            // page takes focus with it and is answered after the change.
            if (event.relatedTarget instanceof Element) focusedAt.current = null;
            letGo(event.currentTarget);
          }}
        >
          {face(task, word, row)}
        </button>
        {items.length > 0 && (
          <span className="fm-board-more" data-board-more={task.id}>
            <RowMenu
              label={`${task.key} actions`}
              items={items}
              size={24}
              triggerTabIndex={-1}
              restoreFocus={() => tileOf(task.id)}
            />
          </span>
        )}
        {asking && (
          <div className="fm-board-confirm" data-board-confirm={asking.op}>
            <p className="fm-board-confirm-text">{asking.sentence}</p>
            <div className="fm-board-confirm-acts">
              <span data-board-confirm-act="cancel">
                <Button
                  variant="secondary"
                  size="sm"
                  autoFocus
                  disabled={asking.busy}
                  onClick={cancelPending}
                  style={{ flex: 1 }}
                >
                  Cancel
                </Button>
              </span>
              <span data-board-confirm-act="go">
                <Button
                  variant={
                    asking.op === "drop-task" || asking.op === "stop-task" ? "danger" : "primary"
                  }
                  size="sm"
                  pending={asking.busy}
                  onClick={() => void confirmPending()}
                  style={{ flex: 1 }}
                >
                  {asking.confirm}
                </Button>
              </span>
            </div>
          </div>
        )}
      </div>
    );
  };

  const laneHead = (name: BoardLane, extra?: ReactNode) => (
    <div className="fm-board-lane-head" data-board-lane-head={name}>
      <span className="fm-board-lane-label">{BOARD_LANE_LABELS[name]}</span>
      <span className="fm-board-n" data-board-count={name}>
        {lane(name).length}
      </span>
      {name === "backlog" &&
        lane(name).filter(
          (tile) =>
            (tile.task as PanelTaskRow & { startNotice?: { reason: string } }).startNotice != null,
        ).length > 0 && (
          <span className="fm-board-n" data-board-failed={name}>
            {`${
              lane(name).filter(
                (tile) =>
                  (tile.task as PanelTaskRow & { startNotice?: { reason: string } }).startNotice !=
                  null,
              ).length
            } could not start`}
          </span>
        )}
      {extra}
    </div>
  );
  const empty = (name: BoardLane) => (
    <div className="fm-board-empty" data-board-empty={name}>
      {BOARD_EMPTY_WORDS[name]}
    </div>
  );
  /** "21–40 of 300": where a page sits in its lane. */
  const range = (at: BoardPage) => `${at.first}–${at.last} of ${at.total}`;
  /** Previous and Next for a lane's pages: dim, never gone, at either end, so focus stays on them. */
  const pager = (name: BoardLane, at: BoardPage) => {
    if (at.pages <= 1) return null;
    const turn = (page: number) => {
      if (page < 0 || page >= at.pages) return;
      setPage(name, page);
    };
    return (
      <span className="fm-board-pager">
        <button
          type="button"
          className="fm-board-page"
          data-board-page-prev={name}
          aria-disabled={at.page === 0 ? "true" : undefined}
          aria-label={`Previous page of ${laneName(name)}`}
          onClick={() => turn(at.page - 1)}
        >
          Previous
        </button>
        <button
          type="button"
          className="fm-board-page"
          data-board-page-next={name}
          aria-disabled={at.page === at.pages - 1 ? "true" : undefined}
          aria-label={`Next page of ${laneName(name)}`}
          onClick={() => turn(at.page + 1)}
        >
          Next
        </button>
      </span>
    );
  };

  const fresh = newInBacklog(tiles);
  const dropped = lane("dropped");
  const waitingAll = lane("waiting");

  /** One of the Board's columns: its head, a page of its tiles, and its foot. */
  const column = ({ lane: name, page: at }: DrawnLane) => (
    <div
      key={name}
      className="fm-board-column fm-board-lane"
      data-board-lane={name}
      {...dropProps(name as BoardTarget)}
    >
      {laneHead(name)}
      {at.tiles.length > 0 ? at.tiles.map((t) => tile(t, name)) : empty(name)}
      {at.pages > 1 ? (
        <div className="fm-board-column-foot" data-board-column-foot={name}>
          <span className="fm-board-n" data-board-range={name}>
            {range(at)}
          </span>
          {pager(name, at)}
        </div>
      ) : null}
    </div>
  );

  /** A lane as a list: its head with Previous and Next, a page of rows, and its foot with the range. */
  const list = ({ lane: name, page: at }: DrawnLane) => {
    const note =
      name !== "earlier" ? null : found?.failed && !found.tasks ? (
        <p className="fm-board-list-note" data-board-earlier-note="unavailable">
          Earlier results are unavailable right now. Done · 7d still lists this week’s.
        </p>
      ) : !earlier ? (
        <p className="fm-board-list-note" data-board-earlier-note="reading">
          Looking for earlier tasks…
        </p>
      ) : earlier.capped ? (
        <p className="fm-board-list-note" data-board-earlier-note="capped">
          The search stops at its newest matches. Type more of a key or title to narrow them.
        </p>
      ) : null;
    return (
      <section
        key={name}
        className="fm-board-list"
        data-board-list={name}
        aria-label={`${laneName(name)}, ${at.total} ${at.total === 1 ? "task" : "tasks"}`}
      >
        <div className="fm-board-list-head">
          {laneHead(
            name,
            <>
              {name === "backlog" && fresh > 0 && (
                <span className="fm-board-n" data-board-new="">{`· ${fresh} new`}</span>
              )}
              {name === "dropped" && <span className="fm-board-lane-note">Read-only</span>}
              {pager(name, at)}
            </>,
          )}
        </div>
        {note}
        <div
          key={`${name}:${at.page}`}
          className="fm-board-rows fm-board-list-rows"
          data-board-list-rows=""
          onScroll={letGoIfMoved}
        >
          {at.tiles.length > 0
            ? at.tiles.map((t) => tile(t, name, true))
            : (name !== "earlier" || earlier) && empty(name)}
        </div>
        {at.total > 0 && (
          <div className="fm-board-list-foot">
            <span className="fm-board-n" data-board-range={name}>
              {range(at)}
            </span>
            {pager(name, at)}
          </div>
        )}
      </section>
    );
  };

  /** A view's button: Board, Backlog · N, Done · 7d · N, Earlier matches · N. */
  const viewTab = (target: BoardView, label: string, extra?: string) => (
    <button
      type="button"
      className="fm-board-view"
      data-board-view-tab={target}
      aria-pressed={view === target ? "true" : "false"}
      onClick={() => showView(target)}
    >
      {label}
      {extra && (
        <span className="fm-board-n" data-board-view-count={target}>
          {extra}
        </span>
      )}
    </button>
  );
  const earlierCount = earlier ? `${earlier.tiles.length}${earlier.capped ? "+" : ""}` : undefined;

  return (
    <section
      ref={rootRef}
      className="fm-board"
      data-task-board=""
      data-board-view={view}
      data-board-dragging={dragging ? "" : undefined}
      aria-label="Task board"
    >
      <style>{styles}</style>
      <div className="fm-board-chrome" data-board-chrome="">
        <span className="fm-board-n" data-board-total="">
          {boardCountOf(tiles)}
        </span>
        {chips.length > 0 && (
          <div className="fm-board-chips" data-board-chips="">
            {chips.map((chip) => (
              <button
                key={chip.id ?? "all"}
                type="button"
                className="fm-board-chip"
                // A chip's handle is its project's key, as on the Tasks panel.
                data-board-chip={chip.id === null ? "all" : chip.label}
                aria-pressed={projectId === chip.id ? "true" : "false"}
                onClick={() => void point.focusProject(chip.id).catch(() => false)}
              >
                {chip.label}
              </button>
            ))}
          </div>
        )}
        <input
          ref={findRef}
          type="search"
          className="fm-board-find"
          data-board-find=""
          placeholder="Find a task"
          aria-label="Find on task board"
          autoComplete="off"
          value={place.query}
          onChange={(event) => patch({ query: event.currentTarget.value, pages: {} })}
          onKeyDown={(event) => {
            // ↓ from Find goes to the first tile it left.
            if (event.key !== "ArrowDown" || event.nativeEvent.isComposing || !stop) return;
            event.preventDefault();
            tileOf(stop)?.focus();
          }}
        />
      </div>
      <nav className="fm-board-views" data-board-views="" aria-label="Task board views">
        {viewTab("board", "Board")}
        {viewTab(
          "backlog",
          "Backlog",
          `${lane("backlog").length}${fresh > 0 ? ` · ${fresh} new` : ""}`,
        )}
        {viewTab("landed", "Done · 7d", String(lane("landed").length))}
        {typed && viewTab("earlier", "Earlier matches", earlierCount)}
      </nav>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the arrows move between the tiles inside */}
      <div
        ref={bodyRef}
        className="fm-board-body"
        data-board-body=""
        onKeyDown={onTileKey}
        onScroll={(event) => {
          scrolled.current = {
            top: event.currentTarget.scrollTop,
            left: event.currentTarget.scrollLeft,
          };
          keepScroll();
          // The summary sits level with a tile that just moved: it lets go.
          letGoIfMoved();
        }}
      >
        {view !== "waiting" && (
          <>
            <div
              className="fm-board-lane fm-board-band"
              data-board-lane="waiting"
              {...dropProps("waiting")}
            >
              {laneHead(
                "waiting",
                <>
                  <span className="fm-board-lane-note">Cards waiting for you</span>
                  {waitingAll.length > band.length && (
                    <button
                      type="button"
                      className="fm-board-page"
                      data-board-browse="waiting"
                      onClick={() => showView("waiting")}
                    >
                      {`Show all ${waitingAll.length}`}
                    </button>
                  )}
                </>,
              )}
              {band.length > 0 ? (
                <div className="fm-board-rows">{band.map((t) => tile(t, "waiting", true))}</div>
              ) : (
                empty("waiting")
              )}
            </div>
            <hr className="fm-board-rule" />
          </>
        )}
        {view === "board" ? (
          <div className="fm-board-columns">{drawn.map(column)}</div>
        ) : (
          drawn.map(list)
        )}
      </div>
      <div className="fm-board-foot" data-board-foot="">
        <button
          type="button"
          className="fm-board-dropped-toggle"
          data-board-dropped-toggle=""
          aria-pressed={view === "dropped" ? "true" : "false"}
          onClick={() => showView(view === "dropped" ? "board" : "dropped")}
        >
          {`Dropped · ${dropped.length}`}
        </button>
        {/* The Drop task tray: there only while a tile is in the air. */}
        {dragging && (
          <div className="fm-board-tray" data-board-drop-tray="" {...dropProps("drop")}>
            Drop task
          </div>
        )}
        <span className="fm-board-hint" data-board-hint="">
          Arrows move · <KeyCap>Enter</KeyCap> opens · <KeyCap>Space</KeyCap> menu
        </span>
      </div>
      <p
        className="fm-board-live"
        data-board-live={live.text ? live.tone : undefined}
        role="status"
        aria-live="polite"
      >
        {live.text}
      </p>
      {drag.ghost && dragged && (
        <div
          ref={drag.ghostRef}
          className="fm-board-tile fm-board-ghost"
          aria-hidden="true"
          style={{ left: drag.ghost.left, top: drag.ghost.top, width: drag.ghost.width }}
        >
          {face(
            dragged,
            tiles.get(dragging?.from ?? "queued")?.find((entry) => entry.task.id === dragged.id)
              ?.word ?? "",
          )}
        </div>
      )}
    </section>
  );
}

/** Where a tile sits in the page, to the pixel. */
function boxKey(tile: HTMLElement): string {
  const { top, left, width, height } = tile.getBoundingClientRect();
  return [top, left, width, height].map(Math.round).join(",");
}

/** The existing timed-fact clock invalidates only this tile's time-varying text. */
function KanbanWait({ task, word }: { task: PanelTaskRow; word: string }) {
  const now = useMinute();
  const wait = taskWaitSummary(task.waits ?? [], now);
  if (!wait) return null;
  return (
    <span className="fm-board-wait" data-board-wait="" id={`wait-${task.id}`}>
      <span className="fm-board-wait-head">
        <span className="fm-board-tile-word-status">
          {word}
          {task.program && ` · ${task.children.closed} of ${task.children.total} parts finished`}
        </span>
        <span className="fm-board-wait-names">{` · ${wait.names}`}</span>
      </span>
      <span className="fm-board-wait-event">{wait.event}</span>
    </span>
  );
}

function showsKanbanWait(
  task: PanelTaskRow & { startNotice?: { reason: string } },
  row: boolean,
): boolean {
  const reading = taskStatusOf(task);
  return (
    !row &&
    Boolean(task.waits?.length) &&
    !reading.outOfReach &&
    reading.mark !== "starting" &&
    reading.mark !== "interrupted" &&
    !task.startNotice
  );
}
