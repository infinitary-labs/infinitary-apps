import { HERE } from "@shared/deviceNames";
import type { KeySystem } from "@shared/platform";
import {
  attachmentStanding,
  browserDriverOf,
  CLOSE_PAGE_LABEL,
  canOpenAgain,
  OPEN_AGAIN_CAPTION,
  OPEN_AGAIN_LABEL,
  REPORT_PROBLEM_DRAFT,
  RETURN_CONTROL_LABEL,
  RETURN_CONTROL_NOTICE,
  rememberSignInLabel,
  SAVED_SIGN_IN_STATUS,
  type SavedSignIn,
  STALE_ATTACHMENT_WORDS,
  STOP_VIEW_WORDS,
  signInCaption,
  TAKE_CONTROL_LABEL,
  TASK_BROWSER_PAGE,
  TASK_BROWSER_PAGE_MAX,
  TASK_BROWSER_PAGE_MIN,
  TASK_BROWSER_PASTE_MAX,
  type TaskBrowserDriver,
  type TaskBrowserFrame,
  type TaskBrowserInput,
  VIEW_DRIVER_WORDS,
} from "@shared/taskBrowser";
import { taskFactsOf } from "@shared/taskFacts";
import type { TaskDetail } from "@shared/tasks";
import type React from "react";
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useCommandKeys } from "../app/keyHints";
import { useShellStore } from "../app/store";
import { useModelNames } from "../app/useModelNames";
import { Button, IconButton, RowMenu, StatusDot } from "../design";
import { CardSizeContext } from "../design/cards/CardSize";
import { CARD_MAX_HEIGHT, cardFloor } from "../design/cards/ResponseCard";
import { thisDesktop } from "../design/core/desktop";
import { useOverflowTitle } from "../design/core/overflowTitle";
import { useRestLabel } from "../design/core/restLabel";
import { browserShownThereWords, isView } from "../devices/viewWords";
import { appReadExecutor } from "../plugins/reads/appExecutor";
import { RecordPaneChrome } from "./RecordPaneChrome";
import { recordPillToneOf } from "./recordFooter";
import { TaskTabStrip } from "./TaskTabStrip";
import { NO_TAB_FACTS, taskTabFactsOf } from "./taskTabs";

/**
 * A task's own browser on the stage (docs/task-browser.md, "The view"; the
 * design skill's `components/cards/TaskBrowser`): the task card's own top -
 * the record's chrome with Hide in its corner, the title and the tabs - then
 * one row of browser chrome, the live page and a foot line, where the
 * captain watches the crewmate drive. A shell-held stack entry like the
 * record.
 *
 * The page is a picture: the host streams the hidden page's own pictures
 * while this view is up, and the view draws the newest on a canvas. The page
 * never enters the app's window, so More's menu may sit over it, and
 * nothing here reaches the page while the captain watches - watching is not
 * control. Take control makes it his (docs/task-browser.md, "Taking
 * control"): his pointer, wheel and keys on the picture go to the page as
 * they came, and nothing records them; Return control hands back directly,
 * with a visible sharing notice and a lasting site save choice (docs/task-browser.md,
 * "Saved sign-ins").
 * The card's tab strip names each page Browser and its title; picking
 * another page is the captain's while he holds the browser, as navigation is.
 * Maximized, the view gives the page its room: the page lays out afresh at
 * that size, and goes back to its own once the view is restored.
 */

const CHROME_HEIGHT = 44;
const FOOT_HEIGHT = 36;
/** The line a card's stale door adds under the row, with its hairline; the return question's row too. */
const NOTICE_HEIGHT = 32;
/** The return question's row: its line, then the tick that remembers the site's sign-in. */
const QUESTION_HEIGHT = 44 + 28;
/**
 * The page's room: the card's cap less the surface's own border, the card's
 * top as it draws (`top`), the row above the page with its hairline, any
 * lines under it, and the foot line with its hairline.
 */
const pageMaxHeight = (notice: boolean, question: boolean, top: number) =>
  `calc(${CARD_MAX_HEIGHT} - ${2 + top + CHROME_HEIGHT + 1 + FOOT_HEIGHT + 1 + (notice ? NOTICE_HEIGHT + 1 : 0) + (question ? QUESTION_HEIGHT + 1 : 0)}px)`;

/** The row's tint and dot for who holds the browser: his violet, attention's ember, or none. */
const ROW_TINT: Partial<Record<TaskBrowserDriver, string>> = {
  waiting: "var(--warn-dim)",
  captain: "var(--captain-dim)",
};
const DOT_TONE: Record<TaskBrowserDriver, "busy" | "idle" | "warn" | "captain"> = {
  crewmate: "busy",
  nobody: "idle",
  waiting: "warn",
  taking: "busy",
  captain: "captain",
};

/** Alt 1, Control 2, Meta 4, Shift 8: the browser protocol's own modifier bits. */
function modifiersOf(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

/** The editing keys, sent to the page as its own editing commands. */
const EDITING_COMMANDS: Record<string, "selectAll" | "undo" | "cut" | "copy" | "paste"> = {
  a: "selectAll",
  z: "undo",
  x: "cut",
  c: "copy",
  v: "paste",
};

type EditingCommand = NonNullable<Extract<TaskBrowserInput, { kind: "key" }>["command"]>;

/**
 * The editing command a key stands for in the window's own key system
 * (docs/keyboard.md, "Keys on each system"): ⌘ on a Mac, Ctrl on Linux,
 * where Ctrl+Y redoes too. The page gets the command whatever system it
 * runs on.
 */
function editingCommand(event: React.KeyboardEvent, system: KeySystem): EditingCommand | undefined {
  const held = system === "mac" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!held || event.altKey) return undefined;
  const key = event.key.toLowerCase();
  if (key === "z" && event.shiftKey) return "redo";
  if (key === "y" && system !== "mac") return "redo";
  return EDITING_COMMANDS[key];
}

/** What a key types on the page, for a key that types. */
function typedText(event: React.KeyboardEvent): string | undefined {
  if (event.metaKey || event.ctrlKey) return undefined;
  if (event.key === "Enter") return "\r";
  return event.key.length === 1 ? event.key : undefined;
}

const MOUSE_BUTTONS = ["left", "middle", "right"] as const;

type KeyInput = Extract<TaskBrowserInput, { kind: "key" }>;

/** The paste key as the page gets it when the paste came from the menu rather than the key. */
const PASTE_KEY: Omit<KeyInput, "type"> = {
  kind: "key",
  key: "v",
  code: "KeyV",
  keyCode: 86,
  modifiers: 4,
  command: "paste",
};

/**
 * The captain's own input on the page while he has control: the pointer,
 * the wheel and the keys on the picture, at the page's own pixels, sent as
 * they came. Moves go at most once a frame. Nothing here keeps any of it.
 */
function useCaptainInput(taskId: string, enabled: boolean) {
  const area = useRef<HTMLDivElement | null>(null);
  const pendingMove = useRef<TaskBrowserInput | null>(null);
  const frame = useRef(0);
  const keysDown = useRef(new Set<string>());
  /** The paste key pressed and its paste not yet come: the key, sent with the words once it does. */
  const pendingPaste = useRef<Omit<KeyInput, "type"> | null>(null);

  const send = useCallback(
    (input: TaskBrowserInput) => {
      void window.infinitary.browser.input(taskId, input).catch(() => undefined);
    },
    [taskId],
  );

  /**
   * A point on the picture, as the page's own pixels at the size of the
   * picture drawn now; null off the page, unless `edge` holds it to the
   * page's edge (a button let go off it).
   */
  const pointOf = useCallback((clientX: number, clientY: number, edge = false) => {
    const canvas = area.current?.querySelector("canvas");
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const { width, height } = canvas;
    const x = ((clientX - rect.left) * width) / rect.width;
    const y = ((clientY - rect.top) * height) / rect.height;
    const off = x < 0 || y < 0 || x > width || y > height;
    if (off && !edge) return null;
    return {
      x: Math.min(width, Math.max(0, x)),
      y: Math.min(height, Math.max(0, y)),
    };
  }, []);

  useEffect(() => {
    const node = area.current;
    if (!enabled || !node) return;
    // The wheel scrolls the page, not the view: a listener that may say so.
    const onWheel = (event: WheelEvent) => {
      const point = pointOf(event.clientX, event.clientY);
      if (!point) return;
      event.preventDefault();
      send({
        kind: "wheel",
        ...point,
        deltaX: Math.max(-10_000, Math.min(10_000, event.deltaX)),
        deltaY: Math.max(-10_000, Math.min(10_000, event.deltaY)),
        modifiers: modifiersOf(event),
      });
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    // A paste on the view carries the words on this computer's own
    // clipboard, which the page's computer may not share; the window reads
    // them only from the paste the captain made (docs/task-browser.md, "Paste").
    const onPaste = (event: ClipboardEvent) => {
      const focused = document.activeElement;
      if (!focused || !node.contains(focused)) return;
      event.preventDefault();
      const text = event.clipboardData?.getData("text/plain") ?? "";
      const key = pendingPaste.current ?? PASTE_KEY;
      pendingPaste.current = null;
      send({
        ...key,
        type: "down",
        ...(text && text.length <= TASK_BROWSER_PASTE_MAX ? { clipboard: text } : {}),
      });
      send({ ...key, type: "up" });
    };
    document.addEventListener("paste", onPaste);
    return () => {
      node.removeEventListener("wheel", onWheel);
      document.removeEventListener("paste", onPaste);
      cancelAnimationFrame(frame.current);
      pendingMove.current = null;
      pendingPaste.current = null;
      keysDown.current.clear();
    };
  }, [enabled, pointOf, send]);

  const mouse = (type: "down" | "up" | "move") => (event: React.MouseEvent) => {
    if (!enabled) return;
    const point = pointOf(event.clientX, event.clientY, type === "up");
    if (!point) return;
    if (type === "down") area.current?.focus({ preventScroll: true });
    if (type !== "move") event.preventDefault();
    const input: TaskBrowserInput = {
      kind: "pointer",
      type,
      ...point,
      button: type === "move" ? "none" : (MOUSE_BUTTONS[event.button] ?? "left"),
      clickCount: type === "move" ? 0 : Math.min(3, Math.max(1, event.detail)),
      modifiers: modifiersOf(event),
    };
    if (type !== "move") {
      send(input);
      return;
    }
    const waiting = pendingMove.current !== null;
    pendingMove.current = input;
    if (waiting) return;
    frame.current = requestAnimationFrame(() => {
      const next = pendingMove.current;
      pendingMove.current = null;
      if (next) send(next);
    });
  };

  const key = (type: "down" | "up") => (event: React.KeyboardEvent) => {
    if (!enabled || event.nativeEvent.isComposing) return;
    const command = editingCommand(event, thisDesktop().keys);
    // The app's own ⌘ shortcuts stay the app's; every other key is the page's.
    if (event.metaKey && !command) return;
    const pressed: Omit<KeyInput, "type"> = {
      kind: "key",
      key: event.key.slice(0, 32),
      code: event.code.slice(0, 32),
      keyCode: Math.min(255, Math.max(0, event.keyCode)),
      modifiers: modifiersOf(event),
    };
    if (command === "paste") {
      event.stopPropagation();
      // The paste key goes on to the window's own paste, which carries the words.
      if (type === "down") {
        if (!event.repeat) pendingPaste.current = { ...pressed, command };
        return;
      }
      event.preventDefault();
      // No paste came: the page pastes from its own computer's clipboard.
      const key = pendingPaste.current;
      pendingPaste.current = null;
      if (key) {
        send({ ...key, type: "down" });
        send({ ...key, type: "up" });
      }
      return;
    }
    if (type === "up" && !keysDown.current.delete(event.code || event.key)) return;
    if (type === "down") keysDown.current.add(event.code || event.key);
    event.preventDefault();
    event.stopPropagation();
    const text = type === "down" ? typedText(event) : undefined;
    send({
      ...pressed,
      type,
      ...(text ? { text } : {}),
      ...(command && type === "down" ? { command } : {}),
    });
  };

  return {
    ref: area,
    handlers: enabled
      ? {
          tabIndex: 0,
          onMouseDown: mouse("down"),
          onMouseUp: mouse("up"),
          onMouseMove: mouse("move"),
          onContextMenu: (event: React.MouseEvent) => event.preventDefault(),
          onKeyDown: key("down"),
          onKeyUp: key("up"),
        }
      : {},
  };
}

const SURFACE: React.CSSProperties = {
  width: "100%",
  maxHeight: CARD_MAX_HEIGHT,
  minHeight: cardFloor(0),
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  background: "var(--acrylic-bg)",
  backdropFilter: "var(--acrylic-blur)",
  WebkitBackdropFilter: "var(--acrylic-blur)",
  border: "1px solid var(--acrylic-border)",
  borderRadius: "var(--radius-l)",
  boxShadow: "var(--acrylic-shadow)",
};

const ROW: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-1)",
  height: CHROME_HEIGHT,
  padding: "0 var(--space-2)",
  borderBottom: "1px solid var(--line-1)",
  flexShrink: 0,
  minWidth: 0,
};

const LINE: React.CSSProperties = {
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  minWidth: 0,
};

const LINK: React.CSSProperties = {
  padding: 0,
  border: 0,
  background: "none",
  font: "inherit",
  color: "var(--accent)",
  cursor: "pointer",
  whiteSpace: "nowrap",
  flexShrink: 0,
};

function icon(paths: string[]) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

const BACK = icon(["m15 18-6-6 6-6"]);
const FORWARD = icon(["m9 18 6-6-6-6"]);
const RELOAD = icon(["M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8", "M21 3v5h-5"]);

/**
 * How tall the card's top draws, followed as it changes: a long title wraps,
 * so the page's room is measured rather than counted. Answers the ref
 * callback the top takes.
 */
function useTopHeight(): [(node: HTMLDivElement | null) => void, number] {
  const [top, setTop] = useState<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    if (!top) return;
    const measure = () => setHeight(top.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(top);
    return () => observer.disconnect();
  }, [top]);
  return [setTop, height];
}

/** A frame's JPEG, decoded off the base64 the host sent. */
function bitmapOf(frame: TaskBrowserFrame): Promise<ImageBitmap> {
  const raw = atob(frame.data);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
}

/**
 * Watches the task's page while the view is up and paints the newest
 * picture on the canvas the answered ref holds. A picture that arrives while
 * one decodes replaces the waiting one, so a busy page never queues; the
 * newest is kept for a canvas that mounts later (after Open again).
 */
function useWatchedPage(taskId: string): (node: HTMLCanvasElement | null) => void {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const latest = useRef<TaskBrowserFrame | null>(null);
  const waiting = useRef<TaskBrowserFrame | null>(null);
  const painting = useRef(false);
  const painted = useRef(0);

  const paint = useCallback(async () => {
    if (painting.current) return;
    painting.current = true;
    try {
      for (let next = waiting.current; next; next = waiting.current) {
        waiting.current = null;
        const target = canvas.current;
        if (!target) break;
        try {
          const bitmap = await bitmapOf(next);
          if (target.width !== bitmap.width) target.width = bitmap.width;
          if (target.height !== bitmap.height) target.height = bitmap.height;
          target.getContext("2d")?.drawImage(bitmap, 0, 0);
          bitmap.close();
          painted.current += 1;
          // Typed hooks a check reads: how many pictures, at what size.
          target.dataset.browserFrames = String(painted.current);
          target.dataset.browserFrameSize = `${next.width}x${next.height}`;
        } catch {
          // A picture that does not decode is skipped; the next one follows.
        }
      }
    } finally {
      painting.current = false;
    }
  }, []);

  useEffect(() => {
    const off = window.infinitary.browser.onFrame((frame) => {
      if (frame.taskId !== taskId) return;
      latest.current = frame;
      waiting.current = frame;
      void paint();
    });
    void window.infinitary.browser.watch(taskId).catch(() => undefined);
    return () => {
      off();
      void window.infinitary.browser.unwatch(taskId).catch(() => undefined);
    };
  }, [taskId, paint]);

  return useCallback(
    (node: HTMLCanvasElement | null) => {
      canvas.current = node;
      painted.current = 0;
      if (node && latest.current) {
        waiting.current = latest.current;
        void paint();
      }
    },
    [paint],
  );
}

/** How long a maximized view's room holds still before the page lays out at it again. */
const ROOM_SETTLE_MS = 120;

const within = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.floor(value)));

/**
 * While the view is maximized, the page takes the room the view gives it
 * (docs/task-browser.md, "The view"): the page's own place under the row,
 * the browser's lines and above the foot line. The persistent sharing notice
 * belongs to that chrome; transient refusal lines keep the page's size under them.
 * Restored or gone, the view gives the page back its own size. Answers the
 * ref the view's surface takes.
 */
function usePageRoom(
  taskId: string,
  maximized: boolean,
  open: boolean,
): React.RefObject<HTMLElement | null> {
  const surface = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!maximized) return;
    return () => {
      void window.infinitary.browser.size(taskId, null).catch(() => undefined);
    };
  }, [taskId, maximized]);

  useEffect(() => {
    const node = surface.current;
    const page = node?.querySelector<HTMLElement>("[data-browser-page]");
    if (!maximized || !open || !node || !page) return;
    let asked = "";
    let timer = 0;
    const measure = () => {
      let height = page.clientHeight;
      for (const passing of node.querySelectorAll<HTMLElement>("[data-browser-passing]")) {
        height += passing.offsetHeight;
      }
      const size = {
        width: within(page.clientWidth, TASK_BROWSER_PAGE_MIN.width, TASK_BROWSER_PAGE_MAX.width),
        height: within(height, TASK_BROWSER_PAGE_MIN.height, TASK_BROWSER_PAGE_MAX.height),
      };
      const key = `${size.width}x${size.height}`;
      if (key === asked) return;
      asked = key;
      void window.infinitary.browser.size(taskId, size).catch(() => undefined);
    };
    // A window being resized settles before the page lays out again.
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(measure, ROOM_SETTLE_MS);
    });
    observer.observe(node);
    observer.observe(page);
    measure();
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [taskId, maximized, open]);

  return surface;
}

export function TaskBrowserView({
  taskId,
  from,
  onClose,
  onDrawn,
}: {
  taskId: string;
  /**
   * The card that opened the view (docs/task-card-tabs.md, "From a card"),
   * and, from a card's live attachment, the browser it named
   * (docs/task-browser.md, "From a card"): a line under the row says when
   * that browser is no longer the task's.
   */
  from?: { cardId: string; session?: string; generation?: number };
  onClose: () => void;
  onDrawn: () => void;
}) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const [fit, setFit] = useState(true);
  /** Why Open again could not open one now; cleared by the next try. */
  const [refusal, setRefusal] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [saveWarning, setSaveWarning] = useState<string | null>(null);
  /** The saved record shown to the captain, whose identity binds refresh consent. */
  const [savedState, setSavedState] = useState<{
    key: string;
    record?: SavedSignIn;
    unavailable?: boolean;
  }>();
  /** An unsaved site's initially unticked Remember choice. */
  const [rememberFor, setRememberFor] = useState<string | null>(null);
  /** The captain's Take control or Return control is on its way. */
  const [moving, setMoving] = useState<"take" | "return" | null>(null);
  const canvas = useWatchedPage(taskId);
  const maximized = useContext(CardSizeContext)?.maximized ?? false;
  const modelName = useModelNames();
  const [topRef, topHeight] = useTopHeight();
  const controlKeys = useCommandKeys("browser.control");
  // On a Mac controlling another, the page shows only there (docs/view.md).
  const thisMac = useShellStore((s) => s.thisMac);
  const there = isView(thisMac) ? browserShownThereWords(thisMac) : null;

  useEffect(() => {
    setDetail(null);
    setUnreadable(false);
    return appReadExecutor().subscribe(
      "tasks.detail",
      { id: taskId },
      {
        onValue: (value) => setDetail(value as TaskDetail),
        onError: () => setUnreadable(true),
      },
    );
  }, [taskId]);

  // Drawn when shown, never prepared: the stage may bring it in at once.
  useEffect(() => {
    onDrawn();
  }, [onDrawn]);

  const fact = detail?.browser;
  const room = usePageRoom(taskId, maximized, fact?.state === "open");
  const driver: TaskBrowserDriver = detail ? browserDriverOf(detail, fact) : "nobody";
  const who = VIEW_DRIVER_WORDS[driver];
  const captain = fact?.state === "open" && driver === "captain";
  const input = useCaptainInput(taskId, captain);
  // A refusal belongs to the state it answered.
  const factState = fact?.state;
  useEffect(() => {
    if (factState !== undefined) setRefusal(null);
  }, [factState]);
  // A refused move belongs to the page it was refused on.
  const factUrl = fact?.state === "open" ? fact.url : undefined;
  useEffect(() => {
    if (factUrl !== undefined) setRefusal(null);
  }, [factUrl]);
  const currentSite = fact?.state === "open" ? fact.site : undefined;
  const currentKey = `${fact?.session}:${fact?.generation}:${currentSite}`;
  const shellView = useShellStore((state) => state.view);
  const saved = savedState?.key === currentKey ? savedState.record : undefined;
  const remember = rememberFor === currentKey;
  const savedRead = savedState?.key === currentKey;
  useEffect(() => {
    setRememberFor(null);
    setSavedState(undefined);
    let active = true;
    if (captain && currentSite && shellView === "home") {
      void window.infinitary.browser
        .signIns()
        .then((view) => {
          if (active)
            setSavedState({
              key: currentKey,
              record: view.signIns.find((entry) => entry.site === currentSite),
              unavailable: !view.available,
            });
        })
        .catch(() => {
          if (active) setSavedState({ key: currentKey, unavailable: true });
        });
    }
    return () => {
      active = false;
    };
  }, [captain, currentSite, currentKey, shellView]);
  // The record keeps the card the view came from, so Hide on it returns there too.
  const openRecord = () =>
    useShellStore.getState().openRecord(taskId, from ? { cardId: from.cardId } : undefined);
  // A card's browser that is no longer the task's is said so, above
  // whatever the task's browser is now.
  const standing =
    from?.session !== undefined && from.generation !== undefined && detail
      ? attachmentStanding({ session: from.session, generation: from.generation }, fact)
      : "same";
  const noticeWords = standing === "same" ? undefined : STALE_ATTACHMENT_WORDS[standing];
  const noticeFit = useOverflowTitle(noticeWords);
  const whoFit = useOverflowTitle(who ? `· ${who}` : undefined);

  // The page's title and whole address, which the status line has no room
  // for: it is a Tab stop that shows them on rest (docs/keyboard.md, "Facts
  // shown on rest").
  const pageWords =
    fact && fact.state !== "stopped" ? [fact.title, fact.url].filter(Boolean).join(" · ") : "";
  const pageRest = useRestLabel(pageWords || undefined, { fact: true });
  const notice =
    standing === "same" ? null : (
      <div
        data-browser-notice={standing}
        ref={noticeFit.ref}
        title={noticeFit.title}
        style={{
          ...LINE,
          height: NOTICE_HEIGHT,
          lineHeight: `${NOTICE_HEIGHT}px`,
          padding: "0 var(--space-3)",
          borderBottom: "1px solid var(--line-1)",
          fontSize: "var(--text-sm)",
          color: "var(--fg-2)",
          flexShrink: 0,
        }}
      >
        {STALE_ATTACHMENT_WORDS[standing]}
      </div>
    );
  const facts = detail ? taskFactsOf(detail, modelName) : null;
  // The record's own top, as the Info and Crewmate tabs draw it, so Hide and
  // the size control stay in the card's corner whichever tab is shown. The
  // card's tab strip names each page Browser and its title; picking another
  // page is the controller's, as navigation is.
  const top = (
    <div
      ref={topRef}
      style={{ display: "flex", flexDirection: "column", flexShrink: 0, minWidth: 0 }}
    >
      <RecordPaneChrome
        reading={facts?.status ?? null}
        pillTone={detail ? recordPillToneOf(detail) : "neutral"}
        taskKey={detail ? detail.key : unreadable ? "this record could not be read" : null}
        title={facts?.title ?? ""}
        tabs={
          <TaskTabStrip
            taskId={taskId}
            shown="browser"
            browser={fact}
            facts={detail ? taskTabFactsOf(detail) : NO_TAB_FACTS}
            captain={captain}
          />
        }
        onClose={onClose}
      />
    </div>
  );

  if (there !== null || !fact || fact.state === "stopped") {
    const stopped = fact?.state === "stopped" ? fact : null;
    const words = there ?? (stopped ? STOP_VIEW_WORDS[stopped.stopped] : null);
    const again = there === null && stopped !== null && canOpenAgain(stopped);
    const openAgain = async () => {
      setOpening(true);
      setRefusal(null);
      try {
        const result = await window.infinitary.browser.reopen(taskId);
        if (!result.ok) setRefusal(result.text);
      } catch {
        setRefusal(`${HERE.This} could not open a browser for this task right now.`);
      } finally {
        setOpening(false);
      }
    };
    return (
      <section
        ref={room}
        data-task-browser={taskId}
        data-browser-state={
          there !== null ? "there" : refusal ? "unavailable" : stopped ? "stopped" : "none"
        }
        aria-label="Task browser"
        style={SURFACE}
      >
        {top}
        {notice}
        <div
          data-browser-stopped={stopped?.stopped ?? ""}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "var(--space-2)",
            minHeight: 320,
            padding: "var(--space-6)",
            textAlign: "center",
          }}
        >
          <div style={{ color: "var(--fg-1)", fontSize: "var(--text-base)", fontWeight: 500 }}>
            {refusal ??
              words?.lead ??
              (detail || unreadable ? `This task has no browser on ${HERE.this}.` : "")}
          </div>
          {words && !refusal && (
            <div style={{ color: "var(--fg-2)", fontSize: "var(--text-sm)" }}>{words.detail}</div>
          )}
          {again && (
            <>
              <span data-browser-open-again="" style={{ marginTop: "var(--space-2)" }}>
                <Button
                  variant="secondary"
                  size="sm"
                  pending={opening}
                  onClick={() => void openAgain()}
                >
                  {OPEN_AGAIN_LABEL}
                </Button>
              </span>
              <div style={{ color: "var(--fg-3)", fontSize: "var(--text-xs)" }}>
                {OPEN_AGAIN_CAPTION}
              </div>
            </>
          )}
        </div>
      </section>
    );
  }

  // What the crewmate did last while it drives, or why it asked for him.
  const did =
    driver === "crewmate" ? fact.did : driver === "waiting" ? fact.request?.reason : undefined;
  const handle =
    fact.session !== undefined && fact.generation !== undefined
      ? { session: fact.session, generation: fact.generation }
      : null;
  const stop = async () => {
    const result = await window.infinitary.browser.stop(taskId).catch(() => null);
    if (result && !result.ok) setRefusal(result.text);
  };
  const handOver = async (which: "take" | "return") => {
    if (!handle) return;
    setMoving(which);
    setRefusal(null);
    setSaveWarning(null);
    try {
      const result =
        which === "return"
          ? await window.infinitary.browser.return(taskId, handle, {
              remember: !saved && remember,
              site: fact.site,
              ...(saved?.id ? { savedId: saved.id } : {}),
            })
          : await window.infinitary.browser.take(taskId, handle);
      if (!result.ok) setRefusal(result.text);
      else if (result.warning) setSaveWarning(result.warning);
    } catch {
      setRefusal(`${HERE.This} could not hand the browser over right now.`);
    } finally {
      setMoving(null);
    }
  };
  const copyAddress = () => void navigator.clipboard.writeText(fact.url).catch(() => undefined);
  const navigation = (label: string, go: "back" | "forward" | "reload", glyph: React.ReactNode) =>
    // Navigation belongs to whoever has control; watching is not control.
    captain ? (
      <IconButton
        label={label}
        onClick={() => {
          setRefusal(null);
          // A move the browser refused - one that would send a form again - says why.
          void window.infinitary.browser
            .input(taskId, { kind: "go", go })
            .then((result) => {
              if (!result.ok) setRefusal(result.text);
            })
            .catch(() => undefined);
        }}
        style={{ flexShrink: 0 }}
      >
        {glyph}
      </IconButton>
    ) : (
      // Marked off, so the keyboard reaches who has control as the pointer does.
      <IconButton label={`${label} · ${who}`} off style={{ flexShrink: 0 }}>
        {glyph}
      </IconButton>
    );
  const control =
    driver === "captain" ? (
      // A browser his own click opened has no crewmate to hand to: it closes.
      fact.own ? (
        <Button
          variant="primary"
          size="sm"
          pending={moving === "return"}
          onClick={() => void handOver("return")}
          style={{ flexShrink: 0 }}
        >
          {CLOSE_PAGE_LABEL}
        </Button>
      ) : (
        <Button
          variant="primary"
          size="sm"
          pending={moving === "return"}
          onClick={() => void handOver("return")}
          {...controlKeys}
          style={{ flexShrink: 0 }}
        >
          {RETURN_CONTROL_LABEL}
        </Button>
      )
    ) : driver === "taking" ? null : (
      <Button
        variant={driver === "waiting" ? "primary" : "secondary"}
        size="sm"
        pending={moving === "take"}
        onClick={() => void handOver("take")}
        {...controlKeys}
        style={{ flexShrink: 0 }}
      >
        {TAKE_CONTROL_LABEL}
      </Button>
    );
  const question = captain && !fact.own;

  return (
    <section
      ref={room}
      data-task-browser={taskId}
      data-browser-state={driver === "crewmate" ? "watching" : driver}
      aria-label="Task browser"
      style={SURFACE}
    >
      {top}
      <div
        data-browser-chrome=""
        data-browser-control={driver}
        style={{ ...ROW, ...(ROW_TINT[driver] ? { background: ROW_TINT[driver] } : {}) }}
      >
        {navigation("Back", "back", BACK)}
        {navigation("Forward", "forward", FORWARD)}
        {navigation("Reload", "reload", RELOAD)}
        <div
          data-browser-status=""
          data-browser-driver={driver}
          tabIndex={pageWords ? 0 : undefined}
          aria-description={pageWords || undefined}
          {...pageRest}
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            padding: "0 var(--space-2)",
            fontSize: "var(--text-sm)",
          }}
        >
          <StatusDot tone={DOT_TONE[driver]} label={who} nativeTitle={whoFit.hidden} />
          <span
            data-browser-site=""
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              color: "var(--fg-1)",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            {fact.site}
          </span>
          <span ref={whoFit.ref} style={{ ...LINE, color: "var(--fg-2)", flexShrink: 1 }}>
            · {who}
          </span>
          {did && (
            <span
              data-browser-did=""
              style={{ ...LINE, color: "var(--fg-3)", flexShrink: 1000, flexBasis: 0, flexGrow: 1 }}
            >
              · {did}
            </span>
          )}
        </div>
        <span
          data-browser-control-button=""
          data-browser-handoff={fact.own ? undefined : ""}
          style={{ display: "contents" }}
        >
          {control}
        </span>
        <RowMenu
          label="More"
          word="More"
          items={[
            { id: "fit", label: fit ? "Actual size" : "Fit", onSelect: () => setFit(!fit) },
            { id: "stop", label: "Stop browser", onSelect: () => void stop() },
            { id: "copy", label: "Copy page address", onSelect: copyAddress },
            {
              id: "report",
              label: "Report a problem",
              onSelect: () => useShellStore.getState().beginDraft(REPORT_PROBLEM_DRAFT),
            },
          ]}
        />
      </div>
      {question && (
        <div
          data-browser-sharing=""
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            minHeight: QUESTION_HEIGHT,
            gap: "var(--space-2)",
            paddingBlock: "var(--space-2)",
            padding: "0 var(--space-3)",
            borderBottom: "1px solid var(--line-1)",
            background: "var(--captain-dim)",
            fontSize: "var(--text-sm)",
            color: "var(--fg-1)",
            flexShrink: 0,
            minWidth: 0,
          }}
        >
          <p style={{ margin: 0, lineHeight: "var(--leading-normal)" }}>{RETURN_CONTROL_NOTICE}</p>
          {saved ? (
            <div
              data-browser-saved=""
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2)",
                flexWrap: "wrap",
                fontSize: "var(--text-xs)",
                color: "var(--fg-2)",
              }}
            >
              <span>{SAVED_SIGN_IN_STATUS}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  useShellStore.setState({ view: "settings", settingsSection: "general" })
                }
              >
                Manage
              </Button>
            </div>
          ) : !savedRead || savedState?.unavailable ? (
            <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-2)" }}>
              {!savedRead
                ? "Checking saved sign-in…"
                : "Saved sign-ins are unavailable. Return control without saving."}
            </span>
          ) : (
            <label
              data-browser-remember=""
              style={{
                ...LINE,
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2)",
                alignSelf: "flex-start",
                maxWidth: "100%",
                fontSize: "var(--text-xs)",
                color: remember ? "var(--fg-1)" : "var(--fg-2)",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={remember}
                onChange={(event) => setRememberFor(event.target.checked ? currentKey : null)}
                style={{ margin: 0, flex: "none", accentColor: "var(--accent)" }}
              />
              {rememberSignInLabel(fact.site)}
            </label>
          )}
        </div>
      )}
      {notice}
      <div
        ref={input.ref}
        data-browser-page=""
        data-browser-input={captain ? "captain" : undefined}
        // Under his control the page takes the keyboard and pointer as they come.
        role={captain ? "application" : undefined}
        {...input.handlers}
        style={{
          display: "flex",
          justifyContent: fit ? "center" : "flex-start",
          alignItems: "flex-start",
          background: "var(--bg-1)",
          maxHeight: pageMaxHeight(notice !== null, question, topHeight),
          overflow: fit ? "hidden" : "auto",
          minHeight: 0,
          flex: "1 1 auto",
          outline: "none",
        }}
      >
        <canvas
          ref={canvas}
          width={TASK_BROWSER_PAGE.width}
          height={TASK_BROWSER_PAGE.height}
          data-browser-canvas=""
          data-browser-fit={fit ? "fit" : "actual"}
          aria-label={
            captain
              ? `The page at ${fact.site}, under your control`
              : `The page at ${fact.site}, as the crewmate's browser shows it`
          }
          role="img"
          style={
            fit
              ? {
                  display: "block",
                  width: "auto",
                  height: "auto",
                  maxWidth: "100%",
                  maxHeight: pageMaxHeight(notice !== null, question, topHeight),
                }
              : // At its own size: one pixel of the picture per point.
                { display: "block", flex: "none" }
          }
        />
      </div>
      <div
        data-browser-foot=""
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          height: FOOT_HEIGHT,
          padding: "0 var(--space-3)",
          borderTop: "1px solid var(--line-1)",
          fontSize: "var(--text-sm)",
          flexShrink: 0,
          minWidth: 0,
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            color: "var(--fg-3)",
            flexShrink: 0,
          }}
        >
          {detail?.key}
        </span>
        <span style={{ ...LINE, flex: 1, color: "var(--fg-2)" }}>{detail?.title}</span>
        <button type="button" style={LINK} data-browser-record="" onClick={openRecord}>
          Task record
        </button>
        <span data-browser-sign-ins="" style={{ color: "var(--fg-3)", whiteSpace: "nowrap" }}>
          · {signInCaption(fact, captain)}
        </span>
      </div>
      {(refusal || saveWarning) && (
        <div
          role="status"
          data-browser-passing=""
          style={{ padding: "var(--space-2) var(--space-3)", color: "var(--fg-2)" }}
        >
          {refusal ?? saveWarning}
        </div>
      )}
    </section>
  );
}
