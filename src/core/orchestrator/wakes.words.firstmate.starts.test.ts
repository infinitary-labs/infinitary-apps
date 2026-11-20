/**
 * The words of the first mate's wakes that `startWakes.ts` words, byte for
 * byte (INF-2625's plan, the wakes row; `tests/helpers/wakeWords.ts` says
 * why): starting work: a queued task starting or not, the captain's Start, a
 * wait that can never end or waits on a model or a computer, and a program's
 * bound and end.
 */
import {
  WAKE_AT as AT,
  type FirstmateStartWakeKind,
  pinWakeWords,
  WAKE_TASK as TASK,
  type WordsCases,
} from "../../../tests/helpers/wakeWords";

const CASES: WordsCases<FirstmateStartWakeKind> = {
  "program-bound": [
    {
      name: "its one wording",
      wake: { facts: { kind: "program-bound", task: TASK, key: "INF-2604", bound: 29, calls: 29 } },
      words:
        "[fm-op] the program on task INF-2604 \"Restructure the wakes file\" filed 29 parts and reached its bound of 29 task() calls: its next call is held and nothing more is filed. Ask the captain on a card whether it may go on, saying what has run and the new bound you propose; on the captain's words raise it with update_task program_bound, or drop the program. Soft hold program-bound: it passes when on the captain's words the crewmate that started it raises it with start_program, or the first mate with update_task program_bound.",
    },
    {
      // INF-3022, the captain's answer "crewmate-then-first-mate": its starter hears it first.
      name: "told to the crewmate that started it, whose task is open",
      wake: {
        facts: {
          kind: "program-bound",
          task: TASK,
          key: "INF-2604",
          bound: 29,
          calls: 29,
          to: "crewmate",
        },
      },
      words:
        'Your program INF-2604 "Restructure the wakes file" filed 29 parts and reached its bound of 29 task() calls: its next call is held and nothing more is filed. Ask the captain on a card whether it may go on, saying what has run and the new bound you propose; on their words raise it with start_program program and bound, or stop it with start_program program and stop.',
    },
  ],
  "program-ended": [
    {
      name: "stopped by an error",
      wake: {
        facts: {
          kind: "program-ended",
          task: TASK,
          key: "INF-2604",
          parts: 6,
          error: "task() was refused: the project is not set up",
        },
      },
      words:
        '[fm-op] the program on task INF-2604 "Restructure the wakes file" stopped after 6 parts: task() was refused: the project is not set up. Nothing more of it runs; tell the captain what stopped it.',
    },
    {
      name: "finished with a result and a branch",
      wake: {
        facts: {
          kind: "program-ended",
          task: TASK,
          key: "INF-2604",
          parts: 29,
          result: { files: 39, over: 0 },
          branch: "INF-2760",
        },
      },
      words:
        '[fm-op] the program on task INF-2604 "Restructure the wakes file" finished after 29 parts. Its result, as declared: {"files":39,"over":0} Its branch is INF-2760\'s last commit: work that ships it names INF-2760 in branch_from.',
    },
    {
      name: "finished with nothing returned",
      wake: { facts: { kind: "program-ended", task: TASK, key: "INF-2604", parts: 2 } },
      words:
        '[fm-op] the program on task INF-2604 "Restructure the wakes file" finished after 2 parts. Its script returned no branch, so there is nothing to ship.',
    },
  ],
  // A start the first mate asked for ended in a wait its tile does not name (INF-3060).
  "asked-start-waits": [
    {
      name: "its computer is out of reach",
      wake: {
        facts: {
          kind: "asked-start-waits",
          task: TASK,
          words: "It waits for Builder, which is out of reach. It never runs on this Mac instead.",
        },
      },
      words:
        '[fm-op] task 479823ee "Restructure the wakes file", which you started, has not started yet. It waits for Builder, which is out of reach. It never runs on this Mac instead.',
    },
  ],
  "queued-started": [
    {
      // A start behind the first mate's answer (INF-3060).
      name: "one the first mate started, on the model named",
      wake: {
        facts: {
          kind: "queued-started",
          task: TASK,
          model: { named: "claude-opus-5-5", took: "claude-opus-5-5" },
          asked: true,
        },
      },
      words:
        '[fm-op] task 479823ee "Restructure the wakes file", which you started, is running now, on claude-opus-5-5.',
    },
    {
      name: "on the model named",
      wake: {
        facts: {
          kind: "queued-started",
          task: TASK,
          model: { named: "claude-opus-5-5", took: "claude-opus-5-5" },
        },
      },
      words:
        '[fm-op] queued task 479823ee "Restructure the wakes file" started - its wait ended. A crewmate is working on it now, on claude-opus-5-5.',
    },
    {
      name: "with no model",
      wake: { facts: { kind: "queued-started", task: TASK } },
      words:
        '[fm-op] queued task 479823ee "Restructure the wakes file" started - its wait ended. A crewmate is working on it now.',
    },
  ],
  "queued-start-failed": [
    {
      // A start behind the first mate's answer (INF-3060).
      name: "one the first mate started",
      wake: {
        facts: {
          kind: "queued-start-failed",
          task: TASK,
          error: "no account can run it",
          asked: true,
        },
      },
      words:
        '[fm-op] task 479823ee "Restructure the wakes file", which you started, could not start: no account can run it',
    },
    {
      // Still open, waiting for its go (the captain's answer on INF-3075's review).
      name: "one the first mate started, still open",
      wake: {
        facts: {
          kind: "queued-start-failed",
          task: TASK,
          error: "No eligible account can serve the selected model now.",
          asked: true,
          open: true,
        },
      },
      words:
        '[fm-op] task 479823ee "Restructure the wakes file", which you started, could not start: No eligible account can serve the selected model now. It is still open with nothing running, so spawn no replacement: update_task start_now tries it again, or update_task drop removes it.',
    },
    {
      name: "on the captain's Start",
      wake: {
        facts: {
          kind: "queued-start-failed",
          task: TASK,
          error: "no account can run it",
          by: "captain",
        },
      },
      words:
        '[fm-op] the captain pressed Start on task 479823ee "Restructure the wakes file", and it could not start: no account can run it',
    },
    {
      name: "on its own wait",
      wake: { facts: { kind: "queued-start-failed", task: TASK, error: "no account can run it" } },
      words:
        '[fm-op] queued task 479823ee "Restructure the wakes file" could not start: no account can run it',
    },
  ],
  "captain-start": [
    {
      name: "start",
      wake: {
        facts: {
          kind: "captain-start",
          task: { ...TASK, key: "INF-2696" },
          move: "start",
          at: AT,
          from: "task-card",
        },
      },
      words:
        '[fm-op] the captain pressed Start on task 479823ee INF-2696 "Restructure the wakes file". It shows Starting and waits for you. Apply every standing direction that bears on it with update_task (merging, delivery, care, model, runs_on), passing direction with each direction\'s id, then update_task start_now. Never decline their Start; if no direction applies, just start_now.',
    },
    {
      name: "queue",
      wake: {
        facts: { kind: "captain-start", task: { ...TASK, key: "INF-2696" }, move: "queue", at: AT },
      },
      words:
        '[fm-op] the captain queued task 479823ee INF-2696 "Restructure the wakes file". Apply every standing direction that bears on it with update_task (merging, delivery, care, model, runs_on), passing direction with each direction\'s id. Do not start it: the host starts it when its wait ends.',
    },
  ],
  "dead-gate": [
    {
      name: "its one wording",
      wake: {
        facts: {
          kind: "dead-gate",
          task: { id: "b9299a73", key: "INF-2697", title: "Restructure the first mate files" },
          blocker: { ...TASK, key: "INF-2696" },
          closed: "dropped",
        },
      },
      words:
        '[fm-op] queued task b9299a73 INF-2697 "Restructure the first mate files" waits on INF-2696 "Restructure the wakes file", which was dropped, so its wait can never end; the dead edge is blocks INF-2696 -> INF-2697.',
    },
  ],
  "reasoning-wait": [
    {
      name: "a class no model sits in",
      wake: {
        facts: {
          kind: "reasoning-wait",
          task: TASK,
          requested: "premium",
          served: "high",
          empty: true,
        },
      },
      words:
        '[fm-op] task 479823ee "Restructure the wakes file" needs a premium model and no model is placed at premium, so no quota reset will start it; it waits until one is placed at premium in Settings → Intelligence → Models unless you say otherwise, and a high model could serve it now.',
    },
    {
      name: "a class whose models read text only, for a task with pictures",
      wake: {
        facts: {
          kind: "reasoning-wait",
          task: TASK,
          requested: "premium",
          served: "high",
          pictures: true,
        },
      },
      words:
        '[fm-op] task 479823ee "Restructure the wakes file" needs a premium model and none there reads the pictures it carries, so no quota reset will start it; it waits until a model that reads pictures is placed at premium in Settings → Intelligence → Models unless you say otherwise, and a high model could serve it now.',
    },
    {
      name: "a class out of quota",
      wake: { facts: { kind: "reasoning-wait", task: TASK, requested: "high" } },
      words:
        '[fm-op] task 479823ee "Restructure the wakes file" needs a high model and none has quota right now; it waits on the high quota reset unless you say otherwise, and the default model could serve it now.',
    },
  ],
  "system-wait": [
    {
      name: "its one wording",
      wake: {
        facts: {
          kind: "system-wait",
          task: { ...TASK, key: "INF-2696" },
          required: ["linux"],
          computers: [
            { name: "This Mac", system: "macos" },
            { name: "Studio", system: "macos" },
          ],
        },
      },
      words:
        '[fm-op] queued task 479823ee INF-2696 "Restructure the wakes file" requires Linux, and no computer runs it: This Mac runs macOS, Studio runs macOS. No room or reading ends this wait: it starts once a computer that runs Linux is paired and in reach, or once what it requires changes (update_task placement_requirements).',
    },
  ],
  "named-model-wait": [
    {
      name: "its one wording",
      wake: {
        facts: {
          kind: "named-model-wait",
          task: { ...TASK, key: "INF-2696" },
          model: "claude-fable-5-2",
        },
      },
      words:
        '[fm-op] queued task 479823ee INF-2696 "Restructure the wakes file" was asked to run on claude-fable-5-2, and no computer it may run on serves it now, as far as their models could be read, so it waits instead of starting on another model. Ask the captain on a card whether to keep waiting for claude-fable-5-2, such as until they sign in to it on a computer, or to run it on another model: on their words, update_task override_model_id names the model they choose, or clears it with an empty value so the app picks, with start_now.',
    },
  ],
  "computer-left-out": [
    {
      name: "a widened chip and system, waiting",
      wake: {
        facts: {
          kind: "computer-left-out",
          task: { ...TASK, key: "INF-2696" },
          project: { id: "b3483155", name: "infinitary" },
          computer: { name: "Builder", system: "linux", chip: "x64" },
          reasons: [
            { kind: "system", runs: "linux", heldTo: ["macos"] },
            { kind: "chip", runs: "x64", heldTo: ["arm64"], heldOn: "macos" },
          ],
          widened: { systems: ["macos", "linux"], chips: ["arm64", "x64"] },
        },
      },
      words:
        '[fm-op] Automatic left Builder out of project "infinitary" when it compared computers for task 479823ee INF-2696 "Restructure the wakes file": Builder runs Linux, and neither the project nor the task declares a system, so the task was held to this computer\'s macOS; Builder runs on Intel or AMD (x64), and neither the project nor the task declares a chip, so the task was held to this computer\'s Apple silicon (arm64). The task waits. No room or reading changes this. Ask the captain once whether Builder may run this project\'s tasks: propose app_change project-settings for b3483155 with changes {"placementRequirements":{"systems":["macos","linux"],"chips":["arm64","x64"]}}, without on_words and with this wake as evidence, so the app\'s exact-change card asks them with Apply change as its default. Never apply it on your own judgment. Runs on stays Automatic, a started task stays where it is, and the project\'s next tasks compare Builder equally. You hear this once for this project, computer and reason.',
    },
    {
      name: "missing programs and no access, taken elsewhere",
      wake: {
        facts: {
          kind: "computer-left-out",
          task: { ...TASK, key: "INF-2696" },
          project: { id: "b3483155", name: "infinitary" },
          computer: { name: "Builder" },
          took: "This Mac",
          reasons: [{ kind: "programs", missing: ["pnpm", "xcodebuild"] }, { kind: "project" }],
        },
      },
      words:
        '[fm-op] Automatic left Builder out of project "infinitary" when it compared computers for task 479823ee INF-2696 "Restructure the wakes file": Builder does not have pnpm, xcodebuild, which this project\'s tasks require; Builder cannot reach where the project lives. This Mac took the task. No room or reading changes this. Builder takes them once pnpm, xcodebuild is installed there. Builder takes them once it can reach the project, such as by signing in there to where the project lives. You hear this once for this project, computer and reason.',
    },
  ],
};

pinWakeWords("the first mate's start wakes, byte for byte", CASES);
