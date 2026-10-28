import type { PanelFeedLine, PanelPoint, PanelProject, PanelProps } from "@infinitary/contracts";
import {
  feedRelativeAge,
  focusWithRing,
  litTaskIn,
  type PanelTaskKeys,
  PanelTaskKeyText,
  usePanelTaskKeys,
} from "@infinitary/ui";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { feedKeysOf, focusedKeyOf, leadingDrop, linesInFocus, semanticKind } from "./feedRows";
import styles from "./panel.css";

/**
 * The activity feed (docs/ui-plugins.md, phase 2; the design skill's
 * ActivityFeed for the look): an ordinary panel folder (docs/ui-plugins.md,
 * "The app's own panels are ordinary folders"), compiled by the panel
 * compiler into the app's pinned library and drawn in its own page like a
 * panel added from elsewhere. It subscribes to `feed.recent` through
 * `reads`; the app re-runs that read on each feed line, so the panel's job
 * is to keep up - the streaming probe.
 *
 * A quiet crewmate event log: a chromeless thread tied together by a 1px
 * rail, a semantic kind dot at the far left and relative age at the right,
 * newest at the bottom, a line about a task carrying its key as a dim mono
 * prefix (P3), each row one line. Every recorded task's key on a line - its
 * prefix and any key its words write - is a link to that task (FI3-1271):
 * resting on it opens the task's summary beside the panel, and a click or
 * Enter opens the task, as a Tasks row does. The keys come from the panel's
 * own reads of the board and of earlier work. Rows are keyed by what they say
 * (./feedRows.ts), so a push that appends lines builds only those rows and
 * one that slides the full window forward drops the oldest and appends the
 * new - every row in between is the node it was. The list stays pinned to
 * its bottom until the reader scrolls away; overflow keeps the thin
 * left-edge thumb (the scroller is mirrored, its content mirrored back) and
 * dissolves clipped edges through an alpha mask. A host that gives the panel
 * less room than its page asks shows the page's top, so while pinned the
 * newest line is brought into the host's view too.
 *
 * Collapsed, its header shows the newest line in the title's place - its
 * dot, its key and its words - with the age ticking each minute at the
 * right (`rail.summarize`, a line part); before the first line it reads
 * the title and `quiet`.
 *
 * While the window is focused on a project (`view.focusedProjectId`,
 * docs/project-focus.md), lines about other projects' tasks leave the list
 * and the header, and lines about no task stay (`linesInFocus`).
 *
 * The keyboard reaches the list as one stop (docs/keyboard.md, "Lists and
 * Settings"): the arrows and the page keys scroll it, and while it has the
 * keyboard's focus every line reads in full, as resting the pointer on one
 * shows it. Each task key after it is a Tab stop of its own, as in a card's
 * body. F6 brings focus here (`asks.onFocus`).
 *
 * Two User Timing measures make the probe observable from outside the
 * page without a product surface: `feed:render` (one paint of the list,
 * its detail the rows that paint added and removed) and `feed:lag` (from a
 * line's own timestamp to its paint, for a line born after this page).
 * tests/e2e/rail-panels.spec.ts reads them.
 */

/** The most of a line's words the collapsed header takes (`PanelSummaryLine`). */
const SUMMARY_LINE_MAX = 500;

/** Distance from an edge that still counts as being at that edge. */
const STICK_THRESHOLD_PX = 8;

/** One line of the feed. Memoized: a push re-renders only the rows it changed. */
const Row = memo(function Row({
  line,
  age,
  fresh,
  taskOf,
  point,
  litTaskId,
}: {
  line: PanelFeedLine;
  age: string;
  fresh: boolean;
  taskOf: PanelTaskKeys;
  point: PanelPoint;
  /** The lit task when this line writes its key, else null: only such a line draws again. */
  litTaskId: string | null;
}) {
  const kind = semanticKind(line.kind);
  const [reveal] = useState(fresh);
  const quiet = useRef(false);
  const held = useRef(false);
  const rest = (row: HTMLElement | null) => {
    if (!row) {
      if (held.current) point.peekLine(null);
      held.current = false;
      return;
    }
    if (quiet.current) return;
    const { top, right, bottom, left } = row.getBoundingClientRect();
    held.current = true;
    point.peekLine({ line, box: { top, right, bottom, left } });
  };
  useEffect(() => {
    const close = () => {
      if (held.current) {
        quiet.current = true;
        held.current = false;
        point.peekLine(null);
      }
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && held.current) {
        event.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", close, true);
      if (held.current) point.peekLine(null);
    };
  }, [point]);
  return (
    <div
      data-in-place-reveal={reveal ? "fade" : undefined}
      data-feed-row={kind}
      data-feed-kind={kind}
      data-feed-event={line.event}
      onPointerEnter={(event) => {
        quiet.current = false;
        rest(event.currentTarget);
      }}
      onPointerMove={(event) => {
        if (event.target instanceof Element && event.target.closest("[data-task-key]")) {
          held.current = false;
          return;
        }
        if (!held.current) rest(event.currentTarget);
      }}
      onPointerLeave={() => {
        quiet.current = false;
        rest(null);
      }}
      onPointerDown={() => {
        quiet.current = true;
        rest(null);
      }}
    >
      {/* Type is a semantic color dot at the far left; age stays at the right.
          The line's words say what its color does, so it is no stop of its
          own and shows nothing on rest (docs/keyboard.md, "Facts shown on
          rest"). */}
      <span className={`dot ${kind}`} data-feed-dot={kind} role="img" aria-label={kind} />
      {/* The line's cell: an optional key prefix, then the text itself, so
          `.text` is always exactly the core's line. */}
      <span className="line" data-feed-line="">
        {line.taskKey && (
          <>
            <span className="key" data-feed-key={line.taskKey}>
              <PanelTaskKeyText
                text={line.taskKey}
                taskOf={taskOf}
                point={point}
                look="quiet"
                litTaskId={litTaskId}
              />
            </span>{" "}
          </>
        )}
        <span className="text" data-feed-text="">
          <PanelTaskKeyText
            text={line.text}
            taskOf={taskOf}
            point={point}
            look="quiet"
            litTaskId={litTaskId}
          />
        </span>
      </span>
      <span className="time" data-feed-time={String(line.at)}>
        {age}
      </span>
    </div>
  );
});

export default function ActivityPanel({ reads, asks, rail, point, view }: PanelProps) {
  const [allLines, setLines] = useState<readonly PanelFeedLine[] | null>(null);
  // The board's projects, for the focused project's key; the key is a
  // string, so a board push that moves no project filters nothing again.
  const [projects, setProjects] = useState<readonly PanelProject[] | null>(null);
  useEffect(() => reads.subscribe("tasks.board", (board) => setProjects(board.projects)), [reads]);
  const focusKey = focusedKeyOf(projects, view.focusedProjectId);
  // The lines this window shows: under focus, the focused project's and those about no task.
  const lines = useMemo(
    () => (allLines === null ? null : linesInFocus(allLines, focusKey)),
    [allLines, focusKey],
  );
  // Which keys the lines write name tasks: the board's, or earlier work's.
  const words = useMemo(
    () => (lines ?? []).map((line) => `${line.taskKey ?? ""} ${line.text}`),
    [lines],
  );
  const taskOf = usePanelTaskKeys(reads, words);
  // Relative times keep aging even during a quiet feed.
  const [now, setNow] = useState(() => Date.now());
  const feedRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const painted = useRef<string[]>([]);
  const snapshotKeys = useRef<Set<string> | null>(null);
  const newestKey = useRef<string | null>(null);
  const pinned = useRef(true);
  /**
   * The scrollTop the feed set itself. A scroll event that lands there is
   * the feed's own scroll being reported, not the reader scrolling away -
   * even when the content grew in between (a late typeface swap) and the
   * bottom has moved on. -1 once a reader's scroll has been seen.
   */
  const ownScrollTop = useRef(-1);

  // F6 (docs/keyboard.md, "Parts of the window"): the app gave this page
  // focus; the list takes it. The key was the app's, not this page's, so
  // the ring is asked for.
  useEffect(
    () =>
      asks.onFocus(() => {
        const scroller = scrollerRef.current;
        if (scroller) focusWithRing(scroller);
      }),
    [asks],
  );

  useEffect(
    () =>
      reads.subscribe("feed.recent", (next) => {
        performance.mark("feed:render:start");
        setLines(next);
        setNow(Date.now());
      }),
    [reads],
  );

  // Collapsed, the header shows the newest line and its age, or quiet before the first.
  const newest = lines?.at(-1) ?? null;
  useEffect(() => {
    if (!rail || lines === null) return;
    if (newest === null) {
      rail.summarize([{ text: "quiet" }]);
      return;
    }
    rail.summarize([
      {
        line: newest.text.slice(0, SUMMARY_LINE_MAX),
        lead: newest.taskKey,
        tone: newest.kind,
        feed: newest,
      },
      { text: feedRelativeAge(newest.at, now) },
    ]);
  }, [rail, lines, newest, now]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // The scroller's pin and edges, kept on the DOM as data: tests read them,
  // and the fades key off them. None of it is React state - a scroll would
  // otherwise re-render the list.
  const edges = useRef({
    atBottom: () => {
      const scroller = scrollerRef.current;
      if (!scroller) return true;
      return (
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= STICK_THRESHOLD_PX
      );
    },
    update: () => {
      const scroller = scrollerRef.current;
      const feed = feedRef.current;
      if (!scroller || !feed) return;
      feed.toggleAttribute("data-overflow", scroller.scrollHeight > scroller.clientHeight);
      feed.toggleAttribute("data-feed-above", scroller.scrollTop > STICK_THRESHOLD_PX);
      feed.toggleAttribute("data-feed-below", !edges.current.atBottom());
    },
    /** Scrolls to the newest line and remembers that this scroll is ours. */
    pin: () => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      scroller.scrollTop = scroller.scrollHeight;
      ownScrollTop.current = scroller.scrollTop;
    },
    setPinned: (next: boolean) => {
      pinned.current = next;
      scrollerRef.current?.setAttribute("data-feed-pinned", next ? "true" : "false");
    },
  });

  useEffect(() => {
    const scroller = scrollerRef.current;
    const rows = rowsRef.current;
    if (!scroller || !rows) return;
    const { atBottom, update, pin, setPinned } = edges.current;
    setPinned(true);
    // A scroll event is reported a frame after the scroll happened, and the
    // scroll steps run before resize observations in that frame. So when the
    // content grows between the feed's own pin and its report (a late
    // typeface swap changing every row's height), the report says "not at
    // bottom" - and reading that as the reader scrolling away would unpin
    // the list for good. The feed's own scroll is recognised by its value
    // and pinned again instead.
    const onScroll = () => {
      if (ownScrollTop.current !== -1 && scroller.scrollTop === ownScrollTop.current) {
        if (pinned.current && !atBottom()) pin();
        update();
        return;
      }
      ownScrollTop.current = -1;
      setPinned(atBottom());
      update();
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    // Two things move the bottom after a paint: the frame gets its height
    // from the host after the first data can land, and the typefaces land
    // after the first paint and change every row's height. So a pinned list
    // re-pins whenever the scroller OR its content changes size. The rows
    // are watched by their border box: what the scroller scrolls is the
    // rows' outer size, so growth in their padding moves the bottom exactly
    // like a taller row does.
    const repin = new ResizeObserver(() => {
      if (pinned.current) {
        pin();
      }
      update();
    });
    repin.observe(scroller);
    repin.observe(rows, { box: "border-box" });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      repin.disconnect();
    };
  }, []);

  // One paint of the list: what it built and removed, pinned when the
  // reader has not scrolled away, then the lag of a line born after this
  // document.
  useLayoutEffect(() => {
    if (lines === null) return;
    const next = feedKeysOf(lines);
    const drop = leadingDrop(painted.current, next);
    const kept = painted.current.length - drop;
    painted.current = next;
    if (pinned.current) edges.current.pin();
    edges.current.update();
    performance.measure("feed:render", {
      start: "feed:render:start",
      detail: { rows: lines.length, added: lines.length - kept, removed: drop },
    });
    const newest = lines[lines.length - 1];
    const key = next[next.length - 1] ?? null;
    if (newest && key !== newestKey.current && newest.at >= performance.timeOrigin) {
      performance.measure("feed:lag", {
        start: Math.max(0, newest.at - performance.timeOrigin),
        end: performance.now(),
      });
    }
    newestKey.current = key;
  }, [lines]);

  const keys = lines ? feedKeysOf(lines) : [];
  // What was there when the page first read the feed is not news, held back by focus or not.
  if (allLines !== null && snapshotKeys.current === null)
    snapshotKeys.current = new Set(feedKeysOf(allLines));
  return (
    <>
      <style>{styles}</style>
      <div data-feed="" ref={feedRef}>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scroller with no controls of its own is one stop for the keyboard, which scrolls it */}
        <section data-feed-scroller="" ref={scrollerRef} tabIndex={0} aria-label="Activity lines">
          <div data-feed-rows="" ref={rowsRef}>
            {lines?.map((line, i) => (
              <Row
                key={keys[i]}
                line={line}
                age={feedRelativeAge(line.at, now)}
                taskOf={taskOf}
                point={point}
                litTaskId={litTaskIn([line.taskKey ?? "", line.text], taskOf, view.litTaskId)}
                fresh={
                  !snapshotKeys.current?.has(keys[i] ?? "") && line.at >= performance.timeOrigin
                }
              />
            ))}
          </div>
        </section>
      </div>
    </>
  );
}
