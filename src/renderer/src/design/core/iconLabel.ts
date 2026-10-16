import { motionEase, motionToken } from "../motion";

/**
 * The label an icon button shows under the pointer (design skill IconButton
 * and Motion), drawn by the app instead of the native title: the first one
 * waits `--delay-label`, then fades in; resting on a neighbouring button
 * while one shows - or just after it went - moves it there at once; leaving
 * or pressing takes it away at once. One label per document, so a panel's
 * frame keeps its own. It is decoration: the button's accessible name is
 * its aria-label, so the label is hidden from assistive technology and
 * never takes the pointer.
 */

/** How soon after a label went the next one still shows at once, ms. */
export const LABEL_RECENT_MS = 400;
/** Clear air between the button and its label, and the label and the window's edge, px. */
const GAP = 6;
const EDGE = 8;
/** The widest a label grows before its words wrap, px. */
const LABEL_MAX_WIDTH = 360;

type LabelState = {
  el: HTMLDivElement | null;
  /** The button the label shows for, or null while it is hidden. */
  on: HTMLElement | null;
  /** The button waiting for its first label, and the words it will show. */
  pending: HTMLElement | null;
  pendingWords: { text: string; keys?: string | undefined };
  timer: number;
  hide: number;
  /** When the last label went, for the moment the next one may show at once. */
  goneAt: number;
  move: Animation | null;
  /** The key press that last took a label away, and the element it showed for. */
  keyTook: { event: Event; from: HTMLElement } | null;
};

const states = new WeakMap<Document, LabelState>();

function stateOf(doc: Document): LabelState {
  const known = states.get(doc);
  if (known) return known;
  const state: LabelState = {
    el: null,
    on: null,
    pending: null,
    pendingWords: { text: "" },
    timer: 0,
    hide: 0,
    goneAt: -Infinity,
    move: null,
    keyTook: null,
  };
  states.set(doc, state);
  const away = () => hideLabel(doc);
  // A key takes the label away too, and remembers whose it was.
  const key = (event: Event) => {
    state.keyTook = state.on && state.el && !state.el.hidden ? { event, from: state.on } : null;
    hideLabel(doc);
  };
  doc.addEventListener("pointerdown", away, true);
  doc.addEventListener("keydown", key, true);
  doc.defaultView?.addEventListener("blur", away);
  return state;
}

function labelElement(doc: Document, state: LabelState): HTMLDivElement {
  if (state.el?.isConnected) return state.el;
  const el = doc.createElement("div");
  el.setAttribute("data-icon-label", "");
  el.setAttribute("aria-hidden", "true");
  Object.assign(el.style, {
    position: "fixed",
    left: "0px",
    top: "0px",
    // Over every layer, a modal overlay included: it labels what is under the pointer.
    zIndex: "2000",
    padding: "2px 8px",
    borderRadius: "var(--radius-s)",
    border: "1px solid var(--line-2)",
    background: "var(--bg-3)",
    color: "var(--fg-1)",
    fontFamily: "var(--font-ui)",
    fontSize: "var(--text-sm)",
    lineHeight: "1.4",
    // One line for a name; a longer fact - a reason, a path - wraps
    // inside the window instead of running past its edge.
    boxSizing: "border-box",
    width: "max-content",
    maxWidth: `min(${LABEL_MAX_WIDTH}px, calc(100vw - ${2 * EDGE}px))`,
    overflowWrap: "anywhere",
    pointerEvents: "none",
    boxShadow: "var(--shadow-1)",
  } satisfies Partial<CSSStyleDeclaration>);
  el.hidden = true;
  doc.body.appendChild(el);
  state.el = el;
  return el;
}

/** Where the label sits for `button`: centred under it, or over it near the bottom edge, inside the window. */
export function labelSpot(
  button: { left: number; top: number; right: number; bottom: number },
  label: { width: number; height: number },
  view: { width: number; height: number },
): { x: number; y: number } {
  const centre = (button.left + button.right) / 2;
  const x = Math.max(EDGE, Math.min(view.width - EDGE - label.width, centre - label.width / 2));
  const below = button.bottom + GAP;
  const y = below + label.height <= view.height - EDGE ? below : button.top - GAP - label.height;
  return { x: Math.round(x), y: Math.round(Math.max(EDGE, y)) };
}

function show(
  doc: Document,
  button: HTMLElement,
  text: string,
  keys: string | undefined,
  how: "fade" | "move" | "cut",
) {
  const state = stateOf(doc);
  const el = labelElement(doc, state);
  const view = doc.defaultView;
  if (!view || !button.isConnected) return;
  const from =
    state.on && !el.hidden
      ? { x: Number.parseFloat(el.style.left) || 0, y: Number.parseFloat(el.style.top) || 0 }
      : null;
  el.replaceChildren(text);
  if (keys) {
    // The command's key after the words, in mono like every keybind.
    const key = doc.createElement("span");
    key.setAttribute("data-icon-label-keys", "");
    Object.assign(key.style, {
      marginLeft: "var(--space-2)",
      fontFamily: "var(--font-mono)",
      color: "var(--fg-3)",
    } satisfies Partial<CSSStyleDeclaration>);
    key.textContent = keys;
    el.append(key);
  }
  el.hidden = false;
  const spot = labelSpot(
    button.getBoundingClientRect(),
    { width: el.offsetWidth, height: el.offsetHeight },
    { width: view.innerWidth, height: view.innerHeight },
  );
  el.style.left = `${spot.x}px`;
  el.style.top = `${spot.y}px`;
  state.on = button;
  state.move?.cancel();
  state.move = null;
  const duration = motionToken(el, "--dur-fast");
  if (duration <= 0) return;
  if (how === "move" && from) {
    state.move = el.animate(
      [
        { transform: `translate(${from.x - spot.x}px, ${from.y - spot.y}px)` },
        { transform: "none" },
      ],
      { duration, easing: motionEase(el) },
    );
  } else if (how === "fade") {
    state.move = el.animate(
      [
        { opacity: 0, transform: "translateY(-2px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration, easing: motionEase(el) },
    );
  }
}

/**
 * How the label comes to a button the pointer rests on: it moves over from
 * the button that shows one, shows at once just after one went, or waits.
 */
export function labelArrival(showing: boolean, sinceGone: number): "move" | "cut" | "wait" {
  if (showing) return "move";
  return sinceGone < LABEL_RECENT_MS ? "cut" : "wait";
}

/** The pointer came to rest on `button`, whose label is `text`, and `keys` its command's key. */
export function labelEnter(button: HTMLElement, text: string, keys?: string): void {
  const doc = button.ownerDocument;
  const state = stateOf(doc);
  doc.defaultView?.clearTimeout(state.timer);
  doc.defaultView?.clearTimeout(state.hide);
  state.pending = null;
  const arrival = labelArrival(
    state.on !== null && state.el !== null && !state.el.hidden,
    performance.now() - state.goneAt,
  );
  if (arrival !== "wait") {
    show(doc, button, text, keys, arrival);
    return;
  }
  const el = labelElement(doc, state);
  state.pending = button;
  state.pendingWords = { text, keys };
  state.timer =
    doc.defaultView?.setTimeout(
      () => {
        if (state.pending !== button) return;
        state.pending = null;
        // The words the button has when its label shows, which may have changed while it waited.
        show(doc, button, state.pendingWords.text, state.pendingWords.keys, "fade");
      },
      motionToken(el, "--delay-label"),
    ) ?? 0;
}

/**
 * The pointer left `button`. The label goes at once; the hand-off waits one
 * task, so a pointer moving straight onto a neighbour moves the label there.
 */
export function labelLeave(button: HTMLElement): void {
  const doc = button.ownerDocument;
  const state = stateOf(doc);
  if (state.pending === button) {
    doc.defaultView?.clearTimeout(state.timer);
    state.pending = null;
  }
  if (state.on !== button) return;
  doc.defaultView?.clearTimeout(state.hide);
  state.hide = doc.defaultView?.setTimeout(() => hideLabel(doc), 0) ?? 0;
}

/**
 * Whether `event`, a key press, took away the label `element` showed: a
 * fact's Esc then lets the label go and nothing else (./restLabel).
 */
export function labelTakenBy(element: HTMLElement, event: Event): boolean {
  const took = states.get(element.ownerDocument)?.keyTook;
  return took?.event === event && took.from === element;
}

/** Takes the label away at once: a press, a key, the window losing focus, or the button going. */
export function hideLabel(doc: Document): void {
  const state = states.get(doc);
  if (!state) return;
  doc.defaultView?.clearTimeout(state.timer);
  doc.defaultView?.clearTimeout(state.hide);
  state.pending = null;
  state.move?.cancel();
  state.move = null;
  if (state.on) state.goneAt = performance.now();
  state.on = null;
  if (state.el) state.el.hidden = true;
}

/**
 * The words of a button change while its label shows or waits to (a
 * player's Play that now reads Pause): the label says the new words where it
 * stands, with no motion of its own.
 */
export function labelChanged(button: HTMLElement, text: string, keys?: string): void {
  const state = states.get(button.ownerDocument);
  if (!state) return;
  if (state.pending === button) state.pendingWords = { text, keys };
  if (state.on !== button || !state.el || state.el.hidden) return;
  show(button.ownerDocument, button, text, keys, "cut");
}

/** A button that leaves the page takes its label, or its wait for one, with it. */
export function labelGone(button: HTMLElement): void {
  const state = states.get(button.ownerDocument);
  if (!state) return;
  if (state.on === button) hideLabel(button.ownerDocument);
  else if (state.pending === button) {
    button.ownerDocument.defaultView?.clearTimeout(state.timer);
    state.pending = null;
  }
}
