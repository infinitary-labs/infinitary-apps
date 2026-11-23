import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APPROVE_AND_BUILD, SAVE_AND_DEFER } from "../../../src/core/prompts/cardContract";
import { runbookManifestSchema } from "../../../src/shared/runbooks";
import { completionCardBody } from "../../helpers/completionCard";
import type { ScriptedArgs, ScriptedCall } from "../../helpers/scriptedCalls";
import { CAPTAIN_DECIDES } from "../crewCards";
import { CLAUDE_CREW_MODEL, type Scenario, SEQ_REPRODUCE_GOAL } from "../mockProvider";
import {
  answering,
  calledTool,
  lookUpTask,
  servedInstructions,
  sinceLastUser,
  spawnedTaskOf,
} from "../providerRequest";

/**
 * Sequences (docs/sequences.md, contracts v4.6 and v4.19): the mock Firstmate
 * opens each of these asks the way the served instructions say - an ask of
 * more than one step as a parent task left on request, the step that runs
 * now spawned under it, and the next step planned on request with the first
 * as its basis; a one-step ask as one spawn with no parent - and hands off
 * on the wakes it already receives. The crewmates are keyed by their step's
 * goal.
 */
export const SEQ_FEATURE_ASK = "the settings page feels cluttered, can we do something about it";
export const SEQ_SMALL_ASK = "the settings page title says Setings, please fix the spelling";
export const SEQ_BUG_YES_ASK = "the meter resets to zero when I reopen the app";
/** Exercise the same hand-off on the mock Claude client, not a Pi session. */
export const SEQ_CLAUDE_STEP_MARKER = "with both tasks on the Claude login";
export const SEQ_BUG_NO_ASK = "the dock flickers when I resize the window";
export const SEQ_FEATURE = {
  parent: "Declutter the settings page",
  plan: "Plan: ways to declutter settings",
  implement: "Implement the accepted direction",
} as const;
export const SEQ_SMALL = {
  implement: "Fix the settings page title spelling",
} as const;
/** Why the one-step ask skips its plan, as the mock Firstmate declares it. */
export const SEQ_SMALL_PLAN_SKIP =
  "One settings title; no rule or meaning changes; inspect the title";
export const SEQ_BUG_YES = {
  parent: "Fix the meter reset",
  reproduce: "Reproduce: the meter reset",
  fix: "Fix: the meter reset",
} as const;
export const SEQ_BUG_SHOWN_ASK = "the clock drifts when the laptop sleeps, show me the repro first";
export const SEQ_BUG_SHOWN = {
  parent: "Fix the clock drift",
  reproduce: "Reproduce: the clock drift",
  fix: "Fix: the clock drift",
} as const;
/** The captain's later word to start the fix while the repro card is still up. */
export const SEQ_START_SHOWN_FIX = "start the clock drift fix now";
export const SEQ_SHOWN_REPRO_TITLE = "The clock drift reproduces";
/** The shown reproduction card's default choice. */
export const SEQ_SHOWN_FIX_LABEL = "Fix it";
export const SEQ_BUG_NO = {
  parent: "Fix the dock flicker",
  reproduce: "Reproduce: the dock flicker",
  fix: "Fix: the dock flicker",
} as const;
const workflowRoot = join(process.cwd(), "resources/runbooks/sequences");
const workflowSection = runbookManifestSchema.parse(
  JSON.parse(readFileSync(join(workflowRoot, "runbook.json"), "utf8")),
).firstmate;
if (!workflowSection) throw new Error("Common workflows has no first-mate section.");
const WORKFLOW_GUIDE = readFileSync(join(workflowRoot, workflowSection), "utf8");
/**
 * The guide's implement line, which the Firstmate relays word for
 * word as the implement step's free constraint.
 */
export const SEQ_IMPLEMENT_AMENDED_GOAL =
  "Implement the accepted direction for the settings page, including saved sample-count choices and replacement-only height motion";
export const SEQ_IMPLEMENT_LINE =
  stepLineOf(WORKFLOW_GUIDE, "feature", "implement") ?? "the guide has no feature implement line";
export const SEQ_PLAN_GOAL = "Propose two or three directions for the settings page as one card";
export const SEQ_IMPLEMENT_GOAL = "Implement the accepted direction for the settings page";
const SEQ_SMALL_GOAL = "The settings page title reads Settings";
const SEQ_FIX_GOAL = "at its root; the failing check passes";
export const SEQ_PLAN_CARD_TITLE = "Two ways to declutter settings";
export const SEQ_PLAN_CHOICE = APPROVE_AND_BUILD;
/** The plan card's second record answer, the one the captain picks. */
export const SEQ_PLAN_MANY_LABEL = "One per task";
export const SEQ_PLAN_CARD_BODY = `<p>Two directions for the settings page.</p><ul><li>Hide the rarely used rows behind one disclosure.</li><li>Group every row into three labelled sections.</li></ul><fieldset><legend>How many records?</legend><label><input type="radio" name="q2_count" value="one" checked>One record</label><label><input type="radio" name="q2_count" value="many">${SEQ_PLAN_MANY_LABEL}</label><label><input type="radio" name="q2_count" value="other" data-inf-write-in>Something else</label></fieldset><label for="sample-count">Demo sample count</label><input id="sample-count" name="sample-count" type="number" value="3">`;
export const SEQ_PLAN_REPORT =
  "Two directions for the settings page; grouping the rows into sections is the one I would take.";
export const SEQ_THREAD_REPLY = "B, but keep the gear icon where it is";
/** The planner's answer under its card to the captain's reply. */
export const SEQ_THREAD_ANSWER = "Noted: B keeps the gear icon where it is.";
/** The spec the planner records after the captain's tweak: the final agreed version. */
export const SEQ_PLAN_FINAL_SPEC =
  "Agreed spec: group every settings row into three labelled sections (option B), and keep the gear icon where it is.";
export const SEQ_IMPLEMENT_CARD_TITLE = "The settings page is grouped into sections";
export const SEQ_REPRODUCED_YES =
  "reproduced: yes - the meter reads zero after a reopen; the failing check is on the working copy.";
export const SEQ_REPRODUCED_NO =
  "reproduced: no - the dock held steady through forty resizes on a clean setup.";
export const SEQ_NOT_REPRODUCED_TITLE = "The dock flicker did not reproduce";
export const SEQ_NOT_REPRODUCED_WAYS = ["Fix it anyway", "Stop here"] as const;
/**
 * A plan the captain asks for on its own and saves for later (HANDOFF's
 * Save and defer): the planner offers Approve and build, Save and defer and
 * Abandon; on Save and defer the Firstmate files the build on request with
 * the plan as its basis, and starts nothing.
 */
export const SEQ_SAVED_ASK = "plan a calmer about page, I may build it later";
export const SEQ_SAVED = {
  plan: "Plan: a calmer about page",
  build: "Build the saved plan: a calmer about page",
} as const;
const SEQ_SAVED_PLAN_GOAL = "Propose a calmer about page as one card";
export const SEQ_SAVED_BUILD_GOAL = "Build the calmer about page the saved plan agreed";
export const SEQ_SAVED_CARD_TITLE = "A calmer about page";
export const SEQ_SAVED_CHOICE = SAVE_AND_DEFER;
export const SEQ_SAVED_BOTTOM_LABEL = "At the bottom";
export const SEQ_SAVED_CARD_BODY = `<p>The about page keeps one paragraph and the version line, and the credits list goes.</p><ul><li>One paragraph says what the app is.</li><li>The credits list moves to the project page.</li></ul><fieldset><legend>Where does the version line sit?</legend><label><input type="radio" name="version_line" value="top">At the top</label><label><input type="radio" name="version_line" value="bottom" data-inf-recommended>${SEQ_SAVED_BOTTOM_LABEL}</label><label><input type="radio" name="version_line" value="other" data-inf-write-in>Something else</label></fieldset>`;
export const SEQ_SAVED_SPEC =
  "Agreed spec: the about page keeps one paragraph and the version line, and drops the credits list.";

/**
 * The ideation plan line of a sequences document, as the Firstmate relays a
 * step's line (one line, no bullet; `SEQ_IMPLEMENT_LINE`).
 */
function planLineOf(document: string): string | undefined {
  return document
    .match(/^- (plan: a read-only step\.[\s\S]*?)\n(?=- |#)/m)?.[1]
    ?.replace(/\s+/g, " ")
    .trim();
}
/** A step's line under a section of a sequences document, as the Firstmate relays it. */
function stepLineOf(document: string, section: string, step: string): string | undefined {
  const at = document.indexOf(`\n## ${section} `);
  if (at === -1) return undefined;
  return document
    .slice(at)
    .split("\n- ")
    .find((line) => line.startsWith(`${step}: `))
    ?.split("\n#")[0]
    ?.replace(/\s+/g, " ")
    .trim();
}
/** The guide's plan line, which says what an ask for a prototype is. */
export const SEQ_PLAN_LINE = planLineOf(WORKFLOW_GUIDE) ?? "the guide has no plan line";
/**
 * An ask for a prototype (FI3-872): the plan line it was served sends it to
 * one read-only plan step whose card is a playable preview; Approve and
 * build closes that answer, and the Firstmate starts a builder grounded on it.
 */
export const SEQ_PROTOTYPE_ASK = "prototype a tilted glass dial I can try";
export const SEQ_PROTOTYPE = {
  plan: "Plan: a tilted glass dial",
  build: "Build: a tilted glass dial",
} as const;
export const SEQ_PROTOTYPE_PLAN_GOAL = "Show a tilted glass dial as a playable preview on one card";
export const SEQ_PROTOTYPE_BUILD_GOAL = "Build the tilted glass dial the captain approved";
export const SEQ_PROTOTYPE_CARD_TITLE = "A tilted glass dial to try";
export const SEQ_PROTOTYPE_CHOICE = APPROVE_AND_BUILD;
export const SEQ_PROTOTYPE_CARD_BODY =
  "<p>A glass dial tilted 16 degrees; drag the tilt to try another angle.</p>" +
  '<label>Tilt in degrees <input id="tilt" type="range" min="0" max="90" value="16"></label>' +
  '<output id="reading">16°</output>' +
  "<script>const tilt = document.getElementById('tilt'); tilt.oninput = () => { document.getElementById('reading').textContent = tilt.value + '°'; inf.stage('look', { tiltDeg: Number(tilt.value) }); }; tilt.oninput();</script>";
export const SEQ_PROTOTYPE_SPEC =
  "Agreed spec: a glass dial tilted 16 degrees by default, adjustable from 0 to 90 degrees.";

/**
 * A check a build waits on (FI3-422): the Firstmate starts the build, runs a
 * read-only check of it as an internal step, and links the check as blocking
 * the build, so the build cannot merge while the check is live. The check
 * reports a pass, and the Firstmate closes it as answered into the build.
 */
export const SEQ_CHECKED_ASK =
  "add the battery meter, and run the live cases on it before it merges";
export const SEQ_CHECKED = {
  build: "Build: the battery meter",
  check: "Check: the battery meter live cases",
} as const;
const SEQ_CHECKED_BUILD_GOAL = "Add a battery meter to the status bar";
const SEQ_CHECK_GOAL = "Run the ten live cases against the battery meter build";
export const SEQ_CHECKS_PASSED = "checks: pass - all ten live cases pass on the battery meter.";

type SeqAsk = {
  ask: string;
  /** The ask's parent; a one-step ask has none. */
  parent?: string;
  /**
   * The step that runs now. The mock Firstmate declares every step it adds
   * as internal_step, as the instructions say, except one the captain asked
   * to see (`captainAsked`) - its judgment, scripted here.
   */
  now: {
    title: string;
    goal: string;
    constraints?: ScriptedArgs<"spawn_crewmate">["constraints"];
    captainAsked?: boolean;
  };
  later?: { title: string; goal: string; constraints?: ScriptedArgs<"create_task">["constraints"] };
};

const SEQ_ASKS: SeqAsk[] = [
  {
    ask: SEQ_SMALL_ASK,
    now: { title: SEQ_SMALL.implement, goal: `${SEQ_SMALL_GOAL}.` },
  },
  {
    ask: SEQ_FEATURE_ASK,
    parent: SEQ_FEATURE.parent,
    now: {
      title: SEQ_FEATURE.plan,
      goal: `${SEQ_PLAN_GOAL}, and wait for my choice.`,
      constraints: [{ kind: "read-only" }],
    },
    later: {
      title: SEQ_FEATURE.implement,
      goal: `${SEQ_IMPLEMENT_GOAL}.`,
      constraints: [{ kind: "free", text: SEQ_IMPLEMENT_LINE }],
    },
  },
  {
    ask: SEQ_BUG_YES_ASK,
    parent: SEQ_BUG_YES.parent,
    now: {
      title: SEQ_BUG_YES.reproduce,
      goal: `Reproduce the meter reset ${SEQ_REPRODUCE_GOAL} yes or reproduced: no.`,
      constraints: [{ kind: "read-only" }],
    },
    later: { title: SEQ_BUG_YES.fix, goal: `Fix the meter reset ${SEQ_FIX_GOAL}.` },
  },
  {
    ask: SEQ_BUG_SHOWN_ASK,
    parent: SEQ_BUG_SHOWN.parent,
    now: {
      title: SEQ_BUG_SHOWN.reproduce,
      goal: `Reproduce the clock drift ${SEQ_REPRODUCE_GOAL} yes or reproduced: no.`,
      constraints: [{ kind: "read-only" }],
      // The captain asked to see this step's own result: not an internal step.
      captainAsked: true,
    },
    later: { title: SEQ_BUG_SHOWN.fix, goal: `Fix the clock drift ${SEQ_FIX_GOAL}.` },
  },
  {
    ask: SEQ_BUG_NO_ASK,
    parent: SEQ_BUG_NO.parent,
    now: {
      title: SEQ_BUG_NO.reproduce,
      goal: `Reproduce the dock flicker ${SEQ_REPRODUCE_GOAL} yes or reproduced: no.`,
      constraints: [{ kind: "read-only" }],
    },
    later: { title: SEQ_BUG_NO.fix, goal: `Fix the dock flicker ${SEQ_FIX_GOAL}.` },
  },
];

export function seqGoal(title: string): string {
  for (const ask of SEQ_ASKS) {
    for (const step of [ask.now, ask.later]) if (step?.title === title) return step.goal;
  }
  throw new Error(`No scripted step is titled ${title}.`);
}

/**
 * The mock Firstmate's moves for the sequences asks: the legs of opening an
 * ask, the plan's hand-off on the captain's choice, and the bug hand-offs on
 * the reproduce step's report. Undefined when the request is none of them.
 */
function sequencesFirstmateMove(
  body: string,
): { calls: ScriptedCall[] } | { text: string } | undefined {
  const { user, results } = sinceLastUser(body);
  const onClaude = body.includes(SEQ_CLAUDE_STEP_MARKER);
  const userSegment = user.slice(user.lastIndexOf("[user]"));
  const script = user.includes("[user]")
    ? SEQ_ASKS.find((entry) => userSegment.includes(entry.ask))
    : undefined;
  if (user.includes("[user]") && userSegment.includes(SEQ_SAVED_ASK)) {
    if (results.length > 0) return { text: "Opened." };
    return {
      calls: [
        {
          name: "spawn_crewmate",
          args: {
            title: SEQ_SAVED.plan,
            goal: `${SEQ_SAVED_PLAN_GOAL}, and wait for my choice.`,
            user_words: SEQ_SAVED_ASK,
            constraints: [{ kind: "read-only" }],
          },
        },
      ],
    };
  }
  // An ask for a prototype: the plan line the Firstmate was served says it
  // is that plan, so it relays the line beside the read-only constraint.
  if (user.includes("[user]") && userSegment.includes(SEQ_PROTOTYPE_ASK)) {
    if (results.length > 0) return { text: "Opened." };
    const line = planLineOf(servedInstructions(body));
    return {
      calls: [
        {
          name: "spawn_crewmate",
          args: {
            title: SEQ_PROTOTYPE.plan,
            goal: `${SEQ_PROTOTYPE_PLAN_GOAL}, and wait for my choice.`,
            user_words: SEQ_PROTOTYPE_ASK,
            constraints: [
              { kind: "read-only" },
              ...(line ? [{ kind: "free" as const, text: line }] : []),
            ],
          },
        },
      ],
    };
  }
  // Approve and build on it: no successor exists, so the builder is spawned
  // grounded on the plan (HANDOFF).
  if (
    user.includes('"event":"answer_task_closed"') &&
    user.includes(`"title":"${SEQ_PROTOTYPE.plan}"`) &&
    user.includes(`"label":"${SEQ_PROTOTYPE_CHOICE}"`)
  ) {
    if (results.length > 0) return { text: "Started the build." };
    const plan = user.match(/"event":"answer_task_closed","task":\{"id":"([\w-]+)"/)?.[1];
    return {
      calls: [
        {
          name: "spawn_crewmate",
          args: {
            title: SEQ_PROTOTYPE.build,
            goal: `${SEQ_PROTOTYPE_BUILD_GOAL}.`,
            user_words: SEQ_PROTOTYPE_ASK,
            constraints: [{ kind: "free", text: SEQ_IMPLEMENT_LINE }],
            shape: { basis: plan ?? "missing" },
          },
        },
      ],
    };
  }
  // Save and defer on that plan: no successor exists, so the build is filed
  // on request, grounded on the plan, and nothing starts.
  if (
    user.includes('"event":"answer_task_closed"') &&
    user.includes(`"title":"${SEQ_SAVED.plan}"`) &&
    user.includes(`"label":"${SEQ_SAVED_CHOICE}"`)
  ) {
    if (results.length > 0) return { text: "Saved for later." };
    const plan = user.match(/"event":"answer_task_closed","task":\{"id":"([\w-]+)"/)?.[1];
    return {
      calls: [
        {
          name: "create_task",
          args: {
            title: SEQ_SAVED.build,
            goal: `${SEQ_SAVED_BUILD_GOAL}.`,
            user_words: SEQ_SAVED_ASK,
            basis: plan ?? "missing",
            start_policy: "on-request",
            constraints: [{ kind: "free", text: SEQ_IMPLEMENT_LINE }],
          },
        },
      ],
    };
  }
  // A build and a check it waits on: the build starts, the check runs as an
  // internal step, and a blocks link holds the build's merge on the check.
  if (user.includes("[user]") && userSegment.includes(SEQ_CHECKED_ASK)) {
    if (results.length === 0) {
      return {
        calls: [
          {
            name: "spawn_crewmate",
            args: {
              title: SEQ_CHECKED.build,
              goal: `${SEQ_CHECKED_BUILD_GOAL}.`,
              user_words: SEQ_CHECKED_ASK,
            },
          },
        ],
      };
    }
    if (results.length === 1) {
      return {
        calls: [
          {
            name: "spawn_crewmate",
            args: {
              title: SEQ_CHECKED.check,
              goal: `${SEQ_CHECK_GOAL}; open your report with checks: pass or checks: fail.`,
              user_words: SEQ_CHECKED_ASK,
              constraints: [{ kind: "read-only" }],
              shape: { internal_step: true },
            },
          },
        ],
      };
    }
    const build = spawnedTaskOf(results[0]);
    const check = spawnedTaskOf(results[1]);
    if (results.length === 2 && build && check) {
      return { calls: [{ name: "link_tasks", args: { from: check, to: build, type: "blocks" } }] };
    }
    return { text: "Started the build and its live check." };
  }
  if (script && !script.parent) {
    if (results.length > 0) return { text: "Opened." };
    return {
      calls: [
        {
          name: "spawn_crewmate",
          args: {
            title: script.now.title,
            goal: script.now.goal,
            user_words: script.ask,
            ...(script.now.constraints ? { constraints: script.now.constraints } : {}),
            shape: { skipped_plan_because: SEQ_SMALL_PLAN_SKIP },
          },
        },
      ],
    };
  }
  if (script?.parent) {
    const parentKey = results[0]?.match(/Planned ([A-Z0-9]+-\d+)/)?.[1];
    if (results.length === 0) {
      return {
        calls: [
          {
            name: "create_task",
            args: { title: script.parent, goal: `${script.parent}.`, user_words: script.ask },
          },
        ],
      };
    }
    if (results.length === 1 && parentKey) {
      return {
        calls: [
          {
            name: "spawn_crewmate",
            args: {
              title: script.now.title,
              goal: script.now.goal,
              // A pinned model skips the classifier. Keep this reproduction
              // an answer with its real read-only constraint (FI3-793).
              ...(onClaude
                ? {
                    override_model_id: CLAUDE_CREW_MODEL,
                    constraints: [{ kind: "read-only" }],
                  }
                : {}),
              user_words: script.ask,
              parent: parentKey,
              ...(script.now.constraints ? { constraints: script.now.constraints } : {}),
              ...(script.now.captainAsked ? {} : { shape: { internal_step: true } }),
            },
          },
        ],
      };
    }
    const nowId = spawnedTaskOf(results[1]);
    if (results.length === 2 && parentKey && nowId && script.later) {
      return {
        calls: [
          {
            name: "create_task",
            args: {
              title: script.later.title,
              goal: script.later.goal,
              user_words: script.ask,
              parent: parentKey,
              basis: nowId,
              start_policy: "on-request",
              internal_step: true,
              ...(script.later.constraints ? { constraints: script.later.constraints } : {}),
            },
          },
        ],
      };
    }
    return { text: "Opened." };
  }
  // The captain says to start the clock fix while the repro he asked to see
  // is still up: the Firstmate starts it and leaves the repro alone - it
  // never declared it a step of its own, so it is his to close.
  if (
    user.includes("[user]") &&
    user.slice(user.lastIndexOf("[user]")).includes(SEQ_START_SHOWN_FIX)
  ) {
    return (
      lookUpTask(SEQ_BUG_SHOWN.fix, results, (fix) => [
        { name: "update_task", args: { task: fix, start_now: true } },
      ]) ?? { text: "Started the fix; the repro is yours to close." }
    );
  }
  // The captain chose on the plan's card: the plan step closed answered, and
  // its choice says the implement step's turn has come.
  if (
    user.includes('"event":"answer_task_closed"') &&
    user.includes(`"title":"${SEQ_FEATURE.plan}"`)
  ) {
    return (
      lookUpTask(SEQ_FEATURE.implement, results, (implement) => [
        {
          name: "update_task",
          args: {
            task: implement,
            start_policy: "when-ready",
            blocked_by: [],
            goal: SEQ_IMPLEMENT_AMENDED_GOAL,
          },
        },
      ]) ?? { text: "Started." }
    );
  }
  // The reproduce step's report: yes starts the fix and closes the step it
  // builds on as answered; no is one decision card with the ways out.
  const reproduced = (title: string, verdict: "yes" | "no") =>
    user.match(new RegExp(`reported on task ([\\w-]+) "${title}": reproduced: ${verdict}`))?.[1];
  const yes = reproduced(SEQ_BUG_YES.reproduce, "yes");
  if (yes) {
    const started = lookUpTask(SEQ_BUG_YES.fix, results, (fix) => [
      {
        name: "update_task",
        args: {
          task: fix,
          start_now: true,
          ...(onClaude ? { override_model_id: CLAUDE_CREW_MODEL } : {}),
        },
      },
    ]);
    if (started) return started;
    if (results.length === 2) {
      return {
        calls: [{ name: "settle_task", args: { task_id: yes, mode: "done", why: "answered" } }],
      };
    }
    return { text: "Fix under way." };
  }
  // The check's pass: the build it held carries on, so the check closes as
  // answered into it.
  const passed = user.match(
    new RegExp(`reported on task ([\\w-]+) "${SEQ_CHECKED.check}": checks: pass`),
  )?.[1];
  if (passed) {
    if (results.length > 0) return { text: "The checks passed; the build carries on." };
    return {
      calls: [{ name: "settle_task", args: { task_id: passed, mode: "done", why: "answered" } }],
    };
  }
  return undefined;
}

function sequencesCrewmateMove(
  body: string,
  hasToolResults: boolean,
): { calls: ScriptedCall[] } | { text: string } | undefined {
  // Most specific first: a builder's brief quotes its basis, never its goal.
  if (body.includes(SEQ_SAVED_BUILD_GOAL)) return { text: "Building the saved plan." };
  if (body.includes(SEQ_PROTOTYPE_BUILD_GOAL)) return { text: "Building the approved dial." };
  if (body.includes(SEQ_PROTOTYPE_PLAN_GOAL)) {
    if (hasToolResults || calledTool(body, "emit_card")) return { text: "done" };
    return {
      calls: [
        {
          name: "emit_card",
          args: {
            title: SEQ_PROTOTYPE_CARD_TITLE,
            body: SEQ_PROTOTYPE_CARD_BODY,
            actions: [
              { id: "abandon", label: "Abandon" },
              { id: "save-and-defer", label: "Save and defer" },
              { id: "approve", label: SEQ_PROTOTYPE_CHOICE, default: true },
            ],
          },
        },
        { name: "report", args: { text: SEQ_PROTOTYPE_SPEC } },
      ],
    };
  }
  if (body.includes(SEQ_SAVED_PLAN_GOAL)) {
    if (hasToolResults || calledTool(body, "emit_card")) return { text: "done" };
    return {
      calls: [
        {
          name: "emit_card",
          args: {
            title: SEQ_SAVED_CARD_TITLE,
            body: SEQ_SAVED_CARD_BODY,
            actions: [
              { id: "abandon", label: "Abandon" },
              { id: "save-and-defer", label: SEQ_SAVED_CHOICE },
              { id: "approve", label: "Approve and build", default: true },
            ],
          },
        },
        { name: "report", args: { text: SEQ_SAVED_SPEC } },
      ],
    };
  }
  if (body.includes(SEQ_IMPLEMENT_GOAL)) {
    if (hasToolResults || calledTool(body, "emit_card")) return { text: "done" };
    return {
      calls: [
        {
          name: "emit_card",
          args: {
            title: SEQ_IMPLEMENT_CARD_TITLE,
            body: completionCardBody(
              "<p>The settings rows need clear groups.</p>",
              "<p>Grouped the rows into three labelled sections.</p>",
              "<p>The rows were one undivided list.</p>",
              "<p>The sections now separate the rows.</p><ul><li>The gear icon stays where it was.</li></ul>",
            ),
            actions: [
              {
                id: "put-in",
                label: "Put it in",
                default: true,
                effect: { kind: "merge", after: "close", asks_first: CAPTAIN_DECIDES },
              },
            ],
          },
        },
        { name: "report", args: { text: "Grouped the settings rows into three sections." } },
      ],
    };
  }
  if (body.includes(SEQ_CHECK_GOAL)) {
    if (hasToolResults) return { text: "done" };
    return { calls: [{ name: "report", args: { text: SEQ_CHECKS_PASSED } }] };
  }
  if (body.includes(SEQ_CHECKED_BUILD_GOAL)) return { text: "Adding the battery meter now." };
  if (body.includes(SEQ_SMALL_GOAL)) return { text: "Fixing the title spelling now." };
  if (body.includes(SEQ_FIX_GOAL)) return { text: "The fix is under way." };
  if (body.includes(SEQ_REPRODUCE_GOAL)) {
    if (hasToolResults) return { text: "done" };
    const verdict = body.includes("the dock flicker") ? SEQ_REPRODUCED_NO : SEQ_REPRODUCED_YES;
    if (verdict === SEQ_REPRODUCED_NO) {
      return {
        calls: [
          {
            name: "emit_card",
            args: {
              title: SEQ_NOT_REPRODUCED_TITLE,
              body: "<p>The dock flicker did not show on a clean setup.</p><ul><li>Forty resizes, no flicker.</li><li>The fix waits on your word.</li></ul>",
              actions: [
                { id: "fix-anyway", label: SEQ_NOT_REPRODUCED_WAYS[0], default: true },
                { id: "stop", label: SEQ_NOT_REPRODUCED_WAYS[1] },
              ],
            },
          },
          { name: "report", args: { text: verdict } },
        ],
      };
    }
    // The brief says which answer shape it has: the captain's own ask lands
    // as a card; a step the Firstmate runs hands its report on.
    if (body.includes("it lands as one card")) {
      return {
        calls: [
          {
            name: "emit_card",
            args: {
              title: SEQ_SHOWN_REPRO_TITLE,
              body: "<p>The clock loses a minute over a sleep.</p><ul><li>Seen on three sleeps.</li></ul>",
              actions: [
                { id: "leave", label: "Leave it" },
                { id: "fix", label: SEQ_SHOWN_FIX_LABEL, default: true },
              ],
            },
          },
          { name: "report", args: { text: verdict } },
        ],
      };
    }
    return { calls: [{ name: "report", args: { text: verdict } }] };
  }
  if (body.includes(SEQ_PLAN_GOAL)) {
    const { user, tail } = sinceLastUser(body);
    // A native steer can precede the original card's tool receipt. Only
    // this amendment's reply call means it was acknowledged; any old tool
    // result is not proof that the new instruction was handled.
    if (user.includes(SEQ_THREAD_REPLY) && !calledTool(tail, "reply")) {
      const shown = body.match(/Card shown: [^(]*\((card-[\w-]+)\)/)?.[1] ?? "";
      return {
        calls: [
          {
            name: "reply",
            args: { card_id: shown, text: SEQ_THREAD_ANSWER, ...answering(user) },
          },
          { name: "report", args: { text: SEQ_PLAN_FINAL_SPEC } },
        ],
      };
    }
    if (hasToolResults || calledTool(body, "emit_card")) return { text: "done" };
    return {
      calls: [
        {
          name: "emit_card",
          args: {
            title: SEQ_PLAN_CARD_TITLE,
            body: SEQ_PLAN_CARD_BODY,
            actions: [
              { id: "abandon", label: "Abandon" },
              { id: "save-and-defer", label: "Save and defer" },
              { id: "group", label: SEQ_PLAN_CHOICE, default: true },
            ],
          },
        },
        { name: "report", args: { text: SEQ_PLAN_REPORT } },
      ],
    };
  }
  return undefined;
}

export const sequences: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, hasToolResults }) => {
    if (!wantsStream) return undefined;
    return isFirstmate ? sequencesFirstmateMove(body) : sequencesCrewmateMove(body, hasToolResults);
  };
