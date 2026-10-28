import type {
  PanelAsks,
  PanelAskVia,
  PanelCards,
  PanelMoveResult,
  PanelOpenCard,
  PanelPoint,
  PanelProps,
  PanelRail,
  PanelReads,
  PanelStore,
  PanelTasks,
  PanelView,
  SqlAnswer,
  StoreEntry,
  StoreValue,
} from "@shared/personal/contracts";
import {
  pointNeedsBoardMessage,
  undeclaredReadMessage,
  undeclaredViewsMessage,
} from "@shared/personal/manifest";
import type { FrameBridgeApi } from "@shared/plugins/bridge";
import type { PanelFrameConfig } from "@shared/plugins/frameDocument";

/**
 * `PanelProps` in the frame realm (one plugin vehicle, Phase A item 4): the
 * same contract a panel gets in the app's own window, built over the bridge
 * instead of the app's IPC, so a panel written once runs in either realm.
 *
 * - `reads.subscribe(name, cb)` is `bridge.subscribe(name, {}, cb)`, and
 *   `reads.subscribe("sql", query, cb)` is `bridge.subscribe("sql", query, cb)`:
 *   the host executes both and checks each against the mount's grant. An
 *   undeclared name throws here too, with the app window's wording, so the
 *   mistake shows at the call rather than as a quiet refusal.
 * - `store` is the bridge's `store` verb, whose slice the HOST binds to the
 *   mount - the panel names a key, never whose slice.
 * - `invoke` rejects: nothing a panel drawn here brings runs as server code
 *   in the app (A1a, no installed `server.ts` in v1).
 * - `cards` puts up, closes and lists the panel's cards on the stack
 *   (docs/ui-plugins.md, "A panel's cards") through the card actions every
 *   panel's mount declares; the host answers `cards.emit` with the card's id.
 * - `asks` hears the presses of its header buttons, and how each came, and
 *   F6's asks for focus, which the host pushes as view state; a count a
 *   document was born with is an earlier ask, never a new one.
 * - `point` and `tasks` are actions the host declared from what the panel
 *   asked for; the host checks each again, and answers whether it happened.
 *   `view` and whether the panel is collapsed ride view state (`frameView`,
 *   `frameRail`), so the runtime hands them in on every render.
 */
export function framePanelProps(
  config: PanelFrameConfig,
  bridge: FrameBridgeApi,
  warn: (...args: unknown[]) => void = (...args) => console.warn(...args),
): Omit<PanelProps, "theme" | "card" | "view" | "rail"> {
  return {
    id: config.id,
    store: frameStore(bridge),
    invoke: async () => {
      throw new Error(`"${config.id}" has no server.ts`);
    },
    reads: frameReads(config, bridge, warn),
    cards: frameCards(bridge),
    asks: frameAsks(bridge),
    point: framePoint(config, bridge, warn),
    ...(config.moves ? { tasks: frameTasks(bridge) } : {}),
  };
}

/** Pointing over the bridge; a panel that does not read the board throws at the call, as in the window. */
function framePoint(
  config: PanelFrameConfig,
  bridge: FrameBridgeApi,
  warn: (...args: unknown[]) => void,
): PanelPoint {
  const reads = config.reads.includes("tasks.board");
  const need = (call: string) => {
    if (!reads) throw new Error(pointNeedsBoardMessage(call));
  };
  const answer = (id: string, value: unknown) =>
    bridge.action(id, value).then((happened) => happened === true);
  return {
    openTask: async (taskId) => {
      need("openTask");
      return answer("point.openTask", { taskId });
    },
    openRecord: async (taskId) => {
      need("openRecord");
      return answer("point.openRecord", { taskId });
    },
    peekLine: (peek) => {
      if (!config.reads.includes("feed.recent"))
        throw new Error('point.peekLine: name "feed.recent" in manifest.json "reads".');
      bridge
        .action("point.peekLine", peek)
        .catch((error: unknown) => warn("point.peekLine:", error));
    },
    peekTask: (peek) => {
      need("peekTask");
      bridge
        .action("point.peekTask", peek)
        .catch((error: unknown) => warn("point.peekTask:", error));
    },
    showCard: async (cardId) => {
      need("showCard");
      return answer("point.showCard", { cardId });
    },
    aim: async (taskId) => {
      need("aim");
      if (config.card === undefined) throw new Error("point.aim: only a card view aims the turn");
      return answer("point.aim", { taskId });
    },
    // Any panel may start the captain's next message: it names nothing of the app's.
    draft: async (text) => answer("point.draft", { text }),
    // And open a Settings section, handing it an item to show.
    openSettings: async (section, item) =>
      answer("point.openSettings", { section, ...(item === undefined ? {} : { item }) }),
    focusProject: async (projectId) => {
      need("focusProject");
      return answer("point.focusProject", { projectId });
    },
  };
}

/** Moves over the bridge: the host runs each through the task record's own path, or says why not. */
function frameTasks(bridge: FrameBridgeApi): PanelTasks {
  return {
    run: (taskId, move, review) =>
      bridge
        .action("tasks.run", { taskId, move, ...(review === undefined ? {} : { review }) })
        .then((result) => result as PanelMoveResult),
  };
}

/** What the captain has open, as the host last pushed it (`view`); empty before it does. */
export function frameView(state: unknown): PanelView {
  const view = (
    state as {
      view?: {
        openTaskIds?: unknown;
        shownTaskId?: unknown;
        litTaskId?: unknown;
        focusedProjectId?: unknown;
      };
    } | null
  )?.view;
  const openTaskIds = Array.isArray(view?.openTaskIds)
    ? view.openTaskIds.filter((id): id is string => typeof id === "string")
    : [];
  const shownTaskId = typeof view?.shownTaskId === "string" ? view.shownTaskId : null;
  const litTaskId = typeof view?.litTaskId === "string" ? view.litTaskId : null;
  const focusedProjectId =
    typeof view?.focusedProjectId === "string" ? view.focusedProjectId : null;
  return { openTaskIds, shownTaskId, litTaskId, focusedProjectId };
}

/**
 * The panel on its rail: whether the host says it is collapsed, and its
 * two calls, which go to the host as actions; a refusal is logged, as a
 * call that cannot reach the host has nothing else to tell.
 */
export function frameRail(
  state: unknown,
  bridge: FrameBridgeApi,
  warn: (...args: unknown[]) => void = (...args) => console.warn(...args),
): PanelRail {
  const collapsed = (state as { collapsed?: unknown } | null)?.collapsed === true;
  return {
    collapsed,
    summarize: (parts) => {
      bridge
        .action("rail.summarize", parts)
        .catch((error: unknown) => warn("rail.summarize:", error));
    },
    show: (shown, why) => {
      bridge
        .action("rail.show", why === undefined ? shown : { shown, why })
        .catch((error: unknown) => warn("rail.show:", error));
    },
  };
}

function frameCards(bridge: FrameBridgeApi): PanelCards {
  return {
    emit: (card) => bridge.action("cards.emit", card).then((id) => String(id)),
    close: (id) => bridge.action("cards.close", { id }).then(() => undefined),
    open: () =>
      bridge
        .action("cards.open")
        .then((open) => (Array.isArray(open) ? (open as PanelOpenCard[]) : [])),
  };
}

/** The presses counted per header button in the host's view state (`asks`). */
function askCounts(state: unknown): Record<string, number> {
  const asks = (state as { asks?: unknown } | null)?.asks;
  if (!asks || typeof asks !== "object") return {};
  return Object.fromEntries(
    Object.entries(asks).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
  );
}

/** How each button's latest press came (`askedBy`): its own click, or a key. */
function askVia(state: unknown, button: string): PanelAskVia {
  const by = (state as { askedBy?: Record<string, unknown> } | null)?.askedBy;
  return by?.[button] === "click" ? "click" : "key";
}

/** F6's asks for focus, counted in the host's view state (`focus`). */
function focusCount(state: unknown): number {
  const focus = (state as { focus?: unknown } | null)?.focus;
  return typeof focus === "number" ? focus : 0;
}

function frameAsks(bridge: FrameBridgeApi): PanelAsks {
  // What this document was born with - the first state the host pushed it,
  // which the bridge keeps - and has heard since: only a count that moves
  // past it is a new ask, even one pushed before the panel's module loaded.
  const born = bridge.birthState ?? null;
  let seen: Record<string, number> | null = born === null ? null : askCounts(born);
  let seenFocus: number | null = born === null ? null : focusCount(born);
  const listeners = new Set<(button: string, via: PanelAskVia) => void>();
  const focusListeners = new Set<() => void>();
  // A press no listener was there to hear, before the panel's first render
  // subscribed, is heard by the first listener, as the window holds one for
  // a panel's first body (`onPanelAsk`).
  let unheard: { button: string; via: PanelAskVia } | null = null;
  const hear = (state: unknown) => {
    const counts = askCounts(state);
    if (seen !== null) {
      for (const [button, count] of Object.entries(counts)) {
        if (count <= (seen[button] ?? 0)) continue;
        const via = askVia(state, button);
        if (listeners.size === 0) unheard = { button, via };
        for (const listener of [...listeners]) listener(button, via);
      }
    }
    seen = counts;
    const focus = focusCount(state);
    if (seenFocus !== null && focus > seenFocus) {
      for (const listener of [...focusListeners]) listener();
    }
    seenFocus = focus;
  };
  bridge.onState(hear);
  // What the host pushed after the birth, before this page started reading.
  if (bridge.state !== null && bridge.state !== born) hear(bridge.state);
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      const ask = unheard;
      if (ask !== null) {
        unheard = null;
        queueMicrotask(() => listener(ask.button, ask.via));
      }
      return () => {
        listeners.delete(listener);
      };
    },
    onFocus: (listener) => {
      focusListeners.add(listener);
      return () => {
        focusListeners.delete(listener);
      };
    },
  };
}

/** A card view's data, as the host last pushed it in its view state. */
export function cardData(state: unknown): StoreValue {
  const card = (state as { card?: { data?: unknown } } | null)?.card;
  return (card?.data ?? null) as StoreValue;
}

/** How many times the card was put up, as the host last pushed it (`card.revision`). */
export function cardRevision(state: unknown): number {
  const revision = (state as { card?: { revision?: unknown } } | null)?.card?.revision;
  return typeof revision === "number" ? revision : 0;
}

/** The place a card kept (`card.keep`), as the host pushed it in its view state. */
export function cardKept(state: unknown): StoreValue {
  const card = (state as { card?: { kept?: unknown } } | null)?.card;
  return (card?.kept ?? null) as StoreValue;
}

/** A card's `keep`: its place goes to the host, which holds it on the card's entry. */
export function frameKeep(bridge: FrameBridgeApi): (value: StoreValue) => Promise<void> {
  return (value) => bridge.action("card.keep", value).then(() => undefined);
}

/**
 * The first view state the host pushes this document, which it pushes as
 * soon as the document is born: a card's page waits for it, so the place
 * the card kept is there at its first render.
 */
export function firstState(bridge: FrameBridgeApi): Promise<unknown> {
  if (bridge.state !== null) return Promise.resolve(bridge.state);
  return new Promise((resolve) => {
    const off = bridge.onState((state) => {
      off();
      resolve(state);
    });
  });
}

function frameStore(bridge: FrameBridgeApi): PanelStore {
  return {
    get: (key) => bridge.store({ op: "get", key }).then((answer) => answer.value as StoreValue),
    set: (key, value) => bridge.store({ op: "set", key, value }).then(() => undefined),
    delete: (key) => bridge.store({ op: "delete", key }).then(() => undefined),
    list: (prefix) =>
      bridge
        .store(prefix === undefined ? { op: "list" } : { op: "list", prefix })
        .then((answer) => (answer.entries ?? []) as StoreEntry[]),
    subscribe: (listener) => bridge.onStore(listener),
  };
}

function frameReads(
  config: PanelFrameConfig,
  bridge: FrameBridgeApi,
  warn: (...args: unknown[]) => void,
): PanelReads {
  const declared = new Set<string>(config.reads);
  const open = (
    name: string,
    args: Record<string, unknown>,
    listener: (value: unknown) => void,
  ): (() => void) => {
    const subscription = bridge.subscribe(name, args, listener, (error) =>
      warn(`panel read "${name}" failed:`, error),
    );
    subscription.ready.catch((error: unknown) => warn(`panel read "${name}" refused:`, error));
    return () => {
      void subscription.unsubscribe().catch(() => {});
    };
  };
  const subscribe = (name: string, second: unknown, third?: unknown): (() => void) => {
    if (name === "sql") {
      if (config.sql.length === 0) throw new Error(undeclaredViewsMessage());
      const listener = third as (answer: SqlAnswer) => void;
      return open("sql", second as Record<string, unknown>, (value) =>
        listener(value as SqlAnswer),
      );
    }
    if (!declared.has(name)) throw new Error(undeclaredReadMessage(name));
    // A read that takes arguments - one task by its id, closed work by its
    // words, a knowledge collection by its scope - has its listener third;
    // every other read takes nothing.
    if (typeof third === "function") {
      return open(name, second as Record<string, unknown>, third as (value: unknown) => void);
    }
    return open(name, {}, second as (value: unknown) => void);
  };
  return { subscribe: subscribe as PanelReads["subscribe"] };
}
