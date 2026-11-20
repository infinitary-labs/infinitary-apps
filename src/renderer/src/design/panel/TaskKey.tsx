import type { PanelPoint, PanelReads } from "@shared/personal/contracts";
import { taskKeyParts, taskKeysIn } from "@shared/taskKeys";
import {
  Fragment,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * How a task key link reads (the design skill's core rule "Task keys"): in
 * words, as a card body's link - accent, underlined; in a dense list (an
 * Activity line, the record's Details, a Usage row), in the list's own dim
 * mono, underlined, turning accent while it is rested on.
 */
export type TaskKeyLook = "prose" | "quiet";

export type TaskKeyProps = {
  /** The key as the words write it. */
  children: string;
  look?: TaskKeyLook;
  /**
   * The pointer or the keyboard rests on the key - its element, where the
   * task's summary goes beside it - or lets it go (null): on leaving it, on
   * a press, on Esc, and on losing focus.
   */
  onRest: (key: HTMLElement | null) => void;
  /** A click or Enter: open the task. */
  onOpen: (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => void;
  /**
   * A rest elsewhere in the window lights this key's task (INF-237): the
   * key takes the look its own rest gives it. The caller reads the window's
   * lit task; this library stays free of the store.
   */
  lit?: boolean;
};

/**
 * One task key as a link (FI3-1271): a Tab stop with the focus ring, whose
 * rest opens the task's summary and whose click or Enter opens the task.
 * It moves no words: it is the key, where the words write it.
 */
export function TaskKey({ children, look = "prose", onRest, onOpen, lit = false }: TaskKeyProps) {
  const [resting, setHot] = useState(false);
  const hot = resting || lit;
  const rested = useRef(false);
  const rest = (key: HTMLElement | null) => {
    rested.current = key !== null;
    onRest(key);
  };
  return (
    <a
      role="link"
      tabIndex={0}
      data-task-key={children}
      data-look={look}
      data-task-lit={lit ? "" : undefined}
      style={{
        cursor: "pointer",
        color: look === "prose" || hot ? "var(--accent)" : "inherit",
        textDecoration: "underline",
        textDecorationThickness: 1,
        textUnderlineOffset: 2,
        borderRadius: "var(--radius-s)",
        background: look === "prose" && hot ? "var(--bg-3)" : undefined,
      }}
      onPointerEnter={(event) => {
        setHot(true);
        rest(event.currentTarget);
      }}
      onPointerLeave={() => {
        setHot(false);
        rest(null);
      }}
      onPointerDown={() => rest(null)}
      onFocus={(event) => {
        const key = event.currentTarget;
        if (!key.matches(":focus-visible")) return;
        setHot(true);
        // Once the window has brought the key into view, where its summary goes.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            if (key.ownerDocument.activeElement === key) rest(key);
          }),
        );
      }}
      onBlur={() => {
        setHot(false);
        rest(null);
      }}
      // biome-ignore lint/a11y/useValidAnchor: a key is a link to a task in the app, which has no address of its own
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        rest(null);
        onOpen(event);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && rested.current) {
          event.stopPropagation();
          rest(null);
          return;
        }
        if (event.key !== "Enter") return;
        event.preventDefault();
        event.stopPropagation();
        rest(null);
        onOpen(event);
      }}
    >
      {children}
    </a>
  );
}

/**
 * Words with the task keys in them drawn as links: `linkFor` draws a key
 * that names a task, and answers undefined for one that names none, which
 * stays in the words as written.
 */
export function TaskKeyWords({
  text,
  linkFor,
}: {
  text: string;
  linkFor: (key: string) => ReactNode | undefined;
}) {
  const links = new Map<string, ReactNode>();
  const parts = taskKeyParts(text, (key) => {
    const link = links.get(key) ?? linkFor(key);
    if (link === undefined) return false;
    links.set(key, link);
    return true;
  });
  let at = 0;
  return (
    <>
      {parts.map((part) => {
        const from = at;
        if ("key" in part) {
          at += part.key.length;
          return <Fragment key={from}>{links.get(part.key)}</Fragment>;
        }
        at += part.text.length;
        return <Fragment key={from}>{part.text}</Fragment>;
      })}
    </>
  );
}

/** Each key's task, by the id the panel's reads gave it. */
export type PanelTaskKeys = (key: string) => string | undefined;

/**
 * Which of the keys `texts` write name tasks, for a panel that reads
 * `tasks.board` and `tasks.search` (FI3-1271): the board's own rows, and
 * for a key the board does not list, one exact search of earlier work.
 * Nothing is guessed: a key-shaped word that names no task stays text.
 */
export function usePanelTaskKeys(reads: PanelReads, texts: readonly string[]): PanelTaskKeys {
  const wanted = useMemo(
    () => [...new Set(texts.flatMap((text) => taskKeysIn(text)))].join(" "),
    [texts],
  );
  const [board, setBoard] = useState<ReadonlyMap<string, string> | null>(null);
  const [found, setFound] = useState<ReadonlyMap<string, string>>(new Map());
  const searches = useRef(new Map<string, (() => void) | null>());
  // The board without its closed rows, until a key names neither a row it
  // lists nor earlier work: it may be work closed this week.
  const lesser = useRef(false);
  const [wantsClosed, setWantsClosed] = useState(false);
  useEffect(
    () =>
      reads.subscribe("tasks.board", wantsClosed ? {} : { closed: false }, (value) => {
        lesser.current = value.closedLeftOut !== undefined;
        setBoard(new Map(value.tasks.map((task) => [task.key, task.id])));
      }),
    [reads, wantsClosed],
  );
  useEffect(() => {
    if (!board || !wanted) return;
    for (const key of wanted.split(" ")) {
      if (board.has(key) || searches.current.has(key)) continue;
      searches.current.set(key, null);
      let answered = false;
      const stop = reads.subscribe("tasks.search", { query: key }, (rows) => {
        answered = true;
        searches.current.get(key)?.();
        searches.current.set(key, null);
        const task = rows.find((row) => row.key === key);
        if (task) setFound((current) => new Map(current).set(key, task.id));
        else if (lesser.current) {
          searches.current.delete(key);
          setWantsClosed(true);
        }
      });
      if (answered) stop();
      else searches.current.set(key, stop);
    }
  }, [reads, board, wanted]);
  useEffect(() => {
    const open = searches.current;
    return () => {
      for (const stop of open.values()) stop?.();
      open.clear();
    };
  }, []);
  // Only a change to which keys name which tasks draws the words again: a
  // board push that moves none of them keeps every line as it is.
  const named = useMemo(
    () =>
      (wanted ? wanted.split(" ") : []).flatMap((key) => {
        const id = board?.get(key) ?? found.get(key);
        return id ? [JSON.stringify([key, id])] : [];
      }),
    [wanted, board, found],
  ).join("\n");
  return useMemo(() => {
    const ids = new Map(
      named ? named.split("\n").map((pair) => JSON.parse(pair) as [string, string]) : [],
    );
    return (key: string) => ids.get(key);
  }, [named]);
}

/**
 * `litTaskId` when one of the keys `texts` write names that task, else null:
 * a memoized row hands this to `PanelTaskKeyText`, so a rest elsewhere
 * draws again only the rows that write the lit task's key (INF-237).
 */
export function litTaskIn(
  texts: readonly string[],
  taskOf: PanelTaskKeys,
  litTaskId: string | null,
): string | null {
  if (litTaskId === null) return null;
  return texts.some((text) => taskKeysIn(text).some((key) => taskOf(key) === litTaskId))
    ? litTaskId
    : null;
}

/** A key's box in its page, for `point.peekTask`. */
function boxOf(key: HTMLElement) {
  const { top, right, bottom, left } = key.getBoundingClientRect();
  return { top, right, bottom, left };
}

/**
 * A panel's words with the task keys in them linked (FI3-1271): resting on
 * one opens the task's summary beside the panel (`point.peekTask`), and a
 * click or Enter opens the task’s record (`point.openRecord`).
 */
export function PanelTaskKeyText({
  text,
  taskOf,
  point,
  look,
  litTaskId = null,
}: {
  text: string;
  taskOf: PanelTaskKeys;
  point: Pick<PanelPoint, "peekTask" | "openRecord">;
  look?: TaskKeyLook;
  /** The panel's `view.litTaskId`: a key of that task takes its rest look (INF-237). */
  litTaskId?: string | null;
}) {
  return (
    <TaskKeyWords
      text={text}
      linkFor={(key) => {
        const taskId = taskOf(key);
        if (taskId === undefined) return undefined;
        return (
          <TaskKey
            {...(look ? { look } : {})}
            lit={litTaskId === taskId}
            onRest={(at) => point.peekTask(at ? { taskId, box: boxOf(at) } : null)}
            onOpen={() => void point.openRecord(taskId).catch(() => {})}
          >
            {key}
          </TaskKey>
        );
      }}
    />
  );
}
