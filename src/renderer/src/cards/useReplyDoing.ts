import type { Card, CardMessage } from "@shared/cards";
import { nowOf } from "@shared/taskFacts";
import type { TaskDetail } from "@shared/tasks";
import { useEffect, useState } from "react";
import { appReadExecutor } from "../plugins/reads/appExecutor";

/**
 * What the crewmate is doing on the captain's reply, from its task record:
 * its Now line (`nowOf`, docs/task-record.md "The Now line") when that
 * doing came at or after the captain's newest line on the thread, else
 * nothing - a doing from before the reply is not work on it (INF-990
 * friction 3).
 */
export function replyDoing(
  detail: Pick<TaskDetail, "activityLog" | "said"> | undefined,
  messages: readonly CardMessage[],
): string | undefined {
  const asked = messages.findLast((message) => message.who === "captain");
  if (!detail || !asked) return undefined;
  const now = nowOf(detail.activityLog, detail.said ?? null);
  return now && now.at >= asked.at ? now.text : undefined;
}

/**
 * The working row's doing for a crewmate's card while its turn runs, read
 * live off the task record (`tasks.detail`, which re-reads on each of the
 * crewmate's calls). Nothing is read while the author is not working, or
 * on a card that is not a crewmate's.
 */
export function useReplyDoing(
  card: Pick<Card, "author" | "taskId">,
  messages: readonly CardMessage[],
  working: boolean,
): string | undefined {
  const taskId = card.author === "crewmate" && working ? card.taskId : undefined;
  const [read, setRead] = useState<{ id: string; detail: TaskDetail }>();
  useEffect(() => {
    if (!taskId) return;
    return appReadExecutor().subscribe(
      "tasks.detail",
      { id: taskId },
      {
        onValue: (value) => setRead({ id: taskId, detail: value as TaskDetail }),
        onError: () => {},
      },
    );
  }, [taskId]);
  return taskId && read?.id === taskId ? replyDoing(read.detail, messages) : undefined;
}
