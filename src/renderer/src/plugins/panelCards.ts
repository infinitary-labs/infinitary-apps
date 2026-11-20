import type {
  PanelAskVia,
  PanelCard,
  PanelCards,
  PanelOpenCard,
  StoreValue,
} from "@shared/personal/contracts";
import {
  panelCardEmitSchema,
  panelCardIdSchema,
  panelCardKeptSchema,
} from "@shared/plugins/panelCards";
import { type PanelCardEntry, panelCardEntryId, shownEntry } from "../app/stack";
import { useShellStore } from "../app/store";
import { windowGesture } from "./frames/frameActivation";
import { frameHoldsFocus } from "./frames/frameFocus";
import { pluginHost } from "./host";

/**
 * A panel's cards on the main card stack, the host's side (FI3-1014 piece
 * 1; docs/ui-plugins.md "A panel's cards"). One way for a card to appear,
 * whoever made the panel: `cards.emit`, which a panel's code calls in
 * either realm, and which the app calls itself for a header button or a
 * command that names a card. The card is a shell-held stack entry
 * (`{ panelCard }` in ../app/stack.ts) that its panel's card view draws.
 *
 * A card the captain asked for - his click on the app's own chrome, his
 * key, or his own click or key inside the panel or the card that called -
 * comes to the front. One put up otherwise waits behind the entry he is
 * reading, marked new (the captain's answer on FI3-1014: "Yes, behind the
 * card you are reading, marked new").
 *
 * The asks are the other way in: a header button that puts up no card is
 * pressed into the panel (`PanelProps.asks`), once its body is there to
 * hear it.
 */

export { PANEL_CARD_ACTIONS, PANEL_CARD_VIEW_ACTIONS } from "@shared/plugins/panelActionIds";

/** Why a call was refused, in the words a panel's author reads at the call. */
function refusal(error: { issues: { path: PropertyKey[]; message: string }[] }): Error {
  const issue = error.issues[0];
  const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  return new Error(`cards.emit: ${where}${issue?.message ?? "not a card"}`);
}

/**
 * Puts up one of `panel`'s cards, or revises its open one, and answers its
 * id. Checked like any input from a panel: the shape, its view among the
 * panel's card views, and the panel's bound of open cards.
 */
export function emitPanelCard(panel: string, card: unknown, front: boolean): string {
  const contribution = pluginHost.sidePanels.get(panel);
  if (!contribution) throw new Error(`cards.emit: "${panel}" is not a panel the app has now`);
  const parsed = panelCardEmitSchema.safeParse(card);
  if (!parsed.success) throw refusal(parsed.error);
  const views = contribution.cardViews ?? [];
  if (!views.includes(parsed.data.view)) {
    throw new Error(
      `cards.emit: "${parsed.data.view}" is not one of this panel's card views; write cards/${parsed.data.view}.tsx`,
    );
  }
  return useShellStore.getState().emitPanelCard(panel, parsed.data, front);
}

/** Takes one of `panel`'s cards off the stack; an id that is not open does nothing. */
export function closePanelCard(panel: string, id: unknown): void {
  const parsed = panelCardIdSchema.safeParse(id);
  if (!parsed.success) throw new Error("cards.close: name the card by its id");
  useShellStore.getState().closePanelCard(panel, parsed.data);
}

/**
 * Keeps the place of one of `panel`'s open cards on its stack entry, until
 * Hide; the next page the card is born into is handed it as `card.kept`.
 */
export function keepPanelCard(panel: string, id: string, value: unknown): void {
  const parsed = panelCardKeptSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`card.keep: ${parsed.error.issues[0]?.message ?? "not JSON"}`);
  }
  useShellStore.getState().keepPanelCard(panel, id, parsed.data);
}

/** `panel`'s open cards, newest first. */
export function openPanelCards(panel: string): PanelOpenCard[] {
  const s = useShellStore.getState();
  const shownId = shownEntry(s)?.id;
  return s.records.flatMap((held) =>
    "panelCard" in held && held.panelCard.panel === panel
      ? [
          {
            id: held.panelCard.id,
            view: held.panelCard.view,
            title: held.panelCard.title,
            width: held.panelCard.width,
            height: held.panelCard.height,
            shown: shownId === panelCardEntryId(panel, held.panelCard.id),
          },
        ]
      : [],
  );
}

/**
 * A card a header button or a command names, put up by the app itself: the
 * captain's click or key, so it comes to the front. Its id is its name, so
 * a second press brings the same card forward; `data` stands in for the
 * card's own. Returns null when the panel or the card is not there.
 */
export function emitNamedCard(panel: string, name: string, data?: StoreValue): string | null {
  const declared = pluginHost.sidePanels.get(panel)?.cards?.[name];
  if (!declared) return null;
  try {
    return emitPanelCard(
      panel,
      {
        id: name,
        view: declared.view,
        title: declared.title,
        ...(declared.width ? { width: declared.width } : {}),
        ...(declared.height ? { height: declared.height } : {}),
        ...(data !== undefined
          ? { data }
          : declared.data !== undefined
            ? { data: declared.data }
            : {}),
      },
      true,
    );
  } catch (error) {
    console.warn(`a header button or command of "${panel}" put up no card:`, error);
    return null;
  }
}

/**
 * `PanelProps.cards` for a panel drawn in the app's own window, the
 * captain's own: a card it puts up comes to the front while the window
 * holds his click or key (`windowGesture`), and otherwise waits behind,
 * marked new.
 */
export function windowPanelCards(panel: string): PanelCards {
  return {
    emit: async (card) => emitPanelCard(panel, card, windowGesture()),
    close: async (id) => closePanelCard(panel, id),
    open: async () => openPanelCards(panel),
  };
}

/**
 * The host's answers to a frame's card actions (`PANEL_CARD_ACTIONS`): a
 * card a frame puts up comes to the front only while that frame holds the
 * window's focus, which only the captain's own click or key gives it
 * (`whenFrameHoldsFocus`); otherwise it waits behind, marked new.
 */
export function framePanelCardAction(
  panel: string,
  frame: () => HTMLIFrameElement | null,
  /** Set for a card's own page: the card whose place `card.keep` keeps. */
  card?: string,
): (id: string, value: unknown) => Promise<unknown> {
  return async (id, value) => {
    switch (id) {
      case "card.keep":
        if (card === undefined) throw new Error("card.keep: only a card's own page keeps a place");
        keepPanelCard(panel, card, value);
        return undefined;
      case "cards.emit":
        return emitPanelCard(panel, value, await frameHoldsFocus(frame));
      case "cards.close":
        closePanelCard(panel, (value as { id?: unknown } | null)?.id);
        return undefined;
      case "cards.open":
        return openPanelCards(panel);
      default:
        throw new Error(`"${id}" is not one of a panel's card actions`);
    }
  };
}

/**
 * The card a card view in the window draws, as `PanelProps.card` hands it:
 * its id, data and revision, the place it kept as this page was born
 * (`kept`), and `keep`, which stores a new one on its entry.
 */
export function cardProp(
  entry: Pick<PanelCardEntry, "panel" | "id" | "data" | "revision">,
  kept: StoreValue,
): PanelCard {
  return {
    id: entry.id,
    data: entry.data,
    revision: entry.revision,
    kept,
    keep: async (value) => keepPanelCard(entry.panel, entry.id, value),
  };
}

// --- the asks ------------------------------------------------------------------

type AskListener = (button: string, via: PanelAskVia) => void;

const askListeners = new Map<string, Set<AskListener>>();
/** The latest ask a panel's body was not there to hear yet, by panel. */
const pendingAsks = new Map<string, { button: string; via: PanelAskVia }>();

/**
 * Hears the asks pushed into `panel` (`PanelProps.asks`): a press of one of
 * its header buttons that puts up no card, by its click or by the command
 * that presses it. An ask made before any body of the panel listened is
 * heard by the first one that does - the body a press brought out of its
 * collapse.
 */
export function onPanelAsk(panel: string, listener: AskListener): () => void {
  let listeners = askListeners.get(panel);
  if (!listeners) {
    listeners = new Set();
    askListeners.set(panel, listeners);
  }
  listeners.add(listener);
  const pending = pendingAsks.get(panel);
  if (pending !== undefined) {
    pendingAsks.delete(panel);
    queueMicrotask(() => listener(pending.button, pending.via));
  }
  return () => {
    listeners?.delete(listener);
  };
}

/** Presses `button` into `panel`: heard now by its body, or by the next body of it that listens. */
export function pushPanelAsk(panel: string, button: string, via: PanelAskVia): void {
  const listeners = askListeners.get(panel);
  if (!listeners || listeners.size === 0) {
    pendingAsks.set(panel, { button, via });
    return;
  }
  for (const listener of [...listeners]) listener(button, via);
}

const focusListeners = new Map<string, Set<() => void>>();

/**
 * Hears F6's ask that `panel` put focus where a person starts in it
 * (`PanelProps.asks.onFocus`). Only a body that is there hears it: F6 lands
 * on a panel that shows.
 */
export function onPanelFocus(panel: string, listener: () => void): () => void {
  let listeners = focusListeners.get(panel);
  if (!listeners) {
    listeners = new Set();
    focusListeners.set(panel, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
  };
}

/** Asks `panel`'s body to put focus where a person starts in it. */
export function pushPanelFocus(panel: string): void {
  for (const listener of [...(focusListeners.get(panel) ?? [])]) listener();
}
