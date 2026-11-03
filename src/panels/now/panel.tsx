import type { PanelAskVia, PanelProps, PanelTaskBoard, PanelTaskRow } from "@infinitary/contracts";
import {
  DEPENDENCY_VISUAL,
  focusWithRing,
  IconButton,
  listEdges,
  PanelExpandChevron,
  TaskStatusMark,
  taskStatusLabel,
  taskStatusOf,
  useInPlaceReveal,
  useRestLabel,
} from "@infinitary/ui";
import {
  type CSSProperties,
  type FocusEvent,
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { groupNavKey, nowNavItems, nowNavMove, rovingKey, rowNavKey } from "./nav";
import styles from "./panel.css";
import { reconcileBoard, reconcileRows } from "./reconcile";
import {
  earlierRowsOf,
  failedStartCount,
  hasSingleRegisteredRepoProject,
  NOW_GROUPS,
  type NowRow,
  newestListedWrite,
  newFilingCount,
  OPEN_BY_DEFAULT,
  onRail,
  PANEL_GROUP_LABELS,
  type PanelGroup,
  projectChipsOf,
  projectNameOf,
  rowStartOf,
  rowsOf,
  rowTrailing,
  summaryOf,
  wordOf,
} from "./rows";

/**
 * The Tasks panel (task-system design section 10, P4; the design skill's
 * NowPanel for the look): an ordinary panel folder (docs/ui-plugins.md,
 * "The app's own panels are ordinary folders"), compiled by the panel
 * compiler into the app's pinned library and drawn in its own page like a
 * panel added from elsewhere, on the API every panel gets. It reads the
 * live board (`tasks.board`) and paints rows for "waiting on you" and
 * "working", with the other groups collapsed to a count.
 *
 * Its own code says whether it shows and what it holds (`rail`): it is on
 * its rail once the board holds an ask's record or a row it lists, and
 * collapsed, its header reads how many tasks wait on the captain and how
 * many work.
 *
 * A click is a pointing gesture, never a write: a row opens its task
 * (`point.openTask`: its waiting card forward, or its record at the front
 * of the stack); a collapsed group's header expands it. The header's Search
 * tasks button is pressed into the panel as an ask: its click opens or
 * closes the search, its key (Find a task) always opens it with the caret
 * in it. Close search beside the field closes it too, and Esc in the search
 * empties its words, then closes it. Closing lets go of the words, so every
 * task shows again; closed from the keyboard, focus goes to the list. The
 * project chips are the window's project focus (`view.focusedProjectId`,
 * the top bar's pill, docs/project-focus.md): a chip picks it, All clears
 * it, and closing the search keeps it. Typed words also ask the app for closed work the board no
 * longer lists (`tasks.search`) and paint it as an `earlier` group.
 *
 * A backlog row offers its record's Start while the pointer or the keyboard
 * rests on it (INF-1663, the captain's direction A on INF-1662): a button
 * beside the row, over its right end, so the row stays one button that opens
 * the record. One press runs the record's own Start (`tasks.run`), and the
 * row moves to Queued as starting; a row the record could not start offers
 * Try again; one that cannot start shows it dim, with the record's reason on
 * rest. → from the row reaches it, Enter presses it and ← goes back.
 *
 * The rows of the tasks whose records are open on the stack are tinted
 * (`view.openTaskIds`), including a record paged away from.
 *
 * Resting is a pointing gesture too (FI3-565 piece 3): the row the pointer
 * or the keyboard rests on goes to the app with its box (`point.peekTask`),
 * and the app opens the crew summary beside the panel, level with it. The
 * panel lets it go when the pointer or the keyboard leaves that row, on a
 * press, on Esc, and when the list moves under the pointer. Leaving another
 * row lets nothing go: focus leaving the row a click opened keeps the
 * summary of the row the pointer rests on, so Esc in the window still
 * closes it alone. The keyboard's rest goes where its row goes (INF-902):
 * a row that moves takes its summary along, and a task that moves to another
 * group keeps focus, the list's Tab stop and an open summary on its row there.
 *
 * The keyboard moves through the list as through a tree of groups
 * (./nav.ts; docs/keyboard.md, "Lists and Settings"): the list is one Tab
 * stop, ↑ ↓ Home End move between the rows and the headers that open and
 * close, → and ← open and close a group, Enter opens a row, and ↓ in the
 * search goes to the first match. F6 brings focus here (`asks.onFocus`),
 * onto the row it last had. A row's stop is its task's, so a task that moves
 * to another group keeps it, and focus resting on a row that leaves the page
 * goes to the list's stop as it then stands: the task's row in its new
 * group, or the header of the closed group it moved into.
 *
 * Two User Timing measures make the paint observable from outside the
 * page: `now:render` (one paint of the groups) and `now:lag` (from the
 * newest row's own write time to its paint, for a write after this page
 * was born). tests/e2e/now-panel.spec.ts reads them.
 */

/**
 * The rows the paint in progress built (INF-2105): reset as the panel
 * renders, counted by each row that renders, and carried on the paint's
 * `now:render` measure as `detail.rows`, so a journey reads the work a
 * change caused rather than its duration alone.
 */
let paintedRows = 0;

export default function TasksPanel({ reads, point, view, asks, rail, tasks }: PanelProps) {
  const [board, setBoard] = useState<PanelTaskBoard | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<PanelGroup>>(() => new Set());
  const [found, setFound] = useState<{ query: string; tasks: PanelTaskRow[] }>({
    query: "",
    tasks: [],
  });
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const groupsRef = useRef<HTMLDivElement>(null);
  const queryRef = useRef<HTMLInputElement>(null);
  const newestSeen = useRef(0);
  // The stop focus was last on in the list: the list's one Tab stop.
  const [lastStop, setLastStop] = useState<string | null>(null);
  // The row the pointer or the keyboard rests on. Edges light up; the stage does not slow.
  const [restedId, setRestedId] = useState<string | null>(null);
  const [placed, setPlaced] = useState<ReadonlyMap<string, number>>(() => new Map());
  // The row the pointer or the keyboard rests on, where it was when the app
  // was told, and whether the keyboard's focus put it there.
  const peeked = useRef<{
    row: HTMLElement;
    task: PanelTaskRow;
    box: string;
    keyboard: boolean;
  } | null>(null);
  const peek = useCallback(
    (row: HTMLElement | null, task?: PanelTaskRow, keyboard = false) => {
      setRestedId(task?.id ?? null);
      if (!row || !task) {
        if (!peeked.current) return;
        peeked.current = null;
        point.peekTask(null);
        return;
      }
      const { top, right, bottom, left } = row.getBoundingClientRect();
      peeked.current = { row, task, box: boxKey(row), keyboard };
      point.peekTask({ taskId: task.id, box: { top, right, bottom, left } });
    },
    [point],
  );
  const leave = useCallback(
    (row: HTMLElement) => {
      if (peeked.current?.row === row) peek(null);
    },
    [peek],
  );
  // The row focus rests on, and whether it shows the ring. A row React
  // removes while it has focus hears no blur, so this still names it once
  // its task's row is drawn again in another group.
  const focused = useRef<{ row: HTMLElement; task: PanelTaskRow; ring: boolean } | null>(null);
  // Set while focus follows a row that left: its summary was closed, so the
  // row focus lands on keeps it closed.
  const quiet = useRef(false);
  const focusRow = useCallback(
    (row: HTMLElement, task: PanelTaskRow) => {
      const ring = row.matches(":focus-visible");
      focused.current = { row, task, ring };
      // The keyboard rests on a row as the pointer does: its summary opens beside it.
      if (ring && !quiet.current) peek(row, task, true);
    },
    [peek],
  );
  const blurRow = useCallback(
    (row: HTMLElement) => {
      if (focused.current?.row === row) focused.current = null;
      leave(row);
    },
    [leave],
  );
  // Focus on a row's Start stands for its row: a task that starts moves to
  // Queued, and focus follows it to its row there, with no summary.
  const focusStart = useCallback((start: HTMLElement, row: HTMLElement, task: PanelTaskRow) => {
    focused.current = { row, task, ring: start.matches(":focus-visible") };
  }, []);
  // The last press on a row's Start, for the row as it stood then: busy until
  // the app answers, then the app's refusal, if any, until the row changes.
  const [press, setPress] = useState<StartPress | null>(null);
  const startTask = useCallback(
    async (task: PanelTaskRow) => {
      if (!tasks) return;
      const at = { taskId: task.id, updatedAt: task.updatedAt };
      setPress({ ...at, refusal: null });
      const result = await tasks.run(task.id, "start-task").catch((caught: unknown) => ({
        ok: false as const,
        text: caught instanceof Error ? caught.message : String(caught),
      }));
      setPress({ ...at, refusal: result.ok ? null : result.text });
    },
    [tasks],
  );
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !peeked.current) return;
      // The summary takes this Escape: nothing else hears it.
      event.preventDefault();
      peek(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [peek]);

  // The board the app pushed, as it lands, reconciled against the one held:
  // a row the change never touched keeps its object, so its memoized paint
  // holds, and a push that moves nothing listed is no new board at all.
  useEffect(
    () => reads.subscribe("tasks.board", (next) => setBoard((held) => reconcileBoard(held, next))),
    [reads],
  );

  // On its rail once the board holds an ask's record or a row it lists,
  // saying why not to a command that would open it; collapsed, it says how
  // many wait and how many work.
  useEffect(() => {
    if (!board || !rail) return;
    if (onRail(board)) rail.show(true);
    else rail.show(false, "There are no tasks yet");
    rail.summarize(summaryOf(board, view.focusedProjectId));
  }, [board, rail, view.focusedProjectId]);

  const chips = useMemo(() => (board ? projectChipsOf(board) : []), [board]);
  const singleProject = useMemo(
    () => (board ? hasSingleRegisteredRepoProject(board) : false),
    [board],
  );
  // The window's project focus is the panel's project filter (the top bar's
  // pill, docs/project-focus.md): a chip here picks it, All clears it.
  const project = view.focusedProjectId;
  const typed = query.trim();
  // Hover is view state, not new task data. Keep grouping, sorting and the
  // row objects stable until the board or the captain's filter changes.
  const heldRows = useRef<ReadonlyMap<PanelGroup, NowRow[]>>(new Map());
  const rows = useMemo(() => {
    const next: Map<PanelGroup, NowRow[]> = board
      ? rowsOf(board, { query, projectId: project })
      : new Map();
    const earlier =
      board && found.query === typed
        ? earlierRowsOf(found.tasks, next, { query, projectId: project })
        : [];
    if (earlier.length > 0) next.set("earlier", earlier);
    heldRows.current = reconcileRows(heldRows.current, next);
    return heldRows.current;
  }, [board, query, project, found, typed]);
  if (board) {
    performance.mark("now:render:start");
    paintedRows = 0;
  }

  // One paint of the groups, measured when it lands, with the rows it built;
  // the lag from the app's write is measured only for a write after this
  // page was born.
  useLayoutEffect(() => {
    if (!board) return;
    performance.measure("now:render", {
      start: "now:render:start",
      detail: { rows: paintedRows },
    });
  });
  useLayoutEffect(() => {
    if (!board) return;
    const newest = newestListedWrite(board);
    if (newest > newestSeen.current && newestSeen.current > 0 && newest >= performance.timeOrigin) {
      performance.measure("now:lag", {
        start: Math.max(0, newest - performance.timeOrigin),
        end: performance.now(),
      });
    }
    if (newest > newestSeen.current) newestSeen.current = newest;
  }, [board]);

  const listed = useMemo(
    () => [...rows.values()].flatMap((group) => group.map((row) => row.task)),
    [rows],
  );
  // The rows a dependency line needs placed: the two ends of each listed
  // blocked-by pair. Only they are measured, never the list (INF-2105).
  const edgeEnds = useMemo(() => {
    const idByKey = new Map(listed.map((task) => [task.key, task.id]));
    const ends = new Set<string>();
    for (const task of listed) {
      for (const key of task.blockedBy) {
        const blocker = idByKey.get(key);
        if (blocker === undefined) continue;
        ends.add(task.id);
        ends.add(blocker);
      }
    }
    return ends;
  }, [listed]);

  // Position and inspection have different lifetimes. Only a changed list
  // or its layout measures rows; hovering reuses those positions, including
  // when inspection exposes an overflow dependency lane.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the edge ends and the expanded groups describe the DOM whose positions the observer reads
  useLayoutEffect(() => {
    const root = groupsRef.current;
    if (!root) return;
    const measure = () => {
      const next = new Map<string, number>();
      if (edgeEnds.size > 0) {
        const rootBox = root.getBoundingClientRect();
        for (const row of root.querySelectorAll<HTMLElement>("[data-now-row]")) {
          const id = row.dataset.nowRow;
          if (!id || !edgeEnds.has(id)) continue;
          const box = row.getBoundingClientRect();
          // Folded and filtered rows are absent. A row not yet laid out
          // waits for the resize observer, which stays attached across hovers.
          if (box.height < 1) continue;
          next.set(id, Math.round(box.top - rootBox.top + box.height / 2));
        }
      }
      setPlaced((current) =>
        current.size === next.size && [...next].every(([id, y]) => current.get(id) === y)
          ? current
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    // A group's reveal translates its rows without resizing the root. Keep
    // the settled positions, not the intermediate boxes read as it opens.
    root.addEventListener("animationend", measure);
    return () => {
      observer.disconnect();
      root.removeEventListener("animationend", measure);
    };
  }, [edgeEnds, expanded]);
  const inspectedId = restedId ?? view.litTaskId;
  const edges = useMemo(
    () =>
      listEdges(listed, placed, inspectedId).flatMap((edge) => {
        const fromY = placed.get(edge.fromId);
        const toY = placed.get(edge.toId);
        return fromY === undefined || toY === undefined ? [] : [{ ...edge, fromY, toY }];
      }),
    [listed, placed, inspectedId],
  );

  // Typed words ask the app for earlier closed work; clearing them lets go.
  useEffect(() => {
    if (!typed) return;
    let live = true;
    const stop = reads.subscribe("tasks.search", { query: typed }, (tasks) => {
      if (live) setFound({ query: typed, tasks });
    });
    return () => {
      live = false;
      stop();
    };
  }, [reads, typed]);

  // Closing the search lets go of its words, so every task of the focused
  // project shows again; the focus itself stays, as the top bar's pill
  // says. Closed from the keyboard, focus goes to the list's stop.
  const [listAsk, setListAsk] = useState(0);
  const closeSearch = useCallback((byKeyboard: boolean) => {
    setSearching(false);
    setQuery("");
    if (byKeyboard) setListAsk((n) => n + 1);
  }, []);

  // Search tasks: its click opens or closes the search, and its key (Find
  // a task) opens it, or puts the caret back in it when it is open. The app
  // gave this page focus before the ask, so the caret can go in.
  const searchingNow = useRef(searching);
  searchingNow.current = searching;
  const [caretAsk, setCaretAsk] = useState(0);
  useEffect(
    () =>
      asks.subscribe((button: string, via: PanelAskVia) => {
        if (button !== "search") return;
        if (via === "click" && searchingNow.current) {
          closeSearch(false);
          return;
        }
        setSearching(true);
        setCaretAsk((n) => n + 1);
      }),
    [asks, closeSearch],
  );
  useEffect(() => {
    if (caretAsk > 0) queryRef.current?.focus();
  }, [caretAsk]);

  const toggle = (group: PanelGroup) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  const openTask = useCallback((task: PanelTaskRow) => void point.openTask(task.id), [point]);

  // The groups as painted: typed words show every match, even in a group
  // the captain left collapsed.
  const shownGroups = useMemo(
    () =>
      [...NOW_GROUPS, "earlier" as const]
        .filter((group) => (rows.get(group) ?? []).length > 0)
        .map((group) => ({
          group,
          open: typed !== "" || OPEN_BY_DEFAULT.has(group) || expanded.has(group),
          collapsible: !OPEN_BY_DEFAULT.has(group),
          taskIds: (rows.get(group) ?? []).map((row) => row.task.id),
        })),
    [rows, typed, expanded],
  );
  const navItems = useMemo(() => nowNavItems(shownGroups), [shownGroups]);
  const stop = rovingKey(navItems, lastStop);
  // A stop F6 lands on shows the ring: the key was the app's, not this page's.
  // So does the one focus follows to from a row that showed it.
  const focusStop = (
    key: string | null,
    ring = false,
    options: FocusOptions & { focusVisible?: boolean } = {},
  ) => {
    if (key === null) return;
    const stopElement = groupsRef.current?.querySelector<HTMLElement>(
      `[data-now-nav="${CSS.escape(key)}"]`,
    );
    if (stopElement && ring) focusWithRing(stopElement, options);
    else stopElement?.focus(options);
  };

  // The rows as just drawn. A row focus rested on that left the page - its
  // task moved to another group, or off the list - took focus with it:
  // focus goes to the list's stop as it now stands, the task's row where
  // the list draws it now, else the header of the closed group holding it,
  // else the first stop. A summary open on it moves with it; one closed
  // stays closed. Then a row arriving or leaving, or a group opening, moves
  // the list under a still pointer, so the row it rested on lets go; the
  // keyboard's rest goes with its row.
  useLayoutEffect(() => {
    const was = focused.current;
    const active = document.activeElement;
    if (was && !was.row.isConnected && (!active || active === document.body)) {
      focused.current = null;
      if (document.hasFocus()) {
        const at = peeked.current;
        quiet.current = !(at?.keyboard && at.task.id === was.task.id);
        try {
          // Preserve modality through both Starting and Working: default
          // focus can turn pointer focus into keyboard focus on the first
          // handoff, making the second reveal the task and lose the backlog.
          focusStop(stop, was.ring, {
            preventScroll: !was.ring,
            focusVisible: was.ring,
          });
        } finally {
          quiet.current = false;
        }
      }
    }
    const at = peeked.current;
    if (!at || (at.row.isConnected && boxKey(at.row) === at.box)) return;
    if (at.keyboard && at.row.isConnected && at.row === document.activeElement) {
      peek(at.row, at.task, true);
    } else {
      peek(null);
    }
  });
  const onListKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = event.target as HTMLElement;
    // → from a backlog row reaches its Start.
    const start = target.matches("[data-now-row]")
      ? target.parentElement?.querySelector<HTMLElement>("[data-now-start]")
      : null;
    if (event.key === "ArrowRight" && start) {
      event.preventDefault();
      focusWithRing(start);
      return;
    }
    // From a Start, the other keys move as from its row.
    const from = (
      target.closest("[data-now-nav]") ??
      target.closest("[data-now-item]")?.querySelector("[data-now-nav]")
    )?.getAttribute("data-now-nav");
    if (!from) return;
    const move = nowNavMove(navItems, from, event.key);
    if (!move) return;
    event.preventDefault();
    if ("toggle" in move) toggle(move.toggle);
    else focusStop(move.focus);
  };

  // F6 (docs/keyboard.md, "Parts of the window"): the app gave this page
  // focus; the list's stop takes it, or the search while the list is empty.
  const landing = useRef({ stop, searching });
  landing.current = { stop, searching };
  // biome-ignore lint/correctness/useExhaustiveDependencies: focusStop reads the list as it stands then
  useEffect(
    () =>
      asks.onFocus(() => {
        const { stop: at, searching: open } = landing.current;
        if (at !== null) focusStop(at, true);
        else if (open) queryRef.current?.focus();
      }),
    [asks],
  );
  // The search closed from the keyboard: the list as it now stands takes focus.
  // biome-ignore lint/correctness/useExhaustiveDependencies: focusStop reads the list as it stands then
  useEffect(() => {
    if (listAsk > 0) focusStop(landing.current.stop);
  }, [listAsk]);

  // Esc in the search, in its order: the summary lets go first (its own
  // listener), then the words empty, then the search closes.
  const onSearchKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing || peeked.current) return;
    event.preventDefault();
    if (query === "") {
      closeSearch(true);
      return;
    }
    setQuery("");
    queryRef.current?.focus();
  };

  return (
    <>
      <style>{styles}</style>
      <div data-now="" data-single-project={singleProject ? "true" : "false"}>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: Esc from the field, its close or a chip */}
        <div data-now-filters="" hidden={!searching} onKeyDown={onSearchKey}>
          <div data-now-query-row="">
            <input
              ref={queryRef}
              type="search"
              data-now-query=""
              placeholder="key or title"
              aria-label="Filter tasks"
              autoComplete="off"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                // ↓ from the search goes to the first match.
                if (event.key !== "ArrowDown" || event.nativeEvent.isComposing) return;
                const first = navItems[0];
                if (!first) return;
                event.preventDefault();
                focusStop(first.key);
              }}
            />
            <IconButton
              label="Close search"
              keys="Esc"
              aria-keyshortcuts="Escape"
              size={24}
              data-now-close=""
              // A press from the keyboard has no pointer, and no click count.
              onClick={(event) => closeSearch(event.detail === 0)}
              style={{ color: "var(--fg-3)" }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </IconButton>
          </div>
          <div data-now-projects="">
            {chips.map((chip) => (
              <button
                key={chip.id ?? "all"}
                type="button"
                className="chip"
                data-now-project={chip.id ?? "all"}
                aria-pressed={project === chip.id ? "true" : "false"}
                onClick={() => void point.focusProject(chip.id)}
              >
                {chip.key}
              </button>
            ))}
          </div>
        </div>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: the arrows move between the buttons inside */}
        <div
          data-now-groups=""
          data-now-edges={edges.length > 0 ? "" : undefined}
          ref={groupsRef}
          onKeyDown={onListKey}
          style={edges.length > 0 ? { paddingLeft: DEPENDENCY_VISUAL.gutterPx } : undefined}
        >
          {edges.length > 0 && (
            <svg
              data-now-edge-layer=""
              aria-hidden="true"
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                width: DEPENDENCY_VISUAL.gutterPx,
                height: "100%",
                overflow: "visible",
                pointerEvents: "none",
              }}
            >
              {edges.map((edge) => {
                const rested = restedId ?? view.litTaskId;
                const lit = rested === edge.fromId || rested === edge.toId;
                return (
                  <path
                    key={`${edge.fromId}-${edge.toId}`}
                    data-now-edge=""
                    data-now-edge-from={edge.fromId}
                    data-now-edge-to={edge.toId}
                    data-now-edge-lit={lit ? "" : undefined}
                    d={edgePath(edge.fromY, edge.toY, edge.lane)}
                    fill="none"
                    stroke={lit ? "var(--accent)" : "var(--fg-3)"}
                    strokeWidth={lit ? 1.4 : 1}
                    opacity={lit ? 0.9 : 0.4}
                  />
                );
              })}
            </svg>
          )}
          {board &&
            shownGroups.map(({ group, open: isOpen }) => (
              <Group
                key={group}
                group={group}
                rows={rows.get(group) ?? []}
                board={board}
                newCount={
                  group === "queued" || group === "backlog"
                    ? newFilingCount(rows.get(group) ?? [])
                    : 0
                }
                open={isOpen}
                selectedTaskIds={view.openTaskIds}
                litTaskId={view.litTaskId}
                stop={stop}
                onStop={setLastStop}
                onToggle={() => toggle(group)}
                onOpen={openTask}
                onPeek={peek}
                onLeave={leave}
                onFocusRow={focusRow}
                onBlurRow={blurRow}
                press={tasks ? press : undefined}
                onStart={startTask}
                onFocusStart={focusStart}
              />
            ))}
        </div>
      </div>
    </>
  );
}

/** The last press on a row's Start: the row as it stood, and the app's refusal once it answered. */
type StartPress = { taskId: string; updatedAt: number; refusal: string | null };

/** Where a row sits in the page, to the pixel. */
function boxKey(row: HTMLElement): string {
  const { top, left, width, height } = row.getBoundingClientRect();
  return [top, left, width, height].map(Math.round).join(",");
}

/** One group: its header, and its rows while it is open. Painted by the panel, and by panel.test.tsx. */
export function Group({
  group,
  rows,
  board,
  newCount = 0,
  open,
  selectedTaskIds,
  litTaskId,
  stop = null,
  onStop,
  onToggle,
  onOpen,
  onPeek,
  onLeave,
  onFocusRow,
  onBlurRow,
  press,
  onStart,
  onFocusStart,
}: {
  group: PanelGroup;
  rows: NowRow[];
  board: PanelTaskBoard;
  /** Crew-filed rows in this group the captain has not opened. */
  newCount?: number;
  open: boolean;
  selectedTaskIds: readonly string[];
  /** The task a rest anywhere in the window lights (INF-237): its row takes the rest look. */
  litTaskId: string | null;
  /** The list's one Tab stop (./nav.ts), when it is in this group. */
  stop?: string | null;
  /** Focus reached a stop in this group: it becomes the list's Tab stop. */
  onStop?: (key: string) => void;
  onToggle: () => void;
  onOpen: (task: PanelTaskRow) => void;
  /** The row the pointer or the keyboard rests on, or null on a press. */
  onPeek?: (row: HTMLElement | null, task?: PanelTaskRow) => void;
  /** The pointer or the keyboard left this row: what rests on it, and only that, goes. */
  onLeave?: (row: HTMLElement) => void;
  /** Focus reached a row: the keyboard rests on it. */
  onFocusRow?: (row: HTMLElement, task: PanelTaskRow) => void;
  /** Focus left a row for somewhere else; a row removed while focused hears none. */
  onBlurRow?: (row: HTMLElement) => void;
  /**
   * Set where the panel moves tasks: backlog rows offer their Start, and
   * this is the last press on one (null before any).
   */
  press?: StartPress | null;
  /** A row's Start was pressed, and it can start. */
  onStart?: (task: PanelTaskRow) => void;
  /** Focus reached a row's Start. */
  onFocusStart?: (start: HTMLElement, row: HTMLElement, task: PanelTaskRow) => void;
}) {
  const collapsible = !OPEN_BY_DEFAULT.has(group);
  const reveal = useInPlaceReveal(open);
  const singleProject = hasSingleRegisteredRepoProject(board);
  const projects = board.projects;
  // A crew write in another group leaves this group's actual elements
  // untouched, not just the Row components' memoized paints (INF-2221).
  const body = useMemo(() => {
    if (!open) return null;
    const names = { projects };
    return rows.map(({ task, depth }) => {
      const start = group === "backlog" && press !== undefined ? rowStartOf(task) : null;
      const pressed =
        press?.taskId === task.id && press.updatedAt === task.updatedAt ? press : null;
      return (
        <Row
          key={task.id}
          group={group}
          task={task}
          depth={depth}
          projectName={projectNameOf(names, task)}
          singleProject={singleProject}
          selected={selectedTaskIds.includes(task.id)}
          lit={litTaskId === task.id}
          isStop={stop === rowNavKey(task.id)}
          onStop={onStop}
          onOpen={onOpen}
          onPeek={onPeek}
          onLeave={onLeave}
          onFocusRow={onFocusRow}
          onBlurRow={onBlurRow}
          startLabel={start?.label}
          startReason={pressed?.refusal ?? start?.reason ?? null}
          startBusy={pressed !== null && pressed.refusal === null}
          onStart={onStart}
          onFocusStart={onFocusStart}
        />
      );
    });
  }, [
    open,
    rows,
    group,
    projects,
    singleProject,
    selectedTaskIds,
    litTaskId,
    stop,
    onStop,
    onOpen,
    onPeek,
    onLeave,
    onFocusRow,
    onBlurRow,
    press,
    onStart,
    onFocusStart,
  ]);
  return (
    <div data-now-group={group}>
      <button
        type="button"
        data-now-group-header={group}
        // A group that is always open has a label, not a stop.
        data-now-nav={collapsible ? groupNavKey(group) : undefined}
        tabIndex={collapsible && stop === groupNavKey(group) ? 0 : -1}
        aria-expanded={collapsible ? (open ? "true" : "false") : undefined}
        onClick={collapsible ? onToggle : undefined}
        onFocus={collapsible ? () => onStop?.(groupNavKey(group)) : undefined}
      >
        <span className="label" data-now-group-label="">
          {PANEL_GROUP_LABELS[group]}
        </span>
        {collapsible && (
          // A collapsed group is its count; the two open groups show their
          // label without one.
          <>
            <span className="n" data-now-count={group}>
              {rows.length}
            </span>
            {group === "backlog" && failedStartCount(rows.map((row) => row.task)) > 0 && (
              <span className="n" data-now-failed={group}>
                {` · ${failedStartCount(rows.map((row) => row.task))} could not start`}
              </span>
            )}
            {newCount > 0 && (
              <span className="n" data-now-new={group}>
                {` · ${newCount} new`}
              </span>
            )}
            <span className="caret" data-now-caret="" aria-hidden="true">
              <PanelExpandChevron collapsed={!open} />
            </span>
          </>
        )}
      </button>
      {open && (
        <div
          data-in-place-reveal={reveal ? "drift" : undefined}
          style={{ display: "flex", flexDirection: "column", gap: 2 }}
        >
          {body}
        </div>
      )}
    </div>
  );
}

/**
 * Only rows whose data, highlight, selection or Tab stop changed paint
 * again: every input is a value or a stable callback, and the task object
 * holds across pushes that never touched it (./reconcile.ts).
 */
const Row = memo(function Row({
  group,
  task,
  depth,
  projectName,
  singleProject,
  selected,
  lit,
  isStop,
  onStop,
  onOpen,
  onPeek,
  onLeave,
  onFocusRow,
  onBlurRow,
  startLabel,
  startReason = null,
  startBusy = false,
  onStart,
  onFocusStart,
}: {
  /** The actual rendered section, including open rows nested in Working. */
  group: PanelGroup;
  task: PanelTaskRow;
  depth: number;
  /** The project's display name, for the row's label; shown after the title unless one project is meant. */
  projectName: string;
  singleProject: boolean;
  selected: boolean;
  lit: boolean;
  isStop: boolean;
  onStop?: (key: string) => void;
  onOpen: (task: PanelTaskRow) => void;
  onPeek?: (row: HTMLElement | null, task?: PanelTaskRow) => void;
  onLeave?: (row: HTMLElement) => void;
  onFocusRow?: (row: HTMLElement, task: PanelTaskRow) => void;
  onBlurRow?: (row: HTMLElement) => void;
  /** The row's Start, on a backlog row of a panel that moves tasks. */
  startLabel?: string | undefined;
  /** Why the Start cannot start the task now, in the app's words. */
  startReason?: string | null;
  /** A press on the Start waits for the app's answer. */
  startBusy?: boolean;
  onStart?: (task: PanelTaskRow) => void;
  onFocusStart?: (start: HTMLElement, row: HTMLElement, task: PanelTaskRow) => void;
}) {
  paintedRows += 1;
  const word = wordOf(task);
  const trailing = rowTrailing(task, singleProject ? "" : projectName);
  const place = task.place ? ` · ${task.place.where}` : "";
  const waiting = task.blockedBy.length > 0 ? ` · Blocked by ${task.blockedBy.join(", ")}` : "";
  const label = `${task.key} · ${task.title} · ${projectName}${place} · ${taskStatusLabel(taskStatusOf(task))}${waiting}`;
  const row = (
    <button
      type="button"
      data-now-row={task.id}
      data-now-key={task.key}
      data-now-blockers={task.blockedBy.join(" ") || undefined}
      data-now-status={task.status}
      data-now-selected={selected ? "" : undefined}
      data-now-lit={lit ? "" : undefined}
      data-now-trailing={trailing.name || trailing.place ? "" : undefined}
      data-now-out-of-reach={trailing.outOfReach ? "" : undefined}
      data-now-connecting={trailing.connecting ? "" : undefined}
      data-now-nav={rowNavKey(task.id)}
      tabIndex={isStop ? 0 : -1}
      style={{ "--depth": String(depth) } as CSSProperties}
      aria-label={label}
      onClick={() => onOpen(task)}
      onPointerEnter={(event) => onPeek?.(event.currentTarget, task)}
      onPointerLeave={(event) => onLeave?.(event.currentTarget)}
      onPointerDown={() => onPeek?.(null)}
      onFocus={(event: FocusEvent<HTMLButtonElement>) => {
        onStop?.(rowNavKey(task.id));
        onFocusRow?.(event.currentTarget, task);
      }}
      onBlur={(event) => onBlurRow?.(event.currentTarget)}
    >
      <span data-now-dot="">
        <TaskStatusMark reading={taskStatusOf(task)} nativeTitle={false} />
      </span>
      <span className="title" data-now-title="">
        <span className="title-key" data-now-title-key="">
          {`${task.key} `}
        </span>
        <span data-now-title-text="">{task.title}</span>
        {word && (
          <span className="word" data-now-word={word}>
            {` · ${word}`}
          </span>
        )}
      </span>
      {group === "queued" && task.queueWait && task.status === "open" && (
        <span data-now-queue-wait="">{task.queueWait.line}</span>
      )}
      {trailing.place ? (
        // Last first: what does not fit leaves whole, the project's
        // name before the place, never "out of reach".
        <span className="key" data-now-project="" data-now-place="">
          {trailing.outOfReach && (
            <span className="reach" data-now-reach="">
              {trailing.reach}
            </span>
          )}
          <span className="place">
            {trailing.outOfReach ? `${trailing.place} · ` : trailing.place}
          </span>
          {trailing.name && <span className="name">{`${trailing.name} · `}</span>}
        </span>
      ) : (
        trailing.name && (
          <span className="key" data-now-project="">
            {trailing.name}
          </span>
        )
      )}
    </button>
  );
  if (startLabel === undefined) return row;
  return (
    <div data-now-item="">
      {row}
      <RowStart
        task={task}
        label={startLabel}
        reason={startReason}
        busy={startBusy}
        onStart={onStart}
        onFocusStart={(start, row, at) => {
          onStop?.(rowNavKey(at.id));
          onFocusStart?.(start, row, at);
        }}
        onBlurRow={onBlurRow}
      />
    </div>
  );
});

/**
 * A backlog row's Start (INF-1663): beside the row, drawn over its right end
 * while the pointer or the keyboard rests on the row. It is no stop of its
 * own: → from the row reaches it, Enter presses it, ← goes back. A Start
 * that cannot start stays reachable, dim, with its reason on rest.
 */
function RowStart({
  task,
  label,
  reason,
  busy,
  onStart,
  onFocusStart,
  onBlurRow,
}: {
  task: PanelTaskRow;
  label: string;
  reason: string | null;
  busy: boolean;
  onStart?: (task: PanelTaskRow) => void;
  onFocusStart?: (start: HTMLElement, row: HTMLElement, task: PanelTaskRow) => void;
  onBlurRow?: (row: HTMLElement) => void;
}) {
  const rest = useRestLabel(reason ?? undefined, { fact: true });
  const ref = useRef<HTMLButtonElement | null>(null);
  const rowOf = (start: HTMLElement) =>
    start.parentElement?.querySelector<HTMLElement>("[data-now-row]") ?? null;
  // The row's title fades out under the Start, as wide as the Start is.
  // biome-ignore lint/correctness/useExhaustiveDependencies: its words set its width
  useLayoutEffect(() => {
    const start = ref.current;
    start?.parentElement?.style.setProperty("--now-start-w", `${start.offsetWidth}px`);
  }, [label]);
  const off = reason !== null || busy;
  return (
    <button
      type="button"
      data-now-start={task.id}
      tabIndex={-1}
      aria-label={`${label} ${task.key}`}
      aria-disabled={off ? "true" : undefined}
      aria-description={reason ?? undefined}
      {...rest}
      ref={(node) => {
        ref.current = node;
        rest.ref(node);
      }}
      onClick={() => {
        if (!off) onStart?.(task);
      }}
      onKeyDown={(event) => {
        rest.onKeyDown(event);
        if (event.key !== "ArrowLeft") return;
        const row = rowOf(event.currentTarget);
        if (!row) return;
        event.preventDefault();
        focusWithRing(row);
      }}
      onFocus={(event) => {
        rest.onFocus(event);
        const row = rowOf(event.currentTarget);
        if (row) onFocusStart?.(event.currentTarget, row, task);
      }}
      onBlur={(event) => {
        rest.onBlur(event);
        const row = rowOf(event.currentTarget);
        if (row) onBlurRow?.(row);
      }}
    >
      {label}
    </button>
  );
}

/** A quiet path in the reserved gutter, arrow at the blocker. */
function edgePath(fromY: number, toY: number, lane: number): string {
  const x = 8 + lane * 10;
  const dir = toY >= fromY ? 1 : -1;
  const turn = 5;
  return [
    `M ${DEPENDENCY_VISUAL.gutterPx} ${fromY}`,
    `H ${x + turn}`,
    `Q ${x} ${fromY} ${x} ${fromY + dir * turn}`,
    `V ${toY - dir * turn}`,
    `Q ${x} ${toY} ${x + turn} ${toY}`,
    `H ${DEPENDENCY_VISUAL.gutterPx - 4}`,
    `M ${DEPENDENCY_VISUAL.gutterPx - 8} ${toY - 3}`,
    `L ${DEPENDENCY_VISUAL.gutterPx - 3} ${toY}`,
    `L ${DEPENDENCY_VISUAL.gutterPx - 8} ${toY + 3}`,
  ].join(" ");
}
