/**
 * The words of the first mate's wakes no family file beside this one holds,
 * byte for byte (INF-2625's plan, the wakes row; `tests/helpers/wakeWords.ts`
 * says why): the captain's own turn, a settle's outcome and a job past its
 * bound. Each wake family's first mate kinds are in
 * `wakes.words.firstmate.<family>.test.ts`, and the crewmate's wakes in
 * `wakes.words.crewmate.test.ts`.
 */
import {
  type FirstmateOtherWakeKind,
  WAKE_PICTURE as PICTURE,
  pinWakeWords,
  WAKE_TASK as TASK,
  type WordsCases,
} from "../../../tests/helpers/wakeWords";

const CASES: WordsCases<FirstmateOtherWakeKind> = {
  "job-bound": [
    {
      name: "its one wording",
      wake: {
        facts: {
          kind: "job-bound",
          task: TASK,
          jobId: "j-9",
          command: "pnpm vitest run src/core/orchestrator",
          runMs: 7_560_000,
        },
      },
      words:
        '[fm-op] task 479823ee "Restructure the wakes file" has had a background job running for 2.1 hours: "pnpm vitest run src/core/orchestrator". It no longer counts as the task moving, so the idle ladder now watches the task; the job itself keeps running.',
    },
  ],
  settled: [
    {
      name: "merged",
      wake: {
        facts: {
          kind: "settled",
          task: TASK,
          chose: "merge",
          outcome: "merged pull request #1061",
        },
      },
      words:
        '[fm-op] the captain chose merge for task 479823ee "Restructure the wakes file"; the host settled it and the outcome was: merged pull request #1061',
    },
    {
      name: "refused",
      wake: {
        facts: {
          kind: "settled",
          task: TASK,
          chose: "merge",
          outcome: "refused",
          refusal: {
            refused: "children-open",
            task: { id: TASK.id, key: "INF-2696", title: TASK.title },
            tasks: [{ id: "c1d2e3f4", key: "INF-2760", title: "Continue: split wakes.ts" }],
            ways: [
              {
                label: "Close with its children planned",
                tool: "settle_task",
                args: { task_id: TASK.id, proceed_with_open: true },
              },
            ],
            text: "INF-2696 has open children.",
          },
        },
      },
      words:
        '[fm-op] the captain chose merge for task 479823ee "Restructure the wakes file"; the host settled it and the outcome was: refused\n```json\n{\n  "refused": "children-open",\n  "task": {\n    "id": "479823ee",\n    "key": "INF-2696",\n    "title": "Restructure the wakes file"\n  },\n  "tasks": [\n    {\n      "id": "c1d2e3f4",\n      "key": "INF-2760",\n      "title": "Continue: split wakes.ts"\n    }\n  ],\n  "ways": [\n    {\n      "label": "Close with its children planned",\n      "tool": "settle_task",\n      "args": {\n        "task_id": "479823ee",\n        "proceed_with_open": true\n      }\n    }\n  ],\n  "text": "INF-2696 has open children."\n}\n```',
    },
  ],
  "captain-turn": [
    {
      name: "pictures dropped",
      wake: {
        facts: {
          kind: "captain-turn",
          words: "Approve and build",
          imagesDropped: true,
          attachments: [PICTURE],
          askId: "ask-9",
        },
      },
      words: "[user]\nApprove and build\n\n[image attachments could not be kept - ask to resend]",
    },
    {
      name: "plain",
      wake: {
        facts: {
          kind: "captain-turn",
          words: "What is left on the wakes split?",
          imagesDropped: false,
        },
      },
      words: "[user]\nWhat is left on the wakes split?",
    },
  ],
};

pinWakeWords("the first mate's other wakes, byte for byte", CASES);
