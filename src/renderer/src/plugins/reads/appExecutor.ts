import { computerPresenceOf } from "@shared/devices";
import type { CorePushChannel } from "@shared/ipc";
import type { PanelFeedLine } from "@shared/personal/contracts";
import { type ComputerResourcesView, panelComputerResources } from "@shared/resources";
import type { ProjectView, TaskBoard, TaskBoardDelta, TaskDetail, TaskView } from "@shared/tasks";
import { presentBoard, presentProjects, presentTask } from "@shared/taskWaiting";
import { useShellStore } from "../../app/store";
import { type ReadApi, ReadExecutor } from "./executor";
import { onResync } from "./resync";
import { sharedSubscription } from "./sharedPush";

const boardPushes = sharedSubscription(
  (listener: (json: string) => void) => window.infinitary.tasks.onBoardJson(listener),
  (json): TaskBoard => JSON.parse(json),
);
const boardDeltaPushes = sharedSubscription(
  (listener: (delta: TaskBoardDelta) => void) => window.infinitary.tasks.onBoardDelta(listener),
  (delta) => delta,
);

export const resourcePushes = sharedSubscription(
  (listener: (view: ComputerResourcesView) => void) =>
    window.infinitary.devices.onResources(listener),
  (view) => view,
);

/**
 * The app's one read executor, over the frozen `window.infinitary` API.
 * Every push other than `inf:event` is mapped here, so a catalog entry
 * naming a push channel the API does not expose is a type error, which
 * is the point.
 */
const PUSHES: Record<Exclude<CorePushChannel, "inf:event">, ReadApi["onPush"]> = {
  "inf:voice:progress": (_channel, listener) => window.infinitary.voice.onProgress(listener),
  "inf:quota": (_channel, listener) => window.infinitary.quota.onSnapshot(listener),
  "inf:models:changed": (_channel, listener) =>
    window.infinitary.models.onChanged(() => listener({ ok: true })),
  "inf:cards": (_channel, listener) => window.infinitary.cards.onCards(listener),
  // One card's thread (cards-as-threads phase 1): no read names it - the
  // card layer subscribes directly, because a thread belongs to the card
  // on screen rather than to a panel.
  "inf:cards:thread": (_channel, listener) => window.infinitary.cards.onThread(listener),
  // The payload rides along: `tasks.board` takes the pushed board as its
  // value (the preload validated it like any invoke response). Every task
  // change pushes it, so it crosses the bridge once as text and is parsed
  // once for every subscriber (./sharedPush.ts).
  "inf:tasks": (_channel, listener) => boardPushes(listener),
  "inf:tasks:delta": (_channel, listener) => boardDeltaPushes(listener),
  // The first mate sends it to each computer that controls it, whose main
  // process opens the page (docs/view.md): no window hears it.
  "inf:app:open-page": () => () => {},
  // A task's browser pictures go to the one view that watches it
  // (docs/task-browser.md, "The view"): no read names it; the browser view
  // subscribes directly.
  "inf:browser:frame": (_channel, listener) => window.infinitary.browser.onFrame(listener),
  "inf:auth:prompt": (_channel, listener) => window.infinitary.auth.onPrompt(listener),
  "inf:auth:notice": (_channel, listener) => window.infinitary.auth.onNotice(listener),
  // Personal extensions (talk-to-personalize Step 2): no read names these
  // yet; the reconciler and a panel's bound store subscribe directly.
  "inf:plugins:personal": (_channel, listener) =>
    window.infinitary.plugins.personal.onSnapshot(listener),
  "inf:plugins:db": (_channel, listener) => window.infinitary.plugins.db.onChange(listener),
  // The captain's preferences ride along whole: `shell.preferences` takes
  // the pushed value as its own (talk-to-personalize Step 1).
  "inf:shell:preferences": (_channel, listener) =>
    window.infinitary.settings.onPreferences(listener),
  // The two switches (roadmap 1.4): no read names this; the Settings
  // section subscribes directly.
  "inf:settings:dictation": (_channel, listener) =>
    window.infinitary.settings.onDictation(listener),
  "inf:sharing": (_channel, listener) => window.infinitary.settings.onSharing(listener),
  // The release notes the app showed: no read names it; the shell store subscribes directly.
  "inf:release-notes": (_channel, listener) => window.infinitary.releaseNotes.onChange(listener),
  // The sign-ins where projects live (git integration PR 1.2): the Projects
  // section subscribes directly; `forge.changes` re-reads when one changes.
  "inf:forges": (_channel, listener) => window.infinitary.forges.onChange(listener),
  // Integrations (docs/integrations.md): no read names it; Settings ->
  // Integrations subscribes directly.
  "inf:integrations": (_channel, listener) => window.infinitary.integrations.onChange(listener),
  "inf:secrets:changed": (_channel, listener) =>
    window.infinitary.secrets.onChange(() => listener({})),
  // A computer's own sign-ins (docs/helper.md, "Its own sign-ins"): no read
  // names these; Settings -> Intelligence subscribes directly.
  "inf:devices:sign-ins": (_channel, listener) => window.infinitary.devices.onSignIns(listener),
  // Your devices (docs/devices.md): no read names it; Settings -> Devices subscribes directly.
  "inf:devices": (_channel, listener) => window.infinitary.devices.onDevices(listener),
  "inf:computers:resources": (_channel, listener) => resourcePushes(listener),
  "inf:computers:presence": (_channel, listener) =>
    window.infinitary.devices.onDevices((list) => listener(computerPresenceOf(list))),
  "inf:devices:addresses": (_channel, listener) => window.infinitary.devices.onAddresses(listener),
  "inf:devices:nearby": (_channel, listener) => window.infinitary.devices.onNearby(listener),
  "inf:devices:sign-in": (_channel, listener) => window.infinitary.devices.onSignIn(listener),
};

/** The recorded feed as last presented, for the host's checked line pointing. */
let presentedFeed: readonly PanelFeedLine[] = [];
export function feedOnScreen(): readonly PanelFeedLine[] {
  return presentedFeed;
}

/**
 * The task board as the app last presented it to a reader, or undefined
 * before anything read it: what a panel's pointing is checked against
 * (`../panelPoint.ts`) - a task or a card it names must be one this board
 * lists, and a panel that points reads it, so it is here.
 */
let presentedBoard: TaskBoard | undefined;
export function boardOnScreen(): TaskBoard | undefined {
  return presentedBoard;
}

/** How many tasks a search found are remembered for pointing: the newest finds. */
const SEARCHED_KEPT = 500;
/**
 * Closed work the board no longer lists, as `tasks.search` last found it for
 * a reader: a panel that searches may point at what it found, as a Tasks
 * row of the `earlier` group is opened and rested on.
 */
const searched = new Map<string, TaskView>();
export function searchedTask(taskId: string): TaskView | undefined {
  return searched.get(taskId);
}
export function searchedTaskByKey(key: string): TaskView | undefined {
  return [...searched.values()].find((task) => task.key === key);
}
function rememberFound(tasks: readonly TaskView[]): void {
  for (const task of tasks) {
    searched.delete(task.id);
    searched.set(task.id, task);
  }
  for (const id of searched.keys()) {
    if (searched.size <= SEARCHED_KEPT) break;
    searched.delete(id);
  }
}

export function firstmateReadApi(): ReadApi {
  let board: TaskBoard | undefined;
  const rememberBoard = (next: TaskBoard) => {
    if (!board || next.seq >= board.seq) board = next;
    return board;
  };
  let projected: { raw: TaskBoard; cards: unknown; value: TaskBoard } | undefined;
  const projectBoard = (raw: TaskBoard) => {
    const { cards } = useShellStore.getState();
    if (projected?.raw === raw && projected.cards === cards) return projected.value;
    const value = presentBoard(raw, cards);
    projected = { raw, cards, value };
    presentedBoard = value;
    return value;
  };
  return {
    read: async (name, args, grant) => {
      const value = await window.infinitary.plugins.read(name, args as never, grant);
      if (name === "projects.list") rememberBoard(await window.infinitary.tasks.board());
      return value;
    },
    present: (name, value) => {
      const { cards } = useShellStore.getState();
      if (name === "tasks.board") {
        return projectBoard(rememberBoard(value as TaskBoard));
      }
      if (name === "feed.recent") presentedFeed = value as PanelFeedLine[];
      if (name === "tasks.detail") return presentTask(value as TaskDetail, cards);
      if (name === "tasks.search") rememberFound(value as TaskView[]);
      if (name === "projects.list" && board) {
        return presentProjects(value as ProjectView[], projectBoard(board).tasks);
      }
      // Panels receive installed memory, the one figure and pressure. The
      // published reading keeps the raw counts; this projection is what
      // stops a panel from computing its own RAM used.
      if (name === "computers.resources")
        return panelComputerResources(value as ComputerResourcesView);
      return value;
    },
    onPresentation: (listener) =>
      useShellStore.subscribe((next, previous) => {
        if (next.cards !== previous.cards) listener();
      }),
    onEvent: (listener) => window.infinitary.events.on(listener),
    onPush: (channel, listener) => PUSHES[channel](channel, listener),
    onResync,
  };
}

let executor: ReadExecutor | undefined;

export function appReadExecutor(): ReadExecutor {
  executor ??= new ReadExecutor(firstmateReadApi());
  return executor;
}
