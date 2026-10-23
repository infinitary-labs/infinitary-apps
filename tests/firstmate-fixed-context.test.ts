import { describe, expect, it } from "vitest";
import { renderRigorSection } from "../src/core/orchestrator/intentBrief";
import { REVIEW_NEW_HEAD_NEXT, renderWake, type WakeFacts } from "../src/core/orchestrator/wakes";
import { SEQUENCES_SEED } from "../src/core/personal/sequencesSkill";
import {
  crewmateOwesCompletionRefusal,
  NOTE_NEEDS_TASK_REFUSAL,
  steerNotAnswerRefusal,
} from "../src/core/pi/cardLint";
import { OLLAMA_MIN_CONTEXT } from "../src/core/pi/ollamaProfile";
import { LOCAL_CONTEXT_RESERVE, localInputFits } from "../src/core/pi/ollamaStream";
import { buildFirstmateSystemPrompt, FIRSTMATE_PROMPT_CORE } from "../src/core/pi/piResources";
import { piToolsOf } from "../src/core/pi/toolSpec";
import { FIRSTMATE_CARD_AUTHORING, FIRSTMATE_HANDOFF } from "../src/core/prompts/cardContract";
import { firstmateTools } from "./helpers/firstmateTools";

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

async function fixedContext() {
  const tools = piToolsOf(await firstmateTools());
  return {
    systemPrompt: `${buildFirstmateSystemPrompt()}\n\n${SEQUENCES_SEED.trim()}`,
    tools,
    served: tools as unknown as ServedTool[],
  };
}

/** The app's own count of the fixed part (`localInputFits`): characters / 4. */
function fixedTokens(context: { systemPrompt: string; tools: unknown }): number {
  return Math.ceil((context.systemPrompt.length + JSON.stringify(context.tools).length) / 4);
}

/** A conversation of a given size, in the count the app's check gives a message. */
function conversation(tokens: number): Parameters<typeof localInputFits>[0]["messages"][number] {
  return { role: "user", content: "x".repeat(tokens * 4), timestamp: 0 };
}

/**
 * The boundary for the fixed part, derived rather than kept by hand
 * (INF-416 piece H, findings P1 and P2). It is the smallest local window's
 * floor, minus the reserve, minus the conversation that window promises:
 * ten status blocks of the size FI3-539 recorded, plus the recent tokens
 * shortening always keeps. A change that would cross it trims first. The
 * boundary is not a second number a revision raises.
 */
const PROMISED_CONVERSATION = 10 * 2_938 + 4_096;
const FIXED_CONTEXT_BOUNDARY = OLLAMA_MIN_CONTEXT - LOCAL_CONTEXT_RESERVE - PROMISED_CONVERSATION;

describe("the Firstmate's fixed context (contract v4.59)", () => {
  it("stays inside its budget by the app's own count", async () => {
    // 65,536 - 12,288 - 33,476. The pin is the derivation, not a ceiling kept beside it.
    expect(PROMISED_CONVERSATION).toBe(33_476);
    expect(FIXED_CONTEXT_BOUNDARY).toBe(19_772);
    expect(fixedTokens(await fixedContext())).toBeLessThanOrEqual(FIXED_CONTEXT_BOUNDARY);
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
    const { systemPrompt, tools } = await fixedContext();
    const fits = (tokens: number) =>
      localInputFits({ systemPrompt, tools, messages: [conversation(tokens)] }, OLLAMA_MIN_CONTEXT);
    // The app's own pre-send check on the window it requires of a local
    // model: the fixed part, then ten status blocks the size of the one
    // FI3-539 recorded (2,938 tokens) beside the 4,096 recent tokens that
    // shortening always keeps.
    expect(fits(PROMISED_CONVERSATION)).toBe(true);
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
 * that answers the call breaking it, or the builder's reviewed brief - and
 * `says` the words that carry it there.
 */
type Home =
  | "core"
  | "authoring"
  | "handoff"
  | "sequences"
  | "reviewed brief"
  | { wake: keyof typeof WAKES }
  | { refusal: keyof typeof REFUSALS }
  | { tool: string; parameter?: string };

const BUILDER = { id: "t1", title: "Fix the pin" };
const REVIEW = { id: "r1", title: "Review: Fix the pin" };
const verdictFacts = (briefed: boolean): WakeFacts => ({
  kind: "review-verdict",
  task: REVIEW,
  builder: BUILDER,
  crewmate: "crewmate 2",
  verdict: "findings",
  excerpt: "verdict: findings",
  cards: [],
  briefed,
});

/** The wakes a ledger rule lives on, as the host serves them (FI3-566 cut C, INF-490). */
const WAKES = {
  findings: verdictFacts(true),
  "findings, brief predates the care": verdictFacts(false),
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
    kind: "review-passed",
    task: BUILDER,
    reviewKey: "FI3-9",
    crewmate: "crewmate 2",
    derived: false,
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
  "a note with no task": NOTE_NEEDS_TASK_REFUSAL,
  "a second card beside a crewmate's": steerNotAnswerRefusal(BUILDER.id, {
    id: "card-t1",
    title: "Fixed the pin",
  }),
  "a merge card its crewmate owes": crewmateOwesCompletionRefusal(BUILDER.id),
};

const LEDGER: { rule: string; home: Home; says: string }[] = [
  // FI3-566 cut C moves the reviewed-work steps out of the core.
  {
    rule: "a review is commissioned once the builder reports its work committed",
    home: "core",
    says: "when the builder reports its work committed, spawn_crewmate with review_of naming that task and the user's words",
  },
  {
    rule: "every fix and review steer carries the captain's latest decision",
    home: "core",
    says: "Carry the latest captain decision into every fix and review steer; a genuinely new, materially different problem is still reviewable.",
  },
  {
    rule: "the builder fixes findings by the fixer preamble",
    home: "reviewed brief",
    says: "To fix them, double-check each finding is legitimate before changing code, identify all sibling sites of the broken invariant, repair the whole defect class with one small correction rather than new machinery, retrace normal callers, never resolve a finding by reverting the author's intentional change, never implement a finding the captain declined or undo a fix the captain chose merely to satisfy an earlier goal, and verify each is resolved.",
  },
  {
    rule: "every auto-fix finding reaches the builder verbatim",
    home: { wake: "findings" },
    says: "Steer the builder with every auto-fix finding verbatim; its brief says how to fix them.",
  },
  {
    rule: "a builder not briefed reviewed hears the fixer preamble with the findings",
    home: { wake: "findings, brief predates the care" },
    says: "Steer the builder with every auto-fix finding verbatim, prefixed with - double-check each finding is legitimate before changing code",
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
    rule: "a reviewer is steered only for a re-review at a new head",
    home: { wake: "builder report" },
    says: "Never steer the reviewer otherwise - an idle reviewer needs no stand-by and no status.",
  },
  {
    rule: "after a pass the builder pushes, opens its PR and drives CI green",
    home: { wake: "pass" },
    says: "Steer the builder to push, open the PR and drive CI green; its PR report is then handled like any other.",
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
    says: "Pass a structured intent - a one-sentence goal, the user's words verbatim, typed constraints, and an optional delivery note",
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
    rule: "a planned task's goal is one sentence of what done looks like",
    home: { tool: "spawn_crewmate", parameter: "goal" },
    says: "One sentence: what done looks like, in plain language",
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
  {
    rule: "an answer about existing work names its task",
    home: "core",
    says: "an answer about existing work carries that task_id",
  },
  {
    rule: "a one-off note asserts standalone",
    home: { refusal: "a note with no task" },
    says: "or standalone true only when the ask is a one-off with no connection or consequence to any work",
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
    rule: "a step you add yourself is declared internal, the captain's own ask never is",
    home: { tool: "spawn_crewmate", parameter: "shape" },
    says: "internal_step: True when you add this task yourself as an internal step of a sequence you run: its answer goes to the next step, and once that step has started you close it with settle_task answered. Omit it when the captain asked for this result themselves",
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
    rule: "what an escalation spawn carries over",
    home: "core",
    says: "spawn_crewmate again with escalate_from naming that task, their words verbatim as user_words, and the original goal",
  },
  {
    rule: "who merges a reviewed task once it passes and is green",
    home: "core",
    says: "Green with autonomy on: settle_task merge-pr; otherwise the crewmate's completion card decides, never yours.",
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
    rule: "an idle finished crewmate stays resumable until merged or discarded",
    home: "core",
    says: "An idle crewmate that finished its work is not settled until you merge or discard it - it stays resumable until then.",
  },
  {
    rule: "crew_status outranks memory",
    home: "core",
    says: "Current context and crew_status outrank transcripts for fleet state.",
  },
  {
    rule: "only a card's own author closes it",
    home: "core",
    says: "A card is never yours to close but your own",
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
    says: "Find it first: the about line, the tasks index in the context block, crew_status, or the tasks query.",
  },
  {
    rule: "a carded task is revised through its crewmate",
    home: { refusal: "a second card beside a crewmate's" },
    says: "steer the crewmate with steer_crewmate to revise card card-t1 (same id) with what you would add, instead of answering it in a new card",
  },
  {
    rule: "every action closes the card, and a revision is asked by reply",
    home: { tool: "emit_card" },
    says: "every action closes the card, and changes come by reply, never a revise button",
  },
  {
    rule: "the host sizes a card from its body, and a hint only widens",
    home: { tool: "emit_card", parameter: "width" },
    says: "pass it only to require more room; it can only widen, never narrow",
  },
  // Taken out of a tool's text at 19,710 (FI3-1268), where the core or the
  // tool's own parameter already says it.
  {
    rule: "a note about no existing work asserts standalone",
    home: { tool: "emit_card", parameter: "standalone" },
    says: "true for a note about no existing work: a one-off with no connection or consequence to any task",
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
    rule: "details holds what a reader who digs would want",
    home: "authoring",
    says: "<details> holds only what a reader who digs would want: evidence, exact code paths, qualifications",
  },
  // INF-416 piece H: the handoff no longer restates the core's read-by-key rule.
  {
    rule: "on approval, read the saved plan by key before filing",
    home: "core",
    says: "Read saved plans with tasks by key and file accepted work yourself",
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
    rule: "a merge decision on a crewmate's task is its completion card",
    home: { refusal: "a merge card its crewmate owes" },
    says: "a crewmate's completion card is the one merge decision on its task",
  },
  {
    rule: "released needs independently verified delivery",
    home: { tool: "settle_task" },
    says: "released closes a reported, idle work task only after you independently verify its delivery through an external release process",
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
  {
    rule: "a capped task's card and re-reviews wait for the steer",
    home: { wake: "ci cap" },
    says: "Its completion card and its re-reviews are held until the captain answers and your steer reopens its rounds.",
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
    says: "Read the task’s current autonomy fact",
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
    says: "Remove a surface or append a standing instruction, only on the captain's own turn",
  },
  {
    rule: "a skipped plan is declared on the direct build",
    home: { tool: "spawn_crewmate", parameter: "shape" },
    says: "skipped_plan_because: On a direct build with no chosen basis",
  },
];

describe("every rule the trim took out of one text is still served (contract v4.59)", () => {
  const flat = (text: string) => text.replace(/\s+/g, " ");

  it("says each one in the home the ledger names", async () => {
    const { served } = await fixedContext();
    const textOf = (home: Home): string => {
      if (home === "core") return FIRSTMATE_PROMPT_CORE;
      if (home === "authoring") return FIRSTMATE_CARD_AUTHORING;
      if (home === "handoff") return FIRSTMATE_HANDOFF;
      if (home === "sequences") return SEQUENCES_SEED;
      if (home === "reviewed brief") return renderRigorSection("reviewed");
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
    // the core and the authoring text, and every tool arrives with its words.
    const { systemPrompt, served } = await fixedContext();
    expect(systemPrompt).toContain(FIRSTMATE_PROMPT_CORE);
    expect(systemPrompt).toContain(FIRSTMATE_CARD_AUTHORING);
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
