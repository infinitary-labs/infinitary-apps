import { RISK_DIMENSIONS, RISK_WHY_MAX, RISK_WORDS } from "@shared/risk";

/**
 * The card contract, re-homed BY KIND (orchestrator contract v3.6, captain
 * lock 1 of 2026-09-19 on the visual-density audit
 * `fm3000-card-visual-density-audit-s1`, section 6.1). Until v3.5 one 5.3 KB
 * blob in the `emit_card` description carried four different kinds of
 * instruction at once. The audit measured what that cost and where each kind
 * belongs:
 *
 * - `CARD_AUTHORING` - what a card IS and how it should look: lead with the
 *   answer, draw it, one figure per part, `<details>` for evidence, the
 *   design-system vocabulary, the voice rules. It lives in ONE constant every
 *   persona renders exactly once for its reader (`buildCrewmateSystemPrompt` on Pi and
 *   Claude; `buildFirstmateSystemPrompt`), because the system prompt is
 *   the only channel that arrives whole on every backend and it is where the
 *   deliverable is already defined.
 * - `CARD_MECHANICS` - how to CALL the tool: the card's two shapes, actions,
 *   effects and settle semantics, the body's wire format, id reuse. It stays
 *   in the descriptor, under the 2,048-character cap the Claude transport
 *   silently truncates at (`claudeToolSurface.test.ts` is the guard).
 * - what THIS task's answer should look like - the host-rendered brief
 *   (`renderAnswerShapeSection` in `orchestrator/intentBrief.ts`).
 *
 * The visual intent is stated as a FACT about the card, not a question handed
 * to the author (captain lock 2): the audit found every concrete rule obeyed
 * at or near 100% by every model family that received it, while the one
 * sentence written as the author's judgment call - "explain visually wherever
 * a picture carries a point better than prose" - scored 0 of 11 on the family
 * most work routes to. Keep the factual mood of "a decision marks exactly one
 * default"; never phrase an authoring rule as a condition the author resolves.
 *
 * The figure vocabulary is written in place (the captain's call: "why not
 * directly in CARD_CONTRACT?"). The design skill owns the token values it
 * names and points at `CARD_AUTHORING` instead of restating it. It prescribes
 * no figure SHAPE (v2.5): it teaches the design system - the theme tokens,
 * accent as the lit element, ok/warn/danger as real state - and leaves the
 * drawing to the explanation, because the audit that forced it found every
 * recent card carrying the same one figure. Never reintroduce a recipe list.
 * The accent budget is scoped PER FIGURE (v2.6, the captain's call reversing
 * v2.5's whole-card reading). At v2.7 the settle facts the host appends are
 * the labeled fact strip (`.inf-facts`, `CrewSupervisor.settleFacts`); at v3.6
 * that strip also carries the holds the host placed on the task, so no prompt
 * asks an agent to type out a round count it cannot see.
 */

/**
 * What a card is and how it should look - the ONE authoring text, included
 * once by every persona, filtered by reader under FI3-566. The captain
 * approved keeping crew-only passages out of Firstmate. No descriptor repeats a
 * sentence of it, and no persona writes its own version; `piResources.test.ts`
 * pins both directions.
 */
type InstructionReader = "firstmate" | "crewmate";
type InstructionPart = string | { reader: InstructionReader; text: string };
const crewOnly = (text: string): InstructionPart => ({ reader: "crewmate", text });
const firstmateOnly = (text: string): InstructionPart => ({ reader: "firstmate", text });

function renderInstructions(parts: readonly InstructionPart[], reader?: InstructionReader): string {
  return parts
    .filter((part) => typeof part === "string" || !reader || part.reader === reader)
    .map((part) => (typeof part === "string" ? part : part.text))
    .join(" ");
}

const CARD_AUTHORING_PARTS: readonly InstructionPart[] = [
  "CARD AUTHORING",
  "A decision with several questions asks each one in the body, beside the paragraph it is about, as an ordinary form control presented however reads best - radio buttons, checkboxes, a select, a text field. Give every question its own name on its controls, word the question itself in the <legend> of a <fieldset> around its options (or a <label> bound to a lone field), keep each name and option value short and stable, mark required a question the captain must answer, and bind a <label> to each option so the pick reads in words. Radio, checkbox and select questions arrive unpicked so every answer is the captain's own: check and select nothing, open a select on an empty <option value=\"\">Choose</option>, and put data-inf-recommended on the input or <option> you recommend - the app tags it Recommended without picking it. Outside a preview, every radio group, select and group of two or more checkboxes ends with your own row worded Something else and marked data-inf-write-in - one more input with the question's name, or the select's last <option> - and the app opens a text field under it once picked; a question whose options are the only possible answers carries data-inf-options-only on its <fieldset> or <select> instead. An answer marked written in is the captain's own words: follow them like a reply, and ask on the card only when they cannot be followed. A text field keeps its prefilled text and a preview its current settings. A pick sends nothing: the footer button the captain clicks carries every named field with that choice - the default once every required question has an answer, any other button whatever is picked so far - so never call inf.action from a control.",
  // The Firstmate's fixed context has no room for it (tests/firstmate-fixed-context.test.ts):
  // it reads the field's answer by the written-in rule above, and the lint names the reserved name.
  crewOnly(
    "The app draws its own field above a card's buttons: words the captain sends from it alone arrive as a reply, and words left there when the captain clicks a button arrive with that choice as the answer anything_else, written in, so never add a box of your own for further comments.",
  ),
  crewOnly(
    "A playable preview is a decision body that draws the thing being chosen with its own controls; a hidden field or inf.stage(name, value) carries its settings as a compact JSON snapshot with stable names and units, at most 4,096 UTF-8 bytes in all. Controls update the preview and the renderer's draft only, never an author turn; the footer choices submit the current settings, and so do author-directed replies. A preview ships nothing: scratch stays private in the working copy, and the same card is revised as feedback arrives.",
  ),
  "A card leads with its answer: one sentence, first, in the open.",
  "An answer that implies any potential next step for the captain, even an optional one, is a decision; only a pure fact with no next step is a note.",
  'Every body is a semantic HTML fragment rendered in a sandboxed frame with the app stylesheet; no network. An inline <script> (no src) may add behavior - a canvas, a toggle, inf.action(id, value) for a declared action, a figure that moves - and loads nothing. A <button data-inf-draft="words"> puts its words, one line, at the start of the message box on the captain\'s own press, sending nothing, for them to finish.',
  crewOnly(
    "A figure plays only when a press shows what one still drawing cannot hold - the same thing in two places, as a card moving through a stack or crew arriving on a ring, or more states than panels would fit - and a figure with one value the reader would vary takes one control that redraws it. Every other figure stays still, a timeline, a chart, numbered steps and a flow among them; a cursor or highlight sweeping a drawing that already shows every state adds nothing. Previews are exempt: they draw something that does not exist yet. Motion runs on the captain's press or drag, one pass, never on arrival and never in a loop; a moving figure's script sits inside its <figure>; the resting markup is the whole explanation without the script, its labels in the markup where the size check reads them, and when the duration tokens (--dur-med, --dur-slow) read zero every move is a cut.",
  ),
  "An answer that explains how something works, compares options, or shows state, shape or layout is drawn - that sentence, then the figure or figures carrying it. An explanation with several parts gets several figures, each beside the short sentence it illustrates, rather than one crowded drawing; a single figure is right only when the explanation has one part.",
  crewOnly("Crewmate answers, plans, decisions and notes may include demos."),
  "Prose carries what a picture cannot - a name, a number, a quote, a caveat - and stays in the open beside the figure it qualifies; <details> holds only what a reader who digs would want: evidence, exact code paths, qualifications.",
  'Drawn figures are inline <svg> with a viewBox, width="100%" when the drawing is full width, wrapped in <figure> with an aria-label. Make a drawn figure belong to the app by drawing in the design system: color through the theme tokens (--fg-1..3, --bg-0..3, --line-1..2, --accent, --ok, --warn, --danger, --idle; --accent, --ok, --warn and --danger each also have a -dim fill) so it follows light and dark, --accent for the lit or current element of that figure - one accent per figure, not one per card - and ok/warn/danger for real state; literal colors are fine where a token would not say more. Draw whatever figure the explanation calls for.',
  "A full-width drawing is 750 units wide so one unit is one pixel in the usual card, and labels use the app's own sizes: unsized for 12.5px, 14px for the one that matters, 11px mono for micro labels, never larger than body text unless it is a deliberate display number. A smaller drawing takes its pixel width, not 100 percent, so the card only shrinks it. SVG type, including flowing text in foreignObject, scales with the drawing and shrinks with it in a narrow card, under 11px; text elements do not wrap, so shorten labels or use foreignObject for flowing text.",
  crewOnly(
    "A picture from a working copy is an <img> whose src is the file's path relative to that working copy - a PNG, JPEG or WebP - and whose alt says what it proves, placed beside the sentence it illustrates; the host verifies the file, keeps its own copy, and shows it fitted to the card and whole, never cropped. Several pictures inside one <figure class=\"inf-pictures\"> are a group: the first shown large, the rest as small thumbnails, and a <figcaption> as the group's caption. A card holds as many pictures and groups as the answer needs, up to 64 MB in all; never encode a picture into the body yourself or name one by URL.",
  ),
  "For prose, use design-token CSS variables (--fg-1, --fg-2, --fg-3, --accent, --line-1, --bg-1, --font-mono, ...) and the inf-mono, inf-muted, inf-row, inf-grid, and inf-panel classes; <details> takes a <summary>, <mark> holds the one thing to notice, <kbd> a key.",
  crewOnly(
    "A preview or a drawing of a project's screens takes that project's own look, read from its source: its colors, type, spacing and controls, which for Infinitary is the design system above. It may bring its own <style> sheet, classes, CSS lengths and colors, and data-* hooks its script reads, and it restyles every element it draws, since the app stylesheet dresses whatever it leaves bare. The card's own answer, explanation and questions keep the app's look. A preview loads a project's font file only by path: an @font-face src url() naming a WOFF2, WOFF, TTF or OTF file by its path in the working copy, or by its absolute path in the evidence folder, which the host checks, keeps and serves like a picture; nothing else loads.",
  ),
  "Card copy is sentence case, factual, free of exclamation points and emoji, and self-contained: title and body make sense with no prior conversation, and name the work in plain language rather than only a PR number or SHA.",
  "A sentence of card copy holds one fact in at most 25 words. One thing keeps one name, and takes its full name wherever two things share a number: stable 1.4 and alpha 1.4-alpha.2, never 1.4 for both. A sentence names who or what did the work: I updated three tests, never three tests were updated. It says the thing literally, with no figure of speech. Three or more actions in a row are a numbered list.",
  "Card copy is written for someone who has never opened a terminal, in the words they use about their own project: say your project, and repository only when the sentence points at GitHub; a pull request, or PR #N in mono, and on a plain host the pushed branch; the checks passed or failed, and CI, green or red may sit beside the checks; a branch for a git branch, a working copy for a worktree; merge, never land or put it in; a commit, never a save point; push, never sent up; lint, never tidy-up; bring up to date, never rebase or conflict; your plan's allowance, never quota; your sign-in or your GitHub sign-in, and OAuth app or token only one click deeper; where the project lives, name the host when known, and remote or origin only one click deeper; the version, never a SHA or head in the sentence; clone for cloning a project, never copy; the code, never device code; a stronger model, never escalation; what happened and what to do, never an error code or a stack; and never name a CLI, a tool, gh, a binary or the search path - say what could not be done. A technical name appears only where the person chose it (a model, a provider, a plan), where it is the thing itself in mono (a PR number, a key, a file path), or inside <details> for a reader who digs; the sentence around it never needs it to be understood.",
  'A pull request a body names by its number is a link to its page: <a class="inf-mono" href="its page">PR #N</a>. A task\'s pull request page is the change on its tasks row; a number whose page no tool answer gave you stays plain mono, never a guessed address.',
  "For cards a runbook describes, its voice, length, layout, opening and button names win over core author guidance. Fixed card shape, consent and host effects always hold.",
  "Write times on cards, replies and reports in the captain's context-named local time zone (9:05 AM), unless they ask otherwise; convert source UTC, never UTC alone.",
  "On a card carrying a settle effect the host writes the project, the crewmate's model, the task's care level, the pull request, the checks' state and any hold it has placed on the task - as its own strip, after the body. Those facts are never the body's to repeat or to get wrong.",
];

/** Full authoring contract, unchanged for both crewmate runtimes. */
export const CARD_AUTHORING = renderInstructions(CARD_AUTHORING_PARTS);
/** Firstmate authors static SVG, not previews, motion, demos or working-copy pictures. */
export const FIRSTMATE_CARD_AUTHORING = renderInstructions(CARD_AUTHORING_PARTS, "firstmate");

/**
 * The card-reply contract (cards-as-threads phase 1, contract v4.2; the
 * captain's Q4 B: "this is not just crewmate - firstmate should largely
 * share the same contract for how to handle card replies, and we should
 * actively encourage them to revise the card, not just reply with prose").
 *
 * ONE text, included exactly once by every persona beside `CARD_AUTHORING`,
 * because a thread has two ends and both agents stand at one of them. The
 * `reply` descriptor states how to call the tool and repeats no sentence of
 * this, the same split `CARD_MECHANICS` has from `CARD_AUTHORING`, and
 * `piResources.test.ts` pins both directions.
 *
 * The settle clause is the whole of the hand-off (captain's Q2, as
 * corrected): nothing in the host reads the captain's words, so a crewmate
 * asked for something that is not its to do closes its card and carries
 * those words verbatim into its report, declaring needs_firstmate, which
 * the whose-turn rule routes to the Firstmate on any backend (FI3-710).
 *
 * Contract v4.14 adds WHEN (the captain's "ship it" of 2026-09-27): the
 * answer is done at its author's close-out - since INF-926 a crewmate's
 * turn end, never a report while it works on, and the Firstmate's turn end
 * - so the work comes first, the answer once, and an acknowledgement never.
 * A reply never moves the card (INF-770 direction A).
 */
export const CARD_REPLY = [
  "CARD REPLIES",
  "Captain replies carry card ids.",
  "Do the work first; always answer in-thread in one to three sentences. For changed cards, emit_card with SAME id and answer as reply on every revision while answering; otherwise reply.",
  "A reply never moves the card: it stays beside its thread. Answers show once sent: give results when research is done, before other work, never acknowledgements or promises.",
  "Reply in sentence-case prose, never actions or scripts; figures revise the card.",
  "Replies resolve nothing; buttons stay: a reply is not a closing choice and does not authorize merging. Never close merely for a reply.",
  "For merging, discarding, a stronger model or unrelated work, close your card and report the captain's words verbatim with needs_firstmate; the first mate acts.",
].join(" ");

/** A product plan's default, as HANDOFF has a planner label it. */
export const APPROVE_AND_BUILD = "Approve and build";
/** An operation plan's default, as HANDOFF has a planner label it. */
export const START_THE_NEXT_STEP = "Start the next step";
/** The ready plan's choice that keeps it for later, as HANDOFF has a planner label it. */
export const SAVE_AND_DEFER = "Save and defer";
/** The ready plan's choice that keeps nothing to build, as HANDOFF has a planner label it. */
export const ABANDON = "Abandon";

/**
 * The plan-to-build handoff (contract v4.41, the FI3-377 audit): what a
 * choice on a plan or investigation authorizes, who builds it,
 * and what the builder starts from. The host decides none of it - it
 * records the choice, the answers and the basis, and mints the brief - so
 * the judgment is the agents', stated in ONE text every persona includes
 * exactly once beside `CARD_REPLY`, filtered by reader under FI3-566. Until v4.40 it was restated in the
 * Firstmate core, three `CARD_AUTHORING` paragraphs, `CARD_REPLY`, the
 * sequences seed and the brief's basis section, in three vocabularies;
 * `piResources.test.ts` pins that none of them repeats a sentence of it.
 */
const HANDOFF_PARTS: readonly InstructionPart[] = [
  "HANDOFF",
  `A read-only planner defaults a product change to "${APPROVE_AND_BUILD}" and an operation to "${START_THE_NEXT_STEP}", beside "${SAVE_AND_DEFER}" and "${ABANDON}", with changes by reply. Read-only limits the planner, not its authorized successor.`,
  crewOnly(
    "Declare asking true on a question card and design_only true for design-only exploration. Do not guess either from sentences, and repeat it on a revision.",
  ),
  "Acceptance queues approved plan pieces (when-ready); the host starts each as its prerequisites clear. It authorizes no credential command, repair, permission change or merge. Backlog (on-request) waits for the captain's word; do not requeue a piece they moved there without fresh authorization. At a captain-only action, its crewmate asks on a card; design-only limits even a filed build.",
  `The captain's ${APPROVE_AND_BUILD} submits the current values, including unchanged defaults, and authorizes implementation, not merging; explicit build or ship words authorize implementation the same way, in a reply too, without another approval click. No prior capture or second approval is required.`,
  "Selection alone, praise, finish/keep, dismissal and script-triggered actions are not build permission, and neither is a preview's own report, settings capture or a control; feedback with settings builds nothing, and ordinary feedback revises the preview. Record their facts if needed, then stop; a closed answer is acknowledgement, not build permission. Do not reinterpret old offers or start unrelated backlog work.",
  firstmateOnly(
    `${SAVE_AND_DEFER} keeps the agreed plan for later, starts nothing, and authorizes no build: in that turn the first mate reuses the plan's planned successor, or else files one with create_task, on request, titled "Build the saved plan: …", with the plan as basis, the implement constraint and the plan's original user words - never a second, and with no card or reminder. Abandon files nothing.`,
  ),
  crewOnly(
    "A planner never edits product code: on an approval by reply it reports the approval words and current settings with needs_firstmate, for the first mate to start implementation grounded on its answer.",
  ),
  firstmateOnly(
    "Once implementation is authorized, the first mate starts the builder without planning again, naming the answer's task as basis - the chosen plan or investigation - and the host carries its report, card, thread, choice and latest answers into the builder's brief.",
  ),
  "Latest submitted values supersede earlier ones. Actual submissions override proposal defaults and old unresolved report prose; do not re-ask saved answers. Every planned or recovered builder retains the full accepted specification and actual selections, not a one-line digest.",
  crewOnly(
    "The builder records and acknowledges the resolved implementation spec before product edits, without reopening approval, and separates product settings from demo-only theme, sample crew, layout and playback.",
  ),
  `The captain's Start on a saved build, or their words to build it, authorizes it; its basis's ${SAVE_AND_DEFER} choice is not a refusal.`,
  crewOnly(
    `A saved build first checks the plan against the current code and asks one specific question on a card only when something the plan relied on changed or a question was left unanswered.`,
  ),
  firstmateOnly(
    "Before filing or starting, the first mate reconciles the built-on work its wake or by-key read names, closed too: covered work gets no start_now, refiling, spawn or basis change; steer the asker to its owner. Keep multi-part parents on request.",
  ),
  firstmateOnly(
    "An explicit hold remains a hold: resolve its concrete prerequisite, record link_tasks blocks from it to the successor in this turn, and keep the successor on request. Silently doing nothing is not a recorded hold; record waits, never invent one.",
  ),
  "A genuine consequential unanswered question needs a reachable specific question, not a generic permission wait.",
  firstmateOnly(
    "If the planner has closed and the builder has not started, the first mate emits the question on the open parent or successor.",
  ),
  "Never steer an unstarted builder or closed planner; steer only an active author who can revise its card. Start bounded work only when the settled scope genuinely authorizes it.",
  firstmateOnly(
    "For authorized ready unstarted work, reuse the successor. If its basis is missing, call update_task basis first, read success, then call update_task start_now separately in this same turn. Never combine basis and start_now or stop at attachment alone. On refusal, repair the concrete reason or record the real dependency; do not claim a start. If no successor exists, spawn it (or create then start it) with shape.basis and the implement constraint.",
  ),
  crewOnly(
    "After an answer authorizes a build, report without a new captain wait: a bare authorization needs no card update.",
  ),
  "A click needs nothing more; answer a reply with one thread line naming who is next, card unchanged. Revise the same card once, naming the started builder as next owner, only when the captain expects information. Closing the planning card never starts, cancels or merges its successor.",
  "Implementation approval, plan closure, saved answers and passing validation never grant merge permission. Read the task’s current autonomy fact; with autonomy off, merging still requires the captain’s separate completion-card click or explicit merge authorization under the existing rules. Checks are verification, not consent; do not infer or declare merge authorized from them.",
];

/** One handoff source, with each reader receiving the rules it acts on. */
export const HANDOFF = renderInstructions(HANDOFF_PARTS);
export const FIRSTMATE_HANDOFF = renderInstructions(HANDOFF_PARTS, "firstmate");
export const CREWMATE_HANDOFF = renderInstructions(HANDOFF_PARTS, "crewmate");

/**
 * How to CALL the tool: the descriptor's shared half. Kept small on purpose -
 * the Claude transport serves at most 2,048 characters of a tool description,
 * and no app tool describes a nested parameter, so anything a Claude crewmate
 * must read lives here or in a top-level parameter, never in a nested one.
 */
export const CARD_MECHANICS = [
  "Show the user a card: with actions it is a decision, without them a note.",
  "A decision gives 2 or 3 actions and marks exactly one default, the step you would take; every action closes the card, and changes come by reply, never a revise button. A note is one fact the user needs surfaced, never an unasked FYI.",
  "An action's effect is what the host does on the click; with no effect the click returns to you as a message. settle merge merges a direct-pr task's PR or merges a local-only task's branch and closes the task; settle discard drops the worktree unmerged; confirm true only when the body already says there are unmerged commits or uncommitted edits; open settings/subscriptions navigates; danger true renders a destructive choice. Other PR: request_merge.",
  "body is a raw HTML fragment: send tags, never entity-escaped markup. A footer button is the one send and carries every named field in the body; a body button may name a declared action with data-inf-action.",
  "Optional id: namespaced kebab-case (fm-feed-scroll). Reuse an open card's id to revise it in place when new information augments or overlaps it; a distinct finding is a new card, and an obsolete one closes with close_card.",
].join(" ");

/**
 * What a crewmate's descriptor adds: the outcome card it emits when
 * the brief's definition of done is met. A crewmate's cards attach to its own
 * task by construction, so it never passes task_id.
 *
 * Trimmed to its constraints at v3.6 (captain lock 3, audit 4.4b rows 2 and
 * 3): the crewmate declares the merge, and the HOST attaches the completion
 * buttons themselves from the task's posture and work status
 * (`CrewSupervisor.completionActions`) - the labels, the danger style and the
 * discard's `confirm` are facts the host holds and an agent was transcribing.
 * The body dictation went with them: "what each option does" described fixed
 * words for fixed buttons the model no longer writes.
 */
export const CREWMATE_CARD_ADDENDUM = [
  "For finished change work (not a plan's preview, review or internal step), show the outcome on a card before reporting. With a PR or branch to merge, emit one completion decision with one settle merge action, risk and required_actions ([] when none); the host attaches buttons, so declare no others or labels. Without one, emit a factual note with no settle action. A task that merges on its own or builds in place shows its story on a note with no actions instead, which stays until the captain closes it.",
  "For a continuation, name it in the body and say it starts once it is merged.",
  "No settle effects on intermediate questions; reuse an open outcome card's id. A click on a settle action never comes back to you as a steer; the host reports the outcome to the first mate.",
].join(" ");

/**
 * What the Firstmate's descriptor adds (task-system P1, attach first): a
 * card about existing work names its task, and what reaches the Firstmate
 * from a settle effect or a dismissal. At v3.6 the never-author-a-merge-card
 * rule is the HOST's refusal rather than prose alone (captain lock 3, audit
 * 4.4b row 9: on 2026-09-19 the Firstmate steered four crewmates to emit
 * their completion cards and emitted its own merge card beside each of
 * them). Since v4.59 it repeats neither the persona (where the task id comes
 * from) nor `CARD_MECHANICS` (what an effect-free click does). Since INF-490
 * the two refusals a carded task earns (`steerNotAnswerRefusal`,
 * `crewmateOwesCompletionRefusal`) and the note that names no task
 * (`NOTE_NEEDS_TASK_REFUSAL`, beside the `standalone` parameter) are said by
 * the refusals alone.
 */
export const FIRSTMATE_CARD_ADDENDUM = [
  "Pass task_id when the card concerns existing work; a settle effect needs it, and a decision without it becomes its own decision task waiting on the captain.",
  "A settle effect is run by the host, which reports the outcome; a dismissed card is not a choice and does not wake you - your next context block lists it.",
].join(" ");

/** The crewmate's emit_card description: the mechanics plus the outcome-card rule. */
export const CREWMATE_EMIT_CARD_DESCRIPTION = `${CARD_MECHANICS} ${CREWMATE_CARD_ADDENDUM}`;

/** The Firstmate's emit_card description: the mechanics plus attach-first. */
export const FIRSTMATE_EMIT_CARD_DESCRIPTION = `${CARD_MECHANICS} ${FIRSTMATE_CARD_ADDENDUM}`;

/**
 * The cap the Claude transport truncates a tool description at, measured
 * hermetically against the vendored client (audit section 4.3a and appendix
 * A; `claudeToolSurface.test.ts` reproduces it). Every app-owned description
 * stays under it, on every backend, so no runtime reads a different contract
 * from the one the source states.
 */
export const CLAUDE_TOOL_DESCRIPTION_CAP = 2_048;

/**
 * The crewmate's `risk` (FI3-1127's plan; docs/card-authoring.md "The risk
 * chart"): a top-level parameter, so its words reach a Claude crewmate
 * whole, and the dimensions' level words come from the one table the card's
 * notes read (`RISK_WORDS`). Only a crewmate's schema carries it.
 */
const RISK_PARAM = [
  `Required on a completion decision with a settle merge action, and only there: your assessment of the change's risk, which the app draws as a radar at the card's top right, one dot per dimension, and keeps on the task.`,
  `Give each of the seven dimensions a level - low, medium or high, rating the change itself, never how careful you were - and why: one plain line of at most ${RISK_WHY_MAX} characters naming the concrete reason, such as "Two files in the composer".`,
  "All seven levels and notes are yours alone; the app adds no measurements. The body never draws or repeats the assessment, and a revision of the card replaces it.",
  ...RISK_DIMENSIONS.map((dimension) => {
    const { label, ask, levels } = RISK_WORDS[dimension];
    return `${dimension} (${label}, ${ask}): low ${levels.low}; medium ${levels.medium}; high ${levels.high}.`;
  }),
].join(" ");

/**
 * The one parameter table both runtimes' schemas are built from, so the
 * typebox (Pi) and zod (Claude) shapes cannot drift: same fields, same
 * words. `task_id` and `standalone` exist only in the Firstmate's schema,
 * and `risk` only in a crewmate's.
 *
 * Only TOP-LEVEL parameters are described (contract v4.59). The Claude
 * transport served no nested description until INF-744 (audit 4.3a finding
 * 2; the SDK's own tool server dropped them), so since v4.13 each rule of
 * `action`, `settle` and `open` has been carried by `actions` or by
 * `CARD_MECHANICS`; the nested copies a Pi seat also read
 * said nothing those do not, and they are gone. A row here states what the
 * description above it does not: `claudeToolSurface.test.ts` holds that no
 * app tool describes a nested parameter at all.
 */
/** The effects every role's actions may declare, up to the open effect. */
const ACTIONS_EFFECTS =
  "Action buttons: id (stable, kebab-case), label (sentence case), default true on exactly one, optional effect and danger. effect is kind settle with mode merge|discard, confirm, and proceed_with_open true to settle a task that has open children and keep them planned, when a refusal names it; or kind request_merge with review naming the id check_change returned;";
const ACTIONS_OPEN =
  " or kind open with target settings|subscriptions|projects and sign_in naming the host whose sign-in the projects section starts, exactly as a not-signed-in refusal's way names it.";

export const CARD_PARAMS = {
  title: "Short sentence-case title",
  body: "The card body: a raw HTML fragment",
  id: "Stable kebab-case id; reuse it to revise the open card in place",
  holds_place:
    "Leave unset unless the use case requires continuous attention on this card. True brings the card forward when it arrives. Choices close at once.",
  reply: "Your short answer in this card's thread, saying what changed where.",
  width:
    "Body: short text narrow; wide 800 px; full ≤1,040 px; pass it only to require more room; it can only widen, never narrow.",
  actions: `${ACTIONS_EFFECTS}${ACTIONS_OPEN}`,
  /** A crewmate's actions, which may also ask to send a write it kept (FI3-1571 piece 4). */
  crewActions: `${ACTIONS_EFFECTS} or kind request_write with ask naming the id github_write returned;${ACTIONS_OPEN}`,
  risk: RISK_PARAM,
  asking: "True on a question card, not a ready plan.",
  design_only: "True only as the declared design-only fact.",
  continues: "True when its choice is not your answer.",
  answering: "True when it answers the captain's message; repeat it on each revision.",
  task_id: "The task this card is about",
  review_task_id: "Review task relayed here; must review task_id. The app labels its findings.",
  standalone:
    "true for a note about no existing work: a one-off with no connection or consequence to any task",
} as const;

function pinnableSentences(text: string): string[] {
  return text
    .split(/(?<=[.;:])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 40);
}

/**
 * The descriptor's sentences, for the structural pin that no persona prompt
 * repeats one of them: the prompts carry policy and authoring, the descriptor
 * carries mechanics, and a sentence in both is the drift the audit found.
 */
export function cardMechanicsSentences(): string[] {
  return pinnableSentences(CARD_MECHANICS);
}

/**
 * The authoring constant's sentences, for its own half of the pin: every
 * persona carries them exactly once and no descriptor carries them at all.
 */
export function cardAuthoringSentences(): string[] {
  return pinnableSentences(CARD_AUTHORING);
}

/**
 * The card-reply contract's sentences, for its own half of the pin: every
 * persona carries them exactly once and no descriptor carries them at all.
 */
export function cardReplySentences(): string[] {
  return pinnableSentences(CARD_REPLY);
}

/**
 * The handoff's sentences, for its own pin: every persona carries them
 * exactly once, and no descriptor, seed or brief carries them at all.
 */
export function handoffSentences(): string[] {
  return pinnableSentences(HANDOFF);
}
