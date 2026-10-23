import {
  PANEL_DRAFT_MAX,
  type PanelBox,
  type PanelPoint,
  type PanelView,
} from "@shared/personal/contracts";
import { pointNeedsBoardMessage } from "@shared/personal/manifest";
import { useMemo } from "react";
import { z } from "zod";
import { pressesSoFar } from "../app/presses";
import { mainMessageRefusal, type ShellState, shownCard, useShellStore } from "../app/store";
import { isView } from "../devices/viewWords";
import { pluginHost } from "./host";
import { useLitTaskId } from "./point/litTask";
import { openTask } from "./point/openTask";
import { taskPeek } from "./point/taskPeek";
import { boardOnScreen, searchedTask } from "./reads/appExecutor";

/**
 * Pointing at the app's own tasks and cards, the host's side (FI3-1014
 * piece 3; docs/ui-plugins.md "A panel's cards"): what any panel that
 * reads `tasks.board` gets as `PanelProps.point`, in either realm, and the
 * view the app pushes into it (`PanelProps.view`). A panel names a task or
 * a card only by an id a read gave it - the board, or for a panel that
 * reads `tasks.search` the closed work a search found - and the host
 * checks that against what it presented; a gesture changes nothing in the
 * app's record - it opens, brings forward, rests or aims.
 *
 * Opening, bringing a card forward and aiming move the captain's focus or
 * the words he sends, so they count only from his own click or key in that
 * page (`gate`: the window's user activation for a panel of his own, the
 * frame holding the window's focus for one from elsewhere); one made
 * otherwise does nothing and answers false. Resting is the pointer's or
 * the keyboard's, and needs no click.
 *
 * Drafting names nothing of the app's, so every panel has it, whatever it
 * reads: the words start the captain's next message for him to finish
 * (`beginDraft`, as the Create panel slot starts one), from his own click
 * or key, and nothing is sent. Opening Settings is the same kind of move:
 * any panel may open a section this window offers, handing it an item to
 * show (`settingsItem`), from his own click or key.
 */

/** The ids a panel's or a card's frame points through (`inf.action`). */
export const PANEL_POINT_ACTIONS = [
  "point.openTask",
  "point.openRecord",
  "point.peekTask",
  "point.showCard",
  "point.aim",
] as const;

/** The one pointing every panel's page has, whatever it reads: `point.draft`. */
export const PANEL_DRAFT_ACTION = "point.draft";
/** And the other: `point.openSettings`. */
export const PANEL_OPEN_SETTINGS_ACTION = "point.openSettings";

/** Where a page runs and whether the captain's own click or key holds it now. */
export type PointPage = {
  /** The reads the panel declared: pointing needs `tasks.board`. */
  reads: readonly string[];
  /** Set in a card view: the card whose aim `aim` sets. */
  card?: string;
  /** Whether the captain's own click or key holds this page now, or within its few frames. */
  gate: () => Promise<boolean>;
  /**
   * The page's frame, for a panel from elsewhere: where it sits is added to
   * a box it names. Null in the window itself, whose boxes are its own.
   */
  frame: () => HTMLIFrameElement | null;
};

/** The page in the window a panel's code draws in: its panel on its rail, or its card on the stack. */
function pageOf(panel: string, card: string | undefined): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    card === undefined
      ? `[data-side-panel="${CSS.escape(panel)}"]`
      : `[data-panel-card="${CSS.escape(`${panel}/${card}`)}"]`,
  );
}

const taskIdSchema = z.string().min(1).max(64);
const boxSchema = z.strictObject({
  top: z.number().finite(),
  right: z.number().finite(),
  bottom: z.number().finite(),
  left: z.number().finite(),
});
const peekSchema = z.strictObject({ taskId: taskIdSchema, box: boxSchema }).nullable();
const draftSchema = z
  .string()
  .max(PANEL_DRAFT_MAX)
  .refine((text) => text.trim().length > 0 && !/[\r\n]/.test(text));
const settingsAskSchema = z.strictObject({
  section: z.string().min(1).max(64),
  item: z
    .string()
    .min(1)
    .max(128)
    .refine((text) => !/[\r\n]/.test(text))
    .optional(),
});

/**
 * A task the board on screen lists, by id, or one a search found for a
 * panel that searches; undefined when neither holds it.
 */
function listedFor(reads: readonly string[]) {
  const searches = reads.includes("tasks.search");
  return (taskId: string) =>
    boardOnScreen()?.tasks.find((task) => task.id === taskId) ??
    (searches ? searchedTask(taskId) : undefined);
}

function idOf(call: string, value: unknown): string {
  const parsed = taskIdSchema.safeParse(value);
  if (!parsed.success) throw new Error(`point.${call}: name it by the id the board gave it`);
  return parsed.data;
}

/**
 * `PanelProps.point` for one page of `panel`: its panel body or one of its
 * card views. Every call is checked like any input from a panel.
 */
export function panelPoint(panel: string, page: PointPage): PanelPoint {
  const reads = page.reads.includes("tasks.board");
  const listed = listedFor(page.reads);
  const need = (call: string) => {
    if (!reads) throw new Error(pointNeedsBoardMessage(call));
  };
  return {
    // Each pointing counts the captain's presses before it waits on the
    // gate: a press he begins meanwhile keeps focus (app/presses.ts).
    openTask: async (taskId) => {
      need("openTask");
      const since = pressesSoFar();
      const id = idOf("openTask", taskId);
      const task = listed(id);
      if (!task || !(await page.gate())) return false;
      await openTask(
        { taskId: id, ...(task.waitingCardId ? { cardId: task.waitingCardId } : {}) },
        since,
      );
      return true;
    },
    openRecord: async (taskId) => {
      need("openRecord");
      const since = pressesSoFar();
      const id = idOf("openRecord", taskId);
      const task = listed(id);
      if (!task || !(await page.gate())) return false;
      if (task.minimizedCardId && !task.key)
        return useShellStore.getState().focusCard(task.minimizedCardId, since);
      useShellStore.getState().openRecord(id);
      return true;
    },
    peekTask: (peek) => {
      need("peekTask");
      const parsed = peekSchema.safeParse(peek);
      if (!parsed.success) throw new Error("point.peekTask: a task's id and its box, or null");
      const where = pageOf(panel, page.card);
      if (!parsed.data || !listed(parsed.data.taskId) || !where) {
        if (where) taskPeek.release(where);
        return;
      }
      const frame = page.frame();
      const at = frame?.getBoundingClientRect();
      const { taskId, box } = parsed.data;
      if (!listed(taskId)?.key) {
        taskPeek.release(where);
        return;
      }
      taskPeek.set({ taskId, box: at ? offset(box, at) : box, page: where, pageFrame: frame });
    },
    showCard: async (cardId) => {
      need("showCard");
      const since = pressesSoFar();
      const id = z.string().min(1).max(128).safeParse(cardId);
      if (!id.success) throw new Error("point.showCard: name the card by its waitingCardId");
      const waits = boardOnScreen()?.tasks.some(
        (task) => task.waitingCardId === id.data || task.minimizedCardId === id.data,
      );
      if (!waits || !(await page.gate())) return false;
      return useShellStore.getState().focusCard(id.data, since);
    },
    aim: async (taskId) => {
      need("aim");
      if (page.card === undefined) throw new Error("point.aim: only a card view aims the turn");
      const id = taskId === null ? null : idOf("aim", taskId);
      if (id !== null && !listed(id)) return false;
      // Letting go aims nothing, so it needs no click.
      if (id !== null && !(await page.gate())) return false;
      useShellStore.getState().aimPanelCard(panel, page.card, id);
      return true;
    },
    draft: async (text) => {
      const parsed = draftSchema.safeParse(text);
      if (!parsed.success) {
        throw new Error(`point.draft: words on one line, at most ${PANEL_DRAFT_MAX} characters`);
      }
      if (!(await page.gate())) return false;
      const shell = useShellStore.getState();
      if (mainMessageRefusal(shell) !== null) return false;
      if (shell.view !== "home") shell.setView("home");
      shell.beginDraft(parsed.data);
      return true;
    },
    openSettings: async (section, item) => {
      const parsed = settingsAskSchema.safeParse({
        section,
        ...(item === undefined ? {} : { item }),
      });
      if (!parsed.success) {
        throw new Error(
          "point.openSettings: a Settings section's id, and an item of at most 128 characters on one line",
        );
      }
      const offered = pluginHost.settingsSections.get(parsed.data.section);
      const shell = useShellStore.getState();
      if (!offered || (isView(shell.thisMac) && offered.onAView !== true)) return false;
      if (!(await page.gate())) return false;
      useShellStore.setState({
        view: "settings",
        settingsSection: parsed.data.section,
        settingsItem:
          parsed.data.item === undefined
            ? null
            : { section: parsed.data.section, item: parsed.data.item },
      });
      return true;
    },
  };
}

/** A box in a frame's own page, in the window's coordinates. */
function offset(box: PanelBox, at: DOMRect): PanelBox {
  return {
    top: box.top + at.top,
    right: box.right + at.left,
    bottom: box.bottom + at.top,
    left: box.left + at.left,
  };
}

/**
 * The host's answers to a frame's pointing (`PANEL_POINT_ACTIONS`), over
 * the same checks as the window's: the value each action carries is the
 * call's argument.
 */
export function framePointAction(
  point: PanelPoint,
): (id: string, value: unknown) => Promise<unknown> {
  return async (id, value) => {
    const arg = value as {
      taskId?: unknown;
      cardId?: unknown;
      text?: unknown;
      section?: unknown;
      item?: unknown;
    } | null;
    switch (id) {
      case "point.openTask":
        return point.openTask(arg?.taskId as string);
      case "point.openRecord":
        return point.openRecord(arg?.taskId as string);
      case "point.peekTask":
        point.peekTask(value as never);
        return undefined;
      case "point.showCard":
        return point.showCard(arg?.cardId as string);
      case "point.aim":
        return point.aim((arg?.taskId ?? null) as string | null);
      case PANEL_DRAFT_ACTION:
        return point.draft(arg?.text as string);
      case PANEL_OPEN_SETTINGS_ACTION:
        return point.openSettings(arg?.section as string, arg?.item as string | undefined);
      default:
        throw new Error(`"${id}" is not one of a panel's pointing actions`);
    }
  };
}

/** The view a panel that does not read the board is handed: nothing open. */
export const NO_VIEW: PanelView = Object.freeze({
  openTaskIds: Object.freeze([]) as unknown as string[],
  shownTaskId: null,
  litTaskId: null,
});

/**
 * What the captain has open, as `PanelProps.view` hands it, written as one
 * key so a reader re-renders only when it moves: the tasks whose records
 * are on the stack, and the task of the entry on screen - a record, a
 * task's browser or Crewmate tab, or a panel card's aim (the task board's
 * selected tile), and the task lit by a rest anywhere in the window
 * (`litTaskId`, ./point/litTask.ts).
 */
export function panelViewKey(s: ShellState, litTaskId: string | null = null): string {
  const shown = shownCard(s.cards, s.cardIndex, s.collapsedCardIds, s.records);
  const openTaskIds = s.records.flatMap((held) => ("taskId" in held ? [held.taskId] : []));
  const shownTaskId =
    shown?.recordTaskId ??
    shown?.browserTaskId ??
    shown?.crewmateTaskId ??
    shown?.panelCard?.aim ??
    null;
  return JSON.stringify([openTaskIds, shownTaskId, litTaskId]);
}

/** The view a key names. */
export function panelViewOf(key: string): PanelView {
  const [openTaskIds, shownTaskId, litTaskId] = JSON.parse(key) as [
    string[],
    string | null,
    string | null,
  ];
  return { openTaskIds, shownTaskId, litTaskId };
}

/** `PanelProps.view`, following the stack: empty for a panel that does not read the board. */
export function usePanelView(readsBoard: boolean): PanelView {
  const lit = useLitTaskId();
  const key = useShellStore((s) => (readsBoard ? panelViewKey(s, lit) : ""));
  return useMemo(() => (key ? panelViewOf(key) : NO_VIEW), [key]);
}
