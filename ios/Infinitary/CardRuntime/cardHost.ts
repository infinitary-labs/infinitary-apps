import { cardAnswersSchema, cardQuestionsSchema } from "../../../src/shared/cards";
import { demoSources, viewablePictures } from "../../../src/shared/cardPictures";
import { ACTION_VALUE_MAX_BYTES, frameMessageSchema, frameRequestSchema, type FrameAnswers } from "../../../src/shared/plugins/bridge";
import { FRAME_SANDBOX, frameCsp } from "../../../src/shared/plugins/containment";
import { buildFrameDocument, type FrameTheme } from "../../../src/shared/plugins/frameDocument";
import { cardBodyHtml, cardStylesheet } from "../../../src/renderer/src/cards/prototypeSrcdoc";

/** INF-64 piece 4: trusted WK parent, never the agent-authored frame. Native chrome owns effects. */
interface NativeHost { postMessage(value: unknown): Promise<unknown> }
declare global {
  interface Window {
    webkit: { messageHandlers: { cardHost: NativeHost } };
    phoneCard: { mount(input: Input): Promise<void>; collect(): Promise<FrameAnswers>; theme(value: FrameTheme): void; ping(seq: number): void; reveal(): void };
  }
}
type Input = { body: string; theme: FrameTheme; fill: unknown; readOnly: boolean; actions: string[]; width: "regular" | "wide" | "full" };
const native = (message: unknown) => window.webkit.messageHandlers.cardHost.postMessage(message);
let frame: HTMLIFrameElement | undefined;
let documentID: string | undefined;
let input: Input;
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
    send({ type: "initialize", document: documentID });
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
      const set = viewablePictures(message.index, message.pictures);
      if (set) void native({ type: "image", ...set }).catch(() => {});
      break;
    }
    case "demo":
      if (document.hasFocus() && navigator.userActivation.isActive && demoSources(input.body).has(message.src) && viewablePictures(0, [message.poster]))
        void native({ type: "demo", src: message.src, poster: message.poster, caption: message.caption, play: message.play }).catch(() => {});
      break;
    case "link": case "draft": case "task": case "entry":
      void native({ type: "mac-only" }).catch(() => {}); break;
  }
});

window.phoneCard = {
  async mount(value) {
    input = value;
    // DOMParser is inert. Hash the script text the browser actually parses, never an event attribute.
    const body = cardBodyHtml(value.body);
    const parsed = new DOMParser().parseFromString(body, "text/html");
    const scripts = Array.from(parsed.querySelectorAll("script:not([src])"), (script) => script.textContent ?? "");
    const hashes = await native({ type: "hash", scripts }) as string[];
    const document = buildFrameDocument({ csp: `${frameCsp(hashes)}; base-uri 'none'; form-action 'none'`,
      theme: value.theme, style: cardStylesheet(), html: body });
    frame = window.document.createElement("iframe");
    frame.title = "Card body";
    frame.setAttribute("sandbox", FRAME_SANDBOX);
    frame.style.cssText = "display:block;width:100%;height:48px;border:0";
    // INF-1263: until native code has given the web view the drawn body's height, the view clips the body, so a tap
    // on its text would land outside the card. The body stays out of reach and out of accessibility until reveal().
    frame.setAttribute("aria-hidden", "true");
    frame.inert = true;
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
  reveal() { frame?.removeAttribute("aria-hidden"); if (frame) frame.inert = false; },
};
