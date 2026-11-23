import { describe, expect, it } from "vitest";
import { REVIEW_FIX_RULES, renderRigorSection } from "../orchestrator/intentBrief";
import { renderWake } from "../orchestrator/wakes";
import { SEQUENCES_SEED } from "../personal/sequencesSkill";
import {
  CARD_MECHANICS,
  CARD_REPLY,
  FIRSTMATE_CARD_AUTHORING,
  FIRSTMATE_EMIT_CARD_DESCRIPTION,
  FIRSTMATE_HANDOFF,
} from "../prompts/cardContract";
import { FLEET_WORK } from "../prompts/fleetWork";
import { CLAUDE_SEAT_TOOL_PREFIX } from "../storage/sessionReader";
import { CREWMATE_TOOLS } from "./crewmateTaskTools";
import { createCrewTools, SHAPE_GROUP_DESCRIPTION } from "./crewTools";
import {
  buildCrewmateSystemPrompt,
  buildFirstmateSystemPrompt,
  crewmateBackendNote,
  FIRSTMATE_PROMPT_CORE,
} from "./piResources";

/**
 * The v1 Firstmate prompt (contract v1, spec section 2.1 with captain
 * decisions A + B applied): a byte-stable checklist core plus a severable
 * frontier-dogfood style appendix. These tests pin the contract properties,
 * not every sentence - the core text itself is the frozen artifact.
 */
describe("FIRSTMATE_PROMPT_CORE (contract v1)", () => {
  const core = FIRSTMATE_PROMPT_CORE;

  it("is byte-stable: no interpolation, no machine-specific paths", () => {
    expect(core).not.toContain("${");
    expect(core).not.toContain("/Users/");
    expect(core).not.toContain("/tmp/");
    // The self-source path rides the context block, referenced abstractly.
    expect(core).toContain("the self-source path in the context block");
  });

  it("carries the six-way classify-first contract in order", () => {
    expect(core).toContain("EVERY TURN, classify first, then act as one of:");
    const order = ["1. answer", "2. ask", "3. steer", "4. spawn", "5. settle", "6. operate"];
    let last = -1;
    for (const label of order) {
      const at = core.indexOf(label);
      expect(at, label).toBeGreaterThan(last);
      last = at;
    }
    // The null outcome is first-class: an op wake may need nothing.
    expect(core).toContain(
      "A wake needing none gets no tool calls and the same short sentence, unread.",
    );
  });

  it("keeps the cards-only output contract and closes with one short sentence the captain reads", () => {
    // INF-772's plan, the captain's Approve and build: the closing sentence is
    // the line beside the captain's message, about 40 characters by
    // instruction alone, what took effect and never the answer.
    expect(core).toContain(
      "cards you emit with emit_card, a quiet activity feed, and your closing sentence beside their message",
    );
    expect(core).toContain("Other plain assistant text is never shown to anyone");
    expect(core).toContain(
      "End every turn after tool calls with one plain sentence of about 40 characters saying what took effect this turn",
    );
    expect(core).toContain("an answer goes on a card, never here");
    expect(core).toContain("for a reply, in its card thread");
    expect(core).toContain("It is not a card action; never end with close_card.");
    expect(core).toContain("Never withdraw this turn's answer card.");
    expect(core).toContain("Zero cards is correct when nothing needs the captain");
    expect(core).toContain("call emote for one motion reaction");
    expect(core).toContain("never instead of a required card or action");
    // Revises infinitary-firstmate-empty-turn-instruction option B: no magic token,
    // and do not revert to "write nothing" (the 21-minute silence loop).
    expect(core).not.toContain("the single word done");
    expect(core).not.toMatch(/write nothing/i);
  });

  it("keeps the card rule verbatim in spirit", () => {
    expect(core).toContain(
      "A card is allowed only when work cannot move forward without a captain decision, or the captain cannot move forward without seeing that fact.",
    );
    expect(core).toContain("Progress, CI waits and watching-status are never cards");
  });

  it("delegates evidence gathering to crewmates without exposing synchronous reading", () => {
    // INF-87: saved plan recovery belongs to the Firstmate, not a retrieval crewmate.
    expect(core).toContain(
      "Read saved plans with tasks by key and create accepted work yourself, not through a retrieval.",
    );
    expect(core).toContain("Work needing code, files, logs, git history");
    expect(core).toContain("Spawn an investigation with the read-only constraint");
    expect(core).not.toMatch(/\bbash\b/);
    expect(core).not.toContain("read tools");
    expect(core).not.toMatch(/\bconsult(?:ant|ing|s|ed)?\b/i);
  });

  it("names the typed replacements for bash's jobs", () => {
    expect(core).toContain("Read PR ci from its report or crew_status");
    expect(core).toContain("locate_project, then app_change project-setup, then proceed");
  });

  it("asks for the shape's facts and names no tier (v2.8)", () => {
    // The tier is the host's, computed from the work's shape through the
    // captain's table (S2): the prompt states the facts the Firstmate
    // alone can see and never a reasoning class.
    expect(core).toContain("You choose no model and no reasoning class");
    // Since v4.59 each fact's rule has one home, spawn_crewmate's shape,
    // and the core points at it instead of saying it a second time.
    expect(core).toContain("Pass only known facts in spawn_crewmate's shape.");
    expect(SHAPE_GROUP_DESCRIPTION).toContain(
      "basis: The task (id or key) whose report specifies this work, or whose reproduction it fixes.",
    );
    expect(SHAPE_GROUP_DESCRIPTION).toContain(
      'premium_ask: True only when the user asked for premium or the best model in words, or clicked your "Try a premium model" action.',
    );
    expect(SHAPE_GROUP_DESCRIPTION).toContain("override_model_id: The user-named model");
    expect(SHAPE_GROUP_DESCRIPTION).toContain("Only when named by the user");
    // Rule 4 of the captain's table assumes the plan is its own task: since
    // v4.6 a step under the ask's parent, grounded on its basis. Since v4.19
    // only an ask of more than one step has a parent, and the next step is
    // filed in the same turn.
    expect(core).toContain("Follow the appended sequencing instructions");
    expect(SEQUENCES_SEED).toContain("An ask that takes one step is that step alone,");
    expect(core).toContain("the parent is create_task");
    expect(core).toContain("the next is create_task on request with parent and basis");
    // A parent stays on request: the false "carries no crewmate" invariant
    // the model used to explain a duplicate crewmate away is gone.
    expect(core).toContain(
      "bending them only on the user's words, never your reading of the ask's size",
    );
    expect(SEQUENCES_SEED).toContain("parent task, left on\nrequest");
    expect(core).not.toContain("A parent carries no crewmate");
    expect(core).not.toMatch(/\bdifficulty\b/);
  });

  it("sends interactive UI prototyping to a plan while leaving static figures to the Firstmate", () => {
    expect(core).toContain(
      "Never author an interactive UI prototype or a multi-option UI exploration with emit_card: an ask for a prototype, a mock-up or a try is a plan with a playable preview, relayed as the plan line says.",
    );
    // Stated as a fact about the Firstmate's cards, not a permission
    // (contract v3.6, captain lock 2): the permission line scored 0 of 13.
    // Non-prescriptive (contract v2.5): no figure shape, no recipe, no helper.
    expect(core).toContain("Your own cards carry static SVG figures, and you draw them.");
    expect(core).not.toContain("fm.viz");
  });

  it("serves gender-neutral captain instructions (INF-863 captain request)", () => {
    for (const prompt of [
      buildFirstmateSystemPrompt(),
      buildCrewmateSystemPrompt("pi"),
      buildCrewmateSystemPrompt("claude"),
    ]) {
      expect(prompt).not.toMatch(/\b(?:he|his|him|himself)\b/i);
    }
  });

  it("tells every persona that an option or step it hands the captain leaves only the captain's part (INF-4186)", () => {
    // INF-4186: a reviewer's way forward and the first mate's option handed
    // the captain a step the crew could do, because the rule read as covering
    // only a direct ask; the approved wording states the outcome for anything
    // that reaches the captain, and keeps the captain-only list as it was.
    for (const prompt of [
      buildFirstmateSystemPrompt(),
      buildFirstmateSystemPrompt("claude"),
      buildCrewmateSystemPrompt("pi"),
      buildCrewmateSystemPrompt("claude"),
    ]) {
      expect(prompt).toContain(
        "Whatever reaches the captain - a question, option or step - leaves them only what the fleet cannot do: choose what they want, give consent the app holds for their click, sign in, enter a password, approval or signing material, or reach a device the fleet cannot.",
      );
      expect(prompt).toContain("seek a way needing nothing from them");
      expect(prompt).not.toContain("Never ask the captain to do what your tools");
    }
  });

  it("keeps the dispatch-policy standing rules", () => {
    expect(core).toContain("Current context and crew_status outrank transcripts");
    expect(core).toContain("Never ask when one confident match exists");
    // INF-863 approved A: one shared instruction, once per served persona.
    for (const prompt of [buildFirstmateSystemPrompt(), buildCrewmateSystemPrompt()]) {
      expect(prompt.split(FLEET_WORK)).toHaveLength(2);
    }
    expect(core).not.toContain("Never send the user to Settings");
    expect(core).not.toContain("Never ask the captain to click a card instead.");
    // Said once, by the tool that returns it (v4.59).
    const spawn = (
      createCrewTools({} as never) as unknown as { name: string; description: string }[]
    ).find((tool) => tool.name === "spawn_crewmate");
    expect(spawn?.description).toContain(
      "Returns the task id immediately; the crewmate's results arrive later as [fm-op] messages, so end your turn.",
    );
    expect(core).toContain(
      "Act on crewmate reports, not relay them: steer the active author to show what the captain must see or decide on its own card",
    );
    expect(core).toContain("nothing parks or returns on its own");
    // INF-3170: doubt sends the first mate to the record, not to the captain;
    // escalation stays the captain's move.
    expect(core).toContain(
      "WHEN IN DOUBT: read the record or delegate a read, and ask the captain only what only they can decide.",
    );
    expect(core).not.toContain("ask, escalate, or delegate");
    // INF-3926 finding 4: two first mate answers given as fact with nothing
    // read first were both wrong; a factual answer is looked up first, or
    // says plainly that it was not checked.
    expect(core).toContain(
      "Before answering a factual question, look it up (the context, a typed lookup or a delegated read), or say plainly that you have not checked.",
    );
  });

  it("stays in the contract size band (v1 ~1,060 tokens; v1.1 adds the answer and boundary rules, v1.3 the routing rule, v1.5 the card-actions and filing rules, v1.6 the effect vocabulary, v1.7 the resumable-settle and structured-refusal rules, v2.8 the personalization case, v2.9 the personal-surface spawn rule, v3.0 the work-shape facts in place of the judged class, v3.1 the escalation trigger, v3.3 the reviewed tier's routing rule, v3.5 the task-level delivery ask, v3.9 the autonomy ask, v4.6 the sequences rule, v4.9 the not-signed-in rule, v4.11 install by talking, v4.14 the delegated thread answer)", () => {
    expect(core.length).toBeGreaterThan(3000);
    // The band moves only with a contract that earned it: v3.0 states four
    // facts where v1.3 stated one judgment, and the plan-as-its-own-task
    // rule the captain's table assumes; v3.1 adds the escalation trigger,
    // which is stated here BECAUSE it is the one spawn field no tool
    // description can gate on its own (the captain's words, Q2); v3.3
    // replaces v3.2's three-sentence rigor default with the reviewed tier's
    // routing rule (delivery rigor phase 2) - the one place the Firstmate
    // learns what a reviewer's findings become, because the host routes
    // none of it: steers, a re-review, one decision card, or the merge.
    // v3.5 (the no-mistakes alignment) grew the reviewed-tier rule: the
    // review-before-PR sequence, the fixer preamble, the info-never-blocks
    // rule, the per-round card, and the user_chose_to_ignore convergence
    // sentence all live in the one rigor rule; the task-level delivery ask
    // rides the same revision. FI3-566 (cut C) moved those steps out again:
    // the fixer preamble to the builder's reviewed brief, the rest to the
    // review wakes, leaving the commission and the captain's latest
    // decision here. v3.9 adds the autonomy rule to that same
    // sentence - who merges a green result, the one spawn field the tool
    // description cannot gate alone (it is relayed from the user's words,
    // like rigor_ask), and the host refusal it now carries.
    // v4.4 links exploratory delegation to the shared prototype contract.
    // v4.6 replaces the plan-as-its-own-task sentence with the sequences
    // rule: the parent and its steps, what tells a step its turn came, and
    // the close of a step the Firstmate declared its own (internal_step)
    // once the next one builds on it. v4.9 adds the not-signed-in rule: a
    // tool's "Not signed in to <host>" is one decision card whose default is
    // the sign-in way and whose other action keeps the project on this Mac
    // (git integration PR 1.2) - the host names the ways, the rule says a
    // sign-in is never required. v4.11 adds install by talking to the
    // operate rule (one plugin vehicle, A2a): a panel someone else made is
    // install_plugin, not the crewmate work the sentence before it names
    // for a new panel, and the host's consent card is the only card. v4.14
    // adds the delegated thread answer to the thread rule (the captain's
    // Q3 A of 2026-09-27): an answer to a reply under its own card that
    // needs a crewmate is said in that card and revises the same card when
    // it lands - never a new card - because the card comes back at the
    // Firstmate's turn end.
    // v4.17 keeps the invariant-complete fixer and latest captain decision
    // in the routing rule; they add policy, not a new move or mechanism.
    // v4.19 states when an ask gets a parent inside the sequences rule and
    // replaces its closing invariant, tightened to stay inside the band.
    // v4.21 adds the filing verdict and the release-cut re-verify, the
    // shortest wording that still states both rules.
    // v4.28 adds the one premium choice and its click-only escalation guard.
    // v4.35 adds 433 characters for evidenced diagnoses, separate-owner
    // waits, one flake reservation and the own-repair/captain boundary.
    // Handoff guidance lives in HANDOFF rather than inflating the persona core.
    // v4.48 adds pasted-file delegation without adding file reads.
    // v4.59 is the first revision that takes the band DOWN (FI3-541, the
    // fixed-context trim): a rule a tool's own words already state is said
    // there once, and the core keeps which move and when. The whole fixed
    // part has its own budget in tests/firstmate-fixed-context.test.ts.
    // v4.68 (FI3-671) adds 320 characters: a report wake naming work its
    // task waits on that nothing starts is answered that turn - the one move
    // a wake's facts cannot carry, since a wake states no policy.
    // FI3-868's selective filing adds 583 characters to the filing rule: a
    // repeat dropped as covered, a kept filing's verdict and priority,
    // optional ideas offered together, the after-merge check of what a merge
    // covered, and what a release review names. Each is a Firstmate move
    // after a report or a merge, which no tool's words can carry.
    expect(core.length).toBeLessThan(15_800);
  });
});

describe("FIRSTMATE_PROMPT_CORE (contract v1.1, interaction P1 WI-9 and WI-12)", () => {
  const core = FIRSTMATE_PROMPT_CORE;

  it("answers with a default: a next step is a decision, a pure fact is a note", () => {
    expect(core).toContain(
      "Emit the answer by CARD_AUTHORING's decision/note rule and emit_card's default-action rule",
    );
    expect(FIRSTMATE_CARD_AUTHORING).toContain(
      "An answer implying any captain next step, even optional, is a decision; only a pure fact is a note.",
    );
    expect(FIRSTMATE_EMIT_CARD_DESCRIPTION).toContain(
      "marks exactly one default, the step you would take",
    );
    expect(core).toContain("the captain's choice there closes the task");
  });

  it("does not prescribe explain-more as a default addition to every decision (v1.8)", () => {
    expect(core).not.toMatch(/explain.more/i);
  });

  it("adds no seventh move and no propose tool", () => {
    expect(core).not.toMatch(/\n7\. /);
    expect(core).not.toMatch(/\bpropose\b/);
    expect(core).not.toMatch(/recommendation/i);
  });

  it("makes personalization the operate case for the app itself, one call and no card (v2.8)", () => {
    // Talk-to-personalize Step 1, captain decision Q5: Tier A is a
    // `personalize` call and a feed line; a new panel stays crewmate work.
    expect(core).toContain(
      "Personalization is the operate case for the app itself: the theme or a panel's rail, position or visibility is one app_change call (theme or panel); removing a surface is one personalize call, a lasting instruction for the panels built for the captain is one app_change direction scoped to the personal workspace, and the feed line is the whole answer - no card.",
    );
    expect(core).toContain(
      "A new panel, or a change to how one draws, is crewmate work on the personal project, never personalize.",
    );
    // The machinery stays out of the persona: no plugin, no extension.
    expect(core).not.toMatch(/\bplugin\b/i);
    expect(core).not.toMatch(/\bextension\b/i);
  });

  it("makes investigations an explicit crewmate responsibility", () => {
    expect(core).toContain("Work needing code, files, logs, git history");
    const spawn = (
      createCrewTools({} as never) as unknown as { name: string; description: string }[]
    ).find((tool) => tool.name === "spawn_crewmate");
    expect(spawn?.description).toContain("evidence-gathering investigation");
    expect(spawn?.description).not.toMatch(/\bconsult(?:ant|ing|s|ed)?\b/i);
  });

  it("replaces answer ownership with steer-not-answer and revise-in-place", () => {
    expect(core).not.toContain("answer owner");
    expect(core).toContain("Context lists open cards.");
    // Steer-not-answer is enforced, so its refusal says it, once (INF-490):
    // tests/firstmate-fixed-context.test.ts's ledger names that home.
    expect(core).not.toContain("your move is steer or nothing");
    // Revise-in-place is how the tool is called, so it is said once, in the
    // descriptor every emitter reads (v4.59).
    expect(CARD_MECHANICS).toContain(
      "Reuse an open card's id to revise it in place when new information augments or overlaps it; a distinct finding is a new card",
    );
    expect(core).not.toMatch(/one card per/i);
  });
});

describe("FIRSTMATE_PROMPT_CORE (contract v1.5 and v1.6, cards/tasks/agents P0 and P1)", () => {
  const core = FIRSTMATE_PROMPT_CORE;

  it("declares the card's actions as exactly the author's, with no automatic Later", () => {
    expect(core).toContain("A card carries exactly the declared actions");
    expect(core).toContain("Offer deferral as an action; its reminder is schedule_prompt.");
    expect(core).not.toMatch(/\bLater\b/);
    expect(core).not.toMatch(/parked/);
    expect(core).not.toContain("recall_decision");
    expect(core).not.toContain("waiting on the user");
  });

  it("keeps effect policy and leaves the effect vocabulary to the card contract (v1.6, v2.0)", () => {
    expect(core).toContain("emit_card's description is the card contract.");
    expect(core).toContain("closing a card is keep");
    expect(CARD_MECHANICS).toContain(
      "An action's effect is what the host does on the click; with no effect the click returns to you as a message.",
    );
    // The crewmate's completion card is the one merge decision (ruling D3).
    expect(core).toContain(
      "Green: the crewmate's merge card decides, never you; the app merges from it with autonomy on.",
    );
    expect(core).not.toContain('labeled "Merge PR"');
    expect(core).not.toMatch(/native action id/);
    expect(core).not.toMatch(/reserved/);
    expect(core).not.toMatch(/\bkind\b/);
  });

  it("triages a crewmate's filings from its report, never from a message per filing", () => {
    expect(core).toContain("A crewmate's report names the follow-ups it filed that turn");
    expect(core).toContain("update_task start_policy when-ready");
    expect(core).toContain("No message comes per filing.");
    expect(core).toContain("Never drop by age;");
    expect(core).toContain("at a release cut re-verify filings older than the last release");
    expect(core).not.toMatch(/\bpropose\b/);
  });
});

describe("FIRSTMATE_PROMPT_CORE (contract v1.4 and v1.7, host-run settle outcomes and structured refusals)", () => {
  const core = FIRSTMATE_PROMPT_CORE;

  it("offers exactly one non-default premium choice on blocked reports, only when available", () => {
    const served = buildFirstmateSystemPrompt();
    expect(served).toContain(
      "Exhausted repairs follow stall recovery; only captain-owned decisions/access/information earn a card",
    );
    expect(served).toContain(
      'Offer exactly one extra, non-default, effect-free "Try a premium model" action',
    );
    expect(served).toContain("neither ran at premium nor spent both escalation rounds");
    expect(served).toContain(
      'If premium is unavailable (quota/models line), say so and offer the hold\'s "Try a stronger model" instead',
    );
    expect(served).toContain("Omit premium when ineligible");
    expect(served).toContain("Omit premium when ineligible; never offer both.");
    expect(served).toContain("omit it for a stronger model");
    expect(served).toContain("Set shape.premium_ask true only on the premium click");
    // What that spawn carries is said once, where the trigger is.
    expect(served).toContain(
      "spawn_crewmate again with escalate_from naming that task, their words verbatim as user_words, and the original goal",
    );
    expect(served.match(/effect-free "Try a premium model" action/g)).toHaveLength(1);
  });

  it("keeps idle crew resumable until explicitly settled, including verified folder work (WI-11, INF-1279)", () => {
    expect(core).toContain("An idle crewmate stays resumable until you settle it.");
    expect(core).toContain("answered for an answer, finished for verified folder work");
    // What released needs is settle_task's own rule (INF-490; the ledger names it).
    expect(core).not.toContain("use released only with verified evidence");
    expect(core).not.toMatch(/\bdelivered\b/);
    expect(core).not.toMatch(/\bfinish\b/);
  });

  it("acts on a settle refusal's structured ways while letting final outcomes end quietly (WI-12)", () => {
    expect(core).toContain("Host-run settle finals may need nothing.");
    expect(core).toContain(
      "A settle refusal names structured ways out: run the obvious one or offer one decision card carrying them as effects - a merge that keeps a task's open children planned is settle merge with proceed_with_open - or replies you will run.",
    );
    expect(core).toContain(
      "Act on the ways, not the narration; never confirm destruction without the captain's choice.",
    );
  });
});

describe("FIRSTMATE_PROMPT_CORE (contract v3.3, delivery rigor phase 2: the reviewed tier)", () => {
  const core = FIRSTMATE_PROMPT_CORE;

  it("states the captain's derivation: standard by default, words or repo rigor only, never escalation", () => {
    // Captain rulings 2026-09-19: rigor derives from the user's words and
    // the repository's configured rigor alone; escalation routes a
    // stronger model, never more ceremony.
    // Override consent and unchanged defaults are asserted on SHAPE_GROUP_DESCRIPTION below.
    expect(core).toContain(
      "The host derives rigor (standard by default), delivery and autonomy from repository settings; escalation never changes rigor.",
    );
    expect(core).toContain("Spawn fields carry captain-only overrides");
    // What each ask takes, and that the repository's default stays as it
    // was, is the field's own rule (v4.59).
    expect(SHAPE_GROUP_DESCRIPTION).toContain(
      "delivery_ask: Only when the user asked in words for this task to ship as a pull request or stay local. The repository default is unchanged.",
    );
    expect(SHAPE_GROUP_DESCRIPTION).toContain(
      "autonomy_ask: Only when the user said in words whether this task merges its green work itself (true) or asks first (false). The repository default is unchanged.",
    );
    expect(SHAPE_GROUP_DESCRIPTION).toContain(
      "rigor_ask: Only when the user said in words how careful to be.",
    );
    // Autonomy is the third of the same shape (contract v3.9, captain
    // ruling of 2026-09-20): a repository default with a per-task ask on
    // the user's words alone, and the host - not this rule - enforces it.
    // Its refusal says so when a merge is tried (INF-490; settleOwners.keptMergeRepairs.test.ts
    // owns the words), so the core does not.
    expect(core).not.toContain("With autonomy off the host refuses a merge of yours");
    expect(core).not.toContain("free constraint (rigor: quick)");
    // Contract v3.7: the personal workspace is a workspace KIND, so the
    // prompt names no `live` posture anywhere - not as a delivery, not as a
    // rigor rule.
    expect(core).toContain("The personal workspace builds in place without delivery or rigor.");
    expect(core).not.toMatch(/\blive\b/);
  });

  it("commissions a review as an operation at any care, leaving what each care asks to the care guidance (INF-1876)", () => {
    expect(core).toContain(
      "A review is an operation on a version at any care: when a builder's report or the captain asks for one, spawn_crewmate with review_of naming that task and the user's words - the host briefs the reviewer on the branch and wakes name later steps; what each care asks is the care guidance's, never a hold of the host's.",
    );
    expect(core).not.toContain("holds the push and merge until it passes");
    expect(core).not.toContain("On a reviewed task the review comes BEFORE the pull request");
    expect(core).toContain(
      "what each care asks is the care guidance's, never a hold of the host's.",
    );
  });

  it("keeps the captain's latest decision in every fix and review steer, and leaves each later step to the wake it arises on (FI3-566 cut C)", () => {
    expect(core).toContain(
      "Carry the latest captain decision into every fix and review steer; a genuinely new, materially different problem is still reviewable.",
    );
    // The findings wake says how to fix a finding (INF-1876: no brief carries
    // the rules); each wake says what its verdict or report asks next
    // (wakes.test.ts words them). After the pass, who merges is the
    // PR-report rule's, said once (v4.59).
    // Session audit finding E moves the instruction to the builder's served handoff.
    expect(
      renderWake({
        facts: {
          kind: "review-handoff",
          from: "review",
          head: "0123456789abcdef0123456789abcdef01234567",
          stage: "fix",
          excerpt: "The flush races the read.",
          findings: ["F1 error await the flush - auto-fix"],
        },
      }),
    ).toContain(`${REVIEW_FIX_RULES}.`);
    expect(renderRigorSection("reviewed")).not.toContain(REVIEW_FIX_RULES);
    expect(core).toContain(
      "Green: the crewmate's merge card decides, never you; the app merges from it with autonomy on.",
    );
  });

  // INF-1540 approved B/C: recovery comes before a remaining captain-only choice (INF-1550).
  it("routes a crewmate blocker through stall recovery, then its guidance, without hard-coding a repair count", () => {
    expect(core).toContain(
      "A blocker follows stall recovery then delivery guidance: coordinate the next owner or ask for a captain-only decision on its task, carrying the wake's other ways. Steer with the answer; never infer merge consent.",
    );
    // A blocker never grants merge consent or invents a host allowance.
    expect(core).not.toContain("until then the host holds its completion card");
    // A repository's standing rigor is set by talking (phase 3): the tool,
    // named once, on the user's words alone - the Firstmate judges none.
    expect(core).toContain(
      "A repository's standing rigor uses app_change project-settings, on a captain message or captain-set schedule.",
    );
    // The rule sits with the escalation trigger it extends: the stronger
    // model is still only the captain's say-so (v3.1).
    expect(core.indexOf("The host derives rigor")).toBeGreaterThan(
      core.indexOf("Escalation is the user's move."),
    );
  });

  // Source: INF-1554 F2, "Give takeovers their own title prefix so they start right away".
  it("starts a takeover filing now from its origin's branch, unlike a Continue filing", () => {
    const takeover = core.slice(core.indexOf('For "Take over: …"'));
    expect(takeover).toMatch(
      /^For "Take over: …", reuse an existing takeover, set branch_from to the origin, start now, hand files via steer_crewmate files_from, and link related and blocks from successor to origin; never block the successor on the origin\. Merge wakes and settle_task results name "Continue: …" tasks that start themselves/,
    );
    // The crewmate's half rides file_followup, which both backends serve whole.
    const fileFollowup = CREWMATE_TOOLS.find((tool) => tool.name === "file_followup");
    expect(fileFollowup?.description).toContain(
      "For a host-record takeover, file Take over: my branch in a fresh task, then needs_firstmate to start it now; no merge prerequisite, never to bypass consent or repeat an unknown effect.",
    );
  });
});

describe("buildFirstmateSystemPrompt (contract v3.6, v4.2, v4.41)", () => {
  it("serves the byte-stable core plus the authoring, reply and handoff texts, and no style appendix", () => {
    // The core stays the frozen, trainable artifact; the authoring constant
    // is appended by the builder exactly as the backend note is on the
    // crewmate side (captain lock 1), so the Firstmate reads what a card
    // should look like in the one channel that arrives whole. The reply
    // contract rides beside it for the same reason (v4.2, the captain's Q4
    // B): a thread has two ends and both agents stand at one of them.
    // The handoff follows them for the same reason (v4.41): both ends of a
    // plan-to-build handoff act on it.
    expect(buildFirstmateSystemPrompt()).toBe(
      `${FIRSTMATE_PROMPT_CORE}\n\n${FLEET_WORK}\n\n${FIRSTMATE_CARD_AUTHORING}\n\n${CARD_REPLY}\n\n${FIRSTMATE_HANDOFF}`,
    );
    expect(buildFirstmateSystemPrompt()).not.toContain("STYLE (");
  });

  it("tells the first mate on Claude how its tools' short names map, with the crewmates' sentence, and no other seat (INF-3718)", () => {
    // On Claude every app tool exists only as its full name, while the
    // prompt names each by its short one; Claude crewmates' short-name
    // calls fell once their note said how the two match.
    const claude = buildFirstmateSystemPrompt("claude");
    const sentence = claude.slice(buildFirstmateSystemPrompt("pi").length).trim();
    expect(claude.startsWith(buildFirstmateSystemPrompt("pi"))).toBe(true);
    expect(sentence).toContain(`${CLAUDE_SEAT_TOOL_PREFIX}<name>`);
    expect(crewmateBackendNote("claude").endsWith(sentence)).toBe(true);
    expect(buildFirstmateSystemPrompt("pi")).not.toContain(CLAUDE_SEAT_TOOL_PREFIX);
    expect(buildFirstmateSystemPrompt()).toBe(buildFirstmateSystemPrompt("pi"));
  });
});
