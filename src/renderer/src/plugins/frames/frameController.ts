import { cardDataName } from "@shared/cardPictures";
import {
  CARD_QUESTIONS_MAX_BYTES,
  type CardAnswer,
  type CardQuestionsGap,
  type CardWidth,
  cardQuestionsBytes,
  cardQuestionsSchema,
} from "@shared/cards";
import type { MoveKey } from "@shared/keyboard";
import {
  PERSONAL_STORE_VALUE_MAX_BYTES,
  type PersonalStoreChange,
  type PersonalStoreRequest,
  type PersonalStoreResponse,
  personalStoreRequestSchema,
} from "@shared/personal/manifest";
import type { FrameAnnotationTarget } from "@shared/plugins/bridge";
import {
  ACTION_VALUE_MAX_BYTES,
  FRAME_BRIDGE_VERSION,
  FRAME_MAX_IN_FLIGHT,
  FRAME_MAX_SUBSCRIPTIONS,
  type FrameAnswers,
  type FrameBox,
  type FrameDemo,
  type FrameEntryRef,
  type FrameError,
  type FrameLog,
  type FramePicture,
  type FrameQuestioned,
  type FrameRequest,
  type FrameSound,
  type FrameTaskGesture,
  frameMessageSchema,
  frameRequestSchema,
  type HostMessage,
} from "@shared/plugins/bridge";
import type { MediatedFetchCall, MediatedFetchResult } from "@shared/plugins/fetch";
import { type FrameTheme, PANEL_SERVER_ACTION } from "@shared/plugins/frameDocument";
import { transferReadValue } from "@shared/plugins/readTransfer";
import type { ReadGrant } from "@shared/reads";
import { type ReadExecutor, ReadSubscriptionError } from "../reads/executor";
import { noteDroppedLinkMessage, noteFrameLink } from "./frameLink";

/**
 * The host side of bridge v2 (docs/ui-plugins.md, phase 1): one controller
 * per frame, whichever vehicle carries it. It receives the frame's
 * messages - already source-checked by the caller - zod-parses the closed
 * envelope, and answers every request of its current document with exactly
 * one correlated response.
 *
 * What it enforces, per mount, is the plugin's declaration: a read must be
 * one the plugin declared and the catalog knows; an action must be one the
 * mount declared, with a bounded value; a fetch is forwarded to the core's
 * mediated-fetch seam and never decided here; a store request reaches the
 * one slice the host bound to the mount (a panel drawn in the frame realm,
 * its own extension id), and is refused on a mount bound to none. Bounds hold the frame to
 * FRAME_MAX_SUBSCRIPTIONS live subscriptions and FRAME_MAX_IN_FLIGHT
 * unanswered async requests, so a misbehaving template can wedge only
 * itself. Framework-free: React wires a window listener and a port.
 *
 * An answer goes only to the document that asked. Each new document of a
 * mount numbers its requests from 1 again, so an answer finished after its
 * document was replaced is dropped, and every answer names the document it
 * is for, which the bridge in any other document ignores. A dropped answer's
 * request still counts against FRAME_MAX_IN_FLIGHT until it settles, so a
 * document that replaces itself cannot escape the cap.
 */

export type FramePort = {
  post: (message: HostMessage) => void;
};

/** A box the chrome holds over a document's top right (`FrameMountSpec.inset`). */
export type FrameInset = { width: number; height: number };

export type FrameMountSpec = {
  pluginId: string;
  onAnnotation?: (target: FrameAnnotationTarget, box: FrameBox, focusComment: boolean) => void;
  onPointExit?: () => void;
  /** The selection an Annotate offer was shown for is gone. */
  onSelectionCleared?: () => void;
  /** The captain pressed inside the frame's annotated document. */
  onPointerDown?: () => void;
  revision?: { offerId: string; starts: readonly number[] };
  /** Read-catalog names the plugin declared (its manifest's capabilities.reads). */
  reads: readonly string[];
  /** What the host adds to the plugin's reads from its grant (the views `sql` reaches). */
  grant?: ReadGrant;
  /** Action ids the mount declared (a card's actions; none for a section). */
  actions: readonly string[];
  /**
   * The gesture, and where the frame was when it made it: only the host
   * knows the iframe's place in the window, so anything it must position
   * against a frame's own contents (a panel's crew summary, which sits
   * beside the one row it rests on) needs the rect here to turn frame
   * coordinates into window ones.
   *
   * Its answer, when it is plain data, goes back to the frame as the
   * action's result (a panel's `cards.emit` answers the card's id).
   */
  onAction: (actionId: string, value: unknown, frame?: DOMRect) => unknown;
  /** The page's height, measured at a width: a reading at width 0 is never passed on. */
  onResize?: (height: number) => void;
  /**
   * Initialized, positive drawing at the reported viewport width, not
   * document birth. `held` when the page drew held (a card's page before it
   * is shown, `activate`): its scripts and animations have not started.
   */
  onDrawn?: (height: number, width: number, held: boolean) => void;
  /** A new document of the mount was born (its bridge posted `ready`). */
  onBorn?: () => void;
  onInteraction?: () => void;
  onLiveChange?: () => void;
  onLink?: (href: string) => void;
  /**
   * A press on a `data-inf-draft` control in the frame's current document:
   * the words to start the message box with. Whether the press was the
   * captain's own is the caller's call, as a link's is.
   */
  onDraft?: (text: string) => void;
  /**
   * A picture in the frame was clicked (card pictures, phase 3): the
   * pictures of its group as the frame saw them, and which one. The
   * envelope is checked here; which sources may be shown is the caller's
   * call (`viewablePictures`). `asked` says the body's own script asked
   * for the drawing (`inf.picture`) rather than a press landing on it.
   */
  onImage?: (
    index: number,
    pictures: FramePicture[],
    frame?: HTMLIFrameElement | null,
    asked?: boolean,
  ) => void;
  /**
   * A demo's Play button or poster was pressed (docs/card-authoring.md
   * "Demo recordings"): the recording's served name, its poster and caption
   * as the frame saw them, and whether to play. Which recordings may play is
   * the caller's call (the card's own, `isPlayableDemoSource`).
   */
  onDemo?: (demo: FrameDemo, frame?: HTMLIFrameElement | null) => void;
  /**
   * A press on a kept proof log's line (docs/card-authoring.md "Proof logs"):
   * its served name, the line's words and the size the host wrote. Which logs
   * may open is the caller's call (the card's own, `logSources`).
   */
  onLog?: (log: FrameLog, frame?: HTMLIFrameElement | null) => void;
  /**
   * A press on a sound clip's Listen button (docs/card-authoring.md "Sound
   * clips"): its served name, caption and length. Whether it plays is the
   * caller's call (the card's own, `soundSources`); a mount without it draws
   * no Listen button.
   */
  onSound?: (sound: FrameSound) => void;
  /**
   * The task keys a card body or a task's record writes that name recorded
   * tasks (FI3-594, FI3-1271): pushed to every document after its `ready`
   * and again on every change, so the bridge links each one. A mount
   * without them links nothing.
   */
  taskKeys?: readonly string[];
  /**
   * The one of those keys a rest elsewhere in the window lights (INF-237),
   * or null: pushed with the keys and again to every new document.
   */
  litKey?: string | null;
  /**
   * A gesture on a linked key: `rest` with the key's box in the frame's
   * viewport, `leave`, or `open`. Only for a key this mount's document was
   * told, so a frame can point at no task its body does not name. A mount
   * (`FrameMount`) adds the frame the key is in.
   */
  onTask?: (
    gesture: FrameTaskGesture,
    key: string,
    box?: FrameBox,
    frame?: HTMLIFrameElement | null,
  ) => void;
  /**
   * The knowledge entries a card body names that the window reads
   * (docs/knowledge.md, "References in an answer"), with the words each
   * reference is read by: pushed like the task keys, so the bridge links
   * each one. A mount without them links none.
   */
  entryRefs?: readonly FrameEntryRef[];
  /**
   * A click or Enter on a linked reference. Only for an entry this mount's
   * document was told, so a frame can open no entry its body does not name.
   */
  onEntry?: (id: string) => void;
  /**
   * An Escape nothing in a card body used (docs/keyboard.md, "Cards and
   * frames"): the document asks to be left for its card. Only a mount that
   * hears it is told to send it, and only its current document is heard;
   * whether focus moves is the host's call.
   */
  onEscape?: () => void;
  /**
   * The body's own Enter or Shift+Enter stepped through its questions
   * (docs/keyboard.md, "Moving between a card's questions"): where it went.
   */
  onQuestioned?: (where: FrameQuestioned) => void;
  /**
   * A part of the body asked to open full screen (`inf.expand`), or, in the
   * full-screen copy, said where it stands: which `[data-inf-expand]` part,
   * and its state as JSON. Only a mount that offers it tells the frame so.
   */
  onExpand?: (index: number, state: string) => void;
  /** An unused key offered by the document; the mount checks focus before forwarding it. */
  onKey?: (press: import("@shared/keyboard").KeyPress) => void;
  /**
   * View state pushed down to the frame, re-pushed on every document birth
   * (`inf.state` / `inf.onState`). Host-owned and not app data: the now
   * panel's selected row is the shell's, because the shell owns the pane
   * docked beside it.
   */
  state?: unknown;
  /**
   * A card's shown size (`data-width` in its document), pushed after every
   * `ready` and on every change, the way the theme is. Only a card's frame
   * carries one; the bridge caps full-width drawings only in a frame told it.
   */
  width?: CardWidth;
  /**
   * The box the card's chrome holds over the top right of the document, in
   * CSS pixels from its top and right edges (a merge card's risk chart,
   * docs/card-authoring.md "The risk chart"): the bridge sets it as
   * `--inf-inset-width` and `--inf-inset-height`, which the frame stylesheet's
   * `[data-inf-inset]` spacer keeps clear. Pushed after every `ready` and on
   * every change, the way the width is.
   */
  inset?: FrameInset;
  /**
   * The document's markup, refreshed in place (FI3-1093): pushed after every
   * `ready` and on every change, and the bridge rewrites only what differs,
   * so a node the refresh leaves alone - the link under a press - stays. Only
   * a card's fact strip carries it; its document is never rebuilt for it.
   */
  markup?: string;
  /**
   * The store slice this mount may reach (one plugin vehicle, Phase A item
   * 4): the extension id the HOST bound, never one the frame names, and for
   * a page drawn for a crewmate's build its draft's own slice (`draft`).
   * Absent, the `store` verb is refused.
   */
  store?: { extensionId: string; draft?: true };
  /**
   * The data files the mount's own body names (docs/card-authoring.md, "Data
   * by reference"): the minted names its `<script type="application/json"
   * src>` blocks carry, read from the body the host checked. The `data` verb
   * answers only these; absent, it is refused.
   */
  data?: ReadonlySet<string>;
  /**
   * Arms the frame watchdog (WI-16): from `expectDocument` or `ready` on, the
   * controller ticks every FRAME_WATCHDOG_INTERVAL_MS, and a frame that is
   * not born or leaves FRAME_WATCHDOG_MISSES pings in a row unanswered - its
   * event loop wedged by a runaway script - is reported once. The caller
   * tears the frame down. Misses are not counted while `paused` says the
   * page is hidden, or while the main process has not answered `askMain`
   * (`armWatchdog` says how a ping is judged against its answers).
   */
  onUnresponsive?: () => void;
  /**
   * Called once per document of a watchdog-armed mount, when it has
   * answered FRAME_WATCHDOG_MISSES of the watchdog's pings in a row: as
   * long a run of answers as the run of misses that stops a page. A mount
   * that reloads a stopped page on its own takes it as that reload having
   * worked (INF-3798).
   */
  onSteady?: () => void;
  /**
   * A card body's form (inline decisions, contract 4.22): the host tells
   * every document of the mount to watch its named controls, handing it the
   * shell's draft to reapply by name (`fill`), and hears each reading. A
   * mount without it - a panel, a section - never has its controls read.
   */
  form?: {
    fill: () => CardAnswer[] | undefined;
    onAnswers: (answers: FrameAnswers) => void;
    /**
     * A past card's body (FI3-579): the document fills the draft, then
     * disables every control it holds and any that arrive later, except a
     * demo's Play button, which only opens the viewer.
     */
    readOnly?: true;
    /** A playable preview's body: its questions are settings, none tagged Default (INF-4425). */
    preview?: true;
  };
};

/**
 * How long the window waits on a frame's answer: a footer click's fresh
 * reading of its form, a reveal, and a pointing heard out (`heard`).
 */
export const FRAME_COLLECT_TIMEOUT_MS = 1_000;

/** How often an armed controller pings its frame. */
export const FRAME_WATCHDOG_INTERVAL_MS = 1_000;
/** Consecutive unanswered pings that make a frame unresponsive. */
export const FRAME_WATCHDOG_MISSES = 4;
/**
 * The most intervals a page that stops answering keeps its frame while the
 * main process answers: its first unanswered ping goes out within one
 * interval, and each ping is judged two answered intervals after it went
 * out (`armWatchdog`), so the last of FRAME_WATCHDOG_MISSES is judged two
 * intervals after the streak's last ping.
 */
export const FRAME_WATCHDOG_STOP_INTERVALS = FRAME_WATCHDOG_MISSES + 2;

export type WatchdogTimers = {
  setInterval: (callback: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
};

const browserTimers: WatchdogTimers = {
  setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
};

/** The extension store's two ends, as the app's IPC serves them (`inf:plugins:db`). */
export type FrameStoreDeps = {
  request: (request: PersonalStoreRequest) => Promise<PersonalStoreResponse>;
  onChange: (listener: (change: PersonalStoreChange) => void) => () => void;
};

export type FrameControllerDeps = {
  executor: ReadExecutor;
  fetch: (call: MediatedFetchCall) => Promise<MediatedFetchResult>;
  /** Absent, every store request is refused whatever the mount was bound to. */
  store?: FrameStoreDeps;
  /** A card's kept data file's text by its minted name; absent, every data request is refused. */
  data?: (name: string) => Promise<string>;
  /** The watchdog's clock; tests drive a fake one. */
  timers?: WatchdogTimers;
  /**
   * While this is true, a missed ping is not a wedge: the page is hidden
   * (a collapsed or off-rail panel, or the window itself) and may not run.
   * Absent, every miss counts, as a showing card does.
   */
  paused?: () => boolean;
  /**
   * Asks the main process for an answer that changes nothing. Every message
   * between the window and a frame passes through the main process, so a
   * second in which it has not answered says nothing about the frame: that
   * tick counts no miss (INF-935), and a ping is judged only by the answer
   * to a question asked after the main process passed it on (INF-3798).
   * Absent, the main process is taken to answer each question by the next
   * tick.
   */
  askMain?: () => Promise<unknown>;
};

const V = FRAME_BRIDGE_VERSION;

const hostUpdates = new Set<(controller: FrameController) => void>();

/**
 * Hears each time the host updates a document's words in place - its markup,
 * its view state or data it reads - so what reads those words (Find in this
 * card) reads them again. A document redrawing itself on its own is not heard.
 */
export function onFrameHostUpdate(listener: (controller: FrameController) => void): () => void {
  hostUpdates.add(listener);
  return () => {
    hostUpdates.delete(listener);
  };
}

/** A request's correlation id, and which document of the mount sent it. */
type Asker = { id: number; document: string | undefined; birth: number };

function byteLength(value: unknown): number {
  const text = JSON.stringify(value) ?? "";
  return new TextEncoder().encode(text).byteLength;
}

/**
 * A collect's question definitions, validated on their own and under their
 * bound (docs/card-evidence.md): definitions the host cannot read become the
 * reason there are none, never a lost reading.
 */
function questionsOf(message: {
  questions?: unknown;
  questionsGap?: CardQuestionsGap | undefined;
}): Pick<FrameAnswers, "questions" | "questionsGap"> {
  if (message.questions === undefined) {
    return message.questionsGap ? { questionsGap: message.questionsGap } : {};
  }
  const questions = cardQuestionsSchema.safeParse(message.questions);
  if (!questions.success) return { questionsGap: "invalid" };
  if (cardQuestionsBytes(questions.data) > CARD_QUESTIONS_MAX_BYTES) {
    return { questionsGap: "too-large" };
  }
  return { questions: questions.data };
}

/** Where a revealed part is, and the pictures its picture opens with when the host asked for them. */
export type FrameRevealed = {
  top: number;
  height: number;
  shown?: { index: number; pictures: FramePicture[] };
};

export class FrameController {
  private spec: FrameMountSpec;
  private theme: FrameTheme;
  private ready = false;
  private reuseReads = false;
  private documentId: string | undefined;
  private retiredDocuments = new Set<string>();
  /** Counts the documents the mount was pointed at, so an answer finds the one that asked. */
  private births = 0;
  private disposed = false;
  private inFlight = 0;
  private readonly subscriptions = new Map<number, () => void>();
  /** The read each live subscription names, so a declaration that drops it ends it. */
  private readonly subscribedReads = new Map<number, string>();
  /** Subscriptions the host ended because their read is no longer declared. */
  private readonly revoked = new Set<number>();
  private watchdog: unknown = null;
  private pingSeq = 0;
  /**
   * The watchdog's own pings not yet judged, each with the question to the
   * main process whose answer judges it; `heard` pings come in between.
   */
  private watched: { seq: number; judgedBy: number }[] = [];
  private answeredSeq = 0;
  /** Each `heard` waiting on the pong to its own ping, by that ping's number. */
  private readonly hearing = new Map<number, () => void>();
  private missed = 0;
  /** Pings this document answered in a row, until it is steady (`onSteady`). */
  private kept = 0;
  private steady = false;
  private unborn = 0;
  /** The last question asked before the watched document was expected. */
  private expectedAfter = 0;
  private mainAsked = 0;
  private mainAnswered = 0;
  private stopStoreNotices: (() => void) | null = null;
  private activated = false;
  private revealSeq = 0;
  private revealing?: {
    seq: number;
    offerId: string;
    resolve: (box: FrameRevealed | undefined) => void;
  };
  private findSeq = 0;
  private findMarks = 0;
  private finding?: {
    seq: number;
    read?: (text: string | undefined) => void;
    mark?: (box: { top: number; height: number } | undefined) => void;
    markId?: number;
  };
  private collectSeq = 0;
  private questionSeq = 0;
  private questioning?: { seq: number; resolve: (where: FrameQuestioned | undefined) => void };
  private readonly collecting = new Map<number, (answers: FrameAnswers | undefined) => void>();

  constructor(
    spec: FrameMountSpec,
    theme: FrameTheme,
    private readonly deps: FrameControllerDeps,
    private readonly port: FramePort,
  ) {
    this.spec = spec;
    this.theme = theme;
  }

  get isReady(): boolean {
    return this.ready;
  }

  get subscriptionCount(): number {
    return this.subscriptions.size;
  }

  /**
   * The latest declaration; a card's actions can change between renders. A
   * read the new declaration no longer names, or a `sql` read whose views
   * changed, ends at once (a card revised without it, or a card that
   * closed): the frame's `onError` hears why, and it keeps what it drew.
   */
  update(spec: Partial<FrameMountSpec>): void {
    const views = viewsOf(this.spec.grant);
    this.spec = { ...this.spec, ...spec };
    const viewsMoved = viewsOf(this.spec.grant) !== views;
    for (const [sub, read] of this.subscribedReads) {
      if (this.spec.reads.includes(read) && !(read === "sql" && viewsMoved)) continue;
      this.subscriptions.get(sub)?.();
      this.subscriptions.delete(sub);
      this.subscribedReads.delete(sub);
      this.revoked.add(sub);
      this.port.post({
        fm: V,
        type: "data",
        sub,
        error: {
          code: "read_not_declared",
          // i18n-exempt: not shown (a console line, or an error for the panel's code)
          message: `"${read}" is no longer a read this frame may use`,
        },
      });
    }
  }

  setTheme(theme: FrameTheme): void {
    this.theme = theme;
    if (this.ready) this.port.post({ fm: V, type: "theme", theme });
  }

  /** Hands a part back its state from the full-screen copy (`inf-expanded`). */
  expanded(index: number, state: string): void {
    if (this.ready) this.port.post({ fm: V, type: "expanded", index, state });
  }

  /**
   * Pushes the host's view state. A document not yet born gets it on its
   * `ready` instead, the way the theme does, so a frame never has to ask
   * for the state it was born into.
   */
  setState(state: unknown): void {
    this.spec = { ...this.spec, state };
    if (this.ready) {
      this.port.post({ fm: V, type: "state", state });
      this.hostUpdated();
    }
  }

  private hostUpdated(): void {
    for (const listener of hostUpdates) listener(this);
  }

  /** Pushes a card's shown size; a document not yet born gets it on its `ready`. */
  setWidth(width: CardWidth | undefined): void {
    this.spec = { ...this.spec, ...(width ? { width } : {}) };
    if (this.ready && width) this.port.post({ fm: V, type: "width", width });
  }

  /** Pushes the chrome's box over the document; a document not yet born gets it on its `ready`. */
  setInset(inset: FrameInset | undefined): void {
    const before = this.spec.inset;
    if (before?.width === inset?.width && before?.height === inset?.height) return;
    this.spec = { ...this.spec, inset };
    if (this.ready && inset) this.port.post({ fm: V, type: "inset", ...inset });
  }

  /** Pushes the document's markup; a document not yet born gets it on its `ready`. */
  setMarkup(markup: string | undefined): void {
    if (markup === this.spec.markup) return;
    this.spec = { ...this.spec, markup };
    if (this.ready && markup !== undefined) {
      this.port.post({ fm: V, type: "markup", html: markup });
      this.hostUpdated();
    }
  }

  /** Pushes the keys a card body links; a document not yet born gets them on its `ready`. */
  setTaskKeys(keys: readonly string[] | undefined): void {
    this.spec = { ...this.spec, taskKeys: keys };
    if (this.ready && keys) this.port.post({ fm: V, type: "tasks", keys: [...keys] });
  }

  /** Pushes the key a rest elsewhere lights; a document not yet born gets it on its `ready`. */
  setLitKey(key: string | null): void {
    if ((this.spec.litKey ?? null) === key) return;
    this.spec = { ...this.spec, litKey: key };
    if (this.ready) this.port.post({ fm: V, type: "lit", key });
  }

  /** Pushes the knowledge references a card body links; a document not yet born gets them on its `ready`. */
  setEntryRefs(refs: readonly FrameEntryRef[] | undefined): void {
    this.spec = { ...this.spec, entryRefs: refs };
    if (this.ready && refs) this.port.post({ fm: V, type: "entries", entries: [...refs] });
  }

  /**
   * The card is shown (FI3-871): its page, and every later document of the
   * mount, releases its held scripts and animations. A document not yet
   * born gets it on its `ready`, after the rest of what it was born into.
   * Once shown, a mount stays shown.
   */
  activate(): void {
    if (this.disposed || this.activated) return;
    this.activated = true;
    if (this.ready) this.port.post({ fm: V, type: "activate" });
  }

  /**
   * One message from the frame. Anything outside the envelope is dropped; a
   * link says so on the console at each step (`noteFrameLink`).
   */
  receive(data: unknown): void {
    if (this.disposed) {
      // i18n-exempt: not shown (a console line, or an error for the panel's code)
      noteDroppedLinkMessage(data, "its frame is gone");
      return;
    }
    const parsed = frameMessageSchema.safeParse(data);
    if (!parsed.success) {
      // i18n-exempt: not shown (a console line, or an error for the panel's code)
      noteDroppedLinkMessage(data, "its message is not one the bridge sends");
      return;
    }
    const message = parsed.data;
    // i18n-exempt: not shown (a console line, or an error for the panel's code)
    if (message.type === "link") noteFrameLink(message.href, "heard from its frame");
    if (
      message.type !== "ready" &&
      typeof data === "object" &&
      data !== null &&
      "document" in data &&
      data.document !== this.documentId
    ) {
      if (message.type === "link")
        noteFrameLink(
          message.href,
          // i18n-exempt: not shown (a console line, or an error for the panel's code)
          "not opened, it came from a document the frame no longer shows",
        );
      return;
    }
    switch (message.type) {
      case "ready":
        if (message.document && this.retiredDocuments.has(message.document)) return;
        if (this.documentId !== message.document) this.retireDocument();
        // The bridge posts this before any template code runs, so it marks
        // a document's birth: a fresh document (a card body rebuilt) starts
        // with no subscriptions, and whatever the old one held is void.
        this.dropSubscriptions();
        this.births += 1;
        this.ready = true;
        this.reuseReads = message.reuseReads === true;
        this.documentId = message.document;
        this.port.post({ fm: V, type: "theme", theme: this.theme });
        if (this.spec.state !== undefined) {
          this.port.post({ fm: V, type: "state", state: this.spec.state });
        }
        if (this.spec.form) {
          this.port.post({
            fm: V,
            type: "form",
            fill: this.spec.form.fill() ?? null,
            ...(this.spec.form.readOnly ? { readOnly: true as const } : {}),
            ...(this.spec.form.preview ? { preview: true as const } : {}),
          });
        }
        if (this.spec.width) this.port.post({ fm: V, type: "width", width: this.spec.width });
        if (this.spec.inset) this.port.post({ fm: V, type: "inset", ...this.spec.inset });
        if (this.spec.markup !== undefined)
          this.port.post({ fm: V, type: "markup", html: this.spec.markup });
        if (this.spec.taskKeys) {
          this.port.post({ fm: V, type: "tasks", keys: [...this.spec.taskKeys] });
        }
        if (this.spec.litKey) this.port.post({ fm: V, type: "lit", key: this.spec.litKey });
        if (this.spec.entryRefs) {
          this.port.post({ fm: V, type: "entries", entries: [...this.spec.entryRefs] });
        }
        // The keys the host hears from this document: a picture's, for a
        // mount that opens pictures, and an Escape that leaves it.
        if (this.spec.onImage || this.spec.onEscape || this.spec.onExpand || this.spec.onSound) {
          this.port.post({
            fm: V,
            type: "keys",
            pictures: this.spec.onImage !== undefined,
            escape: this.spec.onEscape !== undefined,
            ...(this.spec.onExpand ? { expand: true as const } : {}),
            ...(this.spec.onSound ? { sound: true as const } : {}),
          });
        }
        if (message.document)
          this.port.post({ fm: V, type: "initialize", document: message.document });
        if (this.activated) this.port.post({ fm: V, type: "activate" });
        this.armWatchdog();
        this.listenToStore();
        this.spec.onBorn?.();
        return;
      case "annotate":
        if (
          this.spec.onAnnotation &&
          this.spec.revision?.starts.includes(message.target.start) &&
          (message.target.span?.endPart === undefined ||
            (message.target.span.endPart >= message.target.start &&
              this.spec.revision.starts.includes(message.target.span.endPart)))
        )
          this.spec.onAnnotation(message.target, message.box, message.focus);
        return;
      case "point-exit":
        this.spec.onPointExit?.();
        return;
      case "selection-cleared":
        this.spec.onSelectionCleared?.();
        return;
      case "pointer-down":
        this.spec.onPointerDown?.();
        return;
      case "revealed": {
        const pending = this.revealing;
        if (
          !pending ||
          message.seq !== pending.seq ||
          message.offerId !== pending.offerId ||
          this.spec.revision?.offerId !== pending.offerId
        )
          return;
        pending.resolve(
          message.top !== undefined && message.height !== undefined
            ? {
                top: message.top,
                height: message.height,
                ...(message.pictures && message.index !== undefined
                  ? { shown: { index: message.index, pictures: message.pictures } }
                  : {}),
              }
            : undefined,
        );
        return;
      }
      case "find-text": {
        if (this.finding?.seq === message.seq) this.finding.read?.(message.text);
        return;
      }
      case "found": {
        if (this.finding?.seq === message.seq && this.finding.markId === message.mark)
          this.finding.mark?.(
            message.top !== undefined && message.height !== undefined
              ? { top: message.top, height: message.height }
              : undefined,
          );
        return;
      }
      case "questioned": {
        if (message.document !== this.documentId) return;
        const where: FrameQuestioned =
          message.end === true
            ? { end: true }
            : message.top !== undefined && message.height !== undefined
              ? { top: message.top, height: message.height }
              : {};
        if (message.seq === undefined) {
          this.spec.onQuestioned?.(where);
          return;
        }
        if (this.questioning?.seq === message.seq) this.questioning.resolve(where);
        return;
      }
      case "pong":
        if (message.seq > this.answeredSeq) this.answeredSeq = message.seq;
        for (const [seq, heard] of this.hearing) if (seq <= message.seq) heard();
        return;
      case "resize":
        if (message.document !== this.documentId) return;
        if (message.initialized && message.live) this.spec.onLiveChange?.();
        // A page in a process of its own can lay out before its frame's
        // width reaches it, every word on a line of its own, as a card's
        // fact strip does on Linux. That is no height the frame will have,
        // and taking it flashes a scrollbar that narrows the card and moves
        // every frame's width under its drawing (INF-4619). The page
        // reports again once it has its width.
        if (message.width !== 0) this.spec.onResize?.(message.height);
        if (
          message.initialized &&
          message.height > 0 &&
          message.width !== undefined &&
          message.width > 0
        ) {
          this.spec.onDrawn?.(message.height, message.width, message.held === true);
        }
        return;
      case "interaction":
        if (message.document === this.documentId) this.spec.onInteraction?.();
        return;
      // The window's own focus guards read it (`guardFrameActivation`).
      case "focused":
        return;
      // The window's own press count reads it (app/presses.ts).
      case "pressed":
        return;
      case "key":
        if (message.document === this.documentId) this.spec.onKey?.(message.press);
        return;
      case "expand":
        this.spec.onExpand?.(message.index, message.state);
        return;
      case "escape":
        if (message.document === this.documentId) this.spec.onEscape?.();
        return;
      case "link":
        this.spec.onLink?.(message.href);
        return;
      case "draft":
        this.spec.onDraft?.(message.text);
        return;
      case "task":
        if (message.document !== this.documentId) return;
        if (!this.spec.taskKeys?.includes(message.key)) return;
        if (message.gesture === "rest" && !message.box) return;
        this.spec.onTask?.(message.gesture, message.key, message.box);
        return;
      case "entry":
        if (message.document !== this.documentId) return;
        if (!this.spec.entryRefs?.some((ref) => ref.id === message.id)) return;
        this.spec.onEntry?.(message.id);
        return;
      case "image":
        if (message.index < message.pictures.length) {
          this.spec.onImage?.(message.index, message.pictures, undefined, message.asked === true);
        }
        return;
      case "demo": {
        const { src, poster, caption, durationMs, play } = message;
        this.spec.onDemo?.({
          src,
          poster,
          caption,
          durationMs,
          play,
          sound: message.sound === true,
        });
        return;
      }
      case "sound": {
        const { src, caption, durationMs } = message;
        this.spec.onSound?.({ src, caption, durationMs });
        return;
      }
      case "log": {
        const { src, name, bytes } = message;
        this.spec.onLog?.({ src, name, bytes });
        return;
      }
      case "answers": {
        if (!this.spec.form) return;
        const { answered, of, changed, picked, defaults, answers, seq } = message;
        if (answered > of || changed > of || picked > of || answers.length !== of) return;
        if (defaults !== undefined && defaults > of) return;
        const reading = {
          answered,
          of,
          changed,
          picked,
          ...(defaults ? { defaults } : {}),
          answers,
        };
        this.spec.form.onAnswers(reading);
        if (seq !== undefined) {
          this.collecting.get(seq)?.({ ...reading, ...questionsOf(message) });
          this.collecting.delete(seq);
        }
        return;
      }
      case "request": {
        const { id, fm: _fm, type: _type, ...rest } = message;
        const asker: Asker = { id, document: this.documentId, birth: this.births };
        const request = frameRequestSchema.safeParse(rest);
        if (!request.success) {
          // i18n-exempt: not shown (a console line, or an error for the panel's code)
          this.refuse(asker, "bad_request", "malformed request");
          return;
        }
        this.handle(asker, request.data);
        return;
      }
    }
  }

  annotate(
    mode: boolean,
    queued: FrameAnnotationTarget[],
    current?: FrameAnnotationTarget,
    focus = false,
    clear = false,
  ): void {
    if (!this.ready || !this.documentId || !this.spec.onAnnotation) return;
    this.port.post({
      fm: V,
      type: "annotation",
      document: this.documentId,
      mode,
      queued,
      ...(current ? { current } : {}),
      focus,
      ...(clear ? { clear } : {}),
    });
  }

  /**
   * Reveal a note's part. `picture` also asks which pictures the part's picture opens with: 0 for
   * the part itself, or which of its pictures counted from 1.
   */
  revealAnnotation(
    target: FrameAnnotationTarget,
    picture?: number,
  ): Promise<FrameRevealed | undefined> {
    const offer = this.spec.revision?.offerId;
    return offer
      ? this.reveal(offer, target.start, false, target.span, picture)
      : Promise.resolve(undefined);
  }

  /** Reveal a known target on this exact offer; a retired or silent document answers nothing. */
  reveal(
    offerId: string,
    start: number,
    keyboard: boolean,
    span?: { start: number; end: number; endPart?: number },
    picture?: number,
  ): Promise<FrameRevealed | undefined> {
    if (
      this.disposed ||
      !this.ready ||
      !this.documentId ||
      this.spec.revision?.offerId !== offerId ||
      !this.spec.revision.starts.includes(start)
    )
      return Promise.resolve(undefined);
    this.revealing?.resolve(undefined);
    const seq = ++this.revealSeq;
    return new Promise((resolve) => {
      const finish = (box: FrameRevealed | undefined) => {
        globalThis.clearTimeout(timer);
        if (this.revealing?.seq === seq) this.revealing = undefined;
        resolve(box);
      };
      const timer = globalThis.setTimeout(() => finish(undefined), FRAME_COLLECT_TIMEOUT_MS);
      this.revealing = { seq, offerId, resolve: finish };
      this.port.post({
        fm: V,
        type: "reveal",
        document: this.documentId!,
        seq,
        offerId,
        start,
        keyboard,
        ...(span ? { span } : {}),
        ...(picture !== undefined ? { picture } : {}),
      });
    });
  }

  /**
   * The words the document shows, in reading order, for finding in the
   * shown card (docs/keyboard.md, "Finding in the shown card"); undefined
   * when the document is not born or does not answer. Each read starts a new
   * finding: the marks that follow name the words of this read.
   */
  findRead(): Promise<{ seq: number; text: string } | undefined> {
    if (this.disposed || !this.ready || !this.documentId) return Promise.resolve(undefined);
    this.finding?.read?.(undefined);
    this.finding?.mark?.(undefined);
    const seq = ++this.findSeq;
    return new Promise((resolve) => {
      const timer = globalThis.setTimeout(() => finish(undefined), FRAME_COLLECT_TIMEOUT_MS);
      const finish = (text: string | undefined) => {
        globalThis.clearTimeout(timer);
        if (this.finding?.seq === seq) this.finding = { seq };
        resolve(text === undefined ? undefined : { seq, text });
      };
      this.finding = { seq, read: finish };
      this.port.post({ fm: V, type: "find-read", document: this.documentId!, seq });
    });
  }

  /**
   * Draws the matches of the read numbered `seq` - offsets into its words -
   * with `current` lit and its folded section open, and answers with the
   * current match's box in the document. No spans clears every match.
   */
  findMark(
    seq: number,
    spans: [number, number][],
    current: number,
  ): Promise<{ top: number; height: number } | undefined> {
    if (this.disposed || !this.ready || !this.documentId) return Promise.resolve(undefined);
    if (spans.length > 0 && this.finding?.seq !== seq) return Promise.resolve(undefined);
    this.finding?.mark?.(undefined);
    const mark = spans.length > 0 ? seq : ++this.findSeq;
    return new Promise((resolve) => {
      const timer = globalThis.setTimeout(() => finish(undefined), FRAME_COLLECT_TIMEOUT_MS);
      const finish = (box: { top: number; height: number } | undefined) => {
        globalThis.clearTimeout(timer);
        if (this.finding?.seq === mark && this.finding.mark === finish)
          this.finding = { seq: mark };
        resolve(box);
      };
      const markId = ++this.findMarks;
      this.finding = { seq: mark, mark: finish, markId };
      this.port.post({
        fm: V,
        type: "find-mark",
        document: this.documentId!,
        seq: mark,
        mark: markId,
        spans,
        current,
      });
    });
  }

  /**
   * A step through a card body's questions (docs/keyboard.md, "Moving
   * between a card's questions"): where it landed, `end` past the last one,
   * an empty answer when the body asks no question it can go to, and
   * undefined when the document is not born or does not answer.
   */
  question(
    ask: Omit<Extract<HostMessage, { type: "question" }>, "fm" | "type" | "seq">,
  ): Promise<FrameQuestioned | undefined> {
    if (this.disposed || !this.ready || !this.spec.form) return Promise.resolve(undefined);
    this.questioning?.resolve(undefined);
    const seq = ++this.questionSeq;
    return new Promise((resolve) => {
      const finish = (where: FrameQuestioned | undefined) => {
        globalThis.clearTimeout(timer);
        if (this.questioning?.seq === seq) this.questioning = undefined;
        resolve(where);
      };
      const timer = globalThis.setTimeout(() => finish(undefined), FRAME_COLLECT_TIMEOUT_MS);
      this.questioning = { seq, resolve: finish };
      this.port.post({ fm: V, type: "question", seq, ...ask });
    });
  }

  /**
   * A fresh reading of a card body's form, for the footer click that sends
   * it: undefined when the mount watches no form, the document is not born,
   * or it does not answer within FRAME_COLLECT_TIMEOUT_MS (a wedged frame) -
   * the caller then falls back on the last reading it heard.
   */
  collect(focusUnpicked = false): Promise<FrameAnswers | undefined> {
    if (this.disposed || !this.ready || !this.spec.form) return Promise.resolve(undefined);
    this.collectSeq += 1;
    const seq = this.collectSeq;
    return new Promise((resolve) => {
      const timer = globalThis.setTimeout(() => {
        this.collecting.delete(seq);
        resolve(undefined);
      }, FRAME_COLLECT_TIMEOUT_MS);
      this.collecting.set(seq, (answers) => {
        globalThis.clearTimeout(timer);
        resolve(answers);
      });
      this.port.post({ fm: V, type: "collect", seq, focusUnpicked });
    });
  }

  /**
   * Another window's change to the card's draft (docs/card-authoring.md,
   * "Unsent picks follow you"): the bridge applies the answers by name to the
   * body on screen. False for a mount that watches no form, a read-only
   * body, or a document not yet born, which takes the draft at its birth.
   */
  fill(answers: CardAnswer[]): boolean {
    if (this.disposed || !this.ready || !this.spec.form || this.spec.form.readOnly) return false;
    this.port.post({ fm: V, type: "fill", answers });
    return true;
  }

  /**
   * The host just gave the frame focus back (docs/keyboard.md, "Cards and
   * frames"): the document's element that last had focus takes it again,
   * with its caret. Nothing for a document not yet born.
   */
  returnFocus(): void {
    if (this.disposed || !this.ready) return;
    this.port.post({ fm: V, type: "focus" });
  }

  /** A movement command's key: the bridge presses it on the element focused inside. */
  move(key: MoveKey): void {
    if (this.disposed || !this.ready) return;
    this.port.post({ fm: V, type: "move", key });
  }

  /**
   * Resolves once the frame has answered a ping sent now (INF-1146). The
   * frame's messages reach the window in the order it sent them, however
   * late its process sends them, so by then the window has heard every
   * press that began in the frame before the ping reached it (`pressed`,
   * app/presses.ts). A document not yet born has begun none; one that is
   * gone, or silent for FRAME_COLLECT_TIMEOUT_MS (a wedged frame), resolves
   * it too.
   */
  heard(): Promise<void> {
    if (this.disposed || !this.ready) return Promise.resolve();
    this.pingSeq += 1;
    const seq = this.pingSeq;
    return new Promise((resolve) => {
      const timer = globalThis.setTimeout(() => answered(), FRAME_COLLECT_TIMEOUT_MS);
      const answered = () => {
        globalThis.clearTimeout(timer);
        this.hearing.delete(seq);
        resolve();
      };
      this.hearing.set(seq, answered);
      this.port.post({ fm: V, type: "ping", seq });
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.revealing?.resolve(undefined);
    this.questioning?.resolve(undefined);
    for (const resolve of this.collecting.values()) resolve(undefined);
    this.collecting.clear();
    for (const heard of this.hearing.values()) heard();
    this.disarmWatchdog();
    this.dropSubscriptions();
    this.stopStoreNotices?.();
    this.stopStoreNotices = null;
  }

  /**
   * Tells the frame which keys of ITS slice changed, from whichever side
   * wrote them. Started once, with the first document of a store-bound
   * mount; the slice is the one the host bound, read at each change.
   */
  private listenToStore(): void {
    if (this.stopStoreNotices || !this.spec.store || !this.deps.store) return;
    this.stopStoreNotices = this.deps.store.onChange((change) => {
      if (this.disposed || !this.ready) return;
      if (change.extensionId !== this.spec.store?.extensionId) return;
      if ((change.draft === true) !== (this.spec.store.draft === true)) return;
      this.port.post({ fm: V, type: "store", key: change.key });
    });
  }

  /**
   * The host just pointed the frame at a new document. An armed watchdog
   * starts counting at once: a document must be born (post `ready`) within
   * FRAME_WATCHDOG_MISSES intervals, because a script that wedges its frame
   * before the bridge's `ready` reaches the host would otherwise never arm
   * the ping clock at all.
   */
  expectDocument(): void {
    if (this.disposed) return;
    this.retireDocument();
    this.documentId = undefined;
    this.births += 1;
    this.ready = false;
    this.dropSubscriptions();
    this.armWatchdog();
  }

  private retireDocument(): void {
    this.revealing?.resolve(undefined);
    if (!this.documentId) return;
    this.retiredDocuments.add(this.documentId);
    // A bounded birth history rejects queued notices without retaining an
    // unbounded amount of agent-authored message data.
    if (this.retiredDocuments.size > 32) {
      const first = this.retiredDocuments.values().next().value;
      if (first !== undefined) this.retiredDocuments.delete(first);
    }
  }

  /**
   * A fresh document gets a fresh watchdog, ticking every interval.
   *
   * Every message between the window and a frame waits in the main process,
   * so the watchdog judges a frame only against the main process's own
   * answers (INF-935): a tick while the main process has not answered the
   * question the last tick asked judges nothing and sends nothing. A ping
   * goes out before its tick's question, so that question's answer says the
   * main process passed the ping on. A healthy frame answers at once, so its
   * answer stands in the main process ahead of the next tick's question,
   * and the answer to THAT question judges the ping: a ping is missed when
   * it is still unanswered then. Judged by the first answer alone, a main
   * process that stalls again a few milliseconds after each answer let the
   * question's answer through and held the frame's, so a healthy frame
   * missed once per stall (INF-3798). A throttled host clock only pings
   * less often - it never counts a miss the frame did not make.
   *
   * Before `ready` a tick counts the document as not yet born, once the
   * main process has answered a question asked after it was expected. Its
   * load waits on the main process at every step, so a tick at which the
   * main process has not answered starts that count again.
   *
   * A tick while the page is hidden counts nothing and sends nothing: a
   * collapsed panel, or the window while the screen is off, may not run,
   * and that is not a wedge. The streak starts again when the page shows.
   */
  private armWatchdog(): void {
    this.disarmWatchdog();
    if (!this.spec.onUnresponsive) return;
    const timers = this.deps.timers ?? browserTimers;
    this.restartStreak();
    this.kept = 0;
    this.steady = false;
    this.watchdog = timers.setInterval(() => this.tick(), FRAME_WATCHDOG_INTERVAL_MS);
  }

  /** Forgets every miss, unborn tick and unjudged ping: counting starts from now. */
  private restartStreak(): void {
    this.missed = 0;
    this.unborn = 0;
    this.watched = [];
    this.expectedAfter = this.mainAsked;
  }

  private tick(): void {
    if (this.deps.paused?.()) {
      this.restartStreak();
      return;
    }
    if (!this.mainAnsweredLast()) {
      this.unborn = 0;
      return;
    }
    if (!this.ready) {
      if (this.mainAnswered > this.expectedAfter) {
        this.unborn += 1;
        if (this.unborn >= FRAME_WATCHDOG_MISSES) {
          this.unresponsive();
          return;
        }
      }
      this.askMain();
      return;
    }
    for (const ping of this.watched) {
      if (ping.judgedBy > this.mainAnswered) continue;
      if (this.answeredSeq >= ping.seq) {
        this.missed = 0;
        this.keep();
        continue;
      }
      this.missed += 1;
      this.kept = 0;
      if (this.missed >= FRAME_WATCHDOG_MISSES) {
        this.unresponsive();
        return;
      }
    }
    this.watched = this.watched.filter((ping) => ping.judgedBy > this.mainAnswered);
    this.pingSeq += 1;
    this.port.post({ fm: V, type: "ping", seq: this.pingSeq });
    this.askMain();
    // Its tick's question says the main process passed it on; the next one,
    // asked once that answer is in, judges it.
    this.watched.push({ seq: this.pingSeq, judgedBy: this.mainAsked + 1 });
  }

  /** One more ping answered in a row; a run as long as the stopping streak makes the document steady. */
  private keep(): void {
    if (this.steady) return;
    this.kept += 1;
    if (this.kept < FRAME_WATCHDOG_MISSES) return;
    this.steady = true;
    this.spec.onSteady?.();
  }

  /**
   * Whether the main process answered the question the last tick asked.
   * Without `askMain` it is taken to answer each question by the next tick.
   */
  private mainAnsweredLast(): boolean {
    if (!this.deps.askMain) this.mainAnswered = this.mainAsked;
    return this.mainAnswered >= this.mainAsked;
  }

  /** Asks the main process the next question. One question is in flight at a time. */
  private askMain(): void {
    this.mainAsked += 1;
    const ask = this.deps.askMain;
    if (!ask) return;
    const seq = this.mainAsked;
    // A refusal is an answer too: the main process ran to give it.
    const heard = () => {
      if (seq > this.mainAnswered) this.mainAnswered = seq;
    };
    void ask().then(heard, heard);
  }

  private unresponsive(): void {
    this.disarmWatchdog();
    this.ready = false;
    for (const heard of this.hearing.values()) heard();
    this.dropSubscriptions();
    this.spec.onUnresponsive?.();
  }

  private disarmWatchdog(): void {
    if (this.watchdog === null) return;
    (this.deps.timers ?? browserTimers).clearInterval(this.watchdog);
    this.watchdog = null;
  }

  private handle(asker: Asker, request: FrameRequest): void {
    switch (request.verb) {
      case "subscribe":
        this.subscribe(asker, request);
        return;
      case "unsubscribe": {
        // One the host ended already: the frame's own stop is answered as done.
        if (this.revoked.delete(request.sub)) {
          this.respond(asker);
          return;
        }
        const stop = this.subscriptions.get(request.sub);
        if (!stop) {
          // i18n-exempt: not shown (a console line, or an error for the panel's code)
          this.refuse(asker, "subscription_unknown", `no subscription ${request.sub}`);
          return;
        }
        this.subscriptions.delete(request.sub);
        this.subscribedReads.delete(request.sub);
        stop();
        this.respond(asker);
        return;
      }
      case "action":
        void this.action(asker, request);
        return;
      case "fetch":
        void this.fetch(asker, request);
        return;
      case "store":
        void this.storeRequest(asker, request);
        return;
      case "data":
        void this.dataRequest(asker, request);
        return;
    }
  }

  /** A data file the body names, by the address it names it with; never another. */
  private async dataRequest(asker: Asker, request: Extract<FrameRequest, { verb: "data" }>) {
    const name = cardDataName(request.src);
    if (!name || !this.spec.data?.has(name) || !this.deps.data) {
      this.refuse(
        asker,
        "capability_not_granted",
        // i18n-exempt: not shown (a console line, or an error for the card's code)
        `this frame's body names no data file at "${request.src}"`,
      );
      return;
    }
    if (!this.admit(asker)) return;
    try {
      this.respond(asker, await this.deps.data(name));
    } catch (caught) {
      this.refuse(asker, "data_failed", caught instanceof Error ? caught.message : String(caught));
    } finally {
      this.inFlight -= 1;
    }
  }

  private async storeRequest(asker: Asker, request: Extract<FrameRequest, { verb: "store" }>) {
    const slice = this.spec.store;
    if (!slice || !this.deps.store) {
      // i18n-exempt: not shown (a console line, or an error for the panel's code)
      this.refuse(asker, "capability_not_granted", "this frame has no store");
      return;
    }
    // The slice is the host's to name: whatever the frame sent, the request
    // that leaves is for the mount's own extension id.
    const { verb: _verb, ...rest } = request;
    const parsed = personalStoreRequestSchema.safeParse({
      ...rest,
      extensionId: slice.extensionId,
      ...(slice.draft ? { draft: true } : {}),
    });
    if (!parsed.success) {
      this.refuse(
        asker,
        "bad_request",
        // i18n-exempt: not shown (a console line, or an error for the panel's code)
        parsed.error.issues[0]?.message ?? "malformed store request",
      );
      return;
    }
    if (!this.admit(asker)) return;
    try {
      this.respond(asker, await this.deps.store.request(parsed.data));
    } catch (caught) {
      this.refuse(asker, "store_failed", caught instanceof Error ? caught.message : String(caught));
    } finally {
      this.inFlight -= 1;
    }
  }

  private subscribe(asker: Asker, request: Extract<FrameRequest, { verb: "subscribe" }>): void {
    if (!this.spec.reads.includes(request.read)) {
      this.refuse(
        asker,
        "read_not_declared",
        // i18n-exempt: not shown (a console line, or an error for the panel's code)
        `plugin "${this.spec.pluginId}" does not declare the read "${request.read}"`,
      );
      return;
    }
    if (this.subscriptions.has(request.sub)) {
      // i18n-exempt: not shown (a console line, or an error for the panel's code)
      this.refuse(asker, "bad_request", `subscription ${request.sub} already exists`);
      return;
    }
    if (this.subscriptions.size >= FRAME_MAX_SUBSCRIPTIONS) {
      this.refuse(
        asker,
        "too_many_subscriptions",
        // i18n-exempt: not shown (a console line, or an error for the panel's code)
        `a frame may hold ${FRAME_MAX_SUBSCRIPTIONS} subscriptions`,
      );
      return;
    }
    const sub = request.sub;
    let previous: unknown;
    let stop: () => void;
    try {
      stop = this.deps.executor.subscribe(
        request.read,
        request.args,
        {
          onValue: (value) => {
            if (!this.subscriptions.has(sub)) return;
            const transfer = this.reuseReads ? transferReadValue(previous, value) : { value };
            previous = value;
            this.port.post({ fm: V, type: "data", sub, ...transfer });
            this.hostUpdated();
          },
          onError: (error) => {
            if (this.subscriptions.has(sub)) this.port.post({ fm: V, type: "data", sub, error });
          },
        },
        this.spec.grant,
      );
    } catch (caught) {
      if (caught instanceof ReadSubscriptionError) {
        this.refuse(asker, caught.code, caught.message);
      } else {
        this.refuse(
          asker,
          "read_failed",
          caught instanceof Error ? caught.message : String(caught),
        );
      }
      return;
    }
    this.subscriptions.set(sub, stop);
    this.subscribedReads.set(sub, request.read);
    this.respond(asker);
  }

  private async action(asker: Asker, request: Extract<FrameRequest, { verb: "action" }>) {
    if (!this.spec.actions.includes(request.action)) {
      // i18n-exempt: not shown (a console line, or an error for the panel's code)
      this.refuse(asker, "action_not_declared", `"${request.action}" is not a declared action`);
      return;
    }
    // A call into a panel's background work carries what its `invoke` was
    // handed, which may be as large as a value its store keeps.
    const most =
      request.action === PANEL_SERVER_ACTION
        ? PERSONAL_STORE_VALUE_MAX_BYTES
        : ACTION_VALUE_MAX_BYTES;
    if (request.value !== undefined && byteLength(request.value) > most) {
      // i18n-exempt: not shown (a console line, or an error for the panel's code)
      this.refuse(asker, "value_too_large", `an action value may be ${most} bytes`);
      return;
    }
    if (!this.admit(asker)) return;
    try {
      this.respond(asker, plainAnswer(await this.spec.onAction(request.action, request.value)));
    } catch (caught) {
      this.refuse(asker, "bad_request", caught instanceof Error ? caught.message : String(caught));
    } finally {
      this.inFlight -= 1;
    }
  }

  private async fetch(asker: Asker, request: Extract<FrameRequest, { verb: "fetch" }>) {
    if (!this.admit(asker)) return;
    try {
      const result = await this.deps.fetch({
        pluginId: this.spec.pluginId,
        alias: request.alias,
        request: request.request,
      });
      if (result.ok) {
        this.respond(asker, result);
      } else if (result.error.code === "capability_not_granted") {
        this.refuse(asker, "capability_not_granted", result.error.message);
      } else {
        this.refuse(asker, "fetch_failed", `${result.error.code}: ${result.error.message}`);
      }
    } catch (caught) {
      this.refuse(asker, "fetch_failed", caught instanceof Error ? caught.message : String(caught));
    } finally {
      this.inFlight -= 1;
    }
  }

  /** Counts one async request in, refusing past the cap. */
  private admit(asker: Asker): boolean {
    if (this.inFlight >= FRAME_MAX_IN_FLIGHT) {
      // i18n-exempt: not shown (a console line, or an error for the panel's code)
      this.refuse(asker, "too_many_in_flight", `a frame may await ${FRAME_MAX_IN_FLIGHT} requests`);
      return false;
    }
    this.inFlight += 1;
    return true;
  }

  /** Where an answer goes: nowhere once the document that asked was replaced. */
  private addressed(asker: Asker): { id: number; document?: string } | undefined {
    if (this.disposed || asker.birth !== this.births) return undefined;
    return asker.document === undefined
      ? { id: asker.id }
      : { id: asker.id, document: asker.document };
  }

  private respond(asker: Asker, result?: unknown): void {
    const to = this.addressed(asker);
    if (!to) return;
    this.port.post(
      result === undefined
        ? { fm: V, type: "response", ...to, ok: true }
        : { fm: V, type: "response", ...to, ok: true, result },
    );
  }

  private refuse(asker: Asker, code: FrameError["code"], message: string): void {
    const to = this.addressed(asker);
    if (!to) return;
    this.port.post({ fm: V, type: "response", ...to, ok: false, error: { code, message } });
  }

  private dropSubscriptions(): void {
    for (const stop of this.subscriptions.values()) stop();
    this.subscriptions.clear();
    this.subscribedReads.clear();
    this.revoked.clear();
  }
}

/** A grant's views as one comparable key. */
function viewsOf(grant: ReadGrant | undefined): string {
  return (grant?.sql ?? []).join(",");
}

/**
 * An action's answer as the frame may receive it: plain JSON data, or
 * nothing - a handler's other return values (a promise's own value, an
 * object of the window's) never cross into the frame.
 */
function plainAnswer(answer: unknown): unknown {
  if (answer === undefined) return undefined;
  try {
    const text = JSON.stringify(answer);
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}
