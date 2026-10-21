import { type LiveValidationInput, liveValidationInputSchema } from "@shared/liveValidation";
import { Type } from "typebox";
import { z } from "zod";
import { KNOWLEDGE_TOOL, RECORD_KNOWLEDGE_TOOL } from "../knowledge/knowledgeTools";
import { type CrewmateTool, callWithSignal, crewmateTool, stringEnum } from "../session/tools";
import { cardPictureRoot } from "./cardImages";
import { CLOSE_CARD_TOOL, EMIT_CARD_TOOL } from "./cardTool";
import {
  CHECK_CHANGE_TOOL,
  DOWNLOAD_ARTIFACT_TOOL,
  GITHUB_READ_TOOL,
  GITHUB_WRITE_TOOL,
  OPEN_CHANGE_TOOL,
  PREPARE_CHANGE_TOOL,
  READ_WORKFLOW_TOOL,
} from "./forgeTools";
import { CAPTURE_PANEL_TOOL, LINT_PANEL_TOOL, PLACE_PANEL_TOOL } from "./panelTools";
import { TASKS_QUERY_TOOL } from "./taskTools";
import { keepValidationEvidence } from "./validationEvidence";

/**
 * The crewmate's record-facing tools (task-system P2, design section 7):
 * `file_followup` records a defect or safety risk the crewmate found but
 * should not fix itself (FI3-868: optional ideas stay in its report) - an
 * on-request task of its own, discovered-from the crewmate's task
 * rather than filed under it, that the Firstmate hears about with the
 * report and decides on (cards/tasks/agents P0, WI-4) - and `note_progress`
 * puts one line on the crewmate's own timeline without touching the feed.
 * The read-only `tasks` query (taskTools.ts) sits beside them so a crewmate
 * searches the backlog before filing. Each is one entry of the crewmate
 * tool spec (`../session/tools.ts`), and `CREWMATE_TOOLS` below is the
 * whole set: the Pi session and the Claude client's tool server generate
 * their tools from the same entries, so a crewmate reads the same contract
 * whichever subscription runs it.
 */

export const FILE_FOLLOWUP_TOOL_NAME = "file_followup";
export const NOTE_PROGRESS_TOOL_NAME = "note_progress";
export const REPORT_TOOL_NAME = "report";
export const REPLY_TOOL_NAME = "reply";

/**
 * The thread answer (cards-as-threads phase 1, contract v4.1). Every card is
 * the head of a conversation between the captain and its author, and until
 * now a crewmate had no output for "say something back": the Firstmate
 * relayed it by hand, or the card had to be closed to answer at all.
 *
 * The rules the mechanics carry - revise when the card should change, prose
 * only, and the settle hand-off - are the shared card-reply contract
 * (`CARD_REPLY` in `src/core/prompts/cardContract.ts`), which every persona
 * includes once. This description says how to call it and nothing else, so
 * it stays well under the Claude transport's 2,048-character cap.
 */
export const REPLY_TOOL_DESCRIPTION = [
  "Answer the captain in the thread under one of your own cards: plain prose, a few sentences, rendered as a message beside the card.",
  "Never a card and never actions - to change what the card says, call emit_card again with the same id, passing your answer as its reply so one call does both; the host puts one revised line in the thread before it.",
  "Pass the card id emit_card returned. A card that is not yours takes no reply.",
].join(" ");

/**
 * The explicit report (interaction P0, WI-1): a turn reaches Firstmate only
 * when it reports - through this tool, or by ending with text.
 */
export const REPORT_TOOL_DESCRIPTION = [
  "Report to the first mate: what you finished and verified, what you found, or what blocks you.",
  "The first mate hears only an explicit report, or your final message when a turn ends with text; a turn that ends silently - after a background job result you only noted, for example - reports nothing.",
  "Call it when you have something new for the captain: plain words, lead with the outcome, a few sentences.",
  "Always pass summary too: one plain sentence saying what happened (not a heading, not the ask restated); the captain reads it as the task's headline.",
  "Never for progress (that is note_progress) and never to repeat a report you already made.",
  "If your current policies say autonomy on, the task merges on its own: at green, when no standing direction's exception covers your final change, emit no completion card; report needs_firstmate to merge the pull request. When an exception covers it, emit the usual completion card and report needs_firstmate to set the task to ask first, citing the direction.",
].join(" ");

export const FILE_FOLLOWUP_TOOL_DESCRIPTION = [
  "Record a defect or safety risk you discovered outside your task, instead of doing it:",
  "a bug you can show on the current main line, or a credible risk to the person's data, accounts, signing material or merges.",
  "Not for an optional improvement (a refactor, extra assurance, a nicer wording): that is one line in your report, and the first mate decides whether the captain sees it.",
  "Not for work your own change needs to be finished, or documents it makes stale: those are yours.",
  "Search first with tasks (text, project): if a matching task already exists, file nothing and name its key in your report.",
  "It becomes a separate planned task, recorded as discovered from yours - not a part of it - and waits until the first mate decides; nothing starts on its own and you keep working.",
  "The first mate hears about it with your report, not as a message of its own, and triages it there.",
  "Filing it does NOT hold your own task up: your work still stands on its own merits.",
  "If the rest of your own work must wait for this to be merged, file it here with a title beginning Continue: and say in why that it needs this merged first; name it in your report, end that turn without a card, and wait for the first mate to link it before emitting the completion decision on its steer. The first mate makes it start when ready after this task closes.",
  "The one exception is blocks_me, which is a real dependency - pass it true only when your task genuinely cannot merge until that work does, because it will then stop your task from closing.",
  "Give a sentence-case title, a one-sentence goal saying what done looks like, and why - what you found, in plain words.",
  "When the follow-up is a test failure, pass test_failure true and test_path, the failing test's path: the host refuses a test failure with no path, stores the path, and answers with the existing key instead of filing a second open row for the same path.",
  "Never file progress, questions for the captain (emit a card), or work you are about to do yourself.",
].join(" ");

export const NOTE_PROGRESS_TOOL_DESCRIPTION = [
  "Put one line on your task's own timeline - a milestone reached, a decision you made, what you are doing next.",
  "It is never shown as a card or a feed line; the captain can read it on the task's record.",
  "Use it at real checkpoints, not every step, and never instead of your final report.",
  "Pass plan with it to show where the work stands: the whole list of what the task takes, each item with a label, a short label of a word or two for its dot, and its state - done, current, next or skipped.",
  "The captain sees it as dots on a line beside the task and as a list on its record, so keep it short and high level: under eight items in all, one current at a time.",
  "Send the first list with your brief, send the whole list with every later note, unchanged if nothing moved, and fold finished items into one item to make room; the final report leaves every item done or skipped.",
].join(" ");

export const FILE_FOLLOWUP_TOOL = crewmateTool({
  name: FILE_FOLLOWUP_TOOL_NAME,
  label: "File follow-up",
  description: FILE_FOLLOWUP_TOOL_DESCRIPTION,
  parameters: Type.Object({
    title: Type.String({ description: "Short sentence-case title (max 64 chars)" }),
    goal: Type.String({ description: "One sentence: what done looks like" }),
    why: Type.String({
      description:
        "What you found, in plain words: the evidence on the current main line, what it breaks and for whom, and what you are unsure of",
    }),
    blocks_me: Type.Optional(
      Type.Boolean({
        description:
          "True only if your task genuinely cannot land until this does; it then stops your task from closing",
      }),
    ),
    test_failure: Type.Optional(
      Type.Boolean({
        description:
          "True when this follow-up is a test failure. Requires test_path; the host refuses the filing without it.",
      }),
    ),
    test_path: Type.Optional(
      Type.String({
        description:
          "The failing test's path. The host stores it and answers with the existing key instead of filing a second open row for the same path.",
      }),
    ),
  }),
  bind: ({ onFollowup }) =>
    onFollowup &&
    (async (params, signal) => ({
      text: await callWithSignal(
        onFollowup,
        [
          {
            title: params.title,
            goal: params.goal,
            why: params.why,
            ...(params.blocks_me ? { blocksMe: true } : {}),
            ...(params.test_failure ? { testFailure: true } : {}),
            ...(params.test_path ? { testPath: params.test_path } : {}),
          },
        ],
        signal,
      ),
    })),
});

export const REPORT_TOOL = crewmateTool({
  name: REPORT_TOOL_NAME,
  label: "Report",
  description: REPORT_TOOL_DESCRIPTION,
  parameters: Type.Object({
    validation: Type.Optional(
      Type.Unsafe<LiveValidationInput>({
        ...z.toJSONSchema(liveValidationInputSchema),
        description:
          "Careful: plan before edits; keep run proof; review assigned head/revision. Live pass: result pass, live true, unproven []; out-of-scope limits go in reason, never hide gaps. Gaps match a current inconclusive, untested/non-live run's scenario, missingCapability and reason. Requests grant nothing: emit_card.validation_request asks the captain for one action or gap, never follow-on writes. Forge starts approved effects; otherwise record started then outcome; never retry unknown.",
      }),
    ),
    text: Type.String({
      description: "The report: outcome first, then what you verified; plain prose",
    }),
    summary: Type.Optional(
      Type.String({
        description:
          "One plain sentence: what happened, as the task's headline. Never a heading like Intent, never the ask restated",
      }),
    ),
    waiting_on_captain: Type.Optional(
      Type.Object(
        {
          reason: Type.String({
            description: "What the captain still has to read or decide, in a few plain words",
          }),
          card_id: Type.Optional(
            Type.String({ description: "Your open card he is to read; omit when none is up" }),
          ),
        },
        {
          description:
            "Pass when nothing is left for you until the captain acts: your outcome card is up, or he may still want something after closing your card. reason says what he still has to read or decide; card_id names your open card he is to read, omitted when none is up. Your task then waits on him: nothing nudges you, and while your card is up the first mate is not woken until he closes, clicks or replies under it, or you are steered. With no card of yours up he has nothing to answer, so the first mate is woken to ask him. Never while work of your own remains.",
        },
      ),
    ),
    finished: Type.Optional(
      Type.Boolean({
        description:
          "True only after the captain closed your outcome card and nothing is left for you: the first mate is woken to close your task. Never with waiting_on_captain.",
      }),
    ),
    needs_firstmate: Type.Optional(
      Type.String({
        description:
          "What the first mate must do, in a few plain words, when only the first mate can carry out a captain decision you relay: a build he approved by reply, a merge, a discard, a stronger model, or unrelated work. Put his words verbatim and the final specification in text. When this turn ends the first mate is woken for this report, even with your card up or a wait declared, once any reply of his under your card has your answer. It asks for attention and authorizes nothing. Never for progress or news.",
      }),
    ),
  }),
  bind: (delegate) =>
    delegate.onReport &&
    (async (params, signal) => ({
      text: await callWithSignal(
        delegate.onReport!,
        [
          params.text,
          params.summary,
          {
            ...(params.validation
              ? {
                  validation: await keepValidationEvidence(
                    liveValidationInputSchema.parse(params.validation),
                    cardPictureRoot(delegate),
                  ),
                }
              : {}),
            ...(params.waiting_on_captain
              ? {
                  wait: {
                    reason: params.waiting_on_captain.reason,
                    ...(params.waiting_on_captain.card_id
                      ? { cardId: params.waiting_on_captain.card_id }
                      : {}),
                  },
                }
              : {}),
            ...(params.finished ? { finished: true } : {}),
            ...(params.needs_firstmate !== undefined
              ? { needsFirstmate: params.needs_firstmate }
              : {}),
          },
        ],
        signal,
      ),
    })),
});

export const NOTE_PROGRESS_TOOL = crewmateTool({
  name: NOTE_PROGRESS_TOOL_NAME,
  label: "Note progress",
  description: NOTE_PROGRESS_TOOL_DESCRIPTION,
  parameters: Type.Object({
    text: Type.String({ description: "One line, sentence case, factual" }),
    plan: Type.Optional(
      Type.Array(
        Type.Object({
          label: Type.String({
            description: "What the item is, in a few words",
          }),
          short: Type.String({
            description: "A word or two under its dot on the summary, cut there when it is longer",
          }),
          state: stringEnum(["done", "current", "next", "skipped"]),
        }),
        {
          description:
            "The whole list of what the task takes, in order, replacing the last one; under eight items is the aim, and the line folds what it cannot hold",
        },
      ),
    ),
  }),
  bind: ({ onProgress }) =>
    onProgress &&
    (async (params, signal) => ({
      text: await callWithSignal(onProgress, [params.text, params.plan], signal),
    })),
});

/**
 * The crewmate's thread answer. Refusals come back as tool TEXT (an unknown
 * or foreign card, empty words, an over-long reply) rather than as throws:
 * a conversational miss is guidance, not a failure of the turn.
 */
export const REPLY_TOOL = crewmateTool({
  name: REPLY_TOOL_NAME,
  label: "Reply in thread",
  description: REPLY_TOOL_DESCRIPTION,
  parameters: Type.Object({
    card_id: Type.String({ description: "The card whose thread you are answering in" }),
    text: Type.String({
      description: "Your answer: plain prose, sentence case, a few sentences",
    }),
  }),
  bind: ({ onReply }) =>
    onReply &&
    (async (params, signal) => ({
      text: await callWithSignal(onReply, [{ cardId: params.card_id, text: params.text }], signal),
    })),
});

/**
 * Every tool a crewmate can hold, in the order both runtimes serve them:
 * the card pair, the record pair, the report, the thread answer, the
 * read-only backlog, the knowledge pair (only a crewmate whose task has a
 * project or the references grant, in an alpha or development build, has
 * it, on this Mac or a computer that runs work), the
 * live-build checks (only a crewmate on the personal workspace has them),
 * and the pair where the project lives. A task's own browser is no tool:
 * its crewmate runs `infinitary-browser-axi` in its shell (docs/axi-commands.md).
 * This list is
 * the one spec (primitives P7): the Pi placement, the Claude tool server
 * and the self-source pin all read it, so adding a crewmate tool is one
 * entry here.
 */
export const CREWMATE_TOOLS = [
  EMIT_CARD_TOOL,
  CLOSE_CARD_TOOL,
  FILE_FOLLOWUP_TOOL,
  NOTE_PROGRESS_TOOL,
  REPORT_TOOL,
  REPLY_TOOL,
  TASKS_QUERY_TOOL,
  KNOWLEDGE_TOOL,
  RECORD_KNOWLEDGE_TOOL,
  LINT_PANEL_TOOL,
  PLACE_PANEL_TOOL,
  CAPTURE_PANEL_TOOL,
  PREPARE_CHANGE_TOOL,
  OPEN_CHANGE_TOOL,
  CHECK_CHANGE_TOOL,
  READ_WORKFLOW_TOOL,
  DOWNLOAD_ARTIFACT_TOOL,
  GITHUB_READ_TOOL,
  GITHUB_WRITE_TOOL,
] as const satisfies readonly CrewmateTool[];

/** This module, as the self-source map names where a crewmate tool is defined. */
export const CREWMATE_TOOLS_MODULE = "src/core/pi/crewmateTaskTools.ts";

/** The crewmate tool set as the self-source map records it, read off the spec. */
export function crewmateToolManifest(
  tools: readonly CrewmateTool[] = CREWMATE_TOOLS,
): { name: string; module: string }[] {
  return tools.map((tool) => ({ name: tool.name, module: CREWMATE_TOOLS_MODULE }));
}
