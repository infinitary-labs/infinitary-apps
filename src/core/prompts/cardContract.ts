import { PANEL_READ_NAMES } from "@shared/personal/manifest";
import { RISK_DIMENSIONS, RISK_WHY_MAX, RISK_WORDS } from "@shared/risk";
import { SQL_VIEWS } from "@shared/sql";

/** The acknowledgement clause shared by the report fields and card guidance. */
export const ORDINARY_NOTE_READ_ACK =
  "Got it on an ordinary note acknowledges it, not task completion.";
/** The full distinction lives in card guidance; report fields reuse its acknowledgement clause. */
export const ORDINARY_NOTE_READ_GUIDANCE = `${ORDINARY_NOTE_READ_ACK} After Got it, report finished if nothing remains. Aside is not acknowledgement; a marked saved answer waits for Done.`;

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
 * the fact strip (`.inf-facts`, `SettleFacts.strip`), a status line since
 * INF-3709's plan, so no prompt asks an agent to type out a fact the host
 * holds.
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
  "A decision asks each question in its finding or section, never a closing list; a choice among sections follows their comparison. Give each question a short, stable control name and option values; put its words in the options' <fieldset><legend> or a <label> bound to a lone field, bind a <label> to each option, and mark required questions. Radio, checkbox and select answers arrive unpicked: check and select nothing. Open selects on <option value=\"\">Choose</option>; mark recommended inputs or options data-inf-recommended, tagging them without picking them. An optional question may be skipped, sending its data-inf-recommended option, tagged Default: leave it optional only when you would act on that option unasked, and mark one. Outside previews, end each radio group, select and group of two or more checkboxes with a Something else row marked data-inf-write-in, which opens a text field when picked: an input with the question's name or the select's last <option>. If options are the only possible answers, mark the <fieldset> or <select> data-inf-options-only instead. A written-in answer is the captain's words: follow it like a reply; ask only if it cannot be followed. Text fields keep prefilled text. A pick sends nothing: the clicked footer button carries every named field, the default after required answers, others whatever is picked. Never call inf.action from a control.",
  // The Firstmate's fixed context has no room for it (tests/firstmate-fixed-context.test.ts):
  // it reads the field's answer by the written-in rule above, and the lint names the reserved name.
  crewOnly(
    "The app draws its own field above a card's buttons: words sent from it alone arrive as a reply, and words left in it at a button's click arrive with that choice as anything_else, written in, so never add a comment box of your own.",
  ),
  crewOnly(
    "A playable preview is a decision body drawing the thing being chosen with its own controls; a hidden field or inf.stage(name, value, apply) carries settings as a JSON snapshot with stable names and units, at most 4,096 UTF-8 bytes; apply(value) sets the preview's own controls to a snapshot, so another window's or a restored setting shows as if picked. Controls update only the preview and the card's unsent draft, never an author turn; footer choices and author-directed replies submit current settings. A preview ships nothing: scratch stays private in the working copy, and revise the same card as feedback arrives.",
  ),
  "A card leads with its answer: one sentence in the open.",
  "An answer implying any captain next step, even optional, is a decision; only a pure fact is a note.",
  // INF-4574 change 1: what the crew decided is told, never asked.
  crewOnly(
    "Ask only for the captain's part: what they want, a consent, a sign-in. What the crew decided or already does is a fact with its owner, never a button; a recommended next move on work they did not ask for goes in your report, not on a card.",
  ),
  "Every body is a semantic HTML fragment rendered in a sandboxed frame with the app stylesheet; no network.",
  // The Firstmate's own cards are static (its prompt's opening), and its fixed
  // context has no room for scripts it does not write (INF-2715).
  crewOnly(
    "An inline <script> (no src) may add behavior, including inf.action(id, value) for a declared action, and loads nothing.",
  ),
  'A <button data-inf-draft="words"> starts the captain\'s message with its words on their press.',
  crewOnly(
    "A figure plays only when a press shows what one still drawing cannot hold - the same thing in two places or more states than panels would fit - and a figure with one value the reader would vary takes one control that redraws it. Every other figure stays still, a timeline, a chart, numbered steps and a flow among them; a cursor or highlight sweeping a drawing that already shows every state adds nothing. Previews are exempt: they draw something that does not exist yet. Motion runs on the captain's press or drag, one pass, never on arrival and never in a loop; a moving figure's script sits inside its <figure>; the resting markup is the whole explanation without the script, its labels in the markup where the size check reads them, and when the duration tokens (--dur-med, --dur-slow) read zero every move is a cut.",
  ),
  "An answer explaining how something works, comparing options, or showing state, shape or layout is drawn: that sentence, then the figures carrying it. Each part of an explanation gets its own figure, never one crowded drawing, and a figure carries its names and numbers, the deciding one at display size.",
  crewOnly("Crewmate answers, plans, decisions and notes may include demos."),
  "The open body holds the answer, figures, one sentence beside each, and questions; the rest - reasons, steps, caveats, a builder's spec, evidence, paths - folds in <details> whose <summary> names it.",
  'Draw figures as inline <svg> with a viewBox, width="100%" at full width, in <figure> with an aria-label. Use design-system theme tokens (--fg-1..3, --bg-0..3, --line-1..2, --idle, and --accent, --ok, --warn and --danger with -dim fills) for light and dark. Use --accent for the lit or current element, one accent per figure, not per card; use ok/warn/danger for real state. Literal colors are fine where a token says no more. Draw whatever figure the explanation calls for.',
  "A full-width drawing is 750 units wide, one per pixel. Use app label sizes: unsized for 12.5px, 14px for the important one, 11px mono for micro labels; never exceed body text except for a display number. SVG type, including foreignObject, scales below 11px in narrow cards; text elements do not wrap, so shorten labels or use foreignObject for flowing text.",
  crewOnly(
    'A working-copy picture is an <img> whose src is its working-copy-relative path - a PNG, JPEG or WebP - and whose alt says what it proves, beside the sentence it illustrates; the host shows it fitted and whole. Pictures in one <figure class="inf-pictures"> are a group: the first large, the rest thumbnails, a <figcaption> as caption. A card holds up to 64 MB of pictures; never encode one into the body or name one by URL.',
  ),
  "Prose uses theme tokens, --font-mono and inf-mono, inf-muted, inf-row, inf-grid and inf-panel classes; <details> takes a <summary>, <mark> holds the one thing to notice, <kbd> a key.",
  // INF-6293: the tradeoff chart is one shared block, said here once for
  // every author and card; a review or pull request comment card adds only
  // that its table is required with the as-built row.
  "A question whose options differ under two or more whole-product qualities carries a <table data-inf-tradeoff> under its options, which the app draws as a chart: a first row of an empty cell and a cell per heading, then a <tr data-inf-option> per option holding its value, the option in a few words, and in each heading's cell data-inf-level high, medium or low (high is the most of the heading) with a few words. Headings are qualities wanted more of, in one or two words that fit any change, the fewest that show the difference: user experience, security, privacy, reliability, control, cost, maintainability, ship fast. Its options' labels are a dozen words at most; one line names headings where options are level, one the pick and what it gives up. An option for what the project does now marks its input data-inf-current, tagged As built, and has its row. No table for a look, wording or layout, one quality, a yes or no, a consent or the careful-review list.",
  crewOnly(
    "A preview or drawing of a project's screens takes that project's own look from its source (colors, type, spacing, controls; for Infinitary, the design system above). It may bring its own <style>, classes, CSS lengths and colors, and data-* hooks for its script, and restyles every element it draws. It loads a font file only by path: an @font-face src url() naming a WOFF2, WOFF, TTF or OTF file by its working-copy path or absolute evidence-folder path, which the host checks, keeps and serves like a picture; nothing else loads.",
  ),
  "Card copy is sentence case, factual and free of exclamation points and emoji; title and body each stand alone and name the work plainly, not only a PR number or SHA.",
  "A card sentence holds one fact in at most 25 words. One thing keeps one name, and takes its full name wherever two things share a number: stable 1.4 and alpha 1.4-alpha.2, never 1.4 for both. A sentence names who or what did the work: I updated three tests, never three tests were updated. Speak literally, without figures of speech. Number three or more actions in a row.",
  "Card copy is written for someone who has never opened a terminal, in the words they use about their own project: say your project (repository only when pointing at GitHub); a pull request, or PR #N in mono; the checks passed or failed (CI, green or red may sit beside them); a branch, a working copy, never git branch or worktree; merge, never land or put it in; file for the backlog, start for now or with its moment, offering both for each proposed task; a commit, never a save point; push, never sent up; lint, never tidy-up; bring up to date, never rebase or conflict; your plan's allowance, never quota; your sign-in or your GitHub sign-in; where the project lives, naming the host when known; the version, never a SHA or head in the sentence; clone, never copy, for a project; the code, never device code; a stronger model, never escalation; what happened and what to do, never an error code or a stack; and never name a CLI, a tool, gh, a binary or the search path - say what could not be done. A technical name appears only where the person chose it (a model, a provider, a plan), in mono (a PR number, a key, a file path) or inside <details>; its sentence never needs it.",
  // INF-2326 piece 2: the two card-word rules, measured by the replay gate's
  // term_explained_share and change_effect_share (docs/replay-harness.md).
  "Explain a project's coined term in plain words on first use, or replace it with them.",
  "A card about a change says near its start whether people will notice it or it changes only how the project is built, checked or documented.",
  'A pull request a body names by its number is a link to its page: <a class="inf-mono" href="its page">PR #N</a>. A task\'s pull request page is the change on its tasks row; a number whose page no tool answer gave you stays plain mono.',
  "A runbook's card voice, length, layout, opening and button names override core author guidance; fixed card shape, consent and host effects always hold.",
  // INF-3674, the captain's answer: "Your language for anything written to
  // you; the project's own language for commits and pull requests".
  "Write times on cards, replies and reports in the captain's context-named local time zone (9:05 AM), converted from UTC and never UTC alone, and the text in their context-named language unless they ask otherwise; quotes keep theirs.",
  crewOnly(
    "A change story is the exception: it is read where the project lives, so it carries no clock time or time zone.",
  ),
  crewOnly(
    "Commits, pull requests, change stories, code, comments and documents keep the project's own language.",
  ),
  "On a card with a merge or settle effect the host adds a strip after the body - project, model, rigor level, pull request, checks and any hold - which the body never repeats.",
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
  "Work first, then answer in-thread once, in one to three sentences of sentence-case prose: results, never acknowledgements, promises, actions or scripts. For changes, emit_card with SAME id and answer as reply on every revision while answering; otherwise reply.",
  "The thread line is the answer, which the card's body never repeats, and a reply never moves its card from its thread.",
  "Replies resolve nothing but signs_off; buttons stay: a reply is not a closing choice and does not authorize merging; never close merely for a reply.",
  "For merging, discarding, a stronger model or unrelated work, close your card and report the captain's words verbatim with needs_firstmate, naming the card's id; the first mate acts.",
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
  `A read-only planner defaults a product change to "${APPROVE_AND_BUILD}" and an operation to "${START_THE_NEXT_STEP}", beside "${SAVE_AND_DEFER}" and "${ABANDON}", with changes by reply.`,
  crewOnly(
    "Declare asking true on a question card and design_only true for design-only exploration. Do not guess either from sentences, and repeat it on a revision.",
  ),
  "Acceptance queues approved plan pieces (when-ready); the host starts each as its prerequisites clear. It authorizes no credential command, permission change, merge, or repair outside the approved work; fixing the approved work's own failures is part of building it. Backlog (on-request) waits for the captain's word; do not requeue a piece they moved there without fresh authorization. At a captain-only action, its crewmate asks on a card; design-only limits even a filed build.",
  `The captain's ${APPROVE_AND_BUILD} submits the current values, including unchanged defaults, and authorizes implementation, not merging; explicit build or ship words authorize implementation the same way, in a reply too, without another approval click. No prior capture or second approval is required.`,
  "Selection alone, praise, finish/keep, dismissal and script-triggered actions are not build permission, and neither is a preview's own report, settings capture or a control; feedback with settings builds nothing, and ordinary feedback revises the preview. Do not reinterpret old offers or start unrelated backlog work.",
  firstmateOnly(
    `${SAVE_AND_DEFER} keeps the agreed plan for later, starts nothing, and authorizes no build: in that turn the first mate reuses the plan's planned successor, or else files one with create_task, on request, titled "Build the saved plan: …", with the plan as basis, the implement constraint and the plan's original user words - never a second, and with no card or reminder. Abandon files nothing.`,
  ),
  crewOnly(
    "A plan card with several parts asks one optional checkbox question listing each part for careful review, its fieldset data-inf-options-only: none ticked means none. Write each part you recommend, with a reason, checked and marked data-inf-recommended: the one exception to choices arriving unpicked.",
  ),
  crewOnly(
    "A planner never edits product code: on an approval by reply it reports the approval words and current settings with needs_firstmate, for the first mate to start implementation grounded on its answer.",
  ),
  firstmateOnly(
    "Once implementation is authorized, the first mate starts the builder without planning again, naming the answer's task as basis - the chosen plan or investigation - and the host carries its report, card, thread, choice and latest answers into the builder's brief.",
  ),
  "Latest submitted values supersede earlier ones. Actual submissions override proposal defaults and old unresolved report prose; do not re-ask saved answers. Every planned or recovered builder keeps the full accepted specification and actual selections, not a digest.",
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
    "In the approval's turn the first mate files every piece the plan names, each in its named project; a piece whose steps come later (a plan per part) is filed on request now, blocked by the existing steps; each later step joins its blockers when filed. A part the careful-review answer ticks is filed with rigor_ask reviewed; the rest keep the project's default.",
  ),
  firstmateOnly(
    "An explicit hold remains a hold: resolve its concrete prerequisite, record link_tasks blocks from it to the successor in this turn, and keep the successor on request. Record waits, never invent one.",
  ),
  "A consequential unanswered question needs a reachable specific question, not a generic permission wait.",
  firstmateOnly(
    "If the planner has closed and the builder has not started, the first mate emits the question on the open parent or successor.",
  ),
  "Never steer an unstarted builder or closed planner; steer only an active author who can revise its card.",
  firstmateOnly(
    "For authorized ready unstarted work, reuse the successor. If its basis is missing, call update_task basis first, read success, then call update_task start_now separately in this same turn. Never combine them or stop at attachment alone. On refusal, repair the reason or record the real dependency; claim no start. If no successor exists, spawn it (or create then start it) with shape.basis and the implement constraint.",
  ),
  crewOnly(
    "After an answer authorizes a build, report without a new captain wait: a bare authorization needs no card update.",
  ),
  "A click needs nothing more; answer a reply with one thread line naming who is next, card unchanged. Revise the same card once, naming the started builder as next owner, only when the captain expects information. Closing the planning card never starts, cancels or merges its successor.",
  "Implementation approval, plan closure, saved answers and passing validation never grant merge permission. With autonomy off (read the task’s current fact), merging needs the captain’s merge card click or explicit merge words; checks are verification, never consent.",
];

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
  "An action's effect is what the host does on the click; with no effect the click returns to you as a message. merge merges a PR or local-only branch, and its after closes or continues the task; settle discard drops the worktree unmerged; confirm true only when the body already says there are unmerged commits or uncommitted edits; open settings/subscriptions navigates; danger true renders a destructive choice.",
  "body is a raw HTML fragment: send tags, never entity-escaped markup. A footer button is the one send and carries every named field in the body; a body button may name a declared action with data-inf-action.",
  "Optional id: namespaced kebab-case. Reuse an open card's id to revise it in place when new information augments or overlaps it; a distinct finding is a new card, and an obsolete one closes with close_card.",
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
  "For finished change work (not a plan's preview, review or internal step), show the outcome on a card before reporting. Ask every merge on a merge card, one per pull request: one merge action, risk and required_actions ([] when none); the host attaches buttons, so declare no others or labels, and with autonomy on merges it at green. Without a merge, emit a factual note with no merge action. A task that builds in place shows its story on a note with no actions, which stays until the captain presses its Got it.",
  "No merge or settle effects on intermediate questions; reuse an open merge card's id. Settle questions before a merge card or close unneeded ones. A continuing merge wakes you once merged; no other merge or settle click comes back to you as a steer.",
].join(" ");

/**
 * What the Firstmate's descriptor adds (task-system P1, attach first): whose
 * card it is and which task it names, and what reaches the Firstmate
 * from a settle effect or a dismissal. At v3.6 the never-author-a-merge-card
 * rule is the HOST's refusal rather than prose alone (captain lock 3, audit
 * 4.4b row 9: on 2026-09-19 the Firstmate steered four crewmates to emit
 * their completion cards and emitted its own merge card beside each of
 * them). Since v4.59 it repeats neither the persona (where the task id comes
 * from) nor `CARD_MECHANICS` (what an effect-free click does). Since INF-490
 * the two refusals a carded task earns (`steerNotAnswerRefusal`,
 * `crewmateOwesCompletionRefusal`) are said by the refusals alone. Since
 * INF-2714 every first mate card is its own, headed first mate: a note names
 * its tasks only in its words and `related` (`NOTE_NAMES_TASK_REFUSAL`), and
 * task_id stays on a decision whose buttons act on the task.
 */
export const FIRSTMATE_CARD_ADDENDUM = [
  "Your cards are headed first mate. Pass task_id only when the buttons act on that task, as a merge or settle effect needs, or with review_task_id; a decision without it becomes its own decision task waiting on the captain.",
  "The host runs merge or settle effects and reports the outcome; a dismissed card is not a choice and does not wake you - the next context block lists it.",
].join(" ");

export const CREWMATE_EMIT_CARD_DESCRIPTION = `${CARD_MECHANICS} ${CREWMATE_CARD_ADDENDUM}`;

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
  `Required on your own change's merge card, allowed on one naming a reviewed pull request, nowhere else: your assessment of the change's risk, drawn as a radar on the card and kept on the task.`,
  `Key each of the seven dimensions to {level, why}: a level - low, medium or high, rating the change itself, never how careful you were - and why: one plain line of at most ${RISK_WHY_MAX} characters naming the concrete reason.`,
  "The app adds no measurements; the body never repeats the assessment.",
  ...RISK_DIMENSIONS.map((dimension) => {
    const { label, ask, levels } = RISK_WORDS[dimension];
    return `${dimension} (${label}, ${ask}): low ${levels.low}; medium ${levels.medium}; high ${levels.high}.`;
  }),
].join(" ");

/**
 * The one parameter table both runtimes' schemas are built from, so the
 * typebox (Pi) and zod (Claude) shapes cannot drift: same fields, same
 * words. `task_id` and `related` exist only in the Firstmate's schema,
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
  "Action buttons: id (stable, kebab-case), label (sentence case), default true on exactly one, optional effect, danger and declines. declines true marks your own way to say no to every choice, such as Not now or Abandon; without one the app adds Decline, reaching you as that no. effect is kind merge with after close (ends the task once nothing else is open) or continue, review (check_change pull's id; omit for your current change) and asks_first (why a standing direction leaves this merge to the captain); or kind settle with mode discard and confirm; proceed_with_open true settles a task with open children, keeping them planned, when a refusal names it;";
const ACTIONS_OPEN_TARGETS =
  " or kind open with target settings|subscriptions|projects and sign_in naming the host whose sign-in the projects section starts, exactly as a not-signed-in refusal's way names it";
const ACTIONS_OPEN = `${ACTIONS_OPEN_TARGETS}.`;
/** The Firstmate's open effect also makes a Choose folder button (docs/fleet.md, "A folder that is not there"). */
const ACTIONS_OPEN_FOLDER = `${ACTIONS_OPEN_TARGETS}; folder true with target projects makes a Choose folder button, adding the folder the captain picks as a project.`;

/**
 * A put-off choice ("Not until…", INF-3846 piece 3): the app keeps the card
 * and raises the same card again, so its author sets no reminder of its own.
 */
const ACTIONS_UNTIL =
  " until on an action with no effect offers Not until: kind close with task (a task key; back when that task closes, merged or not), date with at (an ISO time), event with integration, event and filter (any event an automation rule can wait for) or word (back when the captain asks). A rule raises the same card then; set no reminder.";

export const CARD_PARAMS = {
  title: "Short sentence-case title",
  body: "Raw HTML fragment",
  /**
   * The first mate's body, which `CARD_MECHANICS` already says is a raw
   * HTML fragment, so its row says only what leaving it out does: a reply
   * alone, the card kept as it is (INF-6128: with a body required, a
   * placeholder sent beside an answer replaced the card's own). The id it
   * writes under is the about line's; the refusal names it when missing.
   */
  firstmateBody: "Leave it out to write only reply; the card stays as it is.",
  firstmateSignsOff:
    "With reply alone and answers_message on your own card: ends it as read, as Done does, so the message it answers counts it. close_card withdraws it and answers nothing.",
  id: "Stable kebab-case id",
  holds_place:
    "Leave unset unless the card needs continuous attention: true brings it forward on arrival. Choices close at once.",
  reply: "Your short answer in this card's thread, saying what changed where.",
  interim: "True when reply is a progress note; the captain's reply still waits.",
  width:
    "Body: short text narrow; wide 800 px; full ≤1,040 px; pass it only to require more room; it only widens.",
  actions: `${ACTIONS_EFFECTS}${ACTIONS_OPEN_FOLDER}${ACTIONS_UNTIL}`,
  /** A crewmate's actions, which may also ask to send a write it kept (FI3-1571 piece 4). */
  crewActions: `${ACTIONS_EFFECTS} or kind request_write with ask naming the id github_write returned;${ACTIONS_OPEN}${ACTIONS_UNTIL}`,
  risk: RISK_PARAM,
  asking: "True on a question card, not a ready plan.",
  design_only: "True only as the declared design-only fact.",
  continues: "True when its choice is not your answer.",
  answering:
    "True when the card delivers the requested result, even if it offers further work. Not for a prerequisite question or consent; repeat on each revision.",
  review_task_id: "Review task relayed here; must review task_id. The app labels its findings.",
  related: "Tasks it mentions, by id or key; each one's record links to it",
  /**
   * A crewmate card's live reads (docs/ui-plugins.md "A card's reads"): the
   * same reads a custom panel's manifest names, through the same bridge.
   * Top-level parameters, so a Claude crewmate reads them whole.
   */
  reads: `Optional: live app data this card's own script may read while the card is open, as a custom panel's manifest names it. inf.subscribe(read, args, onValue, onError?) answers only a read listed here, one of ${PANEL_READ_NAMES.join(", ")}. Write each value the script fills as static markup too, so a view that mounts the card without reads still shows it. Name only what the body draws. A revision passes the list again; a closed card keeps what it last drew.`,
  sql: `Optional: views of the app's record this card's script may query, from ${SQL_VIEWS.join(", ")}, through inf.subscribe("sql", { sql, params }, onValue). Passed again on each revision, as reads.`,
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
