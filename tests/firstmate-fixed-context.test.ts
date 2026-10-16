import { describe, expect, it } from "vitest";
import { renderRigorSection } from "../src/core/orchestrator/intentBrief";
import { renderWake, type WakeFacts } from "../src/core/orchestrator/wakes";
import { SEQUENCES_SEED } from "../src/core/personal/sequencesSkill";
import { OLLAMA_MIN_CONTEXT } from "../src/core/pi/ollamaProfile";
import { LOCAL_CONTEXT_RESERVE, localInputFits } from "../src/core/pi/ollamaStream";
import { buildFirstmateSystemPrompt, FIRSTMATE_PROMPT_CORE } from "../src/core/pi/piResources";
import { piToolsOf } from "../src/core/pi/toolSpec";
import { FIRSTMATE_CARD_AUTHORING } from "../src/core/prompts/cardContract";
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
 * The ceiling, in the app's count: the fixed part measured 19,851 before the
 * trim, 17,190 after it, 17,485 at contract 4.72 and 18,142 once FI3-868
 * taught it selective filing and the after-merge check. Knowledge (FI3-1141,
 * docs/knowledge.md) adds about 950 for the knowledge pair, which only an
 * alpha or development build serves and this census includes: 19,446, while a
 * stable build's fixed part stays at 18,497. The ceiling sits above
 * that with room for several revisions, so a change that adds a few words
 * does not move it and two such changes never edit the same number. One
 * that would cross it trims first, or raises it in a contract revision
 * that says what the new words buy: a rule that a tool, the core and a
 * parameter would each state is written once, where it is used. A revision
 * file says what its words cost (src/core/prompts/contract-revisions/).
 */
// FI3-1238 spends about 100 tokens on faithful bounded retrieval guidance.
// The conversation-space assertion below still holds at this ceiling, and
// fails past 19,772, so the ceiling has no more room to rise. Merged beside
// the all-card demo wording, the two measured 19,710 together; FI3-1253's
// tighter update_task wording left 19,695, and FI3-1268 took three tool
// sentences the core or a parameter already says to 19,659. Back at 19,700,
// FI3-1345's runs_on words were paid for by saying update_task's start_policy
// once, on create_task's, which left 19,676. FI3-1333 retired check_pr_ci
// (about 120 tokens) for the recorded reading in crew_status.
// FI3-566: approved card, sequences and reader-specific handoff cuts left
// 18,541; its cut C moved the reviewed-work steps to the builder's brief and
// the review wakes, leaving 18,243.
// Automation drafts and the setup card, merged a minute apart, measured
// 18,252 together; FI3-1539 said schedule_prompt's prompt rule in fewer
// words, leaving 18,250.
// FI3-1543's request_merge effect on emit_card measured 18,302.
// FI3-1559 direction C adds the personal routing guide and lesson-aware tool
// words: 18,805. The unchanged conversation-space promise still fits.
// Its piece 2 (FI3-1569) adds the game line's play-test in the task browser
// and its finishing note with Play: 18,863.
// FI3-1626's approved required-action declarations and correction field add
// 534 tokens in the real served surface: 19,043, within the 19,401 budget.
// The existing conversation-
// space assertion and its 19,772 hard boundary are unchanged.
// FI3-1307's pull request link rule in the card authoring adds 64: 19,107.
// FI3-1684's casual-project line, measured with the core sentence and the
// personal_ui words: 19,113. The budget is untouched.
// FI3-1718's captain-start rule, the direction field and the self-merge
// handling add 177 tokens: 19,578. The 19,772 hard boundary is unchanged.
// FI3-1776's rule for a project's development practices is paid for by three
// phrases the core said twice (what its tools are for, personal_ui for
// lessons and panels, and who is standalone): 19,599. The budget is
// untouched.
// FI3-1761's always-answer thread rule, merged beside it, measured 19,616
// together. FI3-1805 took three core phrases a tool or the core already says
// (what an escalation does to the rejected attempt, whose thread a card is,
// and whose the fleet is to operate): 19,581. The budget is untouched.
// The plan step's split rule, the corrected pieces line and the feature plan
// pointer (FI3-1801) measured 19,713; the budget rises to 19,720, inside the
// 19,772 hard boundary.
// FI3-1792 names the agent the first mate aboard Infinitary: the persona line,
// "the first mate" where the words said Firstmate, and the development
// signer's new folder beside its old one in spawn_crewmate measured 19,741;
// the budget rises to 19,745, inside the 19,772 hard boundary.
const FIXED_CONTEXT_BUDGET = 19_745;

describe("the Firstmate's fixed context (contract v4.59)", () => {
  it("stays inside its budget by the app's own count", async () => {
    expect(fixedTokens(await fixedContext())).toBeLessThanOrEqual(FIXED_CONTEXT_BUDGET);
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
    expect(fits(10 * 2_938 + 4_096)).toBe(true);
    // So does a fixed part grown to the ceiling.
    expect(
      OLLAMA_MIN_CONTEXT - LOCAL_CONTEXT_RESERVE - FIXED_CONTEXT_BUDGET,
    ).toBeGreaterThanOrEqual(10 * 2_938 + 4_096);
    // The check is the real one: it refuses what cannot fit.
    const room = OLLAMA_MIN_CONTEXT - LOCAL_CONTEXT_RESERVE - fixedTokens({ systemPrompt, tools });
    expect(fits(room)).toBe(true);
    expect(fits(room + 1)).toBe(false);
  });
});

/**
 * Where a rule the trim removed from one text is still said. `rule` names
 * what the removed sentence governed; `home` is the text it is still served
 * in - the Firstmate's fixed context, the wake it arises on, or the
 * builder's reviewed brief - and `says` the words that carry it there.
 */
type Home =
  | "core"
  | "authoring"
  | "sequences"
  | "reviewed brief"
  | { wake: keyof typeof REVIEW_WAKES }
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

/** The review wakes, as the host serves them (FI3-566 cut C). */
const REVIEW_WAKES = {
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
} satisfies Record<string, WakeFacts>;

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
    rule: "a new head is re-reviewed with the declined findings ignored",
    home: { wake: "builder report" },
    says: "When this report brings a new head, steer that reviewer to re-review at it, listing findings the captain declined under user_chose_to_ignore with: do not re-report these unless the code genuinely introduces a new, materially different problem.",
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
    home: "core",
    says: "a note with neither task_id nor standalone is refused",
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
    rule: "a model named for a filed task keeps that task",
    home: { tool: "update_task" },
    says: "When the user names a model for a filed task, pass override_model_id - with start_now to start it now: it keeps its key and links, so never drop it and spawn a replacement.",
  },
  {
    rule: "a step you add yourself is declared internal, the captain's own ask never is",
    home: { tool: "spawn_crewmate", parameter: "shape" },
    says: "internal_step: True when you add this task yourself as an internal step of a sequence you run: its answer goes to the next step, and once that step has started you close it with settle_task answered. Omit it when the captain asked for this result himself",
  },
  {
    rule: "the same internal-step rule on a planned step",
    home: { tool: "create_task", parameter: "internal_step" },
    says: "Omit it when the captain asked for this result himself",
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
    home: { tool: "spawn_crewmate", parameter: "shape" },
    says: "The host stops that attempt, keeps its branch and report, and runs this one a tier up. Pass the user's words verbatim as user_words and the original goal.",
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
    home: "core",
    says: "steer the crewmate to revise its card (same id) with what you would add, never a second card beside it",
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
];

describe("every rule the trim took out of one text is still served (contract v4.59)", () => {
  const flat = (text: string) => text.replace(/\s+/g, " ");

  it("says each one in the home the ledger names", async () => {
    const { served } = await fixedContext();
    const textOf = (home: Home): string => {
      if (home === "core") return FIRSTMATE_PROMPT_CORE;
      if (home === "authoring") return FIRSTMATE_CARD_AUTHORING;
      if (home === "sequences") return SEQUENCES_SEED;
      if (home === "reviewed brief") return renderRigorSection("reviewed");
      if ("wake" in home) return renderWake({ facts: REVIEW_WAKES[home.wake] });
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
    expect(systemPrompt).toContain(SEQUENCES_SEED.trim());
    const tools = new Set(served.map((tool) => tool.name));
    for (const { home } of LEDGER) {
      if (typeof home !== "string" && "tool" in home) expect(tools, home.tool).toContain(home.tool);
    }
  });
});
