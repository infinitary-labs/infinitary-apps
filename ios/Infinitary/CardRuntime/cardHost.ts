import { type Card, cardAnswersSchema, cardQuestionsSchema, isPlayableBody, splitSettleFacts, takesTaskFacts } from "../../../src/shared/cards";
import { cardDataName, cardDataNames, demoSources, isReadableLogSource, logSources, playableSoundKind, soundSources, viewablePictures } from "../../../src/shared/cardPictures";
import { ACTION_VALUE_MAX_BYTES, frameMessageSchema, frameRequestSchema, type FrameAnswers } from "../../../src/shared/plugins/bridge";
import { FRAME_SANDBOX, frameCsp } from "../../../src/shared/plugins/containment";
import { buildFrameDocument, type FrameTheme } from "../../../src/shared/plugins/frameDocument";
import { isSafeCardHref } from "../../../src/shared/linkify";
import { taskKeysIn } from "../../../src/shared/taskKeys";
import { cardBodyHtml, cardBodyMarkup, cardStylesheet, expandedStamp } from "../../../src/renderer/src/cards/prototypeSrcdoc";
import { type CardNote, cardNoteSchema, cardNotesSchema } from "../../../src/shared/cardNotes";
import { noteTarget, pickedNote } from "../../../src/shared/cardNoteTargets";
import { cardNavigationParts, type NavigationPart } from "../../../src/shared/cardParts";
import { setCurrentLanguage } from "../../../src/shared/i18n/current";
import { wordSaidBody } from "../../../src/shared/i18n/said";
import { appBodyOf } from "../../../src/shared/welcome";
import { frameReads } from "../../../src/shared/reads";
import { type FrameReadDeclaration, type FrameReadRefusal, FrameSubscriptions } from "../../../src/renderer/src/plugins/frames/frameSubscriptions";
import { phoneReads } from "./phoneReads";
import { phonePressRule } from "./pressRule";
import { phoneTextRule, textScale } from "./textSize";

/** INF-64 piece 4: trusted WK parent, never the agent-authored frame. Native chrome owns effects. */
interface NativeHost { postMessage(value: unknown): Promise<unknown> }
declare global {
  interface Window {
    webkit: { messageHandlers: { cardHost: NativeHost } };
    phoneCard: {
      mount(input: Input): Promise<void>; collect(): Promise<FrameAnswers>; theme(value: FrameTheme): void; ping(seq: number): void;
      annotate(state: Annotation): void; annotateSelection(): void; reveal(note: unknown): Promise<Revealed>;
      question(ask: QuestionAsk): Promise<Questioned>; questionKey(key: string, shift: boolean): void;
      expanded(index: number, state: string): void; textScale(value: number): void; pressMoved(): void;
      fill(answers: unknown): boolean;
      reads(value: CardReads): void; push(channel: string, payload: unknown): void; resync(): void;
    };
  }
}
/**
 * INF-1524: `marks` are the starts of the parts new since the captain last saw the card, `keys` the recorded tasks, the
 * card's own included, and `card` what decides whether the body's last fact strip stands apart, as on the Mac.
 */
type Input = {
  /** The phone's language, which a body the app wrote and a body's saved facts are worded in, as on the Mac. */
  language?: string;
  body: string; theme: FrameTheme; fill: unknown; readOnly: boolean; actions: string[]; width: "regular" | "wide" | "full";
  marks?: number[]; keys?: string[]; card?: Pick<Card, "actions" | "reviewTaskId" | "risk">;
  /**
   * INF-3881: this page is the full-screen cover of one of the body's parts (the map), drawn live. The same body is
   * mounted read-only with the part's index and where it stood stamped on it, and the frame fills the cover.
   */
  expanded?: { index: number; state: string };
  /** The device's Text Size as a factor of the Mac's sizes (docs/ios.md, "Text size"); 1 draws them as the Mac does. */
  textScale?: number;
} & CardReads;
/**
 * INF-5531 piece 2: the live reads and views the open card's crewmate declared, which its body's own script may
 * subscribe to through `inf.subscribe`, as on the Mac (docs/ui-plugins.md, "A card's reads"). Native code passes them
 * only while the card is open, and none to a past card, a fact strip or a cover.
 */
type CardReads = { reads?: string[]; sql?: string[] };
/**
 * INF-3296's phone piece: what the native chrome holds about the card's notes. The frame hears only targets and
 * offsets, never a comment (docs/card-threads.md, "Pointing at a card").
 */
/** `clear` drops the words selected in the body, as a text note just queued from them leaves no selection behind. */
type Annotation = { mode: boolean; queued: unknown[]; current?: unknown; clear?: boolean };
/** Where a revealed note sits in the body, or why it cannot show. */
type Revealed = { top: number; height: number } | "missing" | "unavailable";
/**
 * A step through the body's questions from the footer's stepper or a key (docs/keyboard.md, "Moving between a card's
 * questions"): `unpicked` goes to the next question with no answer, and `keyboard` moves focus to the question.
 */
type QuestionAsk = { step: 1 | -1; unpicked: boolean; keyboard: boolean };
/** Where a step went: the box of the question now marked, `end` past the last one, or `none` when the body asks none. */
type Questioned = { top: number; height: number } | "end" | "none";
/** The phone's own stamp, which the bridge's reveal asks for, as the Mac's revision navigation writes its offer. */
const OFFER = "phone";
const native = (message: unknown) => window.webkit.messageHandlers.cardHost.postMessage(message);
let frame: HTMLIFrameElement | undefined;
let documentID: string | undefined;
let input: Input;
let linked: string[] = [];
/** The factor the body draws at now: the mount's, then each Text Size change since. */
let scale = 1;
/** The body's parts as the frame draws them, the card's own body and the map from its offsets to the drawn ones. */
let notes: { parts: NavigationPart[]; source: string; toRendered: (start: number) => number; queued: CardNote[] } | undefined;
/**
 * The card's own page can post a pick itself, so a pick counts only when the phone asked for it: a whole part while
 * Point at is on, selected words once right after the phone's own Annotate.
 */
let pointing = false;
let selectionAsked = false;
const reveals = new Map<number, (revealed: Revealed) => void>();
const questionings = new Map<number, (questioned: Questioned) => void>();
const questioned = (message: { end?: boolean; top?: number; height?: number }): Questioned =>
  message.end === true ? "end" : message.top === undefined || message.height === undefined ? "none" : { top: message.top, height: message.height };
/** The captain's own press in the body, as a picture's viewer asks: only then does a link, draft or key leave it. */
const pressed = () => document.hasFocus() && navigator.userActivation.isActive;
let next = 0;
const collections = new Map<number, { resolve: (answers: FrameAnswers) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const send = (message: object) => frame?.contentWindow?.postMessage({ fm: 2, ...message }, "*");
const fail = (message: string) => new Error(message);
/**
 * The card's reads, through the same read catalog and executor a panel's page on the phone uses (phoneReads.ts): each
 * ask goes to native code, which passes only a read's channel, and the computer's pushes come back through it.
 */
const reads = phoneReads((channel, args) => native({ type: "ask", channel, args }));
/** Whether the body's document reuses its last value (`ready`'s `reuseReads`), as the desktop's controller reads it. */
let reuseReads = false;
const subscriptions = new FrameSubscriptions(reads.executor, (message) => frame?.contentWindow?.postMessage(message, "*"), () => reuseReads);
/** What the body may read now: the mount's declaration, then each the card's changes hand it. */
let declaration: FrameReadDeclaration = declared({});
function declared(value: CardReads): FrameReadDeclaration {
  return { pluginId: "host", ...frameReads(value.reads ?? [], value.sql ?? []) };
}

window.addEventListener("message", (event: MessageEvent) => {
  if (!frame || event.source !== frame.contentWindow) return;
  const parsed = frameMessageSchema.safeParse(event.data);
  if (!parsed.success) return;
  const message = parsed.data;
  if (message.type === "ready") {
    if (documentID || !message.document) return;
    documentID = message.document;
    reuseReads = message.reuseReads === true;
    // INF-1338: the body can answer a ping from here on, so the native watchdog starts counting its own answers.
    void native({ type: "ready" }).catch(() => {});
    // INF-4425: a playable preview's questions are settings, so none is tagged Default.
    send({ type: "form", fill: cardAnswersSchema.parse(input.fill ?? []), readOnly: input.readOnly, ...(isPlayableBody(input.body) ? { preview: true } : {}) });
    // INF-3881: a part such as the map opens live in a cover of its own (`inf.expand`); inside the cover the same call
    // only tells the phone where the part now stands.
    // A card that may still be answered plays its sound clips in the strip under its body, so the bridge draws their
    // Listen buttons there; a past card and a part's cover draw the caption alone (docs/card-authoring.md "Sound clips").
    send({ type: "keys", pictures: true, escape: false, expand: true, ...(input.readOnly || input.expanded ? {} : { sound: true }) });
    send({ type: "width", width: input.width });
    // A Text Size change while the body loaded reaches it before it draws.
    send({ type: "text-scale", scale });
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
      // The phone owns one scrolling WebView. The iframe grows within it, not a second scroller. A cover's frame fills
      // the cover instead, so its drawn height only says it drew.
      if (input.expanded) { if (message.initialized) void native({ type: "drawn", height: message.height }).catch(() => {}); break; }
      frame.style.height = `${Math.max(48, Math.min(1_000_000, message.height))}px`;
      if (message.initialized) void native({ type: "drawn", height: message.height }).catch(() => {});
      break;
    case "pong": void native({ type: "pong", seq: message.seq }).catch(() => {}); break;
    case "request": {
      const request = frameRequestSchema.safeParse(message);
      const reply = (ok: boolean, value: unknown) => send({ type: "response", document: documentID, id: message.id,
        ...(ok ? { ok, result: value } : { ok, error: { code: "refused", message: String(value) } }) });
      // A live read the open card declared (INF-5531 piece 2), answered as the Mac's frame controller answers it.
      const answerRead = (refusal: FrameReadRefusal | undefined) => send({ type: "response", document: documentID, id: message.id,
        ...(refusal ? { ok: false, error: refusal } : { ok: true }) });
      if (request.success && request.data.verb === "subscribe") { answerRead(subscriptions.subscribe(declaration, request.data)); break; }
      if (request.success && request.data.verb === "unsubscribe") { answerRead(subscriptions.unsubscribe(request.data.sub)); break; }
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
      const set = viewablePictures(message.index, message.pictures, message.asked === true || !isPlayableBody(input.body));
      if (set) void native({ type: "image", ...set }).catch(() => {});
      break;
    }
    case "expand":
      // INF-3881: in a card, a press on the part opens its cover; in the cover, the part says where it now stands, which
      // goes back to the card on Done. Neither carries more than the part's own place.
      if (!input.expanded && !pressed()) return;
      void native({ type: "expand", index: message.index, state: message.state }).catch(() => {});
      break;
    case "demo":
      if (document.hasFocus() && navigator.userActivation.isActive && demoSources(input.body).has(message.src) && viewablePictures(0, [message.poster]))
        void native({ type: "demo", src: message.src, poster: message.poster, caption: message.caption, play: message.play }).catch(() => {});
      break;
    // A sound clip plays in the native strip under the body: only a clip this card's body names, on the captain's own press.
    case "sound":
      if (pressed() && !input.readOnly && !input.expanded && playableSoundKind(message.src) && soundSources(input.body).has(message.src))
        void native({ type: "sound", src: message.src, caption: message.caption, durationMs: message.durationMs }).catch(() => {});
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
    // A step's answer, or the body's own Enter or Shift+Enter on a question, which the card's scroller follows.
    case "questioned": {
      if (message.seq === undefined) { void native({ type: "questioned", where: questioned(message) }).catch(() => {}); break; }
      const done = questionings.get(message.seq);
      if (!done) break;
      questionings.delete(message.seq);
      done(questioned(message));
      break;
    }
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
  async mount(given) {
    // The Mac's `useWordedBody` (PrototypeBody.tsx): a body the app wrote itself, in the phone's language, or each
    // saved fact worded in it, the change marks moved with the words (docs/i18n.md, "Saved facts").
    setCurrentLanguage(given.language ?? "en");
    const app = appBodyOf(given.body);
    const worded = app === undefined ? wordSaidBody(given.body) : { body: app, at: () => 0 };
    const value = worded.body === given.body ? given : { ...given, body: worded.body, ...(given.marks ? { marks: given.marks.map(worded.at) } : {}) };
    input = value;
    scale = textScale(value.textScale);
    subscriptions.drop();
    declaration = declared(value);
    // The Mac's split: a settle card's fact strip stands beside its choices, and the body shows the rest.
    const split = value.card && takesTaskFacts(value.card) ? splitSettleFacts(value.body) : undefined;
    const marks = (value.marks ?? []).map((mark) => (split && mark > split.at ? mark - split.facts.length : mark));
    linked = value.keys?.length ? taskKeysIn(value.body).filter((key) => value.keys!.includes(key)) : [];
    void native({ type: "mounted", facts: split?.facts ?? null, preview: isPlayableBody(value.body) }).catch(() => {});
    // INF-3296: the body carries the stamp the bridge's reveal asks for, as the Mac's revision navigation writes it,
    // after every part, so no part's offset moves. A plain-words body is drawn as the Mac draws it, its paragraphs parts.
    const shown = split?.body ?? value.body;
    // INF-3881: a cover's copy opens with its part's stamp before the body, so the part reads it as it starts.
    const cover = value.expanded ? expandedStamp(value.expanded.index, value.expanded.state) : "";
    const drawn = `${cover}${cardBodyHtml(shown)}<i hidden data-inf-revision-offer="${OFFER}"></i>`;
    const toRendered = (start: number) => (split && start > split.at ? start - split.facts.length : start);
    notes = { parts: cardNavigationParts(drawn), source: cardBodyHtml(value.body), toRendered, queued: [] };
    pointing = false;
    selectionAsked = false;
    // DOMParser is inert. Hash the script text the browser actually parses, never an event attribute.
    const body = cardBodyMarkup(drawn, cardBodyHtml(shown) === shown && !cover ? marks : []).html;
    const parsed = new DOMParser().parseFromString(body, "text/html");
    const scripts = Array.from(parsed.querySelectorAll("script:not([src])"), (script) => script.textContent ?? "");
    const hashes = await native({ type: "hash", scripts }) as string[];
    const document = buildFrameDocument({ csp: `${frameCsp(hashes)}; base-uri 'none'; form-action 'none'`,
      theme: value.theme, style: `${cardStylesheet()}${phoneTextRule(scale)}${phonePressRule()}`, html: body });
    frame = window.document.createElement("iframe");
    frame.title = "Card body";
    frame.setAttribute("sandbox", FRAME_SANDBOX);
    frame.style.cssText = value.expanded ? "display:block;width:100%;height:100%;border:0" : "display:block;width:100%;height:48px;border:0";
    if (value.expanded) window.document.documentElement.style.height = window.document.body.style.height = "100%";
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
  // The device's Text Size changed while the card shows: the body redraws at it in place, its answers and place kept.
  textScale(value) { scale = textScale(value); send({ type: "text-scale", scale }); },
  ping(seq) { send({ type: "ping", seq }); },
  // The finger on the body moved on the screen as the card's own scroller or swipe takes it: the press does nothing.
  pressMoved() { send({ type: "press-moved" }); },
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
  question(ask) {
    if (!documentID || !frame) return Promise.resolve("none");
    // The frame's own script cannot take focus: a key's step gives the frame focus first, and its bridge moves it on.
    if (ask.keyboard) frame.focus({ preventScroll: true });
    const seq = ++next;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { questionings.delete(seq); resolve("none"); }, 3000);
      questionings.set(seq, (where) => { clearTimeout(timer); resolve(where); });
      // Steps go round past either end, as the Mac's stepper does: the phone's choices hold no keyboard focus to rest on.
      send({ type: "question", seq, step: ask.step === -1 ? -1 : 1, unpicked: ask.unpicked === true,
        wrap: true, restart: false, keyboard: ask.keyboard === true });
    });
  },
  // A number key or Enter the web view heard but did not deliver to the body: its bridge presses it on the focused question.
  questionKey(key, shift) {
    if (!documentID || !frame || !/^([1-9]|Enter)$/.test(key)) return;
    send({ type: "question-key", key, shift: shift === true });
  },
  // INF-5445 piece 2: another screen changed the card's draft. The bridge applies the answers by name to the body on
  // screen, leaving the question being typed in as it is; a body not yet born takes them at its birth.
  fill(value) {
    const answers = cardAnswersSchema.safeParse(value);
    if (!answers.success || input.readOnly || input.expanded) return false;
    if (!documentID) { input = { ...input, fill: answers.data }; return false; }
    send({ type: "fill", answers: answers.data });
    return true;
  },
  // INF-5531 piece 2: the card's declaration changed under the body, as when its author ended it: a read it no longer
  // grants ends at once and the body's script hears why, keeping what it drew.
  reads(value) {
    const before = declaration;
    declaration = declared(value);
    subscriptions.redeclared(before, declaration);
  },
  // A push from the computer, or a reload of what the phone held, which the card's live reads read again on.
  push(channel, payload) { reads.push(channel, payload); },
  resync() { reads.resync(); },
  expanded(index, state) {
    if (documentID && !input.expanded && typeof state === "string") send({ type: "expanded", document: documentID, index, state });
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
