import { type Card, cardAnswersSchema, cardQuestionsSchema, isPreviewBody, splitSettleFacts, takesTaskFacts } from "../../../src/shared/cards";
import { cardDataName, cardDataNames, demoSources, isReadableLogSource, logSources, viewablePictures } from "../../../src/shared/cardPictures";
import { ACTION_VALUE_MAX_BYTES, frameMessageSchema, frameRequestSchema, type FrameAnswers } from "../../../src/shared/plugins/bridge";
import { FRAME_SANDBOX, frameCsp } from "../../../src/shared/plugins/containment";
import { buildFrameDocument, type FrameTheme } from "../../../src/shared/plugins/frameDocument";
import { isSafeCardHref } from "../../../src/shared/linkify";
import { taskKeysIn } from "../../../src/shared/taskKeys";
import { cardBodyHtml, cardBodyMarkup, cardStylesheet } from "../../../src/renderer/src/cards/prototypeSrcdoc";
import { type CardNote, cardNoteSchema, cardNotesSchema } from "../../../src/shared/cardNotes";
import { noteTarget, pickedNote } from "../../../src/shared/cardNoteTargets";
import { cardNavigationParts, type NavigationPart } from "../../../src/shared/cardParts";

/** INF-64 piece 4: trusted WK parent, never the agent-authored frame. Native chrome owns effects. */
interface NativeHost { postMessage(value: unknown): Promise<unknown> }
declare global {
  interface Window {
    webkit: { messageHandlers: { cardHost: NativeHost } };
    phoneCard: {
      mount(input: Input): Promise<void>; collect(): Promise<FrameAnswers>; theme(value: FrameTheme): void; ping(seq: number): void;
      annotate(state: Annotation): void; annotateSelection(): void; reveal(note: unknown): Promise<Revealed>;
    };
  }
}
/**
 * INF-1524: `marks` are the starts of the parts new since the captain last saw the card, `keys` the recorded tasks, the
 * card's own included, and `card` what decides whether the body's last fact strip stands apart, as on the Mac.
 */
type Input = {
  body: string; theme: FrameTheme; fill: unknown; readOnly: boolean; actions: string[]; width: "regular" | "wide" | "full";
  marks?: number[]; keys?: string[]; card?: Pick<Card, "actions" | "reviewTaskId" | "risk">;
};
/**
 * INF-3296's phone piece: what the native chrome holds about the card's notes. The frame hears only targets and
 * offsets, never a comment (docs/card-threads.md, "Pointing at a card").
 */
/** `clear` drops the words selected in the body, as a text note just queued from them leaves no selection behind. */
type Annotation = { mode: boolean; queued: unknown[]; current?: unknown; clear?: boolean };
/** Where a revealed note sits in the body, or why it cannot show. */
type Revealed = { top: number; height: number } | "missing" | "unavailable";
/** The phone's own stamp, which the bridge's reveal asks for, as the Mac's revision navigation writes its offer. */
const OFFER = "phone";
const native = (message: unknown) => window.webkit.messageHandlers.cardHost.postMessage(message);
let frame: HTMLIFrameElement | undefined;
let documentID: string | undefined;
let input: Input;
let linked: string[] = [];
/** The body's parts as the frame draws them, the card's own body and the map from its offsets to the drawn ones. */
let notes: { parts: NavigationPart[]; source: string; toRendered: (start: number) => number; queued: CardNote[] } | undefined;
/**
 * The card's own page can post a pick itself, so a pick counts only when the phone asked for it: a whole part while
 * Point at is on, selected words once right after the phone's own Annotate.
 */
let pointing = false;
let selectionAsked = false;
const reveals = new Map<number, (revealed: Revealed) => void>();
/** The captain's own press in the body, as a picture's viewer asks: only then does a link, draft or key leave it. */
const pressed = () => document.hasFocus() && navigator.userActivation.isActive;
let next = 0;
const collections = new Map<number, { resolve: (answers: FrameAnswers) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const send = (message: object) => frame?.contentWindow?.postMessage({ fm: 2, ...message }, "*");
const fail = (message: string) => new Error(message);

window.addEventListener("message", (event: MessageEvent) => {
  if (!frame || event.source !== frame.contentWindow) return;
  const parsed = frameMessageSchema.safeParse(event.data);
  if (!parsed.success) return;
  const message = parsed.data;
  if (message.type === "ready") {
    if (documentID || !message.document) return;
    documentID = message.document;
    // INF-1338: the body can answer a ping from here on, so the native watchdog starts counting its own answers.
    void native({ type: "ready" }).catch(() => {});
    send({ type: "form", fill: cardAnswersSchema.parse(input.fill ?? []), readOnly: input.readOnly });
    send({ type: "keys", pictures: true, escape: false });
    send({ type: "width", width: input.width });
    if (linked.length > 0) send({ type: "tasks", keys: linked });
    // INF-1562: a picture comes over the connection and waits while the computer is out of reach, so the body draws
    // and takes its height without it; WebKit's fonts.ready alone would wait for every picture.
    send({ type: "initialize", document: documentID, latePictures: true });
    return;
  }
  if (!documentID || ("document" in message && message.document && message.document !== documentID)) return;
  switch (message.type) {
    case "answers": {
      const { questions: raw, ...reading } = message;
      const questions = cardQuestionsSchema.safeParse(raw);
      const answers = { ...reading, ...(questions.success ? { questions: questions.data } : { questionsGap: "invalid" as const }) };
      void native({ type: "answers", reading: answers }).catch(() => {});
      if (message.seq !== undefined) {
        const collection = collections.get(message.seq);
        if (collection) { clearTimeout(collection.timer); collections.delete(message.seq); collection.resolve(answers); }
      }
      break;
    }
    case "resize":
      // The phone owns one scrolling WebView. The iframe grows within it, not a second scroller.
      frame.style.height = `${Math.max(48, Math.min(1_000_000, message.height))}px`;
      if (message.initialized) void native({ type: "drawn", height: message.height }).catch(() => {});
      break;
    case "pong": void native({ type: "pong", seq: message.seq }).catch(() => {}); break;
    case "request": {
      const request = frameRequestSchema.safeParse(message);
      const reply = (ok: boolean, value: unknown) => send({ type: "response", document: documentID, id: message.id,
        ...(ok ? { ok, result: value } : { ok, error: { code: "refused", message: String(value) } }) });
      // A data file the body names (docs/card-authoring.md, "Data by reference"): its text, read from the Mac's copy.
      if (request.success && request.data.verb === "data") {
        const name = cardDataName(request.data.src);
        if (!name || !cardDataNames(input.body).includes(name)) { reply(false, "This card names no such data file."); return; }
        void native({ type: "data", name }).then((text) => reply(true, text), (error) => reply(false, error));
        break;
      }
      if (!request.success || request.data.verb !== "action" || input.readOnly || !input.actions.includes(request.data.action)) {
        reply(false, "This card cannot do that."); return;
      }
      const value = request.data.value;
      if (value !== undefined && new TextEncoder().encode(JSON.stringify(value)).length > ACTION_VALUE_MAX_BYTES) { reply(false, "The answer is too large."); return; }
      // No chrome source, arbitrary request channel, close, reply, or navigation can cross this bridge.
      void native({ type: "action", id: request.data.action, value: value ?? null })
        .then((result) => reply(true, result), (error) => reply(false, error));
      break;
    }
    case "image": {
      if (!document.hasFocus() || !navigator.userActivation.isActive) return;
      // INF-3107: a tapped diagram comes as a picture of its own; a playable preview's drawings open
      // nothing from a tap, only when its own script asks (`inf.picture`).
      const set = viewablePictures(message.index, message.pictures, message.asked === true || !isPreviewBody(input.body));
      if (set) void native({ type: "image", ...set }).catch(() => {});
      break;
    }
    case "demo":
      if (document.hasFocus() && navigator.userActivation.isActive && demoSources(input.body).has(message.src) && viewablePictures(0, [message.poster]))
        void native({ type: "demo", src: message.src, poster: message.poster, caption: message.caption, play: message.play }).catch(() => {});
      break;
    // INF-3887: a merge card's proof log opens in the phone's log reader, only a log the card names.
    case "log":
      if (pressed() && isReadableLogSource(message.src) && logSources(input.body).has(message.src))
        void native({ type: "log", src: message.src, name: message.name, bytes: message.bytes }).catch(() => {});
      break;
    // INF-1524: a link opens in the phone's own browser, a draft goes to the message box and a key opens its record.
    case "link":
      if (pressed() && isSafeCardHref(message.href)) void native({ type: "link", href: message.href }).catch(() => {});
      break;
    case "draft":
      if (pressed()) void native({ type: "draft", text: message.text }).catch(() => {});
      break;
    case "task":
      if (message.gesture === "open" && linked.includes(message.key)) void native({ type: "task", key: message.key }).catch(() => {});
      break;
    case "entry":
      void native({ type: "mac-only" }).catch(() => {}); break;
    case "annotate": {
      // A selection the captain has not asked to annotate yet only lit itself: the phone's Annotate in its menu asks.
      const asked = message.target.span ? message.focus === true && selectionAsked : pointing;
      if (message.target.span && message.focus) selectionAsked = false;
      if (!notes || !asked) { if (notes) native({ type: "annotation-idle" }).catch(() => {}); break; }
      const note = pickedNote({ picked: message.target, parts: notes.parts, source: notes.source, queued: notes.queued, originalToRendered: notes.toRendered });
      if (note) void native({ type: "annotate", note, box: message.box }).catch(() => {});
      break;
    }
    case "point-exit": void native({ type: "point-exit" }).catch(() => {}); break;
    case "revealed": {
      const done = reveals.get(message.seq);
      if (!done) break;
      reveals.delete(message.seq);
      done(message.top === undefined || message.height === undefined ? "missing" : { top: message.top, height: message.height });
      break;
    }
  }
});

window.phoneCard = {
  async mount(value) {
    input = value;
    // The Mac's split: a settle card's fact strip stands beside its choices, and the body shows the rest.
    const split = value.card && takesTaskFacts(value.card) ? splitSettleFacts(value.body) : undefined;
    const marks = (value.marks ?? []).map((mark) => (split && mark > split.at ? mark - split.facts.length : mark));
    linked = value.keys?.length ? taskKeysIn(value.body).filter((key) => value.keys!.includes(key)) : [];
    void native({ type: "mounted", facts: split?.facts ?? null, preview: isPreviewBody(value.body) }).catch(() => {});
    // INF-3296: the body carries the stamp the bridge's reveal asks for, as the Mac's revision navigation writes it,
    // after every part, so no part's offset moves. A plain-words body is drawn as the Mac draws it, its paragraphs parts.
    const shown = split?.body ?? value.body;
    const drawn = `${cardBodyHtml(shown)}<i hidden data-inf-revision-offer="${OFFER}"></i>`;
    const toRendered = (start: number) => (split && start > split.at ? start - split.facts.length : start);
    notes = { parts: cardNavigationParts(drawn), source: cardBodyHtml(value.body), toRendered, queued: [] };
    pointing = false;
    selectionAsked = false;
    // DOMParser is inert. Hash the script text the browser actually parses, never an event attribute.
    const body = cardBodyMarkup(drawn, cardBodyHtml(shown) === shown ? marks : []).html;
    const parsed = new DOMParser().parseFromString(body, "text/html");
    const scripts = Array.from(parsed.querySelectorAll("script:not([src])"), (script) => script.textContent ?? "");
    const hashes = await native({ type: "hash", scripts }) as string[];
    const document = buildFrameDocument({ csp: `${frameCsp(hashes)}; base-uri 'none'; form-action 'none'`,
      theme: value.theme, style: cardStylesheet(), html: body });
    frame = window.document.createElement("iframe");
    frame.title = "Card body";
    frame.setAttribute("sandbox", FRAME_SANDBOX);
    frame.style.cssText = "display:block;width:100%;height:48px;border:0";
    // INF-1263 / INF-1651: native code keeps the web view out of reach and out of accessibility until it holds the
    // drawn body's height. Hiding the frame here would stick on iOS 27.0, which never exposes the body again.
    frame.srcdoc = document;
    window.document.body.replaceChildren(frame);
  },
  collect() {
    if (!documentID) return Promise.reject(fail("This card is still drawing. Try again once it is ready."));
    const seq = ++next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { collections.delete(seq); reject(fail("This card did not answer. Your choice was not sent.")); }, 3000);
      collections.set(seq, { resolve, reject, timer });
      send({ type: "collect", seq, focusUnpicked: true });
    });
  },
  theme(value) { send({ type: "theme", theme: value }); },
  ping(seq) { send({ type: "ping", seq }); },
  annotate(state) {
    if (!notes || !documentID) return;
    const queued = cardNotesSchema.safeParse(state.queued);
    const current = state.current === undefined ? undefined : cardNoteSchema.safeParse(state.current);
    notes.queued = queued.success ? queued.data : [];
    pointing = state.mode === true;
    const target = (note: CardNote) => noteTarget(notes!.parts, note, notes!.toRendered);
    const lit = current?.success ? target(current.data) : undefined;
    send({ type: "annotation", document: documentID, mode: state.mode === true,
      queued: notes.queued.flatMap((note) => { const t = target(note); return t ? [t] : []; }), ...(lit ? { current: lit } : {}),
      ...(state.clear === true ? { focus: true } : {}) });
  },
  annotateSelection() {
    if (!documentID) return;
    selectionAsked = true;
    send({ type: "annotate-selection", document: documentID });
  },
  reveal(value) {
    const note = cardNoteSchema.safeParse(value);
    if (!notes || !documentID || !note.success) return Promise.resolve("unavailable");
    const target = noteTarget(notes.parts, note.data, notes.toRendered);
    if (!target) return Promise.resolve("missing");
    const seq = ++next;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { reveals.delete(seq); resolve("unavailable"); }, 3000);
      reveals.set(seq, (revealed) => { clearTimeout(timer); resolve(revealed); });
      send({ type: "reveal", document: documentID, seq, offerId: OFFER, start: target.start, ...(target.span ? { span: target.span } : {}) });
    });
  },
};
