import type { PanelAskVia, PanelProps, PanelTaskBoard, PanelTaskRow } from "@infinitary/contracts";
import {
  DEPENDENCY_VISUAL,
  focusWithRing,
  IconButton,
  listEdges,
  MenuPanel,
  PanelExpandChevron,
  PinGlyph,
  pinActionLabel,
  stepMenuFocus,
  TaskStatusMark,
  taskStatusLabel,
  taskStatusOf,
  useInPlaceReveal,
  usePopoverPresence,
  useRestLabel,
} from "@infinitary/ui";
import {
  type CSSProperties,
  type FocusEvent,
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as m from "./messages.generated";
import { groupNavKey, nowNavItems, nowNavMove, rovingKey, rowNavKey } from "./nav";
import styles from "./panel.css";
import { barSegments, barWords, PartsBar, useBarRest } from "./partsBar";
import { reconcileBoard, reconcileRows } from "./reconcile";
import {
  COLLAPSED_KEY,
  collapsedIdsOf,
  earlierRowsOf,
  type FoldedRows,
  failedStartCount,
  foldRows,
  GROUPING_KEY,
  type Grouping,
  groupingOf,
  hasSingleRegisteredRepoProject,
  isPinned,
  isTagGroup,
  type ListGroup,
  leftOutDone,
  NO_TAG,
  type NowGroup,
  type NowRow,
  newestListedWrite,
  newFilingCount,
  noTagsWhy,
  OPEN_BY_DEFAULT,
  OPEN_TAG_GROUPS_KEY,
  onRail,
  openTagGroupsOf,
  PANEL_GROUP_LABELS,
  PANEL_GROUPS,
  type PanelGroup,
  partsBarOf,
  partsCountOf,
  projectChipsOf,
  projectNameOf,
  rowControlsOf,
  rowsOf,
  rowTrailing,
  summaryOf,
  type TagFilter,
  type TagGroupKey,
  tagChipsOf,
  tagGroupBarOf,
  tagGroupKey,
  tagGroupsOf,
  tagProjectOf,
  wordOf,
} from "./rows";
import {
  BOARD_TAGS_COMMAND,
  COLLAPSE_ALL_ASK,
  EXPAND_ALL_ASK,
  failedCountWords,
  foldLabel,
  GROUP_ASK,
  newCountWords,
  partsCountWords,
  ROW_COLLAPSED_WORDS,
  TAG_FILTER_ASK,
} from "./words";

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
 * of the stack), and a click on a segment of a collapsed row's bar that
 * names a part opens that part, as its own row would (INF-4172); a
 * collapsed group's header expands it. The header's Search
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
 * Every row of a panel that moves tasks offers a pin the same way (INF-3127,
 * the captain's words: "each task row in the tasks panel should have a hover
 * button to pin/unpin, the button should use a pin icon no text"): after a
 * backlog row's Start, a pin that is filled while the task is pinned. One
 * press pins or unpins it (`tasks.pin`), and the row moves at once into
 * Pinned, the panel's own group at its top, or back to its state's group,
 * with focus following it; its parts move with it, under it, and only the
 * task pressed is pinned (INF-3512). → from the row, or from its Start,
 * reaches it.
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

export default function TasksPanel({ reads, point, view, asks, rail, tasks, store }: PanelProps) {
  const [board, setBoard] = useState<PanelTaskBoard | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<PanelGroup>>(() => new Set());
  const [found, setFound] = useState<{ query: string; tasks: PanelTaskRow[] }>({
    query: "",
    tasks: [],
  });
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  // The tasks the captain collapsed (INF-3823's plan): none at first, and a
  // collapsed task stays collapsed, kept in the panel's own store slice so a
  // restart finds it as it was.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  // The pressed tag (design skill NowPanel, "Tags"): the search's own, as
  // its words are, so closing the search lets go of it.
  const [tag, setTag] = useState<TagFilter>(null);
  // How Tasks groups its tasks (Group tasks) and the tag groups a press
  // opened, kept in the panel's own store slice; tag groups start folded.
  const [grouping, setGrouping] = useState<Grouping>("status");
  const [openTagGroups, setOpenTagGroups] = useState<ReadonlySet<TagGroupKey>>(() => new Set());
  const [menuOpen, setMenuOpen] = useState(false);
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
    (row: HTMLElement | null, task?: PanelTaskRow, keyboard = false, partId?: string) => {
      // A rest on a segment of a collapsed row's bar rests on the part it
      // names (INF-4147): its summary opens level with the row, and the part
      // is lit as any rest is.
      setRestedId(partId ?? task?.id ?? null);
      if (!row || !task) {
        if (!peeked.current) return;
        peeked.current = null;
        point.peekTask(null);
        return;
      }
      const { top, right, bottom, left } = row.getBoundingClientRect();
      peeked.current = { row, task, box: boxKey(row), keyboard };
      point.peekTask({ taskId: partId ?? task.id, box: { top, right, bottom, left } });
    },
    [point],
  );
  const peekPart = useCallback(
    (row: HTMLElement, task: PanelTaskRow, partId: string) => peek(row, task, false, partId),
    [peek],
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
  const pinTask = useCallback(
    (task: PanelTaskRow) => {
      if (!tasks) return;
      void tasks.pin(task.id, !isPinned(task)).catch(() => {});
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
  // The board is read without its closed rows until the captain opens Done
  // or types a search, which reads them: a view coming back does not wait
  // for a week of closed work (`boardWithoutClosed`).
  const [wantsClosed, setWantsClosed] = useState(false);
  useEffect(
    () =>
      reads.subscribe("tasks.board", wantsClosed ? {} : { closed: false }, (next) =>
        setBoard((held) => reconcileBoard(held, next)),
      ),
    [reads, wantsClosed],
  );

  useEffect(() => {
    let live = true;
    const readers: Record<string, (value: unknown) => void> = {
      [COLLAPSED_KEY]: (value) => setCollapsed(new Set(collapsedIdsOf(value))),
      [GROUPING_KEY]: (value) => setGrouping(groupingOf(value)),
      [OPEN_TAG_GROUPS_KEY]: (value) => setOpenTagGroups(new Set(openTagGroupsOf(value))),
    };
    const load = (key: string) =>
      void store
        .get(key)
        .then((value) => {
          if (live) readers[key]?.(value);
        })
        .catch(() => {});
    for (const key of Object.keys(readers)) load(key);
    const stop = store.subscribe((key) => {
      if (key in readers) load(key);
    });
    return () => {
      live = false;
      stop();
    };
  }, [store]);
  const boardNow = useRef(board);
  boardNow.current = board;
  const collapsedNow = useRef(collapsed);
  collapsedNow.current = collapsed;
  // Collapse or expand tasks, and keep the list: only tasks the board still
  // holds are kept, so finished work that left the board leaves the list.
  const setFolded = useCallback(
    (ids: readonly string[] | "all", on: boolean) => {
      const next = new Set(ids === "all" && !on ? [] : collapsedNow.current);
      if (ids !== "all") for (const id of ids) on ? next.add(id) : next.delete(id);
      collapsedNow.current = next;
      setCollapsed(next);
      const held = new Set(boardNow.current?.tasks.map((task) => task.id) ?? []);
      void store
        .set(
          COLLAPSED_KEY,
          [...next].filter((id) => held.has(id)),
        )
        .catch(() => {});
    },
    [store],
  );

  const chooseGrouping = useCallback(
    (next: Grouping) => {
      setGrouping(next);
      void store.set(GROUPING_KEY, next).catch(() => {});
    },
    [store],
  );
  const openTagGroupsNow = useRef(openTagGroups);
  openTagGroupsNow.current = openTagGroups;
  const toggleTagGroup = useCallback(
    (group: TagGroupKey) => {
      const next = new Set(openTagGroupsNow.current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      openTagGroupsNow.current = next;
      setOpenTagGroups(next);
      void store.set(OPEN_TAG_GROUPS_KEY, [...next]).catch(() => {});
    },
    [store],
  );

  // On its rail once the board holds an ask's record or a row it lists,
  // saying why not to a command that would open it; collapsed, it says how
  // many wait and how many work.
  useEffect(() => {
    if (!board || !rail) return;
    if (onRail(board)) rail.show(true);
    else rail.show(false, m.nowPanelNoTasks());
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
  // The project whose tags apply: the one in focus, or the only one with tags.
  const tagProject = useMemo(() => (board ? tagProjectOf(board, project) : null), [board, project]);
  // Focusing a project that lacks the pressed tag, or has no tags, lets go of it.
  const tagHeld =
    tag === null || tag === NO_TAG || (tagProject?.tags ?? []).some(({ id }) => id === tag);
  const pressedTag: TagFilter = tagProject && tagHeld ? tag : null;
  useEffect(() => {
    if (board && tag !== null && pressedTag === null) setTag(null);
  }, [board, tag, pressedTag]);
  const tagChips = useMemo(
    () => (board ? tagChipsOf(board, { query, projectId: project }) : []),
    [board, query, project],
  );
  // Filter tasks by tag and Show tasks by tag say why they cannot run while no tags apply.
  useEffect(() => {
    if (!board || !rail) return;
    const why = tagProject ? null : noTagsWhy(board, project);
    rail.refuse(TAG_FILTER_ASK, why);
    rail.refuse(BOARD_TAGS_COMMAND, why);
  }, [board, rail, tagProject, project]);
  // Hover is view state, not new task data. Keep grouping, sorting and the
  // row objects stable until the board or the captain's filter changes.
  const heldRows = useRef<ReadonlyMap<PanelGroup, NowRow[]>>(new Map());
  const rows = useMemo(() => {
    const next: Map<PanelGroup, NowRow[]> = board
      ? rowsOf(board, { query, projectId: project, tag: pressedTag })
      : new Map();
    const earlier =
      board && found.query === typed
        ? earlierRowsOf(found.tasks, next, { query, projectId: project, tag: pressedTag })
        : [];
    if (earlier.length > 0) next.set("earlier", earlier);
    heldRows.current = reconcileRows(heldRows.current, next);
    return heldRows.current;
  }, [board, query, project, pressedTag, found, typed]);
  // Grouped by tag while tags apply; the choice stays as picked while they do not.
  const byTag = grouping === "tag" && tagProject !== null;
  const tagGroups = useMemo(() => {
    if (!byTag || !tagProject) return [];
    const groups = tagGroupsOf(rows, tagProject);
    // A pressed tag shows its own group alone.
    return pressedTag === null
      ? groups
      : groups.filter(({ group }) => group === tagGroupKey(pressedTag));
  }, [byTag, tagProject, rows, pressedTag]);
  // Each group's rows with the collapsed tasks' parts left out. Typed words
  // show every match, even a part under a collapsed task, and leave what is
  // collapsed as it was.
  const folded = useMemo(() => {
    const kept = typed ? new Set<string>() : collapsed;
    return new Map([...rows].map(([group, list]) => [group, foldRows(list, kept)] as const));
  }, [rows, collapsed, typed]);
  const fold = useMemo(() => {
    const parents = new Set<string>();
    const hiddenUnder = new Map<string, string>();
    const parentRowOf = new Map<string, string>();
    for (const group of folded.values()) {
      for (const id of group.parents) parents.add(id);
      for (const [id, up] of group.hiddenUnder) hiddenUnder.set(id, up);
      for (const [id, up] of group.parentRowOf) parentRowOf.set(id, up);
    }
    return { parents, hiddenUnder, parentRowOf };
  }, [folded]);
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: the edge ends, the expanded groups and the collapsed tasks describe the DOM whose positions the observer reads
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
  }, [edgeEnds, expanded, folded]);
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
    setTag(null);
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
  // Filter tasks by tag, from command search: the search opens with focus on the tag row.
  const tagsRef = useRef<HTMLDivElement>(null);
  const [tagAsk, setTagAsk] = useState(0);
  useEffect(
    () =>
      asks.subscribe((button: string) => {
        if (button !== TAG_FILTER_ASK) return;
        setSearching(true);
        setTagAsk((n) => n + 1);
      }),
    [asks],
  );
  useEffect(() => {
    if (tagAsk === 0) return;
    const at = tagsRef.current?.querySelector<HTMLElement>('[tabindex="0"]');
    if (at) focusWithRing(at);
  }, [tagAsk]);
  // The tag row is one Tab stop (a toolbar): the arrows move along it, Home
  // and End go to its ends, and Enter or Space presses the chip.
  const [tagStop, setTagStop] = useState<TagFilter | undefined>(undefined);
  const tagStopId = tagChips.some((chip) => chip.id === tagStop) ? tagStop : pressedTag;
  const onTagKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const chips = [...(tagsRef.current?.querySelectorAll<HTMLElement>("[data-now-tag]") ?? [])];
    const at = chips.indexOf(event.target as HTMLElement);
    if (at < 0) return;
    const to =
      event.key === "ArrowRight"
        ? Math.min(at + 1, chips.length - 1)
        : event.key === "ArrowLeft"
          ? Math.max(at - 1, 0)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? chips.length - 1
              : null;
    if (to === null) return;
    event.preventDefault();
    const next = chips[to];
    if (next) focusWithRing(next);
  };

  // Group tasks: a click opens or closes its menu, its command opens it.
  // A press outside the panel's page is a blur of the page, so a click on
  // the header button that closed it that way must not open it again.
  const menuRef = useRef<HTMLDivElement>(null);
  const noTrigger = useRef<HTMLElement>(null);
  const menuDrawn = usePopoverPresence(menuOpen, menuRef, noTrigger);
  const menuOpenNow = useRef(menuOpen);
  menuOpenNow.current = menuOpen;
  const closedByBlurAt = useRef(0);
  const [menuAsk, setMenuAsk] = useState(0);
  useEffect(
    () =>
      asks.subscribe((button: string, via: PanelAskVia) => {
        if (button !== GROUP_ASK) return;
        if (via === "click" && (menuOpenNow.current || Date.now() - closedByBlurAt.current < 400)) {
          setMenuOpen(false);
          return;
        }
        setMenuOpen(true);
        setMenuAsk((n) => n + 1);
      }),
    [asks],
  );
  // Collapse all parts and Expand all parts, from command search.
  const parentsNow = useRef(fold.parents);
  parentsNow.current = fold.parents;
  useEffect(
    () =>
      asks.subscribe((button: string) => {
        if (button === COLLAPSE_ALL_ASK) setFolded([...parentsNow.current], true);
        else if (button === EXPAND_ALL_ASK) setFolded("all", false);
      }),
    [asks, setFolded],
  );

  const toggle = (group: ListGroup) => {
    if (isTagGroup(group)) toggleTagGroup(group);
    else toggleGroup(group);
  };
  const toggleGroup = (group: PanelGroup) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  const openTask = useCallback((taskId: string) => void point.openTask(taskId), [point]);

  // The groups as painted: typed words show every match, even in a group
  // the captain left collapsed.
  const doneLeftOut = board ? leftOutDone(board, project) : 0;
  // A pressed tag opens the folded groups, as typed words do.
  const narrowed = typed !== "" || pressedTag !== null;
  useEffect(() => {
    if (narrowed || expanded.has("landed")) setWantsClosed(true);
  }, [narrowed, expanded]);
  const shownGroups = useMemo(() => {
    const byStatus = PANEL_GROUPS.filter(
      (group) => (rows.get(group) ?? []).length > 0 || (group === "landed" && doneLeftOut > 0),
    ).map((group) => ({
      group: group as ListGroup,
      open: narrowed || OPEN_BY_DEFAULT.has(group) || expanded.has(group),
      collapsible: !OPEN_BY_DEFAULT.has(group),
      taskIds: (folded.get(group)?.shown ?? []).map((row) => row.task.id),
      byTag: false,
    }));
    if (!byTag) return byStatus;
    // By tag: Pinned and Waiting on you, one group per tag, No tag, then Done.
    const kept = (groups: readonly PanelGroup[]) =>
      byStatus.filter(({ group }) => groups.includes(group as PanelGroup));
    const tagged = tagGroups.map(({ group, rows: tagRows }) => ({
      group: group as ListGroup,
      open: narrowed || openTagGroups.has(group),
      collapsible: true,
      taskIds: tagRows.map((row) => row.task.id),
      byTag: true,
    }));
    return [...kept(["pinned", "waiting"]), ...tagged, ...kept(["landed", "earlier"])];
  }, [rows, folded, narrowed, expanded, doneLeftOut, byTag, tagGroups, openTagGroups]);
  const navItems = useMemo(() => nowNavItems(shownGroups), [shownGroups]);
  // A row a collapse hid hands its stop to the collapsed task it is under.
  const hiddenStop = lastStop?.startsWith("row:")
    ? fold.hiddenUnder.get(lastStop.slice("row:".length))
    : undefined;
  const stop = rovingKey(navItems, hiddenStop ? rowNavKey(hiddenStop) : lastStop);
  const stopNow = useRef(stop);
  stopNow.current = stop;
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
    // On a task with parts listed under it, ← collapses it and → expands it;
    // from a part, ← goes to the row it is listed under.
    const rowId = target.matches("[data-now-row]") ? target.dataset.nowRow : undefined;
    if (rowId && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      const shut = !typed && collapsed.has(rowId);
      if (fold.parents.has(rowId) && shut === (event.key === "ArrowRight")) {
        event.preventDefault();
        setFolded([rowId], !shut);
        return;
      }
      const up = fold.parentRowOf.get(rowId);
      if (event.key === "ArrowLeft" && up) {
        event.preventDefault();
        focusStop(rowNavKey(up));
        return;
      }
    }
    // → from a row reaches its first control (a backlog row's Start, then
    // its pin); → and ← move between them, and ← from the first goes back.
    const item = target.closest<HTMLElement>("[data-now-item]");
    const controls = item ? [...item.querySelectorAll<HTMLElement>("[data-now-control]")] : [];
    if (controls.length > 0 && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
      const at = target.matches("[data-now-row]") ? -1 : controls.indexOf(target);
      const to = at + (event.key === "ArrowRight" ? 1 : -1);
      const next = to < 0 ? item?.querySelector<HTMLElement>("[data-now-row]") : controls[to];
      if (next && (at >= 0 || to >= 0)) {
        event.preventDefault();
        focusWithRing(next);
        return;
      }
      if (at >= 0) {
        event.preventDefault();
        return;
      }
    }
    // From a control, the other keys move as from its row.
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

  // The Group tasks menu: focus on the current choice as it opens; Esc, a
  // pick or a press outside closes it, and from the keyboard focus goes
  // back to the list's stop.
  const pickedByKey = useRef(false);
  const [menuRoom, setMenuRoom] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback((toList: boolean) => {
    setMenuOpen(false);
    if (toList) setListAsk((n) => n + 1);
  }, []);
  useLayoutEffect(() => {
    if (menuAsk === 0) return;
    menuRef.current
      ?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')
      ?.focus();
  }, [menuAsk]);
  // While it shows, the list keeps room under it, so a short Tasks never cuts it.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const root = rootRef.current;
    const room =
      menuDrawn && menu && root
        ? Math.ceil(menu.getBoundingClientRect().bottom - root.getBoundingClientRect().top) + 8
        : 0;
    setMenuRoom((held) => (held === room ? held : room));
  });
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // The menu owns this Escape: neither the summary nor the search hears it.
        event.preventDefault();
        event.stopPropagation();
        closeMenu(true);
        return;
      }
      if (event.key === "Enter" || event.key === " ") pickedByKey.current = true;
      stepMenuFocus(menuRef.current, event);
    };
    const onDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onBlur = () => {
      closedByBlurAt.current = Date.now();
      setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("blur", onBlur);
    };
  }, [menuOpen, closeMenu]);
  const groupingWhy = !tagProject && board ? noTagsWhy(board, project) : undefined;
  const menuItems = [
    {
      id: "status",
      label: m.nowPanelGroupByStatus(),
      chosen: grouping === "status",
      onSelect: () => chooseGrouping("status"),
    },
    {
      id: "tag",
      label: m.nowPanelGroupByTag(),
      chosen: grouping === "tag",
      disabled: groupingWhy !== undefined,
      ...(groupingWhy !== undefined ? { detail: groupingWhy } : {}),
      onSelect: () => chooseGrouping("tag"),
    },
  ];

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
      <div
        data-now=""
        data-single-project={singleProject ? "true" : "false"}
        data-now-grouping={byTag ? "tag" : "status"}
        ref={rootRef}
        style={menuRoom > 0 ? { minHeight: menuRoom } : undefined}
      >
        {menuDrawn && (
          <MenuPanel
            ref={menuRef}
            label={m.nowPanelGroupTasks()}
            items={menuItems}
            style={{ top: 4, right: 10, transformOrigin: "top right" }}
            onPick={(item) => {
              const toList = pickedByKey.current;
              pickedByKey.current = false;
              item.onSelect?.();
              closeMenu(toList);
            }}
          />
        )}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: Esc from the field, its close or a chip */}
        <div data-now-filters="" hidden={!searching} onKeyDown={onSearchKey}>
          <div data-now-query-row="">
            <input
              ref={queryRef}
              type="search"
              data-now-query=""
              placeholder={m.nowPanelFilterPlaceholder()}
              aria-label={m.nowPanelFilterLabel()}
              autoComplete="off"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowDown" || event.nativeEvent.isComposing) return;
                const first = navItems[0];
                if (!first) return;
                event.preventDefault();
                focusStop(first.key);
              }}
            />
            <IconButton
              label={m.nowPanelCloseSearch()}
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
          {tagChips.length > 0 && (
            <div
              data-now-tags=""
              role="toolbar"
              aria-label={m.nowPanelTags()}
              ref={tagsRef}
              onKeyDown={onTagKey}
            >
              {tagChips.map((chip) => (
                <button
                  key={chip.id ?? "all"}
                  type="button"
                  className="chip"
                  data-now-tag={chip.id ?? "all"}
                  aria-pressed={pressedTag === chip.id ? "true" : "false"}
                  tabIndex={tagStopId === chip.id ? 0 : -1}
                  onFocus={() => setTagStop(chip.id)}
                  onClick={() => setTag(chip.id)}
                >
                  {chip.name}
                  {chip.count !== null && <span className="chip-n">{` ${chip.count}`}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: the arrows move between the buttons inside */}
        <div
          data-now-groups=""
          data-now-edges={edges.length > 0 ? "" : undefined}
          ref={groupsRef}
          onKeyDown={onListKey}
          style={edges.length > 0 ? { paddingInlineStart: DEPENDENCY_VISUAL.gutterPx } : undefined}
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
            shownGroups.map(({ group, open: isOpen }) => {
              const byTagGroup = isTagGroup(group)
                ? tagGroups.find((candidate) => candidate.group === group)
                : undefined;
              const statusGroup = isTagGroup(group) ? null : group;
              return (
                <Group
                  key={group}
                  group={group}
                  label={byTagGroup?.name}
                  rows={byTagGroup ? byTagGroup.rows : (rows.get(statusGroup as PanelGroup) ?? [])}
                  fold={statusGroup ? folded.get(statusGroup) : undefined}
                  collapsed={typed || byTagGroup ? NONE : collapsed}
                  onFold={byTagGroup ? undefined : setFolded}
                  bar={byTagGroup && !isOpen ? barWords(tagGroupBarOf(byTagGroup)) : undefined}
                  board={board}
                  leftOut={group === "landed" ? doneLeftOut : 0}
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
                  onPeekPart={peekPart}
                  onLeave={leave}
                  onFocusRow={focusRow}
                  onBlurRow={blurRow}
                  press={tasks ? press : undefined}
                  onStart={startTask}
                  onFocusStart={focusStart}
                  onPin={tasks ? pinTask : undefined}
                />
              );
            })}
        </div>
      </div>
    </>
  );
}

const NONE: ReadonlySet<string> = new Set();

/** The last press on a row's Start: the row as it stood, and the app's refusal once it answered. */
type StartPress = { taskId: string; updatedAt: number; refusal: string | null };

function boxKey(row: HTMLElement): string {
  const { top, left, width, height } = row.getBoundingClientRect();
  return [top, left, width, height].map(Math.round).join(",");
}

/** One group: its header, and its rows while it is open. Painted by the panel, and by panel.test.tsx. */
export function Group({
  group,
  label,
  bar,
  rows,
  fold,
  collapsed = NONE,
  onFold,
  board,
  leftOut = 0,
  newCount = 0,
  open,
  selectedTaskIds,
  litTaskId,
  stop = null,
  onStop,
  onToggle,
  onOpen,
  onPeek,
  onPeekPart,
  onLeave,
  onFocusRow,
  onBlurRow,
  press,
  onStart,
  onFocusStart,
  onPin,
}: {
  group: ListGroup;
  /** A tag group's name: its tag's, or No tag. */
  label?: string | undefined;
  /** A folded tag group's bar: each task's state and id (`barWords`), drawn under its name. */
  bar?: string | undefined;
  rows: NowRow[];
  /** The rows with the collapsed tasks' parts left out; all of them when absent. */
  fold?: FoldedRows | undefined;
  /** The tasks collapsed now: a collapsed row draws its bar. */
  collapsed?: ReadonlySet<string>;
  /** Collapse or expand a task's parts; the control is drawn only where it is set. */
  onFold?: (ids: readonly string[], on: boolean) => void;
  board: PanelTaskBoard;
  /** Rows of this group the board left out until it is read whole (`leftOutDone`), counted with its own. */
  leftOut?: number;
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
  /** A row was pressed: it opens its task, or the part a segment of its bar names. */
  onOpen: (taskId: string) => void;
  /** The row the pointer or the keyboard rests on, or null on a press. */
  onPeek?: (row: HTMLElement | null, task?: PanelTaskRow) => void;
  /** The pointer rests on a segment of a collapsed row's bar that names this part. */
  onPeekPart?: (row: HTMLElement, task: PanelTaskRow, partId: string) => void;
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
  /** Focus reached a row's Start or its pin. */
  onFocusStart?: (start: HTMLElement, row: HTMLElement, task: PanelTaskRow) => void;
  /** Set where the panel pins tasks: every row offers its pin, and a press pins or unpins it. */
  onPin?: ((task: PanelTaskRow) => void) | undefined;
}) {
  const tagGroup = isTagGroup(group) ? group : undefined;
  const collapsible = tagGroup !== undefined || !OPEN_BY_DEFAULT.has(group as PanelGroup);
  const reveal = useInPlaceReveal(open);
  const projects = board.projects;
  // A crew write in another group leaves this group's actual elements
  // untouched, not just the Row components' memoized paints (INF-2221).
  const body = useMemo(() => {
    if (!open) return null;
    const names = { projects };
    return (fold?.shown ?? rows).map(({ task, depth, home, group: rowGroup }) => {
      // A row in a tag group reads as it does in the group it lists in by status.
      const controls = rowControlsOf(task, rowGroup, home);
      const navKey = rowNavKey(task.id, tagGroup);
      const start = press !== undefined ? controls.start : null;
      const pressed =
        press?.taskId === task.id && press.updatedAt === task.updatedAt ? press : null;
      const count = partsCountOf(task);
      const folds = onFold !== undefined && fold?.parents.has(task.id) === true;
      const shut = folds && collapsed.has(task.id);
      return (
        <Row
          key={task.id}
          group={rowGroup}
          home={home ?? null}
          task={task}
          depth={depth}
          projectName={projectNameOf(names, task)}
          selected={selectedTaskIds.includes(task.id)}
          lit={litTaskId === task.id}
          navKey={navKey}
          isStop={stop === navKey}
          onStop={onStop}
          onOpen={onOpen}
          onPeek={onPeek}
          onPeekPart={onPeekPart}
          onLeave={onLeave}
          onFocusRow={onFocusRow}
          onBlurRow={onBlurRow}
          startLabel={start?.label}
          startReason={pressed?.refusal ?? start?.reason ?? null}
          startBusy={pressed !== null && pressed.refusal === null}
          onStart={onStart}
          onFocusStart={onFocusStart}
          onPin={controls.pin ? onPin : undefined}
          parts={count ? `${count.closed}/${count.total}` : undefined}
          folds={folds}
          shut={shut}
          bar={shut ? barWords(partsBarOf(board, task)) : undefined}
          onFold={onFold}
        />
      );
    });
  }, [
    open,
    rows,
    fold,
    collapsed,
    onFold,
    board,
    projects,
    selectedTaskIds,
    litTaskId,
    stop,
    onStop,
    onOpen,
    onPeek,
    onPeekPart,
    onLeave,
    onFocusRow,
    onBlurRow,
    press,
    onStart,
    onFocusStart,
    onPin,
    tagGroup,
  ]);
  // A folded tag group's bar rests and presses as a collapsed task's does.
  const segments = bar ? barSegments(bar) : [];
  const taskOf = (id: string) => rows.find((row) => row.task.id === id)?.task;
  const barRest = useBarRest(segments, {
    onPart: (header, partId) => {
      const task = taskOf(partId);
      if (task) onPeekPart?.(header, task, partId);
    },
    onSelf: (header) => onLeave?.(header),
    onLeave: (header) => onLeave?.(header),
    onPress: () => onPeek?.(null),
  });
  return (
    <div data-now-group={group}>
      <button
        type="button"
        data-now-group-header={group}
        data-now-barred={bar ? "" : undefined}
        // A group that is always open has a label, not a stop.
        data-now-nav={collapsible ? groupNavKey(group) : undefined}
        tabIndex={collapsible && stop === groupNavKey(group) ? 0 : -1}
        aria-expanded={collapsible ? (open ? "true" : "false") : undefined}
        onClick={
          collapsible
            ? (event) => {
                const part = bar ? barRest.partAt(event.target) : null;
                if (part) onOpen(part.id);
                else onToggle();
              }
            : undefined
        }
        onFocus={collapsible ? () => onStop?.(groupNavKey(group)) : undefined}
        {...(bar ? barRest.handlers : {})}
      >
        <span
          className={tagGroup ? "label tag" : "label"}
          data-now-group-label=""
          data-now-tag-group={tagGroup ? "" : undefined}
        >
          {tagGroup ? label : PANEL_GROUP_LABELS[group as PanelGroup]}
        </span>
        {collapsible && (
          // A collapsed group is its count; the two open groups show their
          // label without one.
          <>
            <span className="n" data-now-count={group}>
              {rows.length + leftOut}
            </span>
            {group === "backlog" && failedStartCount(rows.map((row) => row.task)) > 0 && (
              <span className="n" data-now-failed={group}>
                {failedCountWords(failedStartCount(rows.map((row) => row.task)))}
              </span>
            )}
            {newCount > 0 && (
              <span className="n" data-now-new={group}>
                {newCountWords(newCount)}
              </span>
            )}
            <span className="caret" data-now-caret="" aria-hidden="true">
              <PanelExpandChevron collapsed={!open} />
            </span>
          </>
        )}
        {bar && <PartsBar segments={segments} restedPart={barRest.restedPart} />}
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
  home,
  task,
  depth,
  projectName,
  selected,
  lit,
  navKey,
  isStop,
  onStop,
  onOpen,
  onPeek,
  onPeekPart,
  onLeave,
  onFocusRow,
  onBlurRow,
  startLabel,
  startReason = null,
  startBusy = false,
  onStart,
  onFocusStart,
  onPin,
  parts,
  folds = false,
  shut = false,
  bar,
  onFold,
}: {
  /** The actual rendered section, including open rows nested in Working. */
  group: PanelGroup;
  /** Where a pinned row would list unpinned: a pinned queued task keeps its wait line. */
  home: NowGroup | null;
  task: PanelTaskRow;
  depth: number;
  /** The project's display name, for the row's label; the row itself never shows it. */
  projectName: string;
  selected: boolean;
  lit: boolean;
  /** Its stop in the list (`rowNavKey`): its task's, or its task's in a tag group. */
  navKey: string;
  isStop: boolean;
  onStop?: (key: string) => void;
  onOpen: (taskId: string) => void;
  onPeek?: (row: HTMLElement | null, task?: PanelTaskRow) => void;
  onPeekPart?: (row: HTMLElement, task: PanelTaskRow, partId: string) => void;
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
  /** The row's pin, on a panel that pins tasks and a row with a task behind it (`rowControlsOf`). */
  onPin?: ((task: PanelTaskRow) => void) | undefined;
  /** Its finished parts and all of them, `3/7`, on a task with parts. */
  parts?: string | undefined;
  /** It has rows listed under it: it offers the collapse control. */
  folds?: boolean;
  shut?: boolean;
  /** A collapsed row's bar: each part's state and id, `state:id`, parted by spaces (`barWords`). */
  bar?: string | undefined;
  onFold?: ((ids: readonly string[], on: boolean) => void) | undefined;
}) {
  paintedRows += 1;
  const segments = bar ? barSegments(bar) : [];
  // The rest follows the pointer between the row and its bar's segments: a
  // segment that names a part rests on that part, the rest of the row, and
  // a segment that names none, on the task.
  const barRest = useBarRest(segments, {
    onPart: (row, partId) => onPeekPart?.(row, task, partId),
    onSelf: (row) => onPeek?.(row, task),
    onLeave: (row) => onLeave?.(row),
    onPress: () => onPeek?.(null),
  });
  const word = wordOf(task);
  const trailing = rowTrailing(task);
  const place = task.place ? ` · ${task.place.where}` : "";
  const waiting =
    task.blockedBy.length > 0
      ? ` · ${m.nowPanelRowBlockedBy({ keys: task.blockedBy.join(", ") })}`
      : "";
  const [closedParts = "", allParts = ""] = parts?.split("/") ?? [];
  const partsWords = parts ? ` · ${partsCountWords(Number(closedParts), Number(allParts))}` : "";
  const shutWords = shut ? ` · ${ROW_COLLAPSED_WORDS}` : "";
  const label = `${task.key} · ${task.title} · ${projectName}${place} · ${taskStatusLabel(taskStatusOf(task))}${waiting}${partsWords}${shutWords}`;
  const row = (
    <button
      type="button"
      data-now-row={task.id}
      data-now-key={task.key}
      data-now-blockers={task.blockedBy.join(" ") || undefined}
      data-now-status={task.status}
      data-now-selected={selected ? "" : undefined}
      data-now-lit={lit ? "" : undefined}
      data-now-trailing={trailing.outOfReach ? "" : undefined}
      data-now-out-of-reach={trailing.outOfReach ? "" : undefined}
      data-now-connecting={trailing.connecting ? "" : undefined}
      data-now-catching-up={trailing.catchingUp ? "" : undefined}
      data-now-collapsed={shut ? "" : undefined}
      data-now-nav={navKey}
      tabIndex={isStop ? 0 : -1}
      style={{ "--depth": String(depth) } as CSSProperties}
      aria-label={label}
      // A press opens what a rest there rests on (INF-4172): a segment that
      // names a part opens that part, as its own row does; the rest of the
      // row, a segment that names none, and Enter open the task.
      onClick={(event) => onOpen(barRest.partAt(event.target)?.id ?? task.id)}
      {...barRest.handlers}
      onFocus={(event: FocusEvent<HTMLButtonElement>) => {
        onStop?.(navKey);
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
      {(group === "queued" || home === "queued") && task.queueWait && task.status === "open" && (
        <span data-now-queue-wait="">{task.queueWait.line}</span>
      )}
      {bar && <PartsBar segments={segments} restedPart={barRest.restedPart} />}
      {trailing.outOfReach && (
        // The row names neither its project nor its computer; it says only
        // why its computer cannot take work now, and a long title never cuts it.
        <span className="key reach" data-now-reach="">
          {trailing.reach}
        </span>
      )}
    </button>
  );
  if (startLabel === undefined && !onPin && parts === undefined && !folds) return row;
  const focusControl = (control: HTMLElement, row: HTMLElement, at: PanelTaskRow) => {
    onStop?.(navKey);
    onFocusStart?.(control, row, at);
  };
  return (
    <div data-now-item="" data-now-folds={folds || parts !== undefined ? "" : undefined}>
      {row}
      {(folds || parts !== undefined) && (
        <RowFold task={task} parts={parts} folds={folds} shut={shut} onFold={onFold} />
      )}
      <RowControls>
        {startLabel !== undefined && (
          <RowStart
            task={task}
            label={startLabel}
            reason={startReason}
            busy={startBusy}
            onStart={onStart}
            onFocusStart={focusControl}
            onBlurRow={onBlurRow}
          />
        )}
        {onPin && (
          <RowPin task={task} onPin={onPin} onFocusPin={focusControl} onBlurRow={onBlurRow} />
        )}
      </RowControls>
    </div>
  );
});

/**
 * A task's parts at its row's end (INF-3823's plan): the finished parts and
 * all of them in mono, `3/7`, and, where rows list under it, the panel's
 * own chevron, as on a folding group's header; a press collapses or expands
 * it. The keyboard collapses and expands from the row (← and →), so it is
 * no stop of its own. Its width is kept on the row's item (`--now-fold-w`)
 * so the title and the row's controls stay clear of it.
 */
function RowFold({
  task,
  parts,
  folds,
  shut,
  onFold,
}: {
  task: PanelTaskRow;
  parts: string | undefined;
  folds: boolean;
  shut: boolean;
  onFold?: ((ids: readonly string[], on: boolean) => void) | undefined;
}) {
  // The control is a span until rows list under the task, then a button: each
  // new element is measured and watched, so the room kept for it follows it,
  // also when it was first drawn while the panel was not shown (0 wide).
  const [box, setBox] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!box) return;
    const set = () => box.parentElement?.style.setProperty("--now-fold-w", `${box.offsetWidth}px`);
    set();
    const observer = new ResizeObserver(set);
    observer.observe(box);
    return () => observer.disconnect();
  }, [box]);
  const label = foldLabel(shut, task.key);
  const rest = useRestLabel(folds ? label : undefined);
  const restRef = rest.ref;
  // One stable ref, so a paint hands it no new element to set.
  const buttonRef = useCallback(
    (element: HTMLElement | null) => {
      setBox(element);
      restRef(element);
    },
    [restRef],
  );
  const count = parts && (
    <span className="n" data-now-parts="">
      {parts}
    </span>
  );
  if (!folds || !onFold) {
    return (
      <span data-now-fold="" aria-hidden="true" ref={setBox}>
        {count}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-now-fold={task.id}
      tabIndex={-1}
      aria-label={label}
      aria-expanded={shut ? "false" : "true"}
      {...rest}
      ref={buttonRef}
      onClick={() => onFold([task.id], !shut)}
    >
      {count}
      <span className="caret" aria-hidden="true">
        <PanelExpandChevron collapsed={shut} />
      </span>
    </button>
  );
}

function rowOfControl(control: HTMLElement): HTMLElement | null {
  return control.closest("[data-now-item]")?.querySelector<HTMLElement>("[data-now-row]") ?? null;
}

/**
 * A row's controls, drawn over its right end while the pointer or the
 * keyboard rests on the row: a backlog row's Start, then the pin. The row's
 * title fades out under them, as wide as they are (`--now-start-w`).
 */
function RowControls({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const set = () => box.parentElement?.style.setProperty("--now-start-w", `${box.offsetWidth}px`);
    set();
    const observer = new ResizeObserver(set);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  return (
    <span data-now-controls="" ref={ref}>
      {children}
    </span>
  );
}

/**
 * A row's pin (INF-3127): a pin icon and no text, filled while the task is
 * pinned, its rest label saying what a press does - Pin INF-402, or Unpin
 * INF-402. It is no stop of its own: → from the row (or its Start) reaches
 * it, Enter or Space presses it, ← goes back.
 */
function RowPin({
  task,
  onPin,
  onFocusPin,
  onBlurRow,
}: {
  task: PanelTaskRow;
  onPin: (task: PanelTaskRow) => void;
  onFocusPin?: (pin: HTMLElement, row: HTMLElement, task: PanelTaskRow) => void;
  onBlurRow?: (row: HTMLElement) => void;
}) {
  const pinned = isPinned(task);
  const label = pinActionLabel(pinned, task.key);
  const rest = useRestLabel(label);
  return (
    <button
      type="button"
      data-now-pin={task.id}
      data-now-control=""
      data-now-pinned={pinned ? "" : undefined}
      tabIndex={-1}
      aria-label={label}
      aria-pressed={pinned ? "true" : "false"}
      {...rest}
      onClick={() => onPin(task)}
      onKeyDown={rest.onKeyDown}
      onFocus={(event) => {
        rest.onFocus(event);
        const row = rowOfControl(event.currentTarget);
        if (row) onFocusPin?.(event.currentTarget, row, task);
      }}
      onBlur={(event) => {
        rest.onBlur(event);
        const row = rowOfControl(event.currentTarget);
        if (row) onBlurRow?.(row);
      }}
    >
      <PinGlyph pinned={pinned} />
    </button>
  );
}

/**
 * A backlog row's Start (INF-1663): beside the row, drawn over its right end
 * while the pointer or the keyboard rests on the row, before its pin. It is
 * no stop of its own: → from the row reaches it, Enter presses it, ← goes back. A Start
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
  const off = reason !== null || busy;
  return (
    <button
      type="button"
      data-now-start={task.id}
      data-now-control=""
      tabIndex={-1}
      aria-label={`${label} ${task.key}`}
      aria-disabled={off ? "true" : undefined}
      aria-description={reason ?? undefined}
      {...rest}
      onClick={() => {
        if (!off) onStart?.(task);
      }}
      onKeyDown={rest.onKeyDown}
      onFocus={(event) => {
        rest.onFocus(event);
        const row = rowOfControl(event.currentTarget);
        if (row) onFocusStart?.(event.currentTarget, row, task);
      }}
      onBlur={(event) => {
        rest.onBlur(event);
        const row = rowOfControl(event.currentTarget);
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
