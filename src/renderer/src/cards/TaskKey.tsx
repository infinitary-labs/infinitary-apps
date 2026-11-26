import type { TaskView } from "@shared/tasks";
import { useRef } from "react";
import { useShellStore } from "../app/store";
import { TaskKey, type TaskKeyLook, TaskKeyWords } from "../design/panel/TaskKey";
import { useLitTaskId } from "../plugins/point/litTask";
import { openTaskFromKey } from "../plugins/point/openTask";
import { taskPeek } from "../plugins/point/taskPeek";
import { useTaskLinks } from "./taskLinks";

/**
 * What a key the window draws sits beside when it is rested on: its card on
 * the stage (with its thread, when one is open), or the Settings section it
 * is in; the key itself anywhere else.
 */
const KEY_SURFACE = "[data-card-presentation], [data-settings-section]";

const boxOf = (element: Element) => {
  const { left, top, right, bottom } = element.getBoundingClientRect();
  return { left, top, right, bottom };
};

/**
 * Resting on a key the window draws, or focusing it, opens the task's
 * summary beside the surface the key is on; letting go closes it.
 */
export function useKeyRest(taskId: string): (anchor: HTMLElement | null) => void {
  const held = useRef<HTMLElement | null>(null);
  return (anchor) => {
    if (!anchor) {
      taskPeek.release(held.current);
      held.current = null;
      return;
    }
    held.current = anchor;
    taskPeek.set({
      taskId,
      anchor,
      key: boxOf(anchor),
      card: boxOf(anchor.closest(KEY_SURFACE) ?? anchor),
    });
  };
}

/**
 * A task key the window itself draws, as a link to that task (FI3-1271; the
 * design skill's core rule "Task keys"): resting on it or focusing it opens
 * the task's summary beside its card, as a card body's key does; a click or
 * Enter - only the captain's own - opens the task’s record,
 * leaving Settings first when the key is there.
 */
export function TaskKeyLink({
  task,
  children,
  look,
}: {
  task: TaskView;
  children: string;
  look?: TaskKeyLook;
}) {
  const rest = useKeyRest(task.id);
  const lit = useLitTaskId() === task.id;
  return (
    <TaskKey
      {...(look ? { look } : {})}
      lit={lit}
      onRest={rest}
      onOpen={(event) => {
        if (!event.nativeEvent.isTrusted) return;
        taskPeek.release(event.currentTarget);
        void openTaskFromKey(task).catch(() => {});
      }}
    >
      {children}
    </TaskKey>
  );
}

/**
 * The key in a card's head: the card's own task's key as its door to the
 * task's record (INF-358; the design skill's core rule "Task keys", "The
 * card's own key"). Resting on it opens the task's summary as any key does;
 * a click or Enter - only the captain's own - opens the record in front of
 * the card, never the task's waiting decision, which is this card, and Hide
 * or Esc on the record returns to the card (`openRecord` with `from`).
 */
export function CardTaskKey({
  task,
  cardId,
}: {
  task: Pick<TaskView, "id" | "key">;
  cardId: string;
}) {
  const rest = useKeyRest(task.id);
  const lit = useLitTaskId() === task.id;
  return (
    <TaskKey
      look="quiet"
      lit={lit}
      onRest={rest}
      onOpen={(event) => {
        if (!event.nativeEvent.isTrusted) return;
        taskPeek.release(event.currentTarget);
        useShellStore.getState().openRecord(task.id, { cardId });
      }}
    >
      {task.key}
    </TaskKey>
  );
}

/**
 * Words the window draws with every recorded task's key in them linked
 * (`TaskKeyLink`): a key that names no task stays text, and so does `own`'s,
 * the task whose record the words are on, since opening it would only bring
 * that record forward. A card passes no `own`: every key on a card links,
 * its own task's included, as the captain asked, so the same key never
 * reads as a link in one place and as text in another.
 */
export function KeyedText({
  text,
  own,
  look,
}: {
  text: string;
  /** The id of the task whose record this is; a card passes none. */
  own?: string | undefined;
  look?: TaskKeyLook;
}) {
  const links = useTaskLinks(text, own);
  return (
    <TaskKeyWords
      text={text}
      linkFor={(key) => {
        const task = links.task(key);
        return task ? (
          <TaskKeyLink task={task} {...(look ? { look } : {})}>
            {key}
          </TaskKeyLink>
        ) : undefined;
      }}
    />
  );
}
