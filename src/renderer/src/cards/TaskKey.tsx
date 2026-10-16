import type { TaskView } from "@shared/tasks";
import { useRef } from "react";
import { TaskKey, type TaskKeyLook, TaskKeyWords } from "../design/panel/TaskKey";
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
 * A task key the window itself draws, as a link to that task (FI3-1271; the
 * design skill's core rule "Task keys"): resting on it or focusing it opens
 * the task's summary beside its card, as a card body's key does; a click or
 * Enter - only the captain's own - opens the task as its Tasks row does,
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
  const held = useRef<HTMLElement | null>(null);
  return (
    <TaskKey
      {...(look ? { look } : {})}
      onRest={(anchor) => {
        if (!anchor) {
          taskPeek.release(held.current);
          held.current = null;
          return;
        }
        held.current = anchor;
        taskPeek.set({
          taskId: task.id,
          anchor,
          key: boxOf(anchor),
          card: boxOf(anchor.closest(KEY_SURFACE) ?? anchor),
        });
      }}
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
 * Words the window draws with every recorded task's key in them linked
 * (`TaskKeyLink`): a key that names no task stays text, and so does `own`'s,
 * the task whose card or record the words are on - a task's own key on its
 * own card stays text, as the captain asked.
 */
export function KeyedText({
  text,
  own,
  look,
}: {
  text: string;
  /** The id of the task whose card or record this is. */
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
