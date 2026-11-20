import { dropTaskReviewSchema, taskLifecycleOpSchema } from "@shared/cards";
import * as m from "@shared/i18n/messages.generated";
import type { PanelMoveResult, PanelTasks } from "@shared/personal/contracts";
import { z } from "zod";

/**
 * Moving the captain's tasks from a panel, the host's side (FI3-1014
 * piece 4; docs/ui-plugins.md "A panel's cards"): `PanelProps.tasks`, for a
 * panel whose manifest asks for `moves` - and, for one from elsewhere, that
 * the captain agreed to when he added it (the captain's answer on FI3-1014:
 * "Asked for once, agreed when you add it, then each move on your click or
 * key").
 *
 * A move is one of the six the task record's own buttons and the task
 * board make, and runs the same `inf:task:run` with the same write-time
 * checks, so it lands on the task's record as the captain's own, naming
 * the panel it came from. It counts only from his own click or key in that
 * page (`gate`); one made otherwise writes nothing and says so. Merge and
 * discard are never moves: they stay on the task's own card. A pin
 * (`tasks.pin`, INF-3127) rides the same grant and the same gate: a fact
 * on the task's record, not a move, written only on his click or key.
 */

/** The id a panel's or a card's frame moves a task through (`inf.action`). */
export const PANEL_TASKS_ACTIONS = ["tasks.run", "tasks.pin"] as const;

/**
 * Why a move made without the captain's click or key wrote nothing: worded
 * when it is answered, as `m.panelMoveNotAsked()`; this is those words as the
 * process speaks them when the module loads, for the tests that read them.
 */
export const MOVE_NOT_ASKED = m.panelMoveNotAsked();

const pinSchema = z.strictObject({
  taskId: z.string().min(1).max(64),
  pinned: z.boolean(),
});

/** What `inf:task:pin` needs from the window: a task's pin, from the panel the captain pressed it in. */
export type TaskPinner = (
  taskId: string,
  pinned: boolean,
  from: { panel: string } | undefined,
) => Promise<PanelMoveResult>;

const pinForReal: TaskPinner = (taskId, pinned, from) =>
  window.infinitary.task.pin(taskId, pinned, from);

const runSchema = z.strictObject({
  taskId: z.string().min(1).max(64),
  move: taskLifecycleOpSchema,
  review: dropTaskReviewSchema.optional(),
});

/** What `inf:task:run` needs from the window: the task record's one way to move a task. */
export type TaskRunner = (
  taskId: string,
  op: z.infer<typeof taskLifecycleOpSchema>,
  review: z.infer<typeof dropTaskReviewSchema> | undefined,
  from: { panel: string } | undefined,
) => Promise<PanelMoveResult>;

const runForReal: TaskRunner = (taskId, op, review, from) =>
  window.infinitary.task.run(taskId, op, review, from);

/**
 * `PanelProps.tasks` for one page of `panel`, its title naming it on the
 * task's record - unless it is one of the app's own (`own`), which name no
 * panel, as they carry no maker's name: a move from the app's own reads on
 * the record as a move from the app. Checked like any input from a panel;
 * a refusal comes back as the app's words, and nothing is written.
 */
export function panelTasks(
  panel: { id: string; title: string; own?: boolean },
  gate: () => Promise<boolean>,
  run: TaskRunner = runForReal,
  pin: TaskPinner = pinForReal,
): PanelTasks {
  return {
    // A pin is checked and gated as a move is (INF-3127): only the captain's
    // own click or key in this page writes it, naming the panel.
    pin: async (taskId, pinned) => {
      const parsed = pinSchema.safeParse({ taskId, pinned });
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(`tasks.pin: ${issue?.path.join(".") || "pin"}: ${issue?.message}`);
      }
      if (!(await gate())) return { ok: false, text: m.panelMoveNotAsked() };
      try {
        return await pin(
          parsed.data.taskId,
          parsed.data.pinned,
          panel.own ? undefined : { panel: panel.title },
        );
      } catch (caught) {
        return { ok: false, text: caught instanceof Error ? caught.message : String(caught) };
      }
    },
    run: async (taskId, move, review) => {
      const parsed = runSchema.safeParse({
        taskId,
        move,
        ...(review === undefined ? {} : { review }),
      });
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(`tasks.run: ${issue?.path.join(".") || "move"}: ${issue?.message}`);
      }
      if (!(await gate())) return { ok: false, text: m.panelMoveNotAsked() };
      try {
        return await run(
          parsed.data.taskId,
          parsed.data.move,
          parsed.data.review,
          panel.own ? undefined : { panel: panel.title },
        );
      } catch (caught) {
        return { ok: false, text: caught instanceof Error ? caught.message : String(caught) };
      }
    },
  };
}

/** The host's answer to a frame's `tasks.run` or `tasks.pin`: the value carries the call's arguments. */
export function frameTasksAction(
  tasks: PanelTasks,
): (id: string, value: unknown) => Promise<unknown> {
  return async (id, value) => {
    if (id === "tasks.pin") {
      const arg = (value ?? {}) as { taskId?: unknown; pinned?: unknown };
      return tasks.pin(arg.taskId as string, arg.pinned as boolean);
    }
    if (id !== "tasks.run") throw new Error(`"${id}" is not a panel's move`);
    const arg = (value ?? {}) as { taskId?: unknown; move?: unknown; review?: unknown };
    return tasks.run(arg.taskId as string, arg.move as never, arg.review as never);
  };
}
