import {
  INSTALLED_PLUGIN_PREFIX,
  PERSONAL_PLUGIN_PREFIX,
  type PanelIntegrationsRequest,
  type PersonalStoreChange,
  type PersonalStoreRequest,
  type PersonalStoreResponse,
} from "../../../src/shared/personal/manifest";
import type { MediatedFetchCall, MediatedFetchResult } from "../../../src/shared/plugins/fetch";
import { FRAME_SANDBOX, panelFrameCsp } from "../../../src/shared/plugins/containment";
import {
  buildPanelDocument,
  type FrameTheme,
  PANEL_INTEGRATIONS_ACTION,
  PANEL_SERVER_ACTION,
  type PanelFrameConfig,
  panelMountHost,
  panelMountUrl,
  scriptSafeJson,
} from "../../../src/shared/plugins/frameDocument";
import { FRAME_LIB_BOOT, frameLibUrl } from "../../../src/shared/plugins/frameLib";
import {
  PANEL_CARD_ACTIONS,
  PANEL_CARD_VIEW_ACTIONS,
  PANEL_DRAFT_ACTION,
  PANEL_LINE_PEEK_ACTION,
  PANEL_OPEN_SETTINGS_ACTION,
  PANEL_POINT_ACTIONS,
  panelDraftSchema,
} from "../../../src/shared/plugins/panelActionIds";
import { PANEL_DRAFT_MAX } from "../../../src/shared/personal/contracts";
import { settingsShowSchema } from "../../../src/shared/showActions";
import { panelCardEmitSchema, panelCardIdSchema, panelCardKeptSchema } from "../../../src/shared/plugins/panelCards";
import { FrameController } from "../../../src/renderer/src/plugins/frames/frameController";
import { panelStylesheet } from "../../../src/renderer/src/plugins/frames/frameStylesheet";
import { FRAME_BRIDGE_VERSION } from "../../../src/shared/plugins/bridge";
import { phoneReads } from "./phoneReads";
import { phonePressRule } from "./pressRule";
import { phoneTextRule, textScale } from "./textSize";

/**
 * INF-3830 piece 2: the trusted parent page of one of the captain's panels on the phone (docs/ios.md, "Panels"). It
 * builds the panel's document with the desktop's own owners (`buildPanelDocument`, `panelFrameCsp`, the panel
 * stylesheet), frames it in a sandboxed frame at its own host, and answers it with the desktop's own frame controller
 * and read executor. Every read, press and store call crosses to native code, which asks the computer over the pinned
 * connection; the panel's own frame never reaches native code or the network.
 *
 * Piece 3: the same page draws one of the panel's cards on Home (`cards/<view>.mjs`, the desktop's `FramedCard`), and
 * either page puts up, closes and lists the panel's cards and points at a task, each answered by native code, which
 * holds the cards and opens the task. A card comes to the front, and a task opens, only from the captain's own tap in
 * the page, read as the card host reads one (cardHost.ts): the page has focus and the browser's own user activation.
 */
interface NativeHost { postMessage(value: unknown): Promise<unknown> }
declare global {
  interface Window {
    phonePanel: {
      mount(input: Input): Promise<void>;
      theme(value: FrameTheme): void;
      state(value: { collapsed: boolean; shown: boolean; asks?: Record<string, number> }): void;
      card(value: { data: unknown; kept: unknown; revision: number }): void;
      push(channel: string, payload: unknown): void;
      resync(): void;
      textScale(value: number): void;
      pressMoved(): void;
    };
  }
}

/** What native code hands the page: the panel as the computer lists it, and the pins of every file it may load. */
type Input = {
  mount: string;
  theme: FrameTheme;
  panel: {
    id: string; source: "yours" | "installed" | "app"; title: string; size: "content" | "fill";
    reads: string[]; sql: string[]; moves: boolean; server: boolean; decides: boolean;
  };
  /** The library's pins by path, each file checked against its pin by native code before it is served. */
  lib: Record<string, string>;
  /** The panel's own files by path, each pin the hash of the bytes native code holds and will serve. */
  files: Record<string, string>;
  collapsed: boolean;
  /** The device's Text Size as a factor of the Mac's sizes (docs/ios.md, "Text size"); 1 draws them as the Mac does. */
  textScale?: number;
  /** Its card views (`cards/<view>.tsx`): the views `cards.emit` may name. */
  cardViews: string[];
  /** Set when the page draws one of its cards on Home: the card, as `FramedCard` mounts it. */
  card?: { id: string; view: string; title: string; height: "content" | "fill"; data: unknown; kept: unknown; revision: number };
};

/**
 * The plugin id the frame controller passes on with a fetch: the captain's own panel's, an added plugin's, or, for one of
 * the app's own, which fetch nothing, the built-in plugin's (`BUILTIN_PLUGIN_ID`), which no panel added from elsewhere
 * may take.
 */
function pluginIdOf(panel: Input["panel"]): string {
  if (panel.source === "app") return APP_PLUGIN_ID;
  return `${panel.source === "installed" ? INSTALLED_PLUGIN_PREFIX : PERSONAL_PLUGIN_PREFIX}${panel.id}`;
}
const APP_PLUGIN_ID = "firstmate";

/** The page's one way to native code; the card page declares its own handler on the same `window.webkit`. */
const native = (message: unknown) =>
  (window as unknown as { webkit: { messageHandlers: { panelHost: NativeHost } } }).webkit.messageHandlers.panelHost.postMessage(message);
/** Asks the computer through native code, which passes only the channels the phone may ask for panels. */
const ask = (channel: string, args: unknown[]) => native({ type: "ask", channel, args });

/** The panel's reads, under the desktop's executor and catalog (phoneReads.ts). */
const reads = phoneReads(ask);
const listen = reads.listen;

let frame: HTMLIFrameElement | undefined;
let controller: FrameController | undefined;
let input: Input;
/** The factor the panel draws at now: the mount's, then each Text Size change since. */
let scale = 1;
/** Hands the frame the factor, which its own rule reads; one sent before its document loaded is sent again once it draws. */
const sendScale = () => frame?.contentWindow?.postMessage({ fm: FRAME_BRIDGE_VERSION, type: "text-scale", scale }, "*");
let state: { collapsed: boolean; shown: boolean; asks: Record<string, number> } = { collapsed: false, shown: true, asks: {} };
const NO_VIEW = { openTaskIds: [], shownTaskId: null, litTaskId: null, focusedProjectId: null };
/** The view state the page hears: a card's data, revision and kept place, or the panel's header presses and fold. */
function viewState(): unknown {
  if (input.card) {
    const { data, kept, revision } = input.card;
    return { card: { data, kept, revision }, view: NO_VIEW, keys: {} };
  }
  // A press of a header button that asks the panel, counted, as the desktop's view state counts them (`asks`, `askedBy`).
  const askedBy = Object.fromEntries(Object.keys(state.asks).map((button) => [button, "click"]));
  return { asks: state.asks, askedBy, focus: 0, view: NO_VIEW, collapsed: state.collapsed, keys: {} };
}

/** `rail.show`'s value, as the rail reads it: whether it shows, or that and why it does not. */
function shownOf(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "object" && value !== null && typeof (value as { shown?: unknown }).shown === "boolean") {
    return (value as { shown: boolean }).shown;
  }
  return undefined;
}

/** The captain's own tap holds this page, read as the card host reads one: the page has focus and the browser's own activation. */
const pressed = () => document.hasFocus() && navigator.userActivation.isActive;

/**
 * What a page of the panel may ask on the phone, from what it was granted, as `framePanelActions` declares it: the card
 * actions every panel has (`card.keep` on a card's own page), the pointing a panel that reads the board gets, the draft
 * and the Settings opening every panel has, its rail's two actions on its own page, its background work and its
 * integrations.
 */
function actionsOf(value: Input): string[] {
  const { panel, card } = value;
  return [
    ...(card ? PANEL_CARD_VIEW_ACTIONS : PANEL_CARD_ACTIONS),
    ...(panel.reads.includes("tasks.board") ? PANEL_POINT_ACTIONS : []),
    ...(panel.reads.includes("feed.recent") ? [PANEL_LINE_PEEK_ACTION] : []),
    PANEL_DRAFT_ACTION,
    PANEL_OPEN_SETTINGS_ACTION,
    ...(card ? [] : ["rail.summarize", "rail.show"]),
    ...(panel.server ? [PANEL_SERVER_ACTION] : []),
    // The app's own panels call no integrations, as on the desktop (`FramedPanelBody`).
    ...(panel.source === "app" ? [] : [PANEL_INTEGRATIONS_ACTION]),
  ];
}

/** Why `cards.emit` refused, in the words the desktop's host gives at the call (`emitPanelCard`). */
function emitRefusal(error: { issues: { path: PropertyKey[]; message: string }[] }): Error {
  const issue = error.issues[0];
  const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  return new Error(`cards.emit: ${where}${issue?.message ?? "not a card"}`);
}

/** The card actions, checked like any input from a panel and answered by native code, which holds the cards. */
async function onCardAction(id: string, value: unknown): Promise<unknown> {
  switch (id) {
    case "cards.emit": {
      const parsed = panelCardEmitSchema.safeParse(value);
      if (!parsed.success) throw emitRefusal(parsed.error);
      if (!input.cardViews.includes(parsed.data.view)) {
        throw new Error(`cards.emit: "${parsed.data.view}" is not one of this panel's card views; write cards/${parsed.data.view}.tsx`);
      }
      return native({ type: "cards", op: "emit", card: parsed.data, front: pressed() });
    }
    case "cards.close": {
      const parsed = panelCardIdSchema.safeParse((value as { id?: unknown } | null)?.id);
      if (!parsed.success) throw new Error("cards.close: name the card by its id");
      await native({ type: "cards", op: "close", id: parsed.data });
      return undefined;
    }
    case "cards.open":
      return native({ type: "cards", op: "open" });
    case "card.keep": {
      if (!input.card) throw new Error("card.keep: only a card's own page keeps a place");
      const parsed = panelCardKeptSchema.safeParse(value);
      if (!parsed.success) throw new Error(`card.keep: ${parsed.error.issues[0]?.message ?? "not JSON"}`);
      await native({ type: "cards", op: "keep", id: input.card.id, kept: parsed.data });
      return undefined;
    }
    default:
      throw new Error(`"${id}" is not one of a panel's card actions`);
  }
}

/**
 * The pointing a panel that reads the board gets (`framePointAction`), and the draft and Settings opening every panel
 * gets. Opening a task, its record, its waiting card or Settings, and starting a message, move the captain's view or
 * words, so each counts only from the captain's own tap and answers false otherwise; each is checked as the desktop
 * checks it, and a value it refuses throws as there. A rest has no pointer to follow on a phone, and the phone keeps no
 * aim or project focus, so those answer nothing.
 */
async function onPointAction(id: string, value: unknown): Promise<unknown> {
  const arg = value as { taskId?: unknown; cardId?: unknown; text?: unknown; section?: unknown; item?: unknown } | null;
  switch (id) {
    case PANEL_DRAFT_ACTION: {
      const parsed = panelDraftSchema.safeParse(arg?.text);
      if (!parsed.success) throw new Error(`point.draft: words on one line, at most ${PANEL_DRAFT_MAX} characters`);
      if (!pressed()) return false;
      return native({ type: "point", op: "draft", text: parsed.data });
    }
    case PANEL_OPEN_SETTINGS_ACTION: {
      const parsed = settingsShowSchema.safeParse({ section: arg?.section, ...(arg?.item === undefined ? {} : { item: arg.item }) });
      if (!parsed.success) {
        throw new Error("point.openSettings: a Settings section's id, and an item of at most 128 characters on one line");
      }
      if (!pressed()) return false;
      return native({ type: "point", op: "settings", section: parsed.data.section, ...(parsed.data.item ? { item: parsed.data.item } : {}) });
    }
    case "point.openTask":
    case "point.openRecord":
      if (typeof arg?.taskId !== "string" || !pressed()) return false;
      return native({ type: "point", op: id === "point.openTask" ? "task" : "record", taskId: arg.taskId });
    case "point.showCard":
      if (typeof arg?.cardId !== "string" || !pressed()) return false;
      return native({ type: "point", op: "card", cardId: arg.cardId });
    case "point.peekTask":
    case PANEL_LINE_PEEK_ACTION:
      return undefined;
    default:
      return false;
  }
}

async function onAction(id: string, value: unknown): Promise<unknown> {
  const { panel } = input;
  if (id === PANEL_SERVER_ACTION && panel.server) {
    const call = value as { action?: unknown; input?: unknown } | null;
    if (typeof call?.action !== "string" || call.action.length === 0 || call.action.length > 64) throw new Error("server.invoke: an action name");
    const result = await ask("inf:plugins:invoke", [panel.id, call.action, call.input ?? null]) as { ok: boolean; result?: unknown; error?: string };
    if (!result.ok) throw new Error(result.error ?? "The panel's background work refused.");
    return result.result;
  }
  if (id === PANEL_INTEGRATIONS_ACTION && panel.source !== "app") return ask("inf:plugins:integrations", [panel.id, value as PanelIntegrationsRequest]);
  if (id.startsWith("cards.") || id === "card.keep") return onCardAction(id, value);
  if (id.startsWith("point.")) return onPointAction(id, value);
  if (id === "rail.show") {
    if (!panel.decides) throw new Error('rail.show: say "presence": { "code": true } in manifest.json to decide');
    const shown = shownOf(value);
    if (shown === undefined) throw new Error("rail.show: true or false");
    void native({ type: "shown", shown }).catch(() => {});
    return undefined;
  }
  // The header's summary is drawn by the computer's rail; the phone's header is the title alone.
  if (id === "rail.summarize") return undefined;
  throw new Error(`"${id}" is not something a panel can do on this phone yet.`);
}

window.addEventListener("message", (event: MessageEvent) => {
  if (!frame || event.source !== frame.contentWindow) return;
  controller?.receive(event.data);
});

window.phonePanel = {
  async mount(value) {
    input = value;
    scale = textScale(value.textScale);
    const { panel, mount, card } = value;
    const boot = value.lib[FRAME_LIB_BOOT];
    if (!boot) throw new Error("The panel library has no boot module.");
    // A card's page draws its card view from the same graph as the panel (`moduleOf` with a view).
    const entry = card ? `cards/${card.view}.mjs` : "panel.mjs";
    if (!value.files[entry]) throw new Error(`This panel's code has no entry: ${entry}`);
    // The import map pins every module the frame may load, as the desktop's mount does (`FrameMountRegistry.mountPanel`).
    const integrity: Record<string, string> = {};
    for (const [path, pin] of Object.entries(value.lib)) integrity[frameLibUrl(path)] = pin;
    for (const [path, pin] of Object.entries(value.files)) integrity[`${panelMountUrl(mount)}${path}`] = pin;
    const importMap = scriptSafeJson({ imports: {}, integrity });
    const [hash] = await native({ type: "hash", scripts: [importMap] }) as string[];
    const csp = panelFrameCsp([hash!], panelMountHost(mount));
    const config: PanelFrameConfig = {
      id: panel.id, reads: panel.reads as PanelFrameConfig["reads"], sql: panel.sql as PanelFrameConfig["sql"],
      ...(card ? { card: { id: card.id } } : {}),
      ...(panel.moves ? { moves: true } : {}), ...(panel.server ? { server: true } : {}),
    };
    const fill = card ? card.height === "fill" : panel.size === "fill";
    const body = buildPanelDocument({
      csp, theme: value.theme, title: card ? card.title : panel.title, style: `${panelStylesheet(!fill)}${phoneTextRule(scale)}${phonePressRule()}`, importMap,
      config: { ...config, module: `${panelMountUrl(mount)}${entry}` }, bootIntegrity: boot,
    });
    await native({ type: "document", body, csp });
    state = { collapsed: value.collapsed, shown: true, asks: {} };
    // INF-3830: WebKit gives a frame whose color-scheme differs from its page a black backing.
    document.documentElement.style.colorScheme = value.theme;
    const store = {
      request: (request: PersonalStoreRequest) => ask("inf:plugins:db", [request]) as Promise<PersonalStoreResponse>,
      onChange: (listener: (change: PersonalStoreChange) => void) => listen("inf:plugins:db", (payload) => listener(payload as PersonalStoreChange)),
    };
    frame = document.createElement("iframe");
    frame.title = card ? card.title : panel.title;
    frame.setAttribute("sandbox", FRAME_SANDBOX);
    // A content panel starts at the card frame's height (cardHost.ts) until its page reports its own.
    frame.style.cssText = `display:block;width:100%;height:${fill ? "100%" : "48px"};border:0;background:transparent`;
    controller = new FrameController(
      {
        pluginId: pluginIdOf(panel),
        reads: [...panel.reads, ...(panel.sql.length ? ["sql"] : [])],
        grant: { sql: panel.sql },
        actions: actionsOf(value),
        onAction: (id, actionValue) => onAction(id, actionValue),
        onResize: (height) => {
          if (fill || !frame) return;
          frame.style.height = `${Math.max(0, Math.ceil(height))}px`;
          void native({ type: "height", height: Math.max(0, Math.ceil(height)) }).catch(() => {});
        },
        onDrawn: (height) => { sendScale(); void native({ type: "drawn", height: Math.max(0, Math.ceil(height)) }).catch(() => {}); },
        onUnresponsive: () => { void native({ type: "unresponsive" }).catch(() => {}); },
        onSteady: () => { void native({ type: "steady" }).catch(() => {}); },
        store: { extensionId: panel.id },
        state: viewState() as never,
      },
      value.theme,
      {
        executor: reads.executor,
        fetch: (call: MediatedFetchCall) => ask("inf:plugins:fetch", [call]) as Promise<MediatedFetchResult>,
        store,
        // A folded panel, or one on a tab that is not showing, keeps running out of sight and is never stopped for missed pings.
        paused: () => (!card && state.collapsed) || !state.shown || document.hidden,
      },
      { post: (message) => frame?.contentWindow?.postMessage(message, "*") },
    );
    controller.expectDocument();
    frame.src = panelMountUrl(mount);
    document.body.replaceChildren(frame);
  },
  theme(value) {
    document.documentElement.style.colorScheme = value;
    controller?.setTheme(value);
  },
  state(value) {
    state = { collapsed: value.collapsed, shown: value.shown, asks: value.asks ?? state.asks };
    controller?.setState(viewState() as never);
  },
  card(value) {
    if (!input.card) return;
    input = { ...input, card: { ...input.card, ...value } };
    controller?.setState(viewState() as never);
  },
  push(channel, payload) { reads.push(channel, payload); },
  resync() { reads.resync(); },
  // The device's Text Size changed while the panel shows: it redraws at it in place.
  textScale(value) { scale = textScale(value); sendScale(); },
  // The finger on the panel moved on the screen as the column's scroller takes it: the press does nothing.
  pressMoved() { frame?.contentWindow?.postMessage({ fm: FRAME_BRIDGE_VERSION, type: "press-moved" }, "*"); },
};

void native({ type: "loaded" }).catch(() => {});
