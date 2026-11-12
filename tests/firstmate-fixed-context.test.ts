import { describe, expect, it } from "vitest";
import { REVIEW_NEW_HEAD_NEXT } from "../src/core/orchestrator/reportWakes";
import { renderWake, type WakeFacts } from "../src/core/orchestrator/wakes";
import { SEQUENCES_SEED } from "../src/core/personal/sequencesSkill";
import {
  crewmateOwesCompletionRefusal,
  NOTE_NAMES_TASK_REFUSAL,
  steerNotAnswerRefusal,
} from "../src/core/pi/cardLint";
import { OLLAMA_MIN_CONTEXT } from "../src/core/pi/ollamaProfile";
import { LOCAL_CONTEXT_RESERVE, localInputFits } from "../src/core/pi/ollamaStream";
import { buildFirstmateSystemPrompt, FIRSTMATE_PROMPT_CORE } from "../src/core/pi/piResources";
import { piToolsOf } from "../src/core/pi/toolSpec";
import {
  CARD_REPLY,
  FIRSTMATE_CARD_AUTHORING,
  FIRSTMATE_HANDOFF,
} from "../src/core/prompts/cardContract";
import { firstmateTools } from "./helpers/firstmateTools";
import {
  FIRSTMATE_BUDGET,
  FIRSTMATE_PROMISED_CONVERSATION,
  fixedTokens,
  overLine,
  roomAtHardLine,
} from "./helpers/promptBudget";

/**
 * The fixed part of every Firstmate request: the served prompt, the
 * sequences served after it and the tool list. A model reads all of it
 * before the first word of conversation, on every ask, so its size is what
 * a small window pays first (FI3-539 measured 19,742 of the 20,480 tokens a
 * 32K local seat was then allowed; the fixed part crossed that line three
 * times in two days, one sentence at a time).
 *
 * Contract v4.59 (FI3-541) cut it by saying each rule once. Two things keep
 * it cut: a budget in the app's own count, and a ledger that holds every
 * rule the trim took out of one text to the text that still says it.
 */

/** A Firstmate tool as each seat is offered it. */
type ServedTool = { name: string; description: string; parameters: Schema };
type Schema = { description?: string; properties?: Record<string, Schema> };

async function fixedContext(includeRunbooks = true) {
  const tools = piToolsOf(await firstmateTools());
  return {
    systemPrompt: includeRunbooks
      ? `${buildFirstmateSystemPrompt()}\n\n${SEQUENCES_SEED.trim()}`
      : buildFirstmateSystemPrompt(),
    tools,
    served: tools as unknown as ServedTool[],
  };
}

/** A conversation of a given size, in the count the app's check gives a message. */
function conversation(tokens: number): Parameters<typeof localInputFits>[0]["messages"][number] {
  return { role: "user", content: "x".repeat(tokens * 4), timestamp: 0 };
}

/**
 * The budget for the fixed part is derived rather than kept by hand
 * (INF-416 piece H, findings P1 and P2; tests/helpers/promptBudget.ts): the
 * smallest local window's floor, minus the reserve, minus the conversation
 * that window promises. It is not a second number a revision raises.
 */
const PROMISED_CONVERSATION = FIRSTMATE_PROMISED_CONVERSATION;
const FIXED_CONTEXT_BOUNDARY = FIRSTMATE_BUDGET;

describe("the Firstmate's fixed context (contract v4.59)", () => {
  it("stays under its hard line by the app's own count", async () => {
    // 65,536 - 12,288 - 33,476. The pin is the derivation, not a ceiling kept beside it.
    expect(PROMISED_CONVERSATION).toBe(33_476);
    expect(FIXED_CONTEXT_BOUNDARY).toBe(19_772);
    // INF-2930: it fails only past the hard line; the prompt-budget check on
    // main holds the budget and files the trim.
    const tokens = fixedTokens(await fixedContext(false));
    expect(overLine("First mate", FIXED_CONTEXT_BOUNDARY, [{ label: "core", tokens }])).toEqual([]);
  });

  it("names a prototype only where it sends the ask to a plan (FI3-872)", async () => {
    const { systemPrompt, tools } = await fixedContext();
    const mentions = `${systemPrompt}\n${JSON.stringify(tools)}`
      .replace(/\s+/g, " ")
      .split(/(?<=\.)\s+/)
      .filter((sentence) => /prototype/i.test(sentence));
    expect(mentions).toEqual([
      expect.stringContaining("is a plan with a playable preview"),
      expect.stringContaining("it is this plan with a playable preview as the card"),
    ]);
  });

  it("leaves the smallest local window room for a working conversation", async () => {
    const { systemPrompt, tools } = await fixedContext(false);
    const fits = (tokens: number) =>
      localInputFits({ systemPrompt, tools, messages: [conversation(tokens)] }, OLLAMA_MIN_CONTEXT);
    // The app's own pre-send check on the window it requires of a local
    // model. INF-2930: a fixed part up to the hard line still leaves the
    // conversation the room that line leaves, less than the promised one
    // while an overrun waits for its trim.
    expect(fits(roomAtHardLine(FIXED_CONTEXT_BOUNDARY))).toBe(true);
    // The boundary leaves exactly that conversation, no separately kept slack.
    expect(OLLAMA_MIN_CONTEXT - LOCAL_CONTEXT_RESERVE - FIXED_CONTEXT_BOUNDARY).toBe(
      PROMISED_CONVERSATION,
    );
    // The check is the real one: it refuses what cannot fit.
    const room = OLLAMA_MIN_CONTEXT - LOCAL_CONTEXT_RESERVE - fixedTokens({ systemPrompt, tools });
    expect(fits(room)).toBe(true);
    expect(fits(room + 1)).toBe(false);
  });
});

/**
 * Where a rule the trim removed from one text is still said. `rule` names
 * what the removed sentence governed; `home` is the text it is still served
 * in - the Firstmate's fixed context, the wake it arises on, the refusal
 * that answers the call breaking it - and
 * `says` the words that carry it there.
 */
type Home =
  | "core"
  | "authoring"
  | "replies"
  | "handoff"
  | "sequences"
  | { wake: keyof typeof WAKES }
  | { refusal: keyof typeof REFUSALS }
  | { tool: string; parameter?: string };

const BUILDER = { id: "t1", title: "Fix the pin" };
const REVIEW = { id: "r1", title: "Review: Fix the pin" };
const verdictFacts = (): WakeFacts => ({
  kind: "review-verdict",
  task: REVIEW,
  builder: BUILDER,
  crewmate: "crewmate 2",
  verdict: "findings",
  excerpt: "verdict: findings",
  cards: [],
});

/** The wakes a ledger rule lives on, as the host serves them (FI3-566 cut C, INF-490). */
const WAKES = {
  findings: verdictFacts(),
  // Session audit finding E: the fixer preamble now reaches the builder directly.
  "builder findings": {
    kind: "review-handoff",
    from: REVIEW.id,
    head: "0123456789abcdef0123456789abcdef01234567",
    stage: "fix",
    excerpt: "The read races its flush.",
    findings: ["F1 error await the flush - auto-fix"],
  },
  "builder report": {
    kind: "report",
    task: BUILDER,
    crewmate: "crewmate 1",
    excerpt: "Fixed F1.",
    filed: [],
    cards: [],
    review: { key: "FI3-9", verdict: "findings", head: "0123456789ab" },
  },
  "reviewer acknowledgment": {
    kind: "review-unstated",
    task: REVIEW,
    builder: BUILDER,
    crewmate: "crewmate 2",
    excerpt: "Standing by.",
  },
  pass: {
    kind: "review-handoff",
    from: "FI3-9",
    head: "0123456789abcdef0123456789abcdef01234567",
    stage: "ship",
    excerpt: "verdict: pass",
  },
  // INF-490: the wakes that carry what the core no longer repeats.
  "captain start": {
    kind: "captain-start",
    task: { ...BUILDER, key: "FI3-8" },
    move: "start",
    at: 0,
  },
  "captain queue": {
    kind: "captain-start",
    task: { ...BUILDER, key: "FI3-8" },
    move: "queue",
    at: 0,
  },
  "ci cap": { kind: "ci-cap", task: BUILDER, rounds: 3, cap: 3, head: "0123456789ab" },
} satisfies Record<string, WakeFacts>;

/**
 * The refusals that hold an enforced rule, served when a call breaks it
 * (INF-490: a rule the host enforces is said once, as its refusal's text).
 */
const REFUSALS = {
  "a note naming a task": NOTE_NAMES_TASK_REFUSAL,
  "a second card beside a crewmate's": steerNotAnswerRefusal(BUILDER.id, {
    id: "card-t1",
    title: "Fixed the pin",
  }),
  "a merge card its crewmate owes": crewmateOwesCompletionRefusal(BUILDER.id),
};

const LEDGER: { rule: string; home: Home; says: string }[] = [
  // FI3-566 cut C moves the reviewed-work steps out of the core; INF-1876
  // makes the review an operation at any care, what each care asks the care
  // runbook's.
  {
    rule: "a review is commissioned when the builder's report or the captain asks for one",
    home: "core",
    says: "when a builder's report or the captain asks for one, spawn_crewmate with review_of naming that task and the user's words",
  },
  {
    rule: "what each care asks is the care guidance's, never a hold of the host's",
    home: "core",
    says: "what each care asks is the care guidance's, never a hold of the host's",
  },
  {
    rule: "every fix and review steer carries the captain's latest decision",
    home: "core",
    says: "Carry the latest captain decision into every fix and review steer; a genuinely new, materially different problem is still reviewable.",
  },
  {
    rule: "every auto-fix finding reaches the builder verbatim, with the fixer preamble",
    home: { wake: "builder findings" },
    says: "double-check each finding is legitimate before changing code, identify all sibling sites of the broken invariant, repair the whole defect class with one small correction rather than new machinery, retrace normal callers, never resolve a finding by reverting the author's intentional change, never implement a finding the captain declined or undo a fix the captain chose merely to satisfy an earlier goal, and verify each is resolved.",
  },
  {
    rule: "info findings never block",
    home: { wake: "findings" },
    says: "Info findings never block and need no steer.",
  },
  {
    rule: "an ask-user finding is settled by the user's words or one card per round",
    home: { wake: "findings" },
    says: "Decide an ask-user finding yourself when the user's own words already settle it; the rest are ONE decision card per round on the builder's task, with the step you would take as its default.",
  },
  {
    // INF-125 also binds a pending review to current proof/state, not just code.
    rule: "new code or proof facts are re-reviewed with the declined findings ignored",
    home: { wake: "builder report" },
    says: REVIEW_NEW_HEAD_NEXT,
  },
  {
    rule: "an idle reviewer is never steered for a stand-by or a status",
    home: { wake: "reviewer acknowledgment" },
    says: "an idle reviewer needs no stand-by and no status",
  },
  {
    rule: "the host owns routine re-review handoffs",
    home: { wake: "builder report" },
    says: "The host owns routine re-review handoffs.",
  },
  {
    rule: "after a pass the builder follows its brief's delivery",
    home: { wake: "pass" },
    says: "Follow your brief's delivery for the reviewed version, then show its completion card.",
  },
  // FI3-566 removes repeats from the captain-approved sequences seed.
  {
    rule: "a continuation waits on its origin before it starts when ready",
    home: "core",
    says: "first link_tasks blocks from origin to filing, then set update_task start_policy when-ready",
  },
  {
    rule: "a merge with no task gets one plain-reply ask",
    home: "core",
    says: "Only a merge with no task may be asked for once, with a plain-reply button.",
  },
  {
    rule: "the core keeps parent creation explicit",
    home: "core",
    says: "the parent is create_task",
  },
  // Taken out of the core, where a tool's own words already say it.
  {
    rule: "a spawn returns at once and its results arrive later",
    home: { tool: "spawn_crewmate" },
    says: "Returns the task id immediately; the crewmate's results arrive later as [fm-op] messages, so end your turn.",
  },
  {
    rule: "what a spawn's intent carries",
    home: { tool: "spawn_crewmate" },
    says: "Pass a goal, the user's words verbatim, typed constraints and an optional delivery note;",
  },
  {
    rule: "the waits that queue a spawn",
    home: { tool: "spawn_crewmate", parameter: "start_after" },
    says: "Queue this work instead of starting it now, until one of these",
  },
  {
    rule: "blockers queue a spawn",
    home: { tool: "spawn_crewmate", parameter: "blocked_by" },
    says: "must close before this work starts; queues it instead of starting now",
  },
  {
    rule: "a spawn under a larger task names its parent",
    home: { tool: "spawn_crewmate", parameter: "parent" },
    says: "The task this work belongs under",
  },
  {
    rule: "a personal_ui spawn passes no repo_id and names the surface it changes",
    home: { tool: "spawn_crewmate" },
    says: "the host binds the personal workspace itself (no repo_id) and the crewmate builds in place, so name an existing surface's id in the goal for a change",
  },
  {
    rule: "lessons and the captain's panels use personal_ui",
    home: { tool: "spawn_crewmate" },
    says: "Lessons and the user's own panels on the rails use personal_ui true",
  },
  // The captain's step titles: each task field is said once, where it lives.
  {
    rule: "a task's title says what it does, not its place in a plan",
    home: { tool: "create_task", parameter: "title" },
    says: 'Sentence-case title saying what it does (max 64 chars), e.g. "Ship the bridge to alpha", not its place in a plan',
  },
  {
    rule: "INF-1366: a goal names only the asked-for change; preservation is a constraint, not a current-behavior claim",
    home: { tool: "spawn_crewmate", parameter: "goal" },
    says: "One plain sentence: only the asked-for change. Preserve via constraints: “leave ... as it is”, not how it works now.",
  },
  {
    rule: "a planned task carries the user's words verbatim",
    home: { tool: "spawn_crewmate", parameter: "user_words" },
    says: "The user's request verbatim; outranks every elaboration downstream",
  },
  {
    rule: "a created task waits on request until it is started",
    home: { tool: "create_task", parameter: "start_policy" },
    says: "on-request (the default): no crewmate starts on it until update_task start_now",
  },
  {
    rule: "update_task edits, moves and drops a task",
    home: { tool: "update_task" },
    says: "To drop a task pass drop true with reason",
  },
  {
    rule: "link_tasks records typed edges and refuses a cycle as text",
    home: { tool: "link_tasks" },
    says: "a cycle is refused as text",
  },
  // INF-2714, the captain's direction A: an answer is the first mate's own card.
  {
    rule: "an answer names its tasks in its words and related, never as its task",
    home: "core",
    says: "An answer names it only in words and related.",
  },
  {
    rule: "a note naming a task as its own is refused, apart from a review relay",
    home: { refusal: "a note naming a task" },
    says: "a note is your own card: drop task_id, name the tasks it is about in its words and pass their ids or keys in related",
  },
  {
    rule: "an overlapping card is revised in place, a distinct finding is a new card",
    home: { tool: "emit_card" },
    says: "Reuse an open card's id to revise it in place when new information augments or overlaps it; a distinct finding is a new card",
  },
  {
    rule: "an effect is the host's, an effect-free choice returns",
    home: { tool: "emit_card" },
    says: "An action's effect is what the host does on the click; with no effect the click returns to you as a message.",
  },
  {
    rule: "what cannot be grounded goes to a crewmate, never to imagination",
    home: "core",
    says: "is crewmate work. Spawn an investigation with the read-only constraint when no changes are needed",
  },
  {
    rule: "basis names the task whose report is the spec",
    home: { tool: "spawn_crewmate", parameter: "shape" },
    says: "basis: The task (id or key) whose report is this work's spec, or whose reproduction it fixes. Name it only when that task really carries it",
  },
  {
    rule: "premium only on the user's words or premium click",
    home: { tool: "spawn_crewmate", parameter: "shape" },
    says: 'premium_ask: True only when the user asked for premium or the best model in words, or clicked your "Try a premium model" action. Never your own judgment.',
  },
  {
    rule: "a model override only when the user named a model",
    home: { tool: "spawn_crewmate", parameter: "shape" },
    says: "Only when the user named one; it wins when available, else normal routing.",
  },
  {
    rule: "a model named for a task, filed or started, keeps that task (INF-849)",
    home: { tool: "update_task" },
    says: "When the user names a model, pass override_model_id (start_now starts it now): it keeps its key and links; never drop it to spawn a replacement.",
  },
  {
    rule: "work the captain did not ask for is declared internal, the captain's own ask never is",
    home: { tool: "spawn_crewmate", parameter: "shape" },
    says: "internal_step: True when the captain did not ask for this work: a sequence step, a helper another task needs, a crewmate's request, or work you start unasked. Its drop or finish puts no note up; a merge or release still does. A step's answer goes to the next step, and once that step has started you close it with settle_task done, why answered. Omit it when the captain asked for this result - by message, card choice or schedule",
  },
  {
    rule: "the same internal-step rule on a planned step",
    home: "sequences",
    says: "An answer I ask for myself is never an internal step",
  },
  {
    rule: "an internal step is declared when it is created",
    home: "sequences",
    says: "Each step you add yourself is an internal step: say so when you create it (internal_step)",
  },
  {
    rule: "a parent's children do its work",
    home: { tool: "create_task", parameter: "start_policy" },
    says: "Leave a parent on request: its children do its work",
  },
  {
    rule: "a parent completes with its last step",
    home: "sequences",
    says: "The parent completes when its last step merges.",
  },
  {
    rule: "a delivery ask leaves the repository's default as it was",
    home: { tool: "spawn_crewmate", parameter: "shape" },
    says: "delivery_ask: Only when the user asked in words for this task to ship as a pull request or to stay local. The repository's default is unchanged.",
  },
  {
    rule: "an autonomy ask only on the user's words",
    home: { tool: "spawn_crewmate", parameter: "shape" },
    says: "autonomy_ask: Only when the user said in words whether this task merges its green work itself (true) or asks first (false).",
  },
  {
    // INF-3171: the captain's question under its plan card - "do we have first
    // mate instruction asking first mate to prefer passing original user words
    // for such requirements?" - answered with one standing rule; INF-3173's
    // follow-up makes the words preferred, refined only when they are unclear.
    rule: "a captain requirement prefers their own quoted words, reworded only when unclear",
    home: "core",
    says: "When a goal, constraint, message to a crewmate or standing direction carries a requirement of the captain's - a number, a limit or what it applies to - prefer their own words for it, in quotes; reword it only where their words would leave the requirement unclear, never as a habit.",
  },
  {
    rule: "what an escalation spawn carries over",
    home: "core",
    says: "spawn_crewmate again with escalate_from naming that task, their words verbatim as user_words, and the original goal",
  },
  {
    rule: "who merges a reviewed task once it passes and is green",
    home: "core",
    says: "Green: the crewmate's merge card decides, never you; the app merges from it with autonomy on.",
  },
  {
    rule: "a note is a durable directive, never an intention or progress",
    home: { tool: "record_knowledge" },
    says: "A direction is an imperative directive, not an observation.",
  },
  {
    rule: "an existing note is revised, never duplicated",
    home: { tool: "record_knowledge" },
    says: "Revise an existing direction, never duplicate it. Skip trivia, raw dumps, task progress and TODOs.",
  },
  {
    rule: "an intention is a schedule or a queued task",
    home: { tool: "record_knowledge" },
    says: "Intentions belong in schedule_prompt or a queued task.",
  },
  {
    rule: "a removal names its surface by id",
    home: { tool: "personalize" },
    says: "Name a surface by id from your-surfaces",
  },
  {
    rule: "where an added panel may come from",
    home: { tool: "install_plugin" },
    says: "from npm (a package, optionally @version), a git address (optionally #tag, branch or commit), or a folder on this computer",
  },
  {
    rule: "a filing left planned carries one line on its record",
    home: { tool: "update_task", parameter: "verdict" },
    says: "One line when you leave a filing planned: what waiting costs and who pays it, and what would start it. The captain reads it on the record.",
  },
  // Taken out of a tool's text, where the core already says it.
  {
    rule: "idle crew stays resumable until explicitly settled (WI-11, INF-1279)",
    home: "core",
    says: "An idle crewmate stays resumable until you settle it.",
  },
  {
    rule: "crew_status outranks memory",
    home: "core",
    says: "Current context and crew_status outrank transcripts for fleet state.",
  },
  {
    rule: "a red check is diagnosed before it is fixed",
    home: "core",
    says: "Read PR ci from its report or crew_status. Not green: failed-step/log diagnosis;",
  },
  {
    rule: "a located project is set up, then used",
    home: "core",
    says: "locate_project, then app_change project-setup, then proceed",
  },
  {
    rule: "theme and panel placement are app_change, a new panel is crewmate work",
    home: "core",
    says: "is one app_change call (theme or panel)",
  },
  {
    rule: "the Firstmate authors no card about an added panel",
    home: "core",
    says: "the host asks the captain on its own card, so author none",
  },
  {
    rule: "removing an added panel is personalize",
    home: { tool: "personalize" },
    says: "takes an added panel away with its data",
  },
  {
    rule: "where a card's task id comes from",
    home: "core",
    says: "Find it first: the about line, the crew and open cards in the context block, crew_status, or the tasks query, which reads the backlog.",
  },
  {
    // Shared cards (INF-2214): the first mate writes on the crewmate's card itself.
    rule: "a carded task is written on, never answered beside",
    home: { refusal: "a second card beside a crewmate's" },
    says: "write on that card instead of a second one beside it. Read it with tasks card, then emit_card with id card-t1",
  },
  {
    rule: "every action closes the card, and a revision is asked by reply",
    home: { tool: "emit_card" },
    says: "every action closes the card, and changes come by reply, never a revise button",
  },
  {
    rule: "the host sizes a card from its body, and a hint only widens",
    home: { tool: "emit_card", parameter: "width" },
    says: "pass it only to require more room; it only widens",
  },
  // Taken out of a tool's text at 19,710 (FI3-1268), where the core or the
  // tool's own parameter already says it.
  {
    rule: "the tasks a card mentions link to it",
    home: { tool: "emit_card", parameter: "related" },
    says: "Tasks it mentions, by id or key; each one's record links to it",
  },
  {
    rule: "an escalation never follows a crewmate's own report or an operational wake",
    home: "core",
    says: "Never on an operational wake, and never from a crewmate's own account of itself",
  },
  // Taken out of the core at 19,616 (FI3-1805), where a tool or the core's
  // own rules already say it.
  {
    rule: "an escalation spawn replaces the rejected attempt a tier up",
    home: { tool: "spawn_crewmate", parameter: "shape" },
    says: "The host stops that attempt, keeps its branch and report, and runs this one a tier up.",
  },
  {
    rule: "a crewmate's card is a thread with that crewmate",
    home: "core",
    says: "What the captain types under a crewmate's card reaches that crewmate directly",
  },
  {
    rule: "the fleet is the Firstmate's to operate",
    home: "core",
    says: "operate - fleet and self management: repositories, schedules, notes, and the captain's own surfaces. Do it now with your tools",
  },
  // Taken out of the authoring text, where its neighbours already say it.
  {
    rule: "a card body loads nothing",
    home: "authoring",
    says: "rendered in a sandboxed frame with the app stylesheet; no network",
  },
  {
    rule: "flowing text in a figure is foreignObject",
    home: "authoring",
    says: "text elements do not wrap, so shorten labels or use foreignObject for flowing text",
  },
  {
    rule: "each figure lights its own element",
    home: "authoring",
    says: "one accent per figure, not one per card",
  },
  {
    rule: "the open body is the answer, figures and questions; the rest folds under a named expand",
    home: "authoring",
    says: "the rest - reasons, steps, caveats, a builder's spec, evidence, paths - folds in <details> whose <summary> names it",
  },
  // INF-416 piece H: the handoff no longer restates the core's read-by-key rule.
  {
    rule: "on approval, read the saved plan by key before filing",
    home: "core",
    says: "Read saved plans with tasks by key and create accepted work yourself",
  },
  // The same piece: update_task no longer restates the separate basis-then-start call.
  {
    rule: "a missing basis is set, and read back, before a separate start",
    home: "handoff",
    says: "call update_task basis first, read success, then call update_task start_now separately",
  },
  // INF-490: an enforced rule is said once, as its refusal; a rule a wake or
  // a tool already says leaves the core.
  {
    rule: "a merge decision on a crewmate's task is its merge card",
    home: { refusal: "a merge card its crewmate owes" },
    says: "a crewmate's merge card is the one merge decision for each of its pull requests",
  },
  {
    rule: "released needs independently verified delivery",
    home: { tool: "settle_task" },
    says: "released (you independently verified its delivery through an external release; evidence names it)",
  },
  {
    rule: "the captain's Start applies his directions, then starts",
    home: { wake: "captain start" },
    says: "Apply every standing direction that bears on it with update_task (merging, delivery, care, model, runs_on), passing direction with each direction's id, then update_task start_now. Never decline their Start",
  },
  {
    rule: "a task the captain queued gets its directions and no start",
    home: { wake: "captain queue" },
    says: "Do not start it: the host starts it when its wait ends.",
  },
  // INF-547's closing sentence: settle_task and the core no longer restate each other.
  {
    rule: "a settle names the task id from crew_status",
    home: { tool: "settle_task" },
    says: "Use crew_status to pick the task id; never guess among several matches.",
  },
  {
    rule: "a settle refused for open children runs its ways out, keeping them planned on the captain's choice",
    home: "core",
    says: "a merge that keeps a task's open children planned is settle merge with proceed_with_open",
  },
  {
    rule: "proceed_with_open settles and keeps open children planned",
    home: { tool: "settle_task", parameter: "proceed_with_open" },
    says: "Settle and keep open children planned, after the captain chose",
  },
  // INF-799 piece 3: the program shapes took the guide's repeats of a tool,
  // the handoff or its own preamble.
  {
    rule: "a queued update adds prerequisites and removes none",
    home: { tool: "update_task", parameter: "blocked_by" },
    says: "Adds any not yet linked; never removes.",
  },
  {
    rule: "the queue starts approved pieces as their prerequisites clear",
    home: "handoff",
    says: "Acceptance queues approved plan pieces (when-ready); the host starts each as its prerequisites clear.",
  },
  {
    rule: "autonomy is read to report who merges",
    home: "handoff",
    says: "read the task’s current fact",
  },
  {
    rule: "a piece's basis is the approved answer whatever its kind",
    home: "handoff",
    says: "naming the answer's task as basis - the chosen plan or investigation",
  },
  {
    rule: "a step's crewmate gets the captain's words verbatim, outranking its line",
    home: { tool: "spawn_crewmate", parameter: "user_words" },
    says: "The user's request verbatim; outranks every elaboration downstream",
  },
  {
    rule: "the project line reaches its crewmate word for word",
    home: "sequences",
    says: "A step's line from this document reaches its crewmate word for word",
  },
  {
    rule: "a project setup uses the settings the captain submits",
    home: "handoff",
    says: "Actual submissions override proposal defaults",
  },
  {
    rule: "the first mate chooses no tier or model for a lookup",
    home: "core",
    says: "You choose no model and no reasoning class; you report facts and the host routes.",
  },
  {
    rule: "a panel is removed only on the captain's own ask",
    home: { tool: "personalize" },
    says: "Remove a surface, only on the captain's own turn",
  },
  {
    rule: "a skipped plan is declared on the direct build",
    home: { tool: "spawn_crewmate", parameter: "shape" },
    says: "skipped_plan_because: On a direct build with no chosen basis",
  },
  // INF-1272 makes room for the quit rule by saying two rules once.
  {
    rule: "an emote never stands in for a required card or work",
    home: "core",
    says: "use it only as fitting visual acknowledgement, never instead of a required card or action",
  },
  {
    rule: "lifecycle control goes through interrupt_crewmate, never a steer",
    home: { tool: "interrupt_crewmate" },
    says: "Never send lifecycle instructions as steer text.",
  },
  // INF-1316 brings main back inside the budget: personalize's description drops what the core says.
  {
    rule: "a surface removed with personalize is answered by its feed line, never a card",
    home: "core",
    says: "removing a surface is one personalize call, a lasting instruction for the panels built for the captain is one app_change direction scoped to the personal workspace, and the feed line is the whole answer - no card.",
  },
  // INF-1386 brings main back inside the budget: settle_task's description drops what the core says.
  {
    rule: "closing the captain's settle card keeps its idle task, which stays resumable",
    home: "core",
    says: "nothing parks or returns on its own, and closing a card is keep.",
  },
  // INF-1656 brings main back inside the budget: INF-1623 said its revision answer in two texts,
  // and each now keeps only the part its contract revision named it the home of.
  {
    rule: "every revision while answering carries its own answer as reply",
    home: "replies",
    says: "emit_card with SAME id and answer as reply on every revision while answering",
  },
  {
    rule: "a revision's answer says what changed where",
    home: { tool: "emit_card", parameter: "reply" },
    says: "saying what changed where",
  },
  // INF-2225 fits shared cards beside main's card origin words: each rule below
  // was said twice, and keeps the one home named here.
  {
    rule: "only a card's own author closes it",
    home: { tool: "close_card" },
    says: "Withdraw a card of YOUR OWN",
  },
  {
    rule: "an open card's id revises it in place",
    home: { tool: "emit_card" },
    says: "Reuse an open card's id to revise it in place",
  },
  {
    rule: "a card body is a raw HTML fragment",
    home: { tool: "emit_card" },
    says: "body is a raw HTML fragment",
  },
  {
    rule: "a card names a task as its own only when its buttons act on it",
    home: { tool: "emit_card" },
    says: "Pass task_id only when the buttons act on that task",
  },
  {
    rule: "a filing answering one of several read wakes names it",
    home: { tool: "create_task", parameter: "origin" },
    says: "the one this answers, by automation id, card id or reporting task key",
  },
  {
    rule: "what each priority number means",
    home: { tool: "create_task", parameter: "priority" },
    says: "0 urgent, 1 high, 2 normal (default), 3 low",
  },
  {
    rule: "a drop names its reason",
    home: { tool: "update_task" },
    says: "To drop a task pass drop true with reason",
  },
  {
    rule: "a duplicate's flag names both cards",
    home: { tool: "flag_duplicate" },
    says: "pass the duplicate's card id and the id of the earlier card it repeats",
  },
];

describe("every rule the trim took out of one text is still served (contract v4.59)", () => {
  const flat = (text: string) => text.replace(/\s+/g, " ");

  it("says each one in the home the ledger names", async () => {
    const { served } = await fixedContext();
    const textOf = (home: Home): string => {
      if (home === "core") return FIRSTMATE_PROMPT_CORE;
      if (home === "authoring") return FIRSTMATE_CARD_AUTHORING;
      if (home === "replies") return CARD_REPLY;
      if (home === "handoff") return FIRSTMATE_HANDOFF;
      if (home === "sequences") return SEQUENCES_SEED;
      if ("wake" in home) return renderWake({ facts: WAKES[home.wake] });
      if ("refusal" in home) return REFUSALS[home.refusal];
      const tool = served.find((candidate) => candidate.name === home.tool);
      if (!tool) throw new Error(`the Firstmate holds no ${home.tool}`);
      if (!home.parameter) return tool.description;
      const parameter = tool.parameters.properties?.[home.parameter];
      if (!parameter?.description) {
        throw new Error(`${home.tool}.${home.parameter} has no description`);
      }
      return parameter.description;
    };
    const missing = LEDGER.filter(({ home, says }) => !flat(textOf(home)).includes(says)).map(
      ({ rule }) => rule,
    );
    expect(missing, "a rule the Firstmate is no longer told").toEqual([]);
  });

  it("serves each home's text whole to the seat", async () => {
    // The ledger's homes are what the model reads: the served prompt carries
    // the core, the authoring and card-reply texts, and every tool arrives with its words.
    const { systemPrompt, served } = await fixedContext();
    expect(systemPrompt).toContain(FIRSTMATE_PROMPT_CORE);
    expect(systemPrompt).toContain(FIRSTMATE_CARD_AUTHORING);
    expect(systemPrompt).toContain(CARD_REPLY);
    expect(systemPrompt).toContain(FIRSTMATE_HANDOFF);
    expect(systemPrompt).toContain(SEQUENCES_SEED.trim());
    const tools = new Set(served.map((tool) => tool.name));
    for (const { home } of LEDGER) {
      if (typeof home !== "string" && "tool" in home) expect(tools, home.tool).toContain(home.tool);
    }
  });
});

describe("what an empty blocked_by declares has one home (INF-461)", () => {
  // INF-416 piece I said it once, on create_task's blocked_by; piece K said it
  // again on update_task's and in the refusal. The captain chose the one home
  // again (INF-460): update_task's parameter and the refusal point there.
  it("is said only on create_task's blocked_by, and update_task's points there", async () => {
    const { systemPrompt, served } = await fixedContext();
    const texts: { where: string; text: string }[] = [{ where: "prompt", text: systemPrompt }];
    const walk = (where: string, schema: Schema) => {
      if (schema.description) texts.push({ where, text: schema.description });
      for (const [name, inner] of Object.entries(schema.properties ?? {})) {
        walk(`${where}.${name}`, inner);
      }
    };
    // Every text served about a tool that takes prerequisites.
    for (const tool of served.filter((candidate) => candidate.parameters.properties?.blocked_by)) {
      texts.push({ where: tool.name, text: tool.description });
      walk(tool.name, { properties: tool.parameters.properties });
    }
    expect(texts.filter(({ text }) => text.includes("[]")).map(({ where }) => where)).toEqual([
      "create_task.blocked_by",
    ]);
    const update = served.find((tool) => tool.name === "update_task");
    expect(update?.parameters.properties?.blocked_by?.description).toContain(
      "As create_task's blocked_by",
    );
  });
});
