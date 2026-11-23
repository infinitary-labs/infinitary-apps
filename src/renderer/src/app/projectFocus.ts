import {
  heldFocus,
  holdsBack,
  type ProjectPills,
  pillShown,
  projectPillsOf,
  waitingElsewhere,
} from "@shared/projectFocus";
import type { TaskBoard } from "@shared/tasks";
import { useSyncExternalStore } from "react";
import { railStore } from "../plugins/railStore";
import { appReadExecutor } from "../plugins/reads/appExecutor";

/**
 * The window's project focus (docs/project-focus.md), as every surface
 * reads it: the top bar's pill, the Tasks panel and the board through
 * `PanelProps.view`, the stage's dimming, and the turn's hint. The saved
 * choice is the layout's (`railStore.focusProject`); what holds is that
 * choice while its project still has a pill (`heldFocus`).
 *
 * Two facts are the window's own and never saved: whether the pill's row
 * is open, and the project a pointer or the keyboard rests on in it, which
 * lights that project's crew on the stage.
 */

export type ProjectFocusState = {
  /** Null until the board is read. */
  pills: ProjectPills | null;
  /** The focus that holds now; null is All projects. */
  focus: string | null;
  /** Whether the pill shows: two projects or more. */
  shown: boolean;
  /** Tasks waiting on the captain in other projects than the focused one. */
  elsewhere: number;
  open: boolean;
  /** How many times a command asked the row to open with focus in it. */
  openAsk: number;
  /** The pill a pointer or the keyboard rests on in the open row: a project id, "all", or null. */
  rest: string | null;
};

let pills: ProjectPills | null = null;
/** Each task's project, by the board as last read; null until it is read. */
let taskProjects: ReadonlyMap<string, string> | null = null;
let open = false;
let openAsk = 0;
let rest: string | null = null;
let started = false;
let snapshot: ProjectFocusState = compute();
const listeners = new Set<() => void>();

function compute(): ProjectFocusState {
  const saved = railStore.focusedProject();
  // Before the board is read the saved focus holds, so a restart never
  // paints All projects on the way to the project it was focused on.
  const focus = pills ? heldFocus(saved, pills) : saved;
  return {
    pills,
    focus,
    shown: pills ? pillShown(pills) : false,
    elsewhere: pills ? waitingElsewhere(pills, focus) : 0,
    open,
    openAsk,
    rest,
  };
}

function notify(): void {
  snapshot = compute();
  for (const listener of listeners) listener();
}

function start(): void {
  if (started) return;
  started = true;
  railStore.subscribe(notify);
  appReadExecutor().subscribe(
    "tasks.board",
    { closed: false },
    {
      onValue: (value) => {
        const board = value as TaskBoard;
        pills = projectPillsOf(board);
        taskProjects = new Map(board.tasks.map((task) => [task.id, task.projectId]));
        notify();
      },
      onError: () => {},
    },
  );
}

export const projectFocus = {
  subscribe(listener: () => void): () => void {
    start();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  state(): ProjectFocusState {
    return snapshot;
  },
  /** Focus on one project, or on All projects with null; closes the row. */
  pick(projectId: string | null): void {
    open = false;
    rest = null;
    railStore.focusProject(projectId);
    notify();
  },
  setOpen(next: boolean): void {
    if (open === next) return;
    open = next;
    if (!next) rest = null;
    notify();
  },
  /** Focus on a project (the command): open the row with focus on its pills. */
  askOpen(): void {
    open = true;
    openAsk += 1;
    notify();
  },
  setRest(next: string | null): void {
    if (rest === next) return;
    rest = next;
    notify();
  },
};

export function useProjectFocus(): ProjectFocusState {
  return useSyncExternalStore(projectFocus.subscribe, projectFocus.state, projectFocus.state);
}

/** The focus that holds now, outside React: the turn's hint, the panels' view. */
export function heldProjectFocus(): string | null {
  return snapshot.focus;
}

/**
 * Whether the focus that holds now keeps `card` off the stack
 * (`holdsBack`, docs/project-focus.md "The card stack"): the stack reads
 * this as each cards snapshot lands, and again whenever the focus or the
 * board moves (`projectFocus.subscribe`).
 */
export function focusHoldsBack(card: { taskId?: string }): boolean {
  return holdsBack(card, snapshot.focus, taskProjects);
}
