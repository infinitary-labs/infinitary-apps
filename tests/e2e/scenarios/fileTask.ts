import type { Scenario } from "../mockProvider";

/** "file a task: <title>" makes the mock Firstmate put planned work on the record. */
export const FILE_TASK_PROMPT_MARKER = "file a task:";

/** The first mate files the named task with create_task, starting nothing. */
export const fileTask: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!isFirstmate || !wantsStream) return undefined;
    if (hasToolResults || !latestUserTail.includes(FILE_TASK_PROMPT_MARKER)) return undefined;
    const title =
      latestUserTail.match(/file a task: ([^"\\]+)/)?.[1]?.trim() ?? "Mock planned task";
    return {
      calls: [
        {
          name: "create_task",
          args: {
            title,
            goal: `Complete ${title}`,
            user_words: `${FILE_TASK_PROMPT_MARKER} ${title}`,
          },
        },
      ],
    };
  };
