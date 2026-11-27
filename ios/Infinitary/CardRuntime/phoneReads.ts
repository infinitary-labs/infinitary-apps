import type { Card } from "../../../src/shared/cards";
import type { FmEvent } from "../../../src/shared/events";
import type { FeedLine } from "../../../src/shared/feed";
import { wordedLine } from "../../../src/shared/i18n/said";
import type { CorePushChannel } from "../../../src/shared/ipc";
import { panelQuotaSnapshot, type QuotaSnapshotView } from "../../../src/shared/quota";
import { type ReadName, readCatalog } from "../../../src/shared/reads";
import { type ComputerResourcesView, panelComputerResources } from "../../../src/shared/resources";
import type { ProjectView, TaskBoard, TaskDetail } from "../../../src/shared/tasks";
import { presentBoard, presentProjects, presentTask } from "../../../src/shared/taskWaiting";
import { type ReadApi, ReadExecutor } from "../../../src/renderer/src/plugins/reads/executor";

/**
 * The reads a page on the phone runs (docs/ios.md, "Panels" and "Cards on the phone"): the desktop window's read api
 * (`firstmateReadApi`) over the phone's connection instead of the window's bridge, under the desktop's own
 * `ReadExecutor` and read catalog. A panel's page and a card's page each hold one; every ask crosses to native code,
 * which passes only the channels that page may ask, and every push and reload native code hands the page reaches it
 * through `push` and `resync`.
 */
export type PhoneReads = {
  executor: ReadExecutor;
  /** Hears one of the computer's pushes on a channel, until the returned stop. */
  listen(channel: string, listener: (payload: unknown) => void): () => void;
  /** A push from the computer, handed on by native code. */
  push(channel: string, payload: unknown): void;
  /** The phone reloaded what it held: every read runs again. */
  resync(): void;
};

/** Asks the computer on one channel through the page's native host. */
export type PhoneAsk = (channel: string, args: unknown[]) => Promise<unknown>;

export function phoneReads(ask: PhoneAsk): PhoneReads {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const resyncs = new Set<() => void>();
  function listen(channel: string, listener: (payload: unknown) => void): () => void {
    let set = listeners.get(channel);
    if (!set) { set = new Set(); listeners.set(channel, set); }
    set.add(listener);
    return () => { set?.delete(listener); };
  }

  /** The cards a board or a task is presented against, as the desktop's window presents them. */
  let cards: readonly Card[] = [];
  let cardsAsked = false;
  const presentations = new Set<() => void>();
  function needCards(): void {
    if (cardsAsked) return;
    cardsAsked = true;
    listen("inf:cards", (payload) => { cards = Array.isArray(payload) ? (payload as Card[]) : cards; for (const tell of presentations) tell(); });
    void ask("inf:cards:list", []).then((value: unknown) => {
      if (Array.isArray(value)) { cards = value as Card[]; for (const tell of presentations) tell(); }
    }).catch(() => {});
  }

  /** The board a project list's waiting counts are read against, kept as the desktop window keeps it (`firstmateReadApi`). */
  let board: TaskBoard | undefined;
  function rememberBoard(next: TaskBoard): void {
    // A newer board, or as new a board with its closed rows where one without them is held.
    if (!board || next.seq > board.seq || (next.seq === board.seq && (board.closedLeftOut !== undefined || next.closedLeftOut === undefined))) board = next;
  }

  const readApi: ReadApi = {
    read: async (name: ReadName, args, grant) => {
      const entry = readCatalog[name] as unknown as { channel: string; toRequest: (args: unknown, grant: unknown) => unknown[] };
      if (name === "tasks.board" || name === "tasks.detail") needCards();
      if (name === "tasks.board" && (args as { closed?: false }).closed === false) {
        // An older home refuses the lesser read: the whole board answers it.
        return ask(entry.channel, entry.toRequest(args, grant)).catch(() => ask(entry.channel, entry.toRequest({}, grant)));
      }
      if (name === "projects.list") {
        // Its waiting counts are the board's, as the window presents them, so the board is read beside it.
        needCards();
        const value = await ask(entry.channel, entry.toRequest(args, grant));
        const boardRead = readCatalog["tasks.board"];
        rememberBoard((await ask(boardRead.channel, boardRead.toRequest({ closed: false }, undefined as never))
          .catch(() => ask(boardRead.channel, boardRead.toRequest({}, undefined as never)))) as TaskBoard);
        return value;
      }
      return ask(entry.channel, entry.toRequest(args, grant));
    },
    present: (name, value) => {
      if (name === "tasks.board") {
        rememberBoard(value as TaskBoard);
        return presentBoard(value as TaskBoard, cards);
      }
      if (name === "projects.list" && board) return presentProjects(value as ProjectView[], presentBoard(board, cards).tasks);
      if (name === "tasks.detail") return presentTask(value as TaskDetail, cards);
      // Each line the computer saved as a fact is worded here, as the window words it (docs/i18n.md, "Saved facts").
      if (name === "feed.recent") {
        return (value as FeedLine[]).map(({ said, ...line }) => (said ? { ...line, text: wordedLine({ text: line.text, said }) } : line));
      }
      if (name === "computers.resources") return panelComputerResources(value as ComputerResourcesView);
      if (name === "quota.snapshot") return panelQuotaSnapshot(value as QuotaSnapshotView | null);
      return value;
    },
    onPresentation: (listener) => { presentations.add(listener); return () => { presentations.delete(listener); }; },
    onEvent: (listener) => listen("inf:event", (payload) => listener(payload as FmEvent)),
    onPush: (channel: Exclude<CorePushChannel, "inf:event">, listener) => listen(channel, listener),
    onResync: (listener) => { resyncs.add(listener); return () => { resyncs.delete(listener); }; },
  };

  return {
    executor: new ReadExecutor(readApi),
    listen,
    push(channel, payload) {
      for (const listener of [...(listeners.get(channel) ?? [])]) listener(payload);
    },
    resync() {
      for (const listener of [...resyncs]) listener();
    },
  };
}
