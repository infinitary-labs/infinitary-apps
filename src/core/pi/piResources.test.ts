import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { renderBasisSection } from "../orchestrator/intentBrief";
import { SEQUENCES_SEED } from "../personal/sequencesSkill";
import {
  CARD_AUTHORING,
  CARD_MECHANICS,
  CARD_REPLY,
  CLAUDE_TOOL_DESCRIPTION_CAP,
  CREWMATE_EMIT_CARD_DESCRIPTION,
  CREWMATE_HANDOFF,
  cardAuthoringSentences,
  cardMechanicsSentences,
  cardReplySentences,
  FIRSTMATE_CARD_AUTHORING,
  FIRSTMATE_EMIT_CARD_DESCRIPTION,
  FIRSTMATE_HANDOFF,
  HANDOFF,
  handoffSentences,
} from "../prompts/cardContract";
import { CREWMATE_TOOLS } from "./crewmateTaskTools";
import { AFTER_MERGE_STORY_RULE, PREPARE_CHANGE_STORY_DESCRIPTION } from "./forgeTools";
import {
  buildCrewmateSystemPrompt,
  buildFirstmateSystemPrompt,
  FIRSTMATE_PROMPT_CORE,
} from "./piResources";
import { createTaskTools } from "./taskTools";

/**
 * What reaches every agent from one home: the card contract and the
 * plan-to-build handoff, each served once per persona and restated nowhere
 * else, the crewmate tool spec held against the personas, and the rules a
 * crewmate and the first mate both act on. The first mate's own prompt is
 * held in piResources.firstmate.test.ts, the crewmate's in
 * piResources.crewmate.test.ts.
 */
describe("continuation instructions served at the seven moments", () => {
  it("serves spawn, filing, completion, report triage and wrong-card steer in their existing channels", () => {
    // INF-1410 pointed delivery at the filing tool, which owns the full
    // continuation rule; INF-1876 dropped the pointer, so the tool alone says
    // it, and emit_card alone says that no intermediate card merges. INF-2796
    // moved the rest of the work onto the story's after-merge steps, which
    // the merge files, so the filing tool points there instead.
    expect(buildCrewmateSystemPrompt()).not.toContain("follow file_followup's Continue rule");
    expect(CREWMATE_TOOLS.find((tool) => tool.name === "file_followup")?.description).toContain(
      "Work needing your merge first goes in your story's afterMerge instead.",
    );
    expect(buildCrewmateSystemPrompt()).not.toContain("No intermediate card of yours");
    expect(CREWMATE_EMIT_CARD_DESCRIPTION).toContain(
      "No merge or settle effects on intermediate questions",
    );
    // The merge card draws the story's after-merge steps, so the card tool no
    // longer asks the body to name them; the story tool says so instead.
    expect(CREWMATE_EMIT_CARD_DESCRIPTION).not.toContain("name it in the body");
    expect(PREPARE_CHANGE_STORY_DESCRIPTION).toContain(AFTER_MERGE_STORY_RULE);
    expect(FIRSTMATE_PROMPT_CORE).toContain(
      "first link_tasks blocks from origin to filing, then set update_task start_policy when-ready",
    );
    expect(FIRSTMATE_PROMPT_CORE).toContain(
      'Merge wakes and settle_task results name "Continue: …" tasks that start themselves; drop one only when another task does its work.',
    );
    expect(FIRSTMATE_PROMPT_CORE).toContain("without a merge action");
    // INF-3167, the captain's choice A: every wait is recorded and holds
    // the waiter's start and merge until the other task closes; INF-5269's
    // default-on rule starts it at that task's approval on batched pull
    // requests unless the waiter needs it merged.
    expect(FIRSTMATE_PROMPT_CORE).toContain(
      "Record every wait that turn with link_tasks blocks from the task whose close gives what the waiter needs; it holds start and merge until then, except that on batched pull requests the start comes at that task's merge approval: when the waiter needs it merged, such as for a release, add that wait with update_task blocked_by and needs_merge in one call instead, since a link alone can start it at once.",
    );
  });
});

/**
 * Selective filing (FI3-868, the captain's choice on FI3-845's backlog
 * assessment), read the way each agent receives it: the crewmate persona on
 * either backend, the file_followup tool both runtimes generate from one
 * entry, and the Firstmate core beside the update_task fields it writes.
 * What gets filed is a judgment, so it lives in these words alone; the host
 * still files whatever a crewmate files.
 */
describe("selective filing reaches every agent that acts on it", () => {
  const filing = CREWMATE_TOOLS.find((tool) => tool.name === "file_followup");
  const filingParameters = filing?.parameters as {
    properties: Record<string, { description?: string }>;
  };
  const unavailable = (): never => {
    throw new Error("only the served words are read");
  };
  const updateTask = createTaskTools({
    plan: unavailable,
    update: unavailable,
    drop: unavailable,
    withdrawMerge: unavailable,
    pin: unavailable,
    override: unavailable,
    withdrawOverride: unavailable,
    withdrawAllowance: unavailable,
    startNow: unavailable,
    startAgain: unavailable,
    link: unavailable,
    query: unavailable,
  }).find((tool) => tool.name === "update_task");
  const updateParameters = updateTask?.parameters as {
    properties: Record<string, { description?: string }>;
  };

  it("has every crewmate file defects and safety risks, keep optional ideas in its report and finish its own work", () => {
    for (const backend of [undefined, "pi", "claude"] as const) {
      const prompt = buildCrewmateSystemPrompt(backend);
      expect(prompt).toContain("Do no unrelated work on the side");
      expect(prompt).toContain("Use file_followup for discoveries by its rules");
      expect(filing?.description).toContain(
        "a bug you can show on the current main line, or a credible risk to the person's data, accounts, signing material or merges",
      );
      expect(filing?.description).toContain("Not for an optional improvement");
      expect(filing?.description).toContain("that is one line in your report");
      expect(filing?.description).toContain(
        "Not for work your own change needs to be finished, or documents it makes stale: those are yours",
      );
      expect(filing?.description).toContain("goes in your story's afterMerge instead");
      expect(prompt).toContain(
        "When your change meets another open task's whole goal, name its key and evidence",
      );
      expect(prompt).not.toContain("never done on the side and never dropped");
    }
  });

  it("says what file_followup is for, and asks its why for evidence, consequence and doubt", () => {
    expect(filing?.description).toContain("Record a defect or safety risk you discovered");
    expect(filing?.description).toContain("Not for an optional improvement");
    expect(filing?.description).not.toContain("a test gap");
    expect(filingParameters.properties.why?.description).toContain(
      "the evidence on the current main line, what it breaks and for whom, and what you are unsure of",
    );
  });

  it("has the Firstmate weed out repeats, keep a filing with a reason, offer optional ideas together, and check what a merge covered", () => {
    const core = FIRSTMATE_PROMPT_CORE;
    expect(core).toContain("Search tasks first; drop a repeat as covered");
    expect(core).toContain("leave planned with a verdict and priority");
    expect(core).toContain("Optional ideas stay unfiled unless the captain picks them");
    expect(core).toContain("offer worthwhile choices on one decision card.");
    // A captain's merge wakes the first mate only when it fails or frees work
    // only a start begins (INF-834's friction 7), so a covered task is linked
    // to wait on the merge that covers it.
    expect(core).toContain(
      "Link unstarted tasks the report says it covers to wait on it (link_tasks blocks, on request); after merge, drop one as covered only if its whole goal was met",
    );
    expect(core).toContain("removing blocks links first. Partial or unsure tasks stay");
    expect(core).toContain("naming each key checked, its fate and those unchecked");
    expect(updateParameters.properties.verdict?.description).toContain(
      "what waiting costs, who pays it and what would start it",
    );
    expect(updateParameters.properties.reason?.description).toContain("covered by its key");
  });
});

describe("the tradeoff chart's rules reach every card author (INF-6293)", () => {
  // The captain: "can we make these tradeoff charts a common building block
  // that can be used in any card". One text in the card rules is the nudge
  // for plan, decision and review cards alike, the first mate's included.
  it("serves the one text to the first mate and every crewmate runtime", () => {
    const facts = [
      "A question whose options differ under two or more whole-product qualities carries a <table data-inf-tradeoff> under its options",
      "Headings are qualities wanted more of, in one or two words that fit any change",
      "Its options' labels are a dozen words at most",
      "An option for what the project does now marks its input data-inf-current, tagged As built, and has its row.",
      "No table for a look, wording or layout, one quality, a yes or no, a consent",
    ];
    for (const [name, served] of [
      ["firstmate", buildFirstmateSystemPrompt()],
      ["crewmate/pi", buildCrewmateSystemPrompt("pi")],
      ["crewmate/claude", buildCrewmateSystemPrompt("claude")],
    ] as const) {
      for (const fact of facts) expect(served, `${name}: ${fact}`).toContain(fact);
    }
  });
});

/**
 * The plan-to-build handoff, read the way each agent receives it: the
 * served persona prompt, plus the sequences document the Firstmate is
 * served after it and the basis section a builder's brief carries. Each
 * fact must reach every agent that acts on it, wherever its one home is;
 * a fact that stops reaching one is a change of behaviour, not of structure.
 */
describe("the plan-to-build handoff reaches every agent that acts on it", () => {
  const builderBasis = renderBasisSection({
    key: "FM3K-7",
    title: "Plan the meter",
    outcome: "Two directions; the captain chose B.",
    choice: "Approve and build",
    answers: ['- look: {"tiltDeg":57}, changed'],
  });
  const agents = [
    ["firstmate", `${buildFirstmateSystemPrompt()}\n\n${SEQUENCES_SEED}`],
    ["crewmate", `${buildCrewmateSystemPrompt()}\n\n${builderBasis}`],
    ["crewmate/pi", `${buildCrewmateSystemPrompt("pi")}\n\n${builderBasis}`],
    ["crewmate/claude", `${buildCrewmateSystemPrompt("claude")}\n\n${builderBasis}`],
  ] as const;

  it("tells every agent what authorizes implementation and what does not", () => {
    const facts = [
      "The captain's Approve and build submits the current values, including unchanged defaults, and authorizes implementation, not merging",
      "No prior capture or second approval is required.",
      "explicit build or ship words authorize implementation",
      "without another approval click",
      "Selection alone, praise, finish/keep, dismissal and script-triggered actions are not build permission",
      "with settings builds nothing",
      "feedback revises the preview",
      "a reply is not a closing choice and does not authorize merging",
      "answer a reply with one thread line naming who is next, card unchanged",
      "Revise the same card once, naming the started builder as next owner",
    ];
    for (const [name, served] of agents) {
      for (const fact of facts) expect(served, `${name}: ${fact}`).toContain(fact);
    }
  });

  it("serves requested-plan acceptance and recovery safeguards to every agent", () => {
    const facts = [
      'A read-only planner defaults a product change to "Approve and build"',
      'and an operation to "Start the next step", beside "Save and defer" and "Abandon", with changes by reply',
      // INF-87 P1/P4: Queued owns continuation; Backlog and authorization boundaries remain.
      "Acceptance queues approved plan pieces (when-ready)",
      "the host starts each as its prerequisites clear",
      // INF-3170: the builder fixes its own work's failures without a second approval.
      "It authorizes no credential command, permission change, merge, or repair outside the approved work; fixing the approved work's own failures is part of building it.",
      "Backlog (on-request) waits for the captain's word",
      "do not requeue a piece they moved there without fresh authorization",
      "At a captain-only action, its crewmate asks on a card",
      "design-only limits even a filed build",
      "Never steer an unstarted builder or closed planner",
      "Every planned or recovered builder keeps the full accepted specification",
      "Implementation approval, plan closure, saved answers and passing validation never grant merge permission",
    ];
    for (const [name, served] of agents) {
      for (const fact of facts) expect(served, `${name}: ${fact}`).toContain(fact);
      // Contract 4.65 (FI3-642): a plan's changes come by reply, so no agent
      // is told to set a revision beside the handoff as a button.
      expect(served, name).not.toContain("with revision or deferral separate");
      expect(served, name).not.toContain("keeps-open revision");
      // FI3-872: a preview is a plan's card, so one default is offered.
      expect(served, name).not.toContain("Build it");
    }
  });

  it("tells each builder how to acknowledge the chosen result", () => {
    const facts = [
      "A planner never edits product code: on an approval by reply it reports the approval words and current settings with needs_firstmate, for the first mate to start implementation grounded on its answer",
      "Latest submitted values supersede earlier ones.",
      "the resolved implementation spec before product edits, without reopening approval",
      "product settings from demo-only theme, sample crew, layout and playback",
    ];
    for (const [name, served] of agents.slice(1)) {
      for (const fact of facts) expect(served, `${name}: ${fact}`).toContain(fact);
    }
  });

  it("tells every agent what Save and defer keeps, who files the build, and what starts it", () => {
    const facts = [
      "Save and defer keeps the agreed plan for later, starts nothing, and authorizes no build",
      "reuses the plan's planned successor, or else files one with create_task, on request",
      'titled "Build the saved plan: …", with the plan as basis, the implement constraint',
      "never a second, and with no card or reminder",
      "Abandon files nothing.",
      "The captain's Start on a saved build, or their words to build it, authorizes it",
      "its basis's Save and defer choice is not a refusal",
    ];
    for (const [name, served] of agents.slice(0, 1)) {
      for (const fact of facts) expect(served, `${name}: ${fact}`).toContain(fact);
    }
    // The planned build waits for the captain: the sequences document says so
    // where the Firstmate reads the implement step's line.
    expect(agents[0][1].replace(/\s+/g, " ")).toContain(
      "on Save and defer it waits on request until I press Start or ask",
    );
  });

  it("serves only the reader-specific rules to the reader that acts on them", () => {
    const firstmateOnly = [
      "reuses the plan's planned successor, or else files one with create_task",
      "Once implementation is authorized, the first mate starts the builder",
      "Before filing or starting, the first mate reconciles the built-on work",
      "record link_tasks blocks from it to the successor",
      "the first mate emits the question on the open parent or successor",
      "then call update_task start_now separately in this same turn",
    ];
    const crewOnly = [
      "Declare asking true on a question card",
      "A planner never edits product code",
      "The builder records and acknowledges the resolved implementation spec",
      "A saved build first checks the plan against the current code",
      "After an answer authorizes a build, report without a new captain wait",
      "A preview ships nothing: scratch stays private in the working copy",
      "footer choices and author-directed replies submit current settings",
      // INF-2715: the Firstmate's own cards are static, so a card script is the crew's alone.
      "An inline <script> (no src) may add behavior",
    ];
    for (const [name, served] of agents) {
      for (const fact of firstmateOnly) {
        if (name === "firstmate") expect(served).toContain(fact);
        else expect(served).not.toContain(fact);
      }
      for (const fact of crewOnly) {
        if (name === "firstmate") expect(served).not.toContain(fact);
        else expect(served).toContain(fact);
      }
    }
    // INF-416 piece H: reading the saved plan by key stays in the core, not a second time in HANDOFF.
    const [, firstmate] = agents[0];
    expect(firstmate).toContain(
      "Read saved plans with tasks by key and create accepted work yourself",
    );
    expect(firstmate).not.toContain("On approval, read original user words");
    expect(firstmate).not.toContain("Successful basis edit precedes separate start_now");
    expect(firstmate).not.toContain("Ask-first always cancels unsent merges");
  });

  it("keeps update_task's host consequences out of the description (INF-416 piece H)", () => {
    const unavailable = (): never => {
      throw new Error("only the served words are read");
    };
    const update = createTaskTools({
      plan: unavailable,
      update: unavailable,
      drop: unavailable,
      withdrawMerge: unavailable,
      pin: unavailable,
      override: unavailable,
      withdrawOverride: unavailable,
      withdrawAllowance: unavailable,
      startNow: unavailable,
      startAgain: unavailable,
      link: unavailable,
      query: unavailable,
    }).find((tool) => tool.name === "update_task");
    expect(update?.description).not.toContain("Successful basis edit precedes separate start_now");
    expect(update?.description).not.toContain("Ask-first always cancels unsent merges");
    expect(update?.description).not.toContain("destination changes cancel old approval");
    expect(update?.description).not.toContain("Sent merges cannot stop");
    expect(FIRSTMATE_HANDOFF).toContain(
      "call update_task basis first, read success, then call update_task start_now separately",
    );
  });

  it("sends an ask for a prototype to a plan with a preview, and grounds its builder", () => {
    const [, firstmate] = agents[0];
    for (const fact of [
      "an ask for a prototype, a mock-up or a try is a plan with a playable preview, relayed as the plan line says",
      "When I ask for a prototype, a mock-up or to try something, it is this plan with a playable preview as the card: the thing itself, adjustable, its settings staged for the build.",
      "without planning again",
      "task as basis",
      "into the builder's brief",
    ]) {
      expect(firstmate.replace(/\s+/g, " "), fact).toContain(fact);
    }
    // FI3-872: no crewmate is told of a prototype of its own; the
    // Firstmate's whole fixed context is held in firstmate-fixed-context.test.ts.
    for (const [name, served] of agents.slice(1)) {
      expect(served, name).not.toMatch(/prototype/i);
    }
  });
});

describe("the card contract is re-homed by kind (contract v3.6, captain lock 1)", () => {
  const mechanics = cardMechanicsSentences();
  const authoring = cardAuthoringSentences();
  const personas = [
    ["firstmate", buildFirstmateSystemPrompt()],
    ["crewmate", buildCrewmateSystemPrompt()],
    ["crewmate/pi", buildCrewmateSystemPrompt("pi")],
    ["crewmate/claude", buildCrewmateSystemPrompt("claude")],
  ] as const;

  it("splits both halves into sentences worth pinning", () => {
    expect(mechanics.length).toBeGreaterThan(5);
    expect(authoring.length).toBeGreaterThan(5);
    for (const sentence of mechanics) expect(CARD_MECHANICS).toContain(sentence);
    for (const sentence of authoring) expect(CARD_AUTHORING).toContain(sentence);
  });

  it("gives every persona the authoring text exactly once", () => {
    const decisionFirst =
      "An answer implying any captain next step, even optional, is a decision; only a pure fact is a note.";
    expect(CARD_AUTHORING.split(decisionFirst).length - 1).toBe(1);
    for (const [name, prompt] of personas) {
      const text = name === "firstmate" ? FIRSTMATE_CARD_AUTHORING : CARD_AUTHORING;
      expect(prompt.split(text).length - 1, name).toBe(1);
      expect(prompt.split(decisionFirst).length - 1, name).toBe(1);
    }
  });

  it("gives every persona the five sentence habits for card copy, once (contract v4.58)", () => {
    // FI3-542: the habits are the project's own words. No persona is told to
    // write in an outside standard, and none carries a word list for it.
    const habits = [
      "A card sentence holds one fact in at most 25 words.",
      "One thing keeps one name, and takes its full name wherever two things share a number",
      "A sentence names who or what did the work",
      "Speak literally, without figures of speech.",
      "Number three or more actions in a row.",
    ];
    for (const [name, prompt] of personas) {
      for (const habit of habits)
        expect(prompt.split(habit).length - 1, `${name}: ${habit}`).toBe(1);
      expect(prompt, name).not.toMatch(/STE100|Simplified Technical English/);
    }
  });

  it("repeats none of the authoring text in either descriptor", () => {
    for (const description of [CREWMATE_EMIT_CARD_DESCRIPTION, FIRSTMATE_EMIT_CARD_DESCRIPTION]) {
      for (const sentence of authoring) expect(description, sentence).not.toContain(sentence);
    }
  });

  it("repeats none of the call mechanics in any persona", () => {
    for (const [name, prompt] of personas) {
      for (const sentence of mechanics)
        expect(prompt, `${name}: ${sentence}`).not.toContain(sentence);
    }
  });

  /**
   * The card-reply contract has the same shape of home (cards-as-threads
   * phase 1, contract v4.2, the captain's Q4 B): ONE text, once per
   * persona, repeated by no descriptor - the Firstmate and a crewmate must
   * handle a reply the same way, so neither may be given its own version.
   */
  it("gives every persona the card-reply contract exactly once", () => {
    for (const [name, prompt] of personas) {
      expect(prompt.split(CARD_REPLY).length - 1, name).toBe(1);
    }
  });

  it("repeats none of the card-reply contract in any tool description", () => {
    const reply = cardReplySentences();
    expect(reply.length).toBeGreaterThan(3);
    for (const sentence of reply) expect(CARD_REPLY).toContain(sentence);
    for (const description of [
      FIRSTMATE_EMIT_CARD_DESCRIPTION,
      ...CREWMATE_TOOLS.map((tool) => tool.description),
    ]) {
      for (const sentence of reply) expect(description, sentence).not.toContain(sentence);
    }
  });

  /**
   * The captain-owned sequences served after the Firstmate's prompt
   * (docs/sequences.md, contract v4.6) are held to the same rule: the seed
   * the app ships restates none of the card contract, so the served
   * prompt never carries a sentence of it twice.
   */
  it("keeps the sequences seed free of the card contract's sentences", () => {
    for (const sentence of [
      ...authoring,
      ...mechanics,
      ...cardReplySentences(),
      ...handoffSentences(),
    ]) {
      expect(SEQUENCES_SEED, sentence).not.toContain(sentence);
    }
  });

  /**
   * The plan-to-build handoff has the same shape of home (contract v4.41,
   * the FI3-377 audit): until v4.40 the Firstmate core, three authoring
   * paragraphs, the reply contract, the sequences seed and the brief's
   * basis section each said it in their own words. ONE text now, once per
   * persona, and no other text the agents read carries a sentence of it.
   */
  it("gives every persona the handoff exactly once and restates it nowhere else", () => {
    const handoff = handoffSentences();
    expect(handoff.length).toBeGreaterThan(4);
    for (const sentence of handoff) expect(HANDOFF).toContain(sentence);
    for (const [name, prompt] of personas) {
      const text = name === "firstmate" ? FIRSTMATE_HANDOFF : CREWMATE_HANDOFF;
      expect(prompt.split(text).length - 1, name).toBe(1);
      const rest = prompt.replace(text, "");
      for (const sentence of handoff) expect(rest, `${name}: ${sentence}`).not.toContain(sentence);
    }
    // FI3-628: removing obsolete approval choices must not remove the next owner.
    expect(HANDOFF).toContain("a bare authorization needs no card update");
    expect(HANDOFF).toContain(
      "Closing the planning card never starts, cancels or merges its successor",
    );
    const basis = renderBasisSection({
      key: "FM3K-7",
      title: "Plan the meter",
      outcome: "B, tilted.",
      choice: "Approve and build",
      answers: ['- look: {"tiltDeg":57}, changed'],
    });
    for (const text of [
      basis,
      FIRSTMATE_EMIT_CARD_DESCRIPTION,
      ...CREWMATE_TOOLS.map((tool) => tool.description),
    ]) {
      for (const sentence of handoff) expect(text, sentence).not.toContain(sentence);
    }
  });

  it("keeps the figure vocabulary in the authoring text, prescribing no shape", () => {
    // The visual vocabulary is written in place (the captain's call), not
    // imported. Contract v2.5: it teaches the design system and prescribes
    // no figure - there is no recipe list and no helper to call.
    expect(CARD_AUTHORING).not.toContain("fm.viz");
    expect(CARD_AUTHORING).not.toContain("statusStrip");
    expect(CARD_AUTHORING).not.toContain("quotaMeter");
    expect(CARD_AUTHORING).toContain("Draw whatever figure the explanation calls for.");
    expect(CARD_AUTHORING).toContain(
      "Crewmate answers, plans, decisions and notes may include demos",
    );
    expect(CARD_AUTHORING).toContain("Draw figures as inline <svg>");
    expect(CARD_AUTHORING).toContain("A full-width drawing is 750 units wide");
    expect(CARD_AUTHORING).not.toContain("350px");
    // Contract v2.6: the accent budget is per figure, not per card.
    expect(CARD_AUTHORING).toContain("--accent for the lit or current element");
    expect(CARD_AUTHORING).toContain("one accent per figure, not per card");
    expect(CARD_AUTHORING).not.toContain("across the whole card");
    expect(CARD_AUTHORING).toContain("ok/warn/danger for real state");
    expect(CARD_AUTHORING).toContain("Each part of an explanation gets its own figure");
    expect(CARD_AUTHORING).not.toContain("an image the body carries as a data: URI renders");
    expect(CARD_AUTHORING).not.toContain("literal colors, <image>, filters");
    // FI3-869: served guidance asks what a press adds, not the subject alone.
    for (const [name, prompt] of [
      ["crewmate/pi", buildCrewmateSystemPrompt("pi")],
      ["crewmate/claude", buildCrewmateSystemPrompt("claude")],
    ] as const) {
      for (const fact of [
        "A figure plays only when a press shows what one still drawing cannot hold",
        "a figure with one value the reader would vary takes one control that redraws it",
        "Motion runs on the captain's press or drag, one pass, never on arrival and never in a loop",
        "Every other figure stays still, a timeline, a chart, numbered steps and a flow among them",
        "a cursor or highlight sweeping a drawing that already shows every state adds nothing",
        "Previews are exempt: they draw something that does not exist yet",
        "a moving figure's script sits inside its <figure>",
        "the resting markup is the whole explanation without the script",
        "when the duration tokens (--dur-med, --dur-slow) read zero every move is a cut",
      ]) {
        expect(prompt, `${name}: ${fact}`).toContain(fact);
      }
    }
    for (const text of [CARD_AUTHORING, FIRSTMATE_PROMPT_CORE, buildCrewmateSystemPrompt("pi")]) {
      expect(text).not.toContain("Prefer concise headings");
      expect(text).not.toContain("Prefer headings, paragraphs, lists, tables");
    }
  });

  it("states the visual intent as a fact about the card, not the author's judgment (lock 2)", () => {
    // Root 1 of the audit: every concrete rule was obeyed at or near 100% by
    // the families that received it, while the one sentence phrased as a
    // condition the author resolves scored 0 of 11 on codex. The mood, not
    // the address, is what changed here.
    expect(CARD_AUTHORING).toContain(
      "showing state, shape or layout is drawn: that sentence, then the figures carrying it",
    );
    for (const text of [CARD_AUTHORING, ...personas.map(([, prompt]) => prompt)]) {
      expect(text).not.toContain("wherever a picture carries a point better than prose");
    }
    // The two opt-outs, restated the same way: the crewmate's picture of a
    // visible change, and the Firstmate's own figures.
    expect(buildCrewmateSystemPrompt("pi")).toContain("pictures included for a visible surface");
    expect(buildCrewmateSystemPrompt("pi")).not.toContain(
      "or Verified says in one sentence why not",
    );
    expect(FIRSTMATE_PROMPT_CORE).toContain(
      "Your own cards carry static SVG figures, and you draw them",
    );
    expect(FIRSTMATE_PROMPT_CORE).not.toContain("are yours to draw");
  });

  // INF-547: work that merges on its own, or builds in place on the personal
  // workspace, shows its story on a note the captain closes himself.
  it("offers an outcome card for finished captain work, a note where no click merges it, on both tool surfaces", () => {
    for (const tool of [
      CREWMATE_EMIT_CARD_DESCRIPTION,
      CREWMATE_TOOLS.find((item) => item.name === "emit_card")?.description,
    ]) {
      expect(tool).toContain(
        "For finished change work (not a plan's preview, review or internal step), show the outcome on a card before reporting",
      );
      expect(tool).toContain("Without a merge, emit a factual note with no merge action");
      expect(tool).toContain(
        "A task that builds in place shows its story on a note with no actions, which stays until the captain presses its Got it.",
      );
      // The prompt already says when to report waiting_on_captain and finished.
      expect(tool).not.toContain("waiting_on_captain");
      expect(tool).toContain(
        "Ask every merge on a merge card, one per pull request: one merge action",
      );
    }
    const prompt = buildCrewmateSystemPrompt();
    expect(prompt).toContain(
      "the card is the deliverable and the captain's choice on it closes the task",
    );
    expect(prompt).toContain("completion is a note showing what you built, then your report");
    // The descriptor assertions above hold each outcome shape; the persona points there.
    expect(prompt).toContain("Follow emit_card's contract for the outcome card");
  });

  it("keeps the crewmate's completion trigger and drops the buttons the host attaches (lock 3)", () => {
    expect(CREWMATE_EMIT_CARD_DESCRIPTION).toContain(
      "Ask every merge on a merge card, one per pull request: one merge action",
    );
    expect(CREWMATE_EMIT_CARD_DESCRIPTION).toContain("declare no others or labels");
    // Rows 2 and 3 of the audit's 4.4b table: the labels, the keep-button
    // clause and "what each option does" are the host's job or gone.
    expect(CREWMATE_EMIT_CARD_DESCRIPTION).not.toContain('labeled "Merge PR"');
    expect(CREWMATE_EMIT_CARD_DESCRIPTION).not.toContain("there is no keep button");
    expect(CREWMATE_EMIT_CARD_DESCRIPTION).not.toContain("what each option does");
    expect(CREWMATE_EMIT_CARD_DESCRIPTION).toContain(
      "no other merge or settle click comes back to you as a steer",
    );
    expect(CREWMATE_EMIT_CARD_DESCRIPTION).not.toContain("task_id");
    expect(FIRSTMATE_EMIT_CARD_DESCRIPTION).toContain(
      "Pass task_id only when the buttons act on that task, as a merge or settle effect needs",
    );
    // Its two refusals say themselves when a card breaks them (INF-490;
    // cardLint.test.ts owns their words and the ledger names their homes).
    expect(FIRSTMATE_EMIT_CARD_DESCRIPTION).not.toContain("This tool refuses");
    expect(FIRSTMATE_EMIT_CARD_DESCRIPTION).not.toContain("merge card");
    for (const description of [CREWMATE_EMIT_CARD_DESCRIPTION, FIRSTMATE_EMIT_CARD_DESCRIPTION]) {
      expect(description).not.toMatch(/explain.more/i);
      expect(description).not.toMatch(/reserved/);
    }
  });

  it("drops the card recipes the host now names as structured ways (lock 3)", () => {
    // Rows 7, 8 and 11: the blocked crewmate's options, the cap's options,
    // and "listing them verbatim" were prose in three places while the host
    // held every fact. `holds.ts` names them once, as data.
    expect(FIRSTMATE_PROMPT_CORE).not.toContain("listing them verbatim");
    expect(FIRSTMATE_PROMPT_CORE).not.toContain(
      "whose default action offers to try a stronger model",
    );
    expect(FIRSTMATE_PROMPT_CORE).not.toContain(
      "retry, a stronger model on the user's word, or discard",
    );
    expect(FIRSTMATE_PROMPT_CORE).toContain("carrying the wake's other ways");
  });
});

/**
 * The crewmate tool spec (primitives P7) is where every crewmate tool's
 * words live, once for both runtimes. Held both ways against the personas:
 * no tool description restates a persona's contract, and no persona
 * restates a tool description - a rule has one home, so a revision reaches
 * every crewmate from one edit.
 */
describe("the crewmate tool spec and the personas (contract v4.12, primitives P7)", () => {
  const personas = [
    ["crewmate", buildCrewmateSystemPrompt()],
    ["crewmate/pi", buildCrewmateSystemPrompt("pi")],
    ["crewmate/claude", buildCrewmateSystemPrompt("claude")],
    ["firstmate", buildFirstmateSystemPrompt()],
  ] as const;
  /** A description's sentences long enough to be a rule, split as the card contract's are. */
  const sentencesOf = (text: string) =>
    text
      .split(/(?<=[.;:])\s+/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length >= 40);

  it("restates no persona contract in any crewmate tool description", () => {
    const contract = [...cardAuthoringSentences(), ...cardReplySentences(), ...handoffSentences()];
    for (const tool of CREWMATE_TOOLS) {
      for (const sentence of contract) {
        expect(tool.description, `${tool.name}: ${sentence}`).not.toContain(sentence);
      }
    }
  });

  /**
   * The one restatement on file when the spec landed - the crewmate persona
   * repeating file_followup's search-first sentence - went with FI3-868's
   * persona words, which also ask for what a finding adds to the match.
   * This list only shrinks.
   */
  const KNOWN_RESTATEMENTS = new Set<string>();

  it("restates no crewmate tool description in any persona", () => {
    const found = new Set<string>();
    for (const tool of CREWMATE_TOOLS) {
      const sentences = sentencesOf(tool.description);
      expect(sentences.length, tool.name).toBeGreaterThan(0);
      for (const [, prompt] of personas) {
        for (const sentence of sentences) {
          if (prompt.includes(sentence)) found.add(`${tool.name}: ${sentence}`);
        }
      }
    }
    expect([...found]).toEqual([...KNOWN_RESTATEMENTS]);
  });

  it("keeps every crewmate tool description inside the Claude transport's cap", () => {
    for (const tool of CREWMATE_TOOLS) {
      expect(tool.description.length, tool.name).toBeLessThan(CLAUDE_TOOL_DESCRIPTION_CAP);
    }
  });
});

// Reader tags must not silently rewrite the full approved source.
// INF-680 adds the Anything else? box sentence for crewmates; INF-924 makes it the one field's.
// INF-490 drops the sentences its refusals and the tool answers already say.
it("keeps the full authoring and handoff sources word for word", () => {
  // INF-1177 moves lesson voice into its runbook; fixed card mechanics and runbook precedence stay.
  // INF-2142's approved plan adds the crewmate's sentence keeping clock times out of a change story.
  // INF-2326's approved plan adds the two rules for a card's words (a project's own term, a change's effect).
  // INF-2715's approved plan asks each question in its section and adds the task words file and start.
  // INF-2744's approved plan names the one merge card: the fact strip rides a merge or settle effect.
  // INF-3674's approved plan writes to the captain in their language and keeps the project's for commits.
  // The prompt-budget trim says the same card rules in fewer words.
  // INF-3749's approved plan (Picture first) gives each figure its numbers and folds the rest under a named expand.
  // A later prompt-budget trim says the prose tokens, the copy rule and the fact strip in fewer words.
  // INF-4574's direction B asks a crewmate only for the captain's part and keeps the crew's own work a fact.
  // INF-4425 (INF-4422 direction A) says when a question may be skipped and that a skip sends its Default.
  // A prompt-budget trim says that rule, the reply field, pictures, a preview's look and the project's language in fewer words.
  // A prompt-budget trim after INF-4425 says the skip rule, the draft button, the fact strip, runbook precedence, and time and language in fewer words.
  // The prompt-budget trim keeps these rules while shortening their wording and examples.
  // INF-5446 (the captain chose to apply synced settings through the preview's own controls) adds inf.stage's apply and the card's unsent draft.
  // A prompt-budget trim says the draft button, the browser, files and risk words, the strip and the closing reply lines in fewer words.
  // INF-6293's approved plan adds the one tradeoff chart text every author reads; the token list, the write-in row and time and language say the same in fewer words.
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  expect(hash(CARD_AUTHORING)).toBe(
    "035e35bfd6a4c95b37778976f8a0279939c69805a55653c2e5d8e0c06d7797f6",
  );
  // INF-416 piece H drops HANDOFF's restatement of reading the saved plan by key; the core still says it.
  // INF-976 widens the first mate's check before a start to filing, read off the built-on work.
  // INF-2744 names the captain's separate click by the merge card's name.
  // INF-3170's approved plan keeps a builder's repair of its own work inside the approval.
  // The prompt-budget trim (INF-3227) says the same rules in fewer words, in both sources.
  // INF-4509's chosen direction B files every approved piece in the approval's turn, and a parent never builds.
  // INF-4517's piece 4 asks careful review on the plan card, the recommended parts ticked, and files each part at it.
  // A later prompt-budget trim says the careful-review rule in fewer words, in both halves.
  // A prompt-budget trim after INF-4425 says the first mate's filing of a plan's pieces in fewer words.
  // A later prompt-budget trim drops three restatements: the planner's read-only limit, the closed-answer line and the bounded-work line.
  // INF-6293's approved plan makes room for the tradeoff chart text: the merge permission line says the same in fewer words.
  expect(hash(HANDOFF)).toBe("60089ed6f97cdb96a4ce0617e436615551f23720121fab969685c498a935ea8e");
});
