/**
 * The words of the first mate's wakes that `idleWakes.ts` words, byte for byte
 * (INF-2625's plan, the wakes row; `tests/helpers/wakeWords.ts` says why): the
 * idle ladder, with a crewmate left idle or stalled, an ask the first mate has
 * not acted on, and a task held for the captain with no card up.
 */
import {
  type FirstmateIdleWakeKind,
  pinWakeWords,
  WAKE_TASK as TASK,
  type WordsCases,
} from "../../../tests/helpers/wakeWords";
import { crewHoldWays, idleStallWays } from "./holds";

const CASES: WordsCases<FirstmateIdleWakeKind> = {
  "idle-stall": [
    {
      name: "nothing up, nudged, its repeat, after a report",
      wake: {
        facts: {
          kind: "idle-stall",
          task: TASK,
          crewmate: "crewmate 61",
          key: "INF-2696",
          idleMs: 2_700_000,
          thread: false,
          nudged: true,
          wakes: 2,
          last: { kind: "report", excerpt: "Pushed the guardrail branch." },
        },
        ways: idleStallWays(TASK.id),
      },
      words:
        '[fm-op] crewmate 61 on task 479823ee "Restructure the wakes file" has been idle for 45m with nothing running, nothing queued and no card up; the host\'s nudge did not move it. This is the second time: if nothing is done about it in 30 minutes, the host puts it to the captain on a card of its own. Its last report: Pushed the guardrail branch.\n```json\n{\n  "held": "idle-stall",\n  "task": {\n    "id": "479823ee",\n    "title": "Restructure the wakes file"\n  },\n  "ways": [\n    {\n      "label": "Tell it what to do next",\n      "tool": "steer_crewmate",\n      "args": {\n        "task_id": "479823ee"\n      },\n      "hold": "waits",\n      "basis": "record",\n      "approach": "workaround",\n      "needsConsent": false\n    },\n    {\n      "label": "Park it in the backlog until something changes",\n      "tool": "update_task",\n      "args": {\n        "task": "479823ee",\n        "start_policy": "on-request"\n      },\n      "hold": "waits",\n      "basis": "record",\n      "approach": "workaround",\n      "needsConsent": false\n    },\n    {\n      "label": "Hold it until its wait ends",\n      "tool": "update_task",\n      "args": {\n        "task": "479823ee",\n        "hold": {\n          "until": "<ISO time>",\n          "reason": "<what it waits for>"\n        }\n      },\n      "hold": "waits",\n      "basis": "record",\n      "approach": "workaround",\n      "needsConsent": false\n    },\n    {\n      "label": "Drop task",\n      "tool": "interrupt_crewmate",\n      "args": {\n        "task_id": "479823ee",\n        "mode": "cancel"\n      },\n      "hold": "asks-first",\n      "basis": "consent",\n      "approach": "pass-hold",\n      "needsConsent": true\n    },\n    {\n      "label": "Discard the work",\n      "tool": "settle_task",\n      "args": {\n        "task_id": "479823ee",\n        "mode": "discard"\n      },\n      "hold": "asks-first",\n      "basis": "consent",\n      "approach": "pass-hold",\n      "needsConsent": true\n    }\n  ]\n}\n```',
    },
    {
      name: "a thread naming its cards, with no runtime, after a failure",
      wake: {
        facts: {
          kind: "idle-stall",
          task: TASK,
          key: "INF-2696",
          idleMs: 1_500_000,
          thread: true,
          waiting: [{ id: "card-a", title: "Guardrails ready" }],
          nudged: false,
          wakes: 1,
          last: { kind: "failed", excerpt: "failed: the provider refused the request" },
        },
        ways: idleStallWays(TASK.id),
      },
      words:
        '[fm-op] the crewmate on INF-2696 on task 479823ee "Restructure the wakes file" has been idle for 25m since the captain wrote under card "Guardrails ready" (card-a), without answering them, and nothing queued will. Its last turn failed: the provider refused the request\n```json\n{\n  "held": "idle-stall",\n  "task": {\n    "id": "479823ee",\n    "title": "Restructure the wakes file"\n  },\n  "ways": [\n    {\n      "label": "Tell it what to do next",\n      "tool": "steer_crewmate",\n      "args": {\n        "task_id": "479823ee"\n      },\n      "hold": "waits",\n      "basis": "record",\n      "approach": "workaround",\n      "needsConsent": false\n    },\n    {\n      "label": "Park it in the backlog until something changes",\n      "tool": "update_task",\n      "args": {\n        "task": "479823ee",\n        "start_policy": "on-request"\n      },\n      "hold": "waits",\n      "basis": "record",\n      "approach": "workaround",\n      "needsConsent": false\n    },\n    {\n      "label": "Hold it until its wait ends",\n      "tool": "update_task",\n      "args": {\n        "task": "479823ee",\n        "hold": {\n          "until": "<ISO time>",\n          "reason": "<what it waits for>"\n        }\n      },\n      "hold": "waits",\n      "basis": "record",\n      "approach": "workaround",\n      "needsConsent": false\n    },\n    {\n      "label": "Drop task",\n      "tool": "interrupt_crewmate",\n      "args": {\n        "task_id": "479823ee",\n        "mode": "cancel"\n      },\n      "hold": "asks-first",\n      "basis": "consent",\n      "approach": "pass-hold",\n      "needsConsent": true\n    },\n    {\n      "label": "Discard the work",\n      "tool": "settle_task",\n      "args": {\n        "task_id": "479823ee",\n        "mode": "discard"\n      },\n      "hold": "asks-first",\n      "basis": "consent",\n      "approach": "pass-hold",\n      "needsConsent": true\n    }\n  ]\n}\n```',
    },
    {
      name: "a thread naming none",
      wake: {
        facts: {
          kind: "idle-stall",
          task: TASK,
          crewmate: "crewmate 61",
          key: "INF-2696",
          idleMs: 1_500_000,
          thread: true,
          nudged: true,
          wakes: 1,
        },
      },
      words:
        '[fm-op] crewmate 61 on task 479823ee "Restructure the wakes file" has been idle for 25m since the captain wrote under its card, without answering them, and nothing queued will; the host\'s nudge did not move it.\n```json\n{\n  "held": "idle-stall",\n  "task": {\n    "id": "479823ee",\n    "title": "Restructure the wakes file"\n  },\n  "ways": []\n}\n```',
    },
    {
      name: "a reported wait with an end, which took no nudge",
      wake: {
        facts: {
          kind: "idle-stall",
          task: TASK,
          crewmate: "crewmate 61",
          key: "INF-2696",
          idleMs: 1_200_000,
          thread: false,
          nudged: false,
          wait: {
            owner: "INF-2697",
            end: "INF-2697 merges",
            observation: "INF-2697's batch is waiting for its checks",
            cheapestWay: "None: the batch merges it",
          },
          wakes: 1,
          last: { kind: "report", excerpt: "Waiting for INF-2697 to merge." },
        },
        ways: idleStallWays(TASK.id),
      },
      words:
        '[fm-op] crewmate 61 on task 479823ee "Restructure the wakes file" has been idle for 20m with nothing running, nothing queued and no card up; it reported a wait with an end, so the host did not nudge it. Work wait: {"owner":"INF-2697","end":"INF-2697 merges","observation":"INF-2697\'s batch is waiting for its checks","cheapestWay":"None: the batch merges it"}. Its last report: Waiting for INF-2697 to merge.\n```json\n{\n  "held": "idle-stall",\n  "task": {\n    "id": "479823ee",\n    "title": "Restructure the wakes file"\n  },\n  "ways": [\n    {\n      "label": "Tell it what to do next",\n      "tool": "steer_crewmate",\n      "args": {\n        "task_id": "479823ee"\n      },\n      "hold": "waits",\n      "basis": "record",\n      "approach": "workaround",\n      "needsConsent": false\n    },\n    {\n      "label": "Park it in the backlog until something changes",\n      "tool": "update_task",\n      "args": {\n        "task": "479823ee",\n        "start_policy": "on-request"\n      },\n      "hold": "waits",\n      "basis": "record",\n      "approach": "workaround",\n      "needsConsent": false\n    },\n    {\n      "label": "Hold it until its wait ends",\n      "tool": "update_task",\n      "args": {\n        "task": "479823ee",\n        "hold": {\n          "until": "<ISO time>",\n          "reason": "<what it waits for>"\n        }\n      },\n      "hold": "waits",\n      "basis": "record",\n      "approach": "workaround",\n      "needsConsent": false\n    },\n    {\n      "label": "Drop task",\n      "tool": "interrupt_crewmate",\n      "args": {\n        "task_id": "479823ee",\n        "mode": "cancel"\n      },\n      "hold": "asks-first",\n      "basis": "consent",\n      "approach": "pass-hold",\n      "needsConsent": true\n    },\n    {\n      "label": "Discard the work",\n      "tool": "settle_task",\n      "args": {\n        "task_id": "479823ee",\n        "mode": "discard"\n      },\n      "hold": "asks-first",\n      "basis": "consent",\n      "approach": "pass-hold",\n      "needsConsent": true\n    }\n  ]\n}\n```',
    },
    {
      name: "a note up",
      wake: {
        facts: {
          kind: "idle-stall",
          task: TASK,
          crewmate: "crewmate 61",
          key: "INF-2696",
          idleMs: 1_500_000,
          thread: false,
          nudged: true,
          wakes: 1,
          note: { id: "card-n", title: "Coverage measured" },
        },
        ways: idleStallWays(TASK.id),
      },
      words:
        '[fm-op] crewmate 61 on task 479823ee "Restructure the wakes file" has been idle for 25m with nothing running, nothing queued and only the note "Coverage measured" (card-n) up, which asks the captain nothing; the host\'s nudge did not move it. If that note is its outcome, steer it to report waiting on the captain naming the note, never to post it again.\n```json\n{\n  "held": "idle-stall",\n  "task": {\n    "id": "479823ee",\n    "title": "Restructure the wakes file"\n  },\n  "ways": [\n    {\n      "label": "Tell it what to do next",\n      "tool": "steer_crewmate",\n      "args": {\n        "task_id": "479823ee"\n      },\n      "hold": "waits",\n      "basis": "record",\n      "approach": "workaround",\n      "needsConsent": false\n    },\n    {\n      "label": "Park it in the backlog until something changes",\n      "tool": "update_task",\n      "args": {\n        "task": "479823ee",\n        "start_policy": "on-request"\n      },\n      "hold": "waits",\n      "basis": "record",\n      "approach": "workaround",\n      "needsConsent": false\n    },\n    {\n      "label": "Hold it until its wait ends",\n      "tool": "update_task",\n      "args": {\n        "task": "479823ee",\n        "hold": {\n          "until": "<ISO time>",\n          "reason": "<what it waits for>"\n        }\n      },\n      "hold": "waits",\n      "basis": "record",\n      "approach": "workaround",\n      "needsConsent": false\n    },\n    {\n      "label": "Drop task",\n      "tool": "interrupt_crewmate",\n      "args": {\n        "task_id": "479823ee",\n        "mode": "cancel"\n      },\n      "hold": "asks-first",\n      "basis": "consent",\n      "approach": "pass-hold",\n      "needsConsent": true\n    },\n    {\n      "label": "Discard the work",\n      "tool": "settle_task",\n      "args": {\n        "task_id": "479823ee",\n        "mode": "discard"\n      },\n      "hold": "asks-first",\n      "basis": "consent",\n      "approach": "pass-hold",\n      "needsConsent": true\n    }\n  ]\n}\n```',
    },
  ],
  "idle-asked": [
    {
      name: "a request, its first reminder, with work built on it",
      wake: {
        facts: {
          kind: "idle-asked",
          task: TASK,
          crewmate: "crewmate 61",
          key: "INF-2696",
          request: "merge pull request #1061 under the restructure direction",
          askedMs: 1_800_000,
          wakes: 2,
          builtOn: [
            {
              key: "INF-2697",
              title: "Restructure the first mate files",
              status: "done",
              closedReason: "merged",
              change: "#1064",
            },
            { key: "INF-2760", title: "Continue: split wakes.ts", status: "open" },
          ],
          last: { kind: "report", excerpt: "Every check passed." },
        },
      },
      words:
        '[fm-op] crewmate 61 on task 479823ee "Restructure the wakes file" asked you 30m ago to act: merge pull request #1061 under the restructure direction. You have not acted on that task since: no steer, card or change to it, and no task built on it or under it was created or started. Work built on this task, open or closed: INF-2697 "Restructure the first mate files" (done: merged, #1064), INF-2760 "Continue: split wakes.ts" (open). If nothing is done about it in 30 minutes, you are reminded once more. The ask authorizes nothing by itself; the captain\'s own words do. Act on it, or steer the crewmate to tell it why not. Its report: Every check passed.',
    },
    {
      name: "finished, its last reminder, with no runtime",
      wake: {
        facts: {
          kind: "idle-asked",
          task: TASK,
          key: "INF-2696",
          finished: true,
          askedMs: 3_600_000,
          wakes: 3,
          last: { kind: "failed", excerpt: "failed: the provider refused the request" },
        },
      },
      words:
        '[fm-op] the crewmate on INF-2696 on task 479823ee "Restructure the wakes file" declared its work finished 1h ago with no card of its own up, so nothing is left for it and it is not nudged. You have not acted on that task since: no steer, card or change to it, and no task built on it or under it was created or started. This is the last reminder: nothing more is sent about it, and its crew line says it is stalled. Close the task if the record bears that out, or steer the crewmate with what is still missing.',
    },
  ],
  "backlog-news": [
    {
      // INF-3143, direction A: one wake when a parked task gets news.
      name: "a check's result reached a parked task",
      wake: {
        facts: {
          kind: "backlog-news",
          task: TASK,
          waitedMs: 7_200_000,
          news: "Every check on your pull request passed.",
        },
      },
      words:
        '[fm-op] task 479823ee "Restructure the wakes file" has waited in the backlog for 2h, and news from the app reached it there; its crewmate hears it only once it starts again. If the news means it can move, start it with update_task start_now; otherwise leave it parked. You are told this once per stay in the backlog. The news: Every check on your pull request passed.',
    },
  ],
  "next-move": [
    {
      // INF-3846 piece 2: an open part of begun work nobody started.
      name: "a part waits on request under a parent where work started",
      wake: {
        facts: {
          kind: "next-move",
          task: TASK,
          key: "INF-12",
          stands: "on-request",
          begun: {
            why: "part",
            task: { id: "c2d8e1a0", key: "INF-10", title: "Move secrets behind one owner" },
          },
          standingMs: 3_600_000,
        },
      },
      words:
        '[fm-op] task INF-12 "Restructure the wakes file" is begun work (it is a part of INF-10 "Move secrets behind one owner", where work has started), and nothing will move it: it has waited on request for 1h for a start nobody has given, no card of it asks the captain anything, and no stop from the captain is recorded on it. Begun work is always moving, waiting on the captain with a card up, or stopped by the captain. First read its history with tasks: if the captain asked for it to wait, record that with update_task captain_stop true and leave it. Otherwise give it a next move: start it with update_task start_now, or start_policy when-ready to start once nothing holds it; put what holds it to the captain on a card naming it in task_id or related; or drop it with update_task drop and a reason if it is no longer needed. You are told this once: if it still stands after this turn, the app shows the captain one card about it.',
    },
    {
      name: "started work went back to the backlog",
      wake: {
        facts: {
          kind: "next-move",
          task: TASK,
          key: "INF-12",
          stands: "backlog",
          begun: { why: "started" },
          standingMs: 900_000,
        },
      },
      words:
        '[fm-op] task INF-12 "Restructure the wakes file" is begun work (it started before), and nothing will move it: it went back to the backlog 15m ago and waits there for a start, no card of it asks the captain anything, and no stop from the captain is recorded on it. Begun work is always moving, waiting on the captain with a card up, or stopped by the captain. First read its history with tasks: if the captain asked for it to wait, record that with update_task captain_stop true and leave it. Otherwise give it a next move: start it with update_task start_now; put what holds it to the captain on a card naming it in task_id or related; or drop it with update_task drop and a reason if it is no longer needed. You are told this once: if it still stands after this turn, the app shows the captain one card about it.',
    },
  ],
  "idle-owed": [
    {
      name: "a captain gate with its reason, its repeat",
      wake: {
        facts: {
          kind: "idle-owed",
          held: "captain-gate",
          task: TASK,
          reason: "approve the validation plan",
          idleMs: 2_400_000,
          wakes: 2,
        },
        ways: crewHoldWays(TASK.id),
      },
      words:
        '[fm-op] task 479823ee "Restructure the wakes file" is held for the captain (its crewmate waits on them to approve the validation plan) and has had no card up for 40m: its crewmate cannot move until the captain answers one. This is the second time: if nothing is done about it in 30 minutes, the host puts it to the captain on a card of its own.\n```json\n{\n  "held": "captain-gate",\n  "task": {\n    "id": "479823ee",\n    "title": "Restructure the wakes file"\n  },\n  "ways": [\n    {\n      "label": "Retry with the captain\'s guidance",\n      "tool": "steer_crewmate",\n      "args": {\n        "task_id": "479823ee"\n      },\n      "hold": "asks-first",\n      "basis": "consent",\n      "approach": "pass-hold",\n      "needsConsent": true\n    },\n    {\n      "label": "Try a premium model",\n      "tool": "spawn_crewmate",\n      "args": {\n        "shape": {\n          "escalate_from": "479823ee",\n          "premium_ask": true\n        }\n      },\n      "hold": "asks-first",\n      "basis": "consent",\n      "approach": "pass-hold",\n      "needsConsent": true\n    },\n    {\n      "label": "Discard the work",\n      "tool": "settle_task",\n      "args": {\n        "task_id": "479823ee",\n        "mode": "discard"\n      },\n      "hold": "asks-first",\n      "basis": "consent",\n      "approach": "pass-hold",\n      "needsConsent": true\n    }\n  ]\n}\n```',
    },
    {
      name: "a captain gate with no reason",
      wake: {
        facts: {
          kind: "idle-owed",
          held: "captain-gate",
          task: TASK,
          idleMs: 1_200_000,
          wakes: 1,
        },
      },
      words:
        '[fm-op] task 479823ee "Restructure the wakes file" is held for the captain and has had no card up for 20m: its crewmate cannot move until the captain answers one.\n```json\n{\n  "held": "captain-gate",\n  "task": {\n    "id": "479823ee",\n    "title": "Restructure the wakes file"\n  },\n  "ways": []\n}\n```',
    },
  ],
};

pinWakeWords("the first mate's idle ladder wakes, byte for byte", CASES);
