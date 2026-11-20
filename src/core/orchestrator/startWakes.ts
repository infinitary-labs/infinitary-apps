/**
 * Starting work: a queued task starting or not, the captain's Start, a
 * wait that can never end or waits on a model or a computer, and a
 * program's bound and end.
 *
 * The wake envelope, `renderWake` and `WAKE_WORDS`, the map of every
 * kind's words, are in `wakes.ts`.
 */

import { chipWords, HERE, SYSTEM_WORDS } from "@shared/deviceNames";
import type { DeviceChip, DeviceSystem } from "@shared/devices";
import { softHoldWords } from "@shared/holds";
import type { PlacementRequirements, WorkSystem } from "@shared/placement";
import type { LeftOut, LeftOutReason } from "../routing/placementEngine";
import { RESULT_WORDS, resultText } from "../tasks/taskResult";
import { type NamedModel, namedModelWords } from "./namedModel";
import type { KindWords, TypedWake, WakeFacts, WakeKeyedTask, WakeTask } from "./wakes";

/** The facts of starting work. */
export type StartFacts =
  | {
      /**
       * A program's next task() call reached the bound the first mate
       * proposed and is held, nothing filed (INF-799 piece 2; the
       * `program-bound` hold): the captain's word raises it.
       */
      kind: "program-bound";
      task: WakeTask;
      key: string;
      bound: number;
      /** The parts it filed so far. */
      calls: number;
      /** Told to the crewmate that started it, whose task is open (INF-3022). */
      to?: "crewmate";
    }
  | {
      /**
       * A program's script ended (INF-799 piece 2): its typed result and the
       * part its script returned as its branch, or why it stopped.
       */
      kind: "program-ended";
      task: WakeTask;
      key: string;
      parts: number;
      error?: string;
      result?: unknown;
      /** The part, by key, whose saved work a shipping task branches from. */
      branch?: string;
    }
  | {
      /**
       * A queued task's wait ended and a crewmate started on it. A start
       * someone asked for - the Firstmate's start_now, the captain's Start -
       * raises none (FI3-695).
       */
      kind: "queued-started";
      task: WakeTask;
      /** The model the user named and the one that took the task (FI3-444). */
      model?: NamedModel;
      /**
       * A start the first mate asked for, answered before it ran
       * (INF-3060): its wake says only which model took it.
       */
      asked?: true;
    }
  | {
      /** A queued task's start failed; `by` is the captain when he pressed Start. */
      kind: "queued-start-failed";
      task: WakeTask;
      error: string;
      by?: "captain";
      /** A start the first mate asked for, answered before it ran (INF-3060). */
      asked?: true;
      /** That task is still open, waiting for update_task start_now or a drop. */
      open?: true;
    }
  | {
      /**
       * A start the first mate asked for, answered before it ran (INF-3060),
       * ended in a wait its task's tile does not name: `words` say it.
       */
      kind: "asked-start-waits";
      task: WakeTask;
      words: string;
    }
  | {
      /**
       * The captain moved a task toward starting (Start, a drag to Working,
       * or a drag to Queued): his standing directions apply to it before a
       * crewmate begins. `start` is held as Starting until the turn that
       * reads this starts it; `queue` only asks for the directions, and the
       * host starts the task when its wait ends. `at` tells one press from
       * the next.
       */
      kind: "captain-start";
      task: WakeKeyedTask;
      move: "start" | "queue";
      at: number;
      /** Where the press came from, so the history still records it as his. */
      from?: "task-card";
      panel?: string;
    }
  | {
      /** A queued task waits on a task that closed without finishing. */
      kind: "dead-gate";
      task: WakeKeyedTask;
      blocker: WakeKeyedTask;
      /** How the blocker closed. */
      closed: string;
    }
  | {
      /** The ask-first wake: a reasoning class no model can serve now. */
      kind: "reasoning-wait";
      task: WakeTask;
      requested: string;
      /** The class that could serve it now; absent for the default model. */
      served?: string;
      /**
       * No model sits in the requested class at all, so no quota reset ends
       * the wait: placing a model there does (FI3-848).
       */
      empty?: true;
      /**
       * The requested class's models that could serve read text only and the
       * task carries pictures (`RouteResult.picturesUnread`), so no quota
       * reset ends the wait: placing a model that reads pictures there does.
       */
      pictures?: true;
    }
  | {
      /**
       * An Automatic start waits for a system no computer runs (INF-720):
       * this one, and each paired computer that runs work by what it last
       * said it runs. No room or reading ends that wait.
       */
      kind: "system-wait";
      task: WakeKeyedTask;
      required: WorkSystem[];
      computers: { name: string; system: DeviceSystem }[];
    }
  | {
      /**
       * An Automatic start waits for the model the captain named, which no
       * computer whose models were read serves now: it never starts on
       * another model in silence, so the first mate asks the captain.
       */
      kind: "named-model-wait";
      task: WakeKeyedTask;
      model: string;
    }
  | {
      /**
       * An Automatic comparison left an added computer out of a project's
       * tasks for a reason only a change ends (INF-1456): a system or chip
       * inherited from this computer, a missing program, or no access to the
       * project there. Once per project, computer and reasons, whichever
       * computer took the task.
       */
      kind: "computer-left-out";
      task: WakeKeyedTask;
      project: { id: string; name: string };
      computer: { name: string; system?: DeviceSystem; chip?: DeviceChip };
      /** The computer that took the task; absent while it waits. */
      took?: string;
      reasons: LeftOutReason[];
      /** The project's requirements that let it in (`LeftOut.widened`). */
      widened?: PlacementRequirements;
    };

/** An added computer Automatic left out, as the Firstmate hears it once (INF-1456). */
function renderComputerLeftOut(facts: Extract<WakeFacts, { kind: "computer-left-out" }>): string {
  const { computer, project, task } = facts;
  const why = facts.reasons.map((reason) =>
    leftOutReasonWords(reason, computer.name, computer.system),
  );
  const where = facts.took ? `${facts.took} took the task.` : "The task waits.";
  const ways: string[] = [];
  if (facts.widened)
    ways.push(
      `Ask the captain once whether ${computer.name} may run this project's tasks: propose app_change project-settings for ${project.id} with changes {"placementRequirements":${JSON.stringify(facts.widened)}}, without on_words and with this wake as evidence, so the app's exact-change card asks them with Apply change as its default. Never apply it on your own judgment. Runs on stays Automatic, a started task stays where it is, and the project's next tasks compare ${computer.name} equally.`,
    );
  for (const reason of facts.reasons) {
    if (reason.kind === "programs")
      ways.push(
        `${computer.name} takes them once ${reason.missing.join(", ")} is installed there.`,
      );
    if (reason.kind === "project")
      ways.push(
        `${computer.name} takes them once it can reach the project, such as by signing in there to where the project lives.`,
      );
  }
  return `[fm-op] Automatic left ${computer.name} out of project "${project.name}" when it compared computers for task ${task.id} ${task.key} "${task.title}": ${why.join("; ")}. ${where} No room or reading changes this. ${ways.join(" ")} You hear this once for this project, computer and reason.`;
}

/**
 * The one wake about a task no computer can run (INF-720), once per system
 * it requires: every later sweep compares the same computers again.
 */
export function systemWaitWake(
  task: WakeKeyedTask,
  unserved: { required: WorkSystem[]; computers: { name: string; system: DeviceSystem }[] },
): TypedWake {
  return {
    facts: {
      kind: "system-wait",
      task: { id: task.id, key: task.key, title: task.title },
      required: [...unserved.required],
      computers: unserved.computers.map(({ name, system }) => ({ name, system })),
    },
    once: `system-wait:${[...unserved.required].sort().join("+")}`,
  };
}

/**
 * The one wake about a task waiting for the model the captain named, once
 * per task and model: every later sweep compares the same computers again.
 */
export function namedModelWaitWake(task: WakeKeyedTask, model: string): TypedWake {
  return {
    facts: {
      kind: "named-model-wait",
      task: { id: task.id, key: task.key, title: task.title },
      model,
    },
    once: `named-model-wait:${model}`,
  };
}

/** The once-name of a left-out computer's wake: its project, the computer and why. */
export function computerLeftOutOnce(
  project: { id: string },
  left: Pick<LeftOut, "computerId" | "reasons">,
): string {
  const kinds = [...new Set(left.reasons.map((reason) => reason.kind))].sort().join("+");
  return `computer-left-out:${project.id}:${left.computerId}:${kinds}`;
}

/**
 * The one wake about an added computer Automatic leaves out of a project's
 * tasks (INF-1456). It goes out on the first comparison that leaves it out,
 * and never again for the same project, computer and reasons.
 */
export function computerLeftOutWake(
  task: WakeKeyedTask,
  project: { id: string; name: string },
  left: LeftOut & { name: string; took?: string },
): TypedWake {
  const { took } = left;
  return {
    facts: {
      kind: "computer-left-out",
      task: { id: task.id, key: task.key, title: task.title },
      project: { id: project.id, name: project.name },
      computer: {
        name: left.name,
        ...(left.system ? { system: left.system } : {}),
        ...(left.chip ? { chip: left.chip } : {}),
      },
      ...(took ? { took } : {}),
      reasons: left.reasons,
      ...(left.widened ? { widened: left.widened } : {}),
    },
    once: computerLeftOutOnce(project, left),
  };
}

/** One reason a computer was left out, as the first mate reads it. */
function leftOutReasonWords(reason: LeftOutReason, name: string, system?: DeviceSystem): string {
  switch (reason.kind) {
    case "chip":
      return `${name} runs on ${chipWords(reason.runs, system)} (${reason.runs}), and neither the project nor the task declares a chip, so the task was held to ${HERE.this}'s ${reason.heldTo.map((chip) => `${chipWords(chip, reason.heldOn)} (${chip})`).join(" or ")}`;
    case "system":
      return `${name} runs ${SYSTEM_WORDS[reason.runs]}, and neither the project nor the task declares a system, so the task was held to ${HERE.this}'s ${reason.heldTo.map((each) => SYSTEM_WORDS[each]).join(" or ")}`;
    case "programs":
      return `${name} does not have ${reason.missing.join(", ")}, which this project's tasks require`;
    case "project":
      return `${name} cannot reach where the project lives`;
  }
}

/** Starting work, worded. */
export const START_WORDS: KindWords<StartFacts> = {
  "program-bound": (facts) =>
    facts.to === "crewmate"
      ? `Your program ${facts.key} "${facts.task.title}" filed ${facts.calls} parts and reached its bound of ${facts.bound} task() calls: its next call is held and nothing more is filed. Ask the captain on a card whether it may go on, saying what has run and the new bound you propose; on their words raise it with start_program program and bound, or stop it with start_program program and stop.`
      : `[fm-op] the program on task ${facts.key} "${facts.task.title}" filed ${facts.calls} parts and reached its bound of ${facts.bound} task() calls: its next call is held and nothing more is filed. Ask the captain on a card whether it may go on, saying what has run and the new bound you propose; on the captain's words raise it with update_task program_bound, or drop the program. ${softHoldWords("program-bound", "firstmate")}`,
  "program-ended": (facts) =>
    facts.error
      ? `[fm-op] the program on task ${facts.key} "${facts.task.title}" stopped after ${facts.parts} parts: ${facts.error}. Nothing more of it runs; tell the captain what stopped it.`
      : `[fm-op] the program on task ${facts.key} "${facts.task.title}" finished after ${facts.parts} parts.${facts.result !== undefined ? ` ${RESULT_WORDS} ${resultText(facts.result)}` : ""}${facts.branch ? ` Its branch is ${facts.branch}'s last commit: work that ships it names ${facts.branch} in branch_from.` : " Its script returned no branch, so there is nothing to ship."}`,
  "queued-started": (facts) =>
    facts.asked && facts.model
      ? `[fm-op] task ${facts.task.id} "${facts.task.title}", which you started, is running now, ${namedModelWords(facts.model)}.`
      : `[fm-op] queued task ${facts.task.id} "${facts.task.title}" started - its wait ended. A crewmate is working on it now${facts.model ? `, ${namedModelWords(facts.model)}` : ""}.`,
  "queued-start-failed": (facts) =>
    facts.by === "captain"
      ? `[fm-op] the captain pressed Start on task ${facts.task.id} "${facts.task.title}", and it could not start: ${facts.error}`
      : facts.asked
        ? facts.open
          ? `[fm-op] task ${facts.task.id} "${facts.task.title}", which you started, could not start: ${facts.error.replace(/[.\s]+$/, "")}. It is still open with nothing running, so spawn no replacement: update_task start_now tries it again, or update_task drop removes it.`
          : `[fm-op] task ${facts.task.id} "${facts.task.title}", which you started, could not start: ${facts.error}`
        : `[fm-op] queued task ${facts.task.id} "${facts.task.title}" could not start: ${facts.error}`,
  "asked-start-waits": (facts) =>
    `[fm-op] task ${facts.task.id} "${facts.task.title}", which you started, has not started yet. ${facts.words}`,
  "captain-start": (facts) =>
    facts.move === "start"
      ? `[fm-op] the captain pressed Start on task ${facts.task.id} ${facts.task.key} "${facts.task.title}". It shows Starting and waits for you. Apply every standing direction that bears on it with update_task (merging, delivery, care, model, runs_on), passing direction with each direction's id, then update_task start_now. Never decline their Start; if no direction applies, just start_now.`
      : `[fm-op] the captain queued task ${facts.task.id} ${facts.task.key} "${facts.task.title}". Apply every standing direction that bears on it with update_task (merging, delivery, care, model, runs_on), passing direction with each direction's id. Do not start it: the host starts it when its wait ends.`,
  "dead-gate": (facts) =>
    `[fm-op] queued task ${facts.task.id} ${facts.task.key} "${facts.task.title}" waits on ${facts.blocker.key} "${facts.blocker.title}", which was ${facts.closed}, so its wait can never end; the dead edge is blocks ${facts.blocker.key} -> ${facts.task.key}.`,
  "reasoning-wait": (facts) => {
    const wait = facts.empty
      ? `no model is placed at ${facts.requested}, so no quota reset will start it; it waits until one is placed at ${facts.requested} in Settings → Intelligence → Models`
      : facts.pictures
        ? `none there reads the pictures it carries, so no quota reset will start it; it waits until a model that reads pictures is placed at ${facts.requested} in Settings → Intelligence → Models`
        : `none has quota right now; it waits on the ${facts.requested} quota reset`;
    return `[fm-op] task ${facts.task.id} "${facts.task.title}" needs a ${facts.requested} model and ${wait} unless you say otherwise, and ${facts.served ? `a ${facts.served} model` : "the default model"} could serve it now.`;
  },
  "system-wait": (facts) => {
    const runs = facts.computers.map((row) => `${row.name} runs ${SYSTEM_WORDS[row.system]}`);
    const wanted = facts.required.map((system) => SYSTEM_WORDS[system]).join(" or ");
    return `[fm-op] queued task ${facts.task.id} ${facts.task.key} "${facts.task.title}" requires ${wanted}, and no computer runs it: ${runs.join(", ")}. No room or reading ends this wait: it starts once a computer that runs ${wanted} is paired and in reach, or once what it requires changes (update_task placement_requirements).`;
  },
  "named-model-wait": (facts) =>
    `[fm-op] queued task ${facts.task.id} ${facts.task.key} "${facts.task.title}" was asked to run on ${facts.model}, and no computer it may run on serves it now, as far as their models could be read, so it waits instead of starting on another model. Ask the captain on a card whether to keep waiting for ${facts.model}, such as until they sign in to it on a computer, or to run it on another model: on their words, update_task override_model_id names the model they choose, or clears it with an empty value so the app picks, with start_now.`,
  "computer-left-out": (facts) => renderComputerLeftOut(facts),
};
