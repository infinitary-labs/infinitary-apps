import {
  type DrawnMark,
  keyStep,
  middleBox,
  movedBox,
  type PictureSize,
  sizedBox,
} from "@shared/cardNoteMarks";
import {
  type CardNote,
  markNumbers,
  type NotePlace,
  PAGE_NOTE_KEY,
  PAGE_NOTE_KIND,
  placeBounds,
  placeKey,
} from "@shared/cardNotes";
import { TURN_IMAGES_MAX } from "@shared/cards";
import { formatNumber } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";
import type { TaskBrowserFrame, TaskBrowserPlace } from "@shared/taskBrowser";
import type React from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useCommandKeys } from "../app/keyHints";
import { useShellStore } from "../app/store";
import { IconButton } from "../design";
import {
  type ClientBox,
  type MarkTool,
  PictureMarks,
  placeClientBox,
} from "../design/cards/PictureMarks";
import { NO_NOTES } from "./AnnotationControls";
import { sameNote, settleAnnotation } from "./annotationBridge";
import { markedGroups, markedSource, rememberMarked } from "./markedPictures";

/**
 * Point at on the Browser tab (docs/task-browser.md, "Pointing at a page"; the
 * design skill's `components/cards/TaskBrowser`): it holds the newest picture
 * of the task's page still, and the captain marks a place on it - a spot, a
 * box or a freehand line by pointer, or a thing the page's outline names by
 * the arrow keys. The mark becomes a note written in the same popover a
 * card's note is, queued in the list of the card beside the page or, with no
 * card there, in the crewmate's message box.
 *
 * Nothing leaves the window before the captain sends: the held picture is one
 * this window already has, and the page's outline is read once, when the
 * picture is held, through the read every view may ask (`inf:browser:places`).
 */

/** The page's pictures as the view paints them, and the hold Point at puts on them. */
export type WatchedPage = {
  canvas: (node: HTMLCanvasElement | null) => void;
  /** Holds the picture shown still and answers it, or lets the newest through again. */
  hold: (on: boolean) => TaskBrowserFrame | null;
};

/** The picture Point at holds: the page as it was shown, and what its outline names on it. */
export type HeldPage = {
  src: string;
  size: PictureSize;
  /** In the held picture's own pixels; none until the outline is read, or where it cannot be. */
  places: TaskBrowserPlace[];
  /**
   * The page's address and title as its crewmate's own reads give them: only the outline's read
   * answers those, so where it cannot the note names the page's site alone.
   */
  page: { url: string; title: string };
};

export type PagePointAt = {
  held: HeldPage | null;
  on: boolean;
  tool: MarkTool;
  setTool: (tool: MarkTool) => void;
  /** Holds the picture shown now, of the page on this site; false when the view has none yet. */
  start: (site: string) => boolean;
  end: () => void;
  /** The held page with its outline, once the one read of it has answered. */
  read: () => Promise<HeldPage | null>;
};

export function usePagePointAt(taskId: string, watch: WatchedPage): PagePointAt {
  const [held, setHeld] = useState<HeldPage | null>(null);
  const [tool, setTool] = useState<MarkTool>("box");
  const reading = useRef<Promise<HeldPage> | null>(null);

  const end = useCallback(() => {
    watch.hold(false);
    reading.current = null;
    setHeld(null);
  }, [watch]);

  const start = useCallback(
    (site: string) => {
      const frame = watch.hold(true);
      if (!frame) {
        watch.hold(false);
        return false;
      }
      const first: HeldPage = {
        src: `data:image/jpeg;base64,${frame.data}`,
        size: { width: frame.width, height: frame.height },
        places: [],
        page: { url: site.slice(0, 2_048), title: "" },
      };
      setHeld(first);
      const read = window.infinitary.browser
        .places(taskId)
        .then((answer): HeldPage => {
          if (!answer.ok) return first;
          const x = first.size.width / answer.width;
          const y = first.size.height / answer.height;
          return {
            ...first,
            page: { url: answer.url, title: answer.title },
            places: answer.places.map((place) => ({
              ...place,
              x: Math.round(place.x * x),
              y: Math.round(place.y * y),
              width: Math.max(1, Math.round(place.width * x)),
              height: Math.max(1, Math.round(place.height * y)),
            })),
          };
        })
        .catch(() => first);
      reading.current = read;
      void read.then((whole) => {
        if (reading.current === read) setHeld(whole);
      });
      return true;
    },
    [taskId, watch],
  );

  // The picture is let go with the view, and with the task it showed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: another task's page is another picture
  useEffect(() => end, [taskId, end]);

  const read = useCallback(async () => {
    const asked = reading.current;
    if (!asked) return null;
    const whole = await asked;
    return reading.current === asked ? whole : null;
  }, []);

  return { held, on: held !== null, tool, setTool, start, end, read };
}

/** Whether the queue's message has no room for the held picture: each marked picture rides it as one. */
function useFull(owner: string, held: HeldPage | null): boolean {
  const notes = useShellStore((s) => s.replyNotes[owner] ?? NO_NOTES);
  const attached = useShellStore((s) => s.replyImages[owner]?.length ?? 0);
  if (!held) return false;
  const groups = markedGroups(owner, notes);
  return (
    !groups.some((group) => group.source.src === held.src) &&
    groups.length + attached >= TURN_IMAGES_MAX
  );
}

const ICON = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;
const PRESSED: React.CSSProperties = { flexShrink: 0, background: "var(--accent-dim)" };
const RESTING: React.CSSProperties = { flexShrink: 0 };

/** Point at in the Browser tab's row, with its two tools while it is on. */
export function PagePointAtButton({
  point,
  site,
  off,
}: {
  point: PagePointAt;
  /** The site of the page shown now, as the view names it. */
  site: string;
  /** Why it cannot be pressed now, in words: changes are off. */
  off?: string | undefined;
}) {
  const keys = useCommandKeys("cards.point-at");
  return (
    <>
      {point.on &&
        (
          [
            [
              "box",
              m.cardNoteToolBox(),
              <rect key="box" x="4.5" y="6.5" width="15" height="11" rx="1.5" />,
            ],
            ["line", m.cardNoteToolLine(), <path key="line" d="M4 16c2.5-7 5-7 7-2s4.5 5 9-6" />],
          ] as const
        ).map(([tool, label, glyph]) => (
          <IconButton
            key={tool}
            label={label}
            data-browser-tool={tool}
            aria-pressed={point.tool === tool}
            tone={point.tool === tool ? "accent" : "neutral"}
            onClick={() => point.setTool(tool)}
            style={point.tool === tool ? PRESSED : RESTING}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" {...ICON} aria-hidden="true">
              {glyph}
            </svg>
          </IconButton>
        ))}
      <IconButton
        label={m.cardNotePointAt()}
        restWords={off}
        off={off !== undefined}
        keys={keys.keys}
        aria-keyshortcuts={keys["aria-keyshortcuts"]}
        data-key-command={keys["data-key-command"]}
        data-browser-point-at=""
        aria-pressed={point.on}
        tone={point.on ? "accent" : "neutral"}
        onClick={() => {
          if (off !== undefined) return;
          if (point.on) point.end();
          else point.start(site);
        }}
        style={point.on ? PRESSED : RESTING}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" {...ICON} aria-hidden="true">
          <path d="m4 4 7.07 17 2.51-7.39L21 11.07 4 4z" />
        </svg>
      </IconButton>
    </>
  );
}

/** What the foot line says while the page is held: how to mark, or why no more marks fit. */
export function PagePointAtHint({ point, owner }: { point: PagePointAt; owner: string }) {
  const full = useFull(owner, point.held);
  const words = full
    ? m.cardNotePicturesFull({ max: formatNumber(TURN_IMAGES_MAX) })
    : point.tool === "line"
      ? m.cardNoteMarkHintLine()
      : m.cardNotePageHint();
  return (
    <span
      role="status"
      data-browser-point-hint=""
      title={words}
      style={{
        flex: 1,
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        color: "var(--fg-2)",
      }}
    >
      {words}
    </span>
  );
}

const ARROWS: Record<string, readonly [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

const boxOf = (size: PictureSize, entry: TaskBrowserPlace): NotePlace => ({
  width: size.width,
  height: size.height,
  box: { x: entry.x, y: entry.y, width: entry.width, height: entry.height },
});

/** The smallest thing the page names around a mark's middle: what the note says it is on. */
function under(
  places: readonly TaskBrowserPlace[],
  place: NotePlace,
): TaskBrowserPlace | undefined {
  const bounds = placeBounds(place);
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  let found: TaskBrowserPlace | undefined;
  for (const each of places) {
    if (x < each.x || y < each.y || x > each.x + each.width || y > each.y + each.height) continue;
    if (!found || each.width * each.height < found.width * found.height) found = each;
  }
  return found;
}

/**
 * The held picture's marks over the page, and the surface that makes one. It sits over the
 * view's canvas, which shows the held picture, and takes the pointer and the keys while it is
 * up, so nothing reaches the page.
 */
export function PagePointAtLayer({
  point,
  owner,
  canvas,
  shows,
  openColumn,
}: {
  point: PagePointAt;
  /** Whose queue a note joins: the card beside the page, else the page's own (`pageQueue`). */
  owner: string;
  canvas: HTMLCanvasElement | null;
  /** The captain holds the browser, so the picture shows its crewmate a page it cannot see now. */
  shows: boolean;
  /** Opens the column beside the page, where the note is written and waits. */
  openColumn: () => void;
}) {
  const held = point.held;
  const notes = useShellStore((s) => s.replyNotes[owner] ?? NO_NOTES);
  const writing = useShellStore((s) =>
    s.annotationPick?.cardId === owner && s.annotationPick.note.page
      ? s.annotationPick.note
      : undefined,
  );
  const sending = useShellStore((s) => s.sendingReplies[owner] === true);
  const full = useFull(owner, held);
  const root = useRef<HTMLDivElement | null>(null);
  const layer = useRef<HTMLDivElement | null>(null);
  /** Which of the outline's things the arrows stepped to. */
  const [stepped, setStepped] = useState<number | null>(null);
  /** A box the keys moved or sized freely. */
  const [keyBox, setKeyBox] = useState<NotePlace | null>(null);
  const [at, setAt] = useState<{ left: number; top: number; width: number; height: number }>();

  // Over the canvas wherever it is drawn: fitted to its room, or at its own size and scrolled.
  useLayoutEffect(() => {
    if (!canvas) return;
    const measure = () =>
      setAt({
        left: canvas.offsetLeft,
        top: canvas.offsetTop,
        width: canvas.clientWidth,
        height: canvas.clientHeight,
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    if (canvas.parentElement) observer.observe(canvas.parentElement);
    return () => observer.disconnect();
  }, [canvas]);

  // The keys are the layer's while it is up, off whichever control turned Point at on.
  const src = held?.src;
  const drawn = at !== undefined;
  useEffect(() => {
    if (src && drawn) root.current?.focus();
    setStepped(null);
    setKeyBox(null);
  }, [src, drawn]);

  // Point at ends once its note is queued or put away, and the live pictures resume.
  const wrote = useRef(false);
  const { end } = point;
  useEffect(() => {
    if (writing) wrote.current = true;
    else if (wrote.current) {
      wrote.current = false;
      end();
    }
  }, [writing, end]);

  if (!held || !at) return null;
  const { size, places } = held;
  const numbers = markNumbers(notes);
  const marks: DrawnMark[] = notes.flatMap((note, index) =>
    note.page &&
    note.place &&
    markedSource(owner, note)?.src === held.src &&
    !(writing && sameNote(note, writing))
      ? [{ number: numbers[index] as number, place: note.place }]
      : [],
  );
  const queuedAt = writing ? notes.findIndex((note) => sameNote(note, writing)) : -1;
  const next =
    queuedAt >= 0
      ? (numbers[queuedAt] as number)
      : numbers.filter((number) => number !== undefined).length + 1;
  const entry = stepped === null ? undefined : places[stepped];
  const lit = writing?.place ?? keyBox ?? (entry ? boxOf(size, entry) : undefined);
  if (lit) marks.push({ number: next, place: lit, lit: true });

  const mark = async (drawn: NotePlace, box: ClientBox, named?: TaskBrowserPlace) => {
    if (sending || full) return;
    // The outline's one read, which the mark's name and the page's address come from.
    const whole = await point.read();
    // Point at ended while the outline was read: the picture is no longer held.
    if (!whole) return;
    const on = named ?? under(whole.places, drawn);
    // The same place marked again is the queued note it already is, with its words.
    const queued = useShellStore
      .getState()
      .replyNotes[owner]?.find((note) => note.page && placeKey(note.place) === placeKey(drawn));
    const note: CardNote = {
      ...(queued ?? {
        kind: PAGE_NOTE_KIND,
        key: PAGE_NOTE_KEY,
        start: 0,
        line: 1,
        // The page's title is the note's excerpt, as a picture's caption is.
        excerpt: (whole.page.title || whole.page.url).slice(0, 240),
        comment: "",
      }),
      place: drawn,
      page: { ...whole.page, ...(on ? { under: { role: on.role, name: on.name } } : {}) },
    };
    rememberMarked(owner, note, {
      src: held.src,
      alt: whole.page.title || whole.page.url,
      width: size.width,
      height: size.height,
      ...(shows ? { shows: true as const } : {}),
    });
    const open = useShellStore.getState().annotationPick;
    if (open && !(open.cardId === owner && sameNote(open.note, note))) settleAnnotation();
    setStepped(null);
    setKeyBox(null);
    openColumn();
    useShellStore.setState({
      annotationPick: { cardId: owner, note, box },
      annotationOffer: null,
    });
  };

  return (
    <div
      ref={root}
      data-browser-pointing={point.tool}
      data-browser-places={places.length}
      data-browser-stepped={entry ? `${entry.role} ${entry.name}`.trim() : undefined}
      // The held picture takes the arrow keys as its own, as the page does under the captain's control.
      role="application"
      aria-label={m.cardNotePointAt()}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
        // Esc ends Point at and leaves the view up.
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          point.end();
          requestAnimationFrame(() =>
            document.querySelector<HTMLButtonElement>("[data-browser-point-at]")?.focus(),
          );
          return;
        }
        if (writing || full) return;
        const arrow = ARROWS[event.key];
        if (arrow) {
          event.preventDefault();
          event.stopPropagation();
          const [dx, dy] = arrow;
          // Shift sizes a box of its own, which the arrows then move as they do on a picture;
          // until then they step through what the page's outline names, in its order.
          if (keyBox || event.shiftKey || places.length === 0) {
            const step = keyStep(size);
            const from = keyBox ?? (entry ? boxOf(size, entry) : middleBox(size));
            if (point.tool !== "box") point.setTool("box");
            setKeyBox(
              event.shiftKey
                ? sizedBox(from, dx * step, dy * step)
                : keyBox
                  ? movedBox(from, dx * step, dy * step)
                  : from,
            );
            setStepped(null);
          } else {
            const forward = dx + dy > 0;
            setStepped((now) =>
              now === null
                ? forward
                  ? 0
                  : places.length - 1
                : (now + (forward ? 1 : -1) + places.length) % places.length,
            );
          }
          return;
        }
        if (event.key === "Enter" && layer.current) {
          const place = keyBox ?? (entry ? boxOf(size, entry) : undefined);
          if (!place) return;
          event.preventDefault();
          event.stopPropagation();
          void mark(
            place,
            placeClientBox(place, layer.current.getBoundingClientRect()),
            keyBox ? undefined : entry,
          );
        }
      }}
      style={{ position: "absolute", ...at, outline: "none" }}
    >
      <PictureMarks
        size={size}
        marks={marks}
        on={!writing && !full && !sending}
        tool={point.tool}
        next={next}
        onMark={(place, box) => void mark(place, box)}
        style={{ inset: 0 }}
        layerStyle={{ inset: 0 }}
        layerRef={layer}
      />
    </div>
  );
}
