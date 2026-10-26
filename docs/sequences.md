# Sequences

How the first mate works an ask through opinionated steps - plan before an unclear feature, reproduce before a fix - without a workflow engine.
The captain-approved design is task `fm3000-opinionated-workflows-s1` (the report and its implementation plan live beside it in the firstmate home); its governing rule, in the captain's words: "avoid special-casing this 'sequences' concept ... it should look just like a regular parent task with some child tasks. all the special knowledge about how to handle 'sequences' should exist in natural language instructions."

## The decision

Sequences are guidance, not a runner.
The first mate reads them from an app-managed document refreshed from the packaged seed on updates and served with its prompt.
It opens an ask that takes more than one step as a parent task with each step a child, spawns each step when its turn comes, and bends the plan on the captain's words; an ask that takes one step is one `spawn_crewmate` with no parent (contract v4.19).
The parent stays on request, so no crewmate starts on it; the first mate talks to each step's crewmate directly.
Every hand-off is a decision the first mate makes on a wake it already receives.
Nothing in the host advances a sequence: there is no new tool, no card effect, no settings record and no migration, and the words "sequence" and "step" reach no user surface.
A program (`docs/programs.md`) is the agent's reach, not a sequence runner: the first mate may write the steps a script can decide as one script the host runs, and sequences themselves stay guidance.
The seed's `programs` section says how, with the loop and the audit, deep research and migrate shapes written in the program's own names, so "use a workflow" or a loop toward a goal is one program task rather than a parent with steps (`docs/programs.md`, "The shapes the first mate is served").
The task's shape gained facts the first mate declares and the host only stores and honours - `internal_step` and `skipped_plan_because` - and two it declares and the host checks - `result_schema` and `branch_from` (`src/shared/routingPolicy.ts`).

A read-only answer from what the app can already read - a fact, or how or why something is so - is retrieval, with its question stated faithfully and the captain's words preserved verbatim; it is not broadened into an investigation by default.
The goal names every source the answer needs, another computer included, because the classifier reads where the evidence lives from the words alone.
The classifier, not the first mate, owns the kind, and an answer that needs past runs compared, a computer the app does not reach, a reproduction, a measurement or the web is research or reproduce.
When the captain chooses Look deeper on a retrieval answer's card, the first mate starts a read-only research step built on that answer, its goal naming the source the answer said was missing.

The personal section draws the line between lessons, projects and panels.
Someone learning or practising a subject, including a math quiz, gets one `teach` task per subject on the personal workspace with `personal_ui` true and the packaged teach line attached; its brief names the lessons guide and cards (`docs/lessons.md`).
A glanceable rail surface remains a panel, and existing quiz or game panels stay untouched.
An ambiguous ask naming something to learn becomes a lesson, otherwise a project; the first mate states its choice in the activity line.
A new game, toy, page or small app gets its own project on the existing setup card; work in an existing project needs no setup.
Whether that project is casual is the first mate's judgment from the ask, never a host parser.
A casual project is made for fun or for yourself: the ask names who it is for or how small it is, and nothing to ship.
When the ask does not say, the first mate treats it as casual and writes the reason in the setup card's work text; the captain's submitted settings govern the work afterward.
For a casual web project it proposes local-only delivery, automatic merging, quick care and plain HTML, CSS and JavaScript opening from index.html without installation or a server.
A serious project names a framework, engine or build step, hosting or a store, a sign-in or a database, a team or a customer, or a release or a launch, and gets asks-first, standard care and a plan first.
Plan skipping stays governed by the existing skip rule, and the full project line reaches the crewmate as a constraint.
A casual web project's crewmate play-tests and photographs it in its task browser through a local server, then puts up a note beside its completion decision with that picture and `browser_button` Open with `browser_page` index.html, and never waits on that note (`docs/task-browser.md`, "A page from the project").

Each step is one of the task kinds the classifier already speaks (plan, retrieval, research, reproduce, implement, fix), so the document's line for a step, the kind the host records and the tier it routes to agree.
The host never reads a kind from a title - the classifier still sorts the step's goal.
A step's title says what that step does, not its place in the plan: `create_task`'s `title` gives "Ship the bridge to alpha" as its example, and `spawn_crewmate` and `update_task` point to it (INF-19).
The host stores whatever title the first mate passes and never judges it.
Validation is not a step: it is the project's rigor inside the implement or fix step, and at reviewed rigor the reviewer is that step's child exactly as before (`docs/delivery-rigor.md`).

## The document

`userData/fleet/personal/.claude/skills/sequences/SKILL.md`, written by the workspace seeder (`src/core/personal/sequencesSkill.ts`, `seedSequencesSkill`) from the packaged seed whenever the file is missing or differs - on workspace setup and on app updates - so a hand edit is overwritten; until the file exists the built-in text (`SEQUENCES_SEED`) is served.
The seed carries five sequences - ideation, feature, bugfix, refactor, explainer
- from kunchenguid/kun `ENTRY.md`, "Solving a task", sharpened by the captain-approved borrowings of task `fm3000-sequences-external-skills-s1` (mattpocock/skills' grill-me and wayfinder, cursor/plugins' pstack, both MIT): ask only what nothing else can settle, question rounds and a checkable spec in the plan step, evidence-first fixing, guardrails and no compatibility layer in a refactor, a Risk line naming what the change is safe because of, steps that need nothing from each other running at once, an idea too big for one plan broken into plan steps toward a stated destination, and a spec split into pieces only when each is a distinct outcome with a safe stopping point and a nameable benefit (the plan step's split rule, in the one packaged plan line the feature sequence relays whole; the feature sequence's `pieces` line: each piece its own implement step under the same parent, grounded on the plan and blocked by exactly the pieces it needs, never by printed order).
  The preamble gives an ask of more than one step a parent, left on request, with the next step filed on request in the same turn, and an ask of one step none.
  `HANDOFF` (`docs/card-authoring.md`, "The handoff") governs building immediately on an authorized chosen basis; the preamble says to skip the plan only when one nameable place changes, no rule, state transition or meaning changes, and the outcome can be checked by looking.
  The direct build declares `shape.skipped_plan_because`, which the host stores on the task and shows in the feed without judging it.
  The record shows the declared reason beside the captain's words.
  Symptom-only asks, wording or look choices, trust, click or setting meaning, motion and several screens plan first; in doubt plan.
  The plan is a crewmate task, not a first mate card.
  It asks the first mate to relay a step's line to its crewmate word for word (below).
  The ideation plan line also says what an ask for a prototype is: "When I ask for a prototype, a mock-up or to try something, it is this plan with a playable preview as the card: the thing itself, adjustable, its settings staged for the build."
  The first mate core sends such an ask to that line, so it lands as one read-only plan step whose card is the preview (`docs/card-authoring.md`, "A playable preview").

A new seed reaches every installation on its next update: the file is app-managed, and a future customization flow is deferred.

## How a step's line reaches its crewmate

Crewmates never see the document.
A step's brief is what the first mate passes - the goal, the captain's words, and typed constraints - plus the host's basis section.
The document's preamble asks the first mate to put a step's line in that step's constraints, as a `free` constraint, when it spawns or creates the step; `renderIntentBrief` prints a free constraint verbatim under "Constraints:", below the captain's words, which the brief marks as outranking it.
Both `spawn_crewmate` and `create_task` take `constraints` and `delivery_note` with one shared schema (`CONSTRAINTS_PARAM`, `DELIVERY_NOTE_PARAM` in `src/core/pi/crewTools.ts`), so a later step planned on request carries its line as fully as the step that runs now.
The host matches an attached packaged plan or teach line by whitespace-normalized equality, not by reading the captain's words.
A packaged plan line is its whole bullet, the first line and every indented line under it, so the ideation plan's paragraph matches only when it is relayed whole.
These closed facts set the kind without a classifier call, including when a named model skips classification.

## How it is served

The first mate's resource loader serves the document's body (front matter stripped) as Pi's appended system-prompt section (`createCrewmateResourceLoader`'s `appended`, `src/core/pi/piResourceLoader.ts`).
Pi keeps it as its own `addendum` section after the byte-stable prompt (`FIRSTMATE_PROMPT_CORE` + `FIRSTMATE_CARD_AUTHORING` + `CARD_REPLY` + `FIRSTMATE_HANDOFF`), so the provider's prefix cache holds it across turns.
`SequencesSource` stats the file at every idle boundary - right before each prompt, never inside a turn - and reads it only when its size or modification time moved; `ModelSession.serveInstructions` swaps the served text and asks Pi to rebuild, which re-sends the section on that prompt only.
An unreadable, empty or oversized (past 16 KB) file serves the built-in text with one feed line in plain words; an absent file serves it quietly.

Provenance: the session's `fm-contract` entry records `instructions_sha` (sha256 of the served text) beside `version`, `prompt_sha` and `tools_sha`, written whenever any of them changes.
`prompt_sha` stays the byte-stable prompt's alone, so the trainable contract is never moved by the captain's own text.
The C5 extractor carries the field through (`docs/dispatch-extractor.md`).

## The rule (contracts v4.6, v4.19 and v4.32)

One rule in `FIRSTMATE_PROMPT_CORE` replaced "spawn a plan as its own task and the build as a second one".
The core gives the tool mapping: the parent is `create_task`, the current step is `spawn_crewmate` with `parent` (that spawn alone records it), and the next is `create_task` on request with `parent` and `basis`, started with `update_task start_now` when `HANDOFF` says its turn has come.
The appended guide owns when an ask needs a parent and when an internal step closes, rather than the core saying both twice.
The core’s Continue rule owns the mid-work merge and its plain-reply rule owns a merge with no task; the seed does not repeat them (FI3-566).
A parent stays on request - its children do its work - and completes when its last child lands.
The seeded document supplies the objective skip test.
A declared direct build is the whole ask and has no parent; the host prints its reason in the feed and stores it in the task shape without checking whether the reason is sound.

`start_policy` is worded in the host's terms: `when-ready` means the host starts a crewmate on the task once nothing blocks or holds it, and a parent stays on request.
`create_task` requires an explicit `blocked_by` list before admitting automatic creation; what `[]` declares, and what an update adds, is `docs/task-graph.md`, "Tools".
Its description names the purpose, recording project work without starting, and the immediate start rather than promising that creation never starts work; approved pieces carry all prerequisites at creation.
`create_task`'s answer for an admitted `when-ready` row nothing waits on says a crewmate starts on it now, and the queued-started wake says a crewmate is working on the task.
The host judges nothing: no dispatch rule reads a row's children.
`spawn_crewmate` does not offer `plan-first`; a recorded spawn or stored intent that names it still parses as a free constraint with the same words.

## The host pieces it runs on (all generic)

- `create_task` takes `basis`, stored on the planned row's shape; its verdict is derived at every read and never stored (`TaskService.basisHolds`), because the task it names is usually still running when the step is planned.
  A step whose basis answered starts grounded (R4/R6).
- A step whose answer the next step needs as data carries `result_schema`: its report's `result` is checked against it, reaches the first mate on the report wake, and reaches the next step through its basis section; a step that continues another's code names it in `branch_from`, so its working copy starts at that step's last commit (`docs/task-record.md`, "A typed result and where a working copy starts").
  The preamble says both once; the host advances nothing and reads no loop.
- Only the typed `read-only` constraint makes a step an answer task (`deliverableFor`): the document marks every plan, retrieval, research and reproduce step read-only, the constraint's description says a task without it ships a change, and the classifier's kind only routes, so a build that shows a preview first is never closed by the captain's choice on it (INF-990 friction 7).
- `settle_task answered` closes an idle answer task the first mate declared an internal step (`internal_step`) once a live task names it as its basis or waits on it through a `blocks` link, or once its crewmate reported its answer, which the first mate may have passed on by a steer to a task already under way (INF-1137).
  A finished answer closes `done/answered`, never as a discard.
- A container completes with its children (`docs/task-graph.md`, "The close rules"): a parent no crewmate holds closes done when its last child closes and any child is done, else dropped, with one feed line.
- The basis section names the basis task's live branch, or the kept ref its unlanded work was saved on, and quotes the thread under its card (`renderBasisSection`, `src/core/orchestrator/intentBrief.ts`) - a branch or kept ref only for a basis that delivers a change: a plan or reproduce step is an answer task whose scratch copy holds nothing of its answer, so the brief carries the answer itself - report, card, thread and the captain's choice.
- The card goes as a file, never pasted into the brief: at the mint the host saves its body whole - script, style and picture paths included, never cut - to the new task's own `crewmates/<taskId>/source-cards/<key>.html` (`CrewSupervisor.withCardFile`), and the section names that file beside the picture files.
  The choice, the submitted answers and the thread stay words in the brief.
  A discovered-from origin's card goes the same way; a card that cannot be saved rides in the brief whole.
- The card the basis section carries is the one its own crewmate answered with: the newest of its crewmate's cards the captain chose an action on, else its crewmate's newest card, never a merge decision while another card exists, and never a first mate or host card filed under the task (`CardStore.newestAnswerForTask`).
  A basis that prototyped and then built hands over its prototype, not its completion card or a note that came after; the thread, the choice and the submitted answers come off that same card.
- The context index nests live children under their live parent, and a parent with no crewmate says so with its children's counts; a parent and its children count as one row against the caps.

## The plan's final spec is on the record

When a plan step finalizes, the implementer must start from what was agreed, not from the first proposal.
The planning crewmate writes the final agreed spec into the task as its report each time the plan changes - the captain's tweaks and anything decided on the card included - before the captain chooses.
Every answer task's brief says it (`renderAnswerShapeSection`: the report is the answer the task keeps).
The captain's click is what closes the step, so it has no turn after the choice; the host records the chosen action on the close (`data.choice`), and the implementer's basis section carries the recorded spec ("Its report - the final answer it recorded"), the card, the thread and "The captain closed it by choosing ...".

## A plan saved for later

A ready plan ends in three choices: **Approve and build** for a product change, or **Start the next step** for an operation, beside **Save and defer** and **Abandon** (`HANDOFF`, `docs/card-authoring.md` "The handoff").
Save and defer closes the plan like any choice on an answer, and the first mate's answer to that wake files the build, never the host.
When the plan's step already has its build filed on request - an ask with a parent - the first mate reuses it and files nothing.
A plan that stands alone has no build yet, so the first mate files one with `create_task`: on request, titled "Build the saved plan: …", with the plan as `basis`, the implement line as its constraint and the plan's original words as the captain's.
It starts nothing and raises no card or reminder: its row in the Tasks backlog is where the build waits, and its record reads "Starts when you press Start."
The captain's Start, or the captain's words asking the first mate to build it, starts it; Drop task removes it.
The brief is minted at dispatch, so the builder gets the plan's recorded spec, card, thread, choice and answers as any builder grounded on a plan does, and checks the plan against the current code first.
Abandon files nothing.

## A bug that reproduces

The reproduce step is an answer step (a real classifier sorts it `reproduce`): it puts the failing check in its report and opens it with `reproduced: yes` or `reproduced: no`.
On yes the first mate starts the fix step - its basis is the reproduce step, so the fix's brief carries the reproduction - and then closes the reproduce step with `settle_task` mode `answered`: `done/answered`, with the feed line "its answer carries on in KEY", never a discard.
On no the reproduce crewmate raises its own decision card with the ways out, and the first mate starts nothing.

That close is generic, not a reproduce rule, and it carries no host judgment (the captain's call C and the captain's direction that what is inside a sequence is "intelligent judgments ... handled mostly through instructions").
Whether an answer task is an internal step of a sequence the first mate runs, or something the captain asked for, is the first mate's own judgment under these instructions: it declares each step it adds as `internal_step` when it creates it (`spawn_crewmate` or `create_task`), and the host only stores and honours that - `settle_task answered` works on a declared step and on nothing else (`docs/task-graph.md`).
An answer the captain asks for personally - a question, a plan, a reproduction - is never declared, and neither is a step whose result the captain asked to see ("fix it, but show me the repro first"): that repro shows its answer as a card, the first mate leaves it, and the captain's choice closes it.
The same mark covers any work the captain did not ask for, beyond a sequence's steps, and keeps its drop off the captain's stack (`docs/card-authoring.md`, "Work that closed without the captain's click").

A cardless report from a declared internal step wakes the first mate on every backend, after any card, pending reply, or moving witness (`docs/report-sort.md`, row 4b); the host does not decide what follows.
The brief follows the same declaration (`renderAnswerShapeSection`): an answer the captain asked for lands as one card, as every answer always has; a declared step is told its report is the answer handed to the next step verbatim, with a card, as any crewmate does, when the captain must decide or see something before the next step can start.
The captain's replies and choice reach the step there, not through the first mate; a clean report with nothing for the captain still goes directly to the next step.

## The proof

`tests/e2e/sequences.spec.ts` runs the feature ask end to end (plan step, the captain's thread reply and choice, the grounded implement step, its completion card, the parent's close and feed line), a plan saved for later (Save and defer files one build on request, nothing starts, and the captain's Start grounds it on the plan), an ask for a prototype (one read-only plan step carrying the plan line, its preview's staged setting submitted by Approve and build, and a builder whose brief carries the card file, the choice and the setting), a clear, small ask (one running implement task and nothing else filed, no parent), and both bug outcomes through the real app and the mock provider, whose first mate follows the instructions by script; in the feature case the scripted first mate relays the document's implement line as a `create_task` constraint, and the spec asserts the implement step's served brief carries it word for word under the captain's words.
Unit coverage: `taskTools.test.ts` (a planned step's constraint and delivery note reach its brief), `sequencesSkill.test.ts` (seed, ownership, fallbacks), `firstmateSession.instructions.contract.test.ts` (what real Pi sends and records), `firstmateSession.realSession.test.ts` (never mid-turn), `firstmateAgent.test.ts` (served at each boundary, the one feed line, the nested index), and `crewSupervisor.test.ts` (basis at dispatch, the container rule, the basis section).

## Notes moved from AGENTS.md

Moved verbatim from `AGENTS.md` on 2026-09-24; `AGENTS.md` keeps a one-line pointer to each.

- Sequences (captain-approved 2026-09-24, task `fm3000-opinionated-workflows-s1`; `docs/sequences.md` is the one home): opinionated ways of working (plan before an unclear feature, reproduce before a fix) are GUIDANCE the first mate follows, never a runner.
  The app-managed `userData/fleet/personal/.claude/skills/sequences/SKILL.md` is refreshed from the packaged seed on updates (`src/core/personal/sequencesSkill.ts`), served as Pi's appended prompt section after the byte-stable prompt and re-served only when it changed, at an idle boundary; its sha rides the `fm-contract` entry as `instructions_sha` while `prompt_sha` stays the prompt's alone.
  An ask of more than one step is an ordinary parent task, left on request, with child steps built with the existing task tools, and an ask of one step is one spawn with no parent (contract v4.19); each step the first mate adds is declared `internal_step` at creation - its judgment, never inferred by the host - and closes with `settle_task answered` once the next step builds on it, while an answer the captain asked for personally (a step whose result the captain asked to see included) is never declared and stays the captain's to close; the seeded document asks the first mate to relay a step's line word for word as a free constraint, so `create_task` takes `constraints` and `delivery_note` with `spawn_crewmate`'s schema; the host pieces are generic - `create_task` takes a `basis` verified at dispatch, a parent no crewmate holds completes with its children, the basis section names the basis task's branch or kept ref and quotes its card's thread, and the context index nests children.
  Never add a host rule that knows the word "sequence"; "sequence" and "step" reach no user surface.
  `tests/e2e/sequences.spec.ts` is the binding test.

### A landing in the middle of work

When the rest of a crewmate's work requires its own change to be put in first, it files "Continue: …" and reports it in a turn with no card.
A completion card in the same turn suppresses the report wake, so the first mate could not triage the filing.
On the report the first mate links the origin as its blocker before making the filing when-ready in that same turn, so the ready sweep cannot start it between the two calls.
Then the first mate steers the crewmate to emit the ordinary completion decision.
Once the origin closes after put-in, the ready sweep starts the rest from the freshly fetched main line.
The continuation's brief carries the origin's report, card and thread as its origin section.
If a further landing belongs to no task, it asks once with a plain reply button naming what must be put in; this is the one permitted ask.

## Persisted handoff facts and recovery

The authorization rule has one home, `HANDOFF` in `src/core/prompts/cardContract.ts`, included once per persona.
A by-key `tasks` read exposes the persisted closing `resolution` (card, action, time and submitted answers), including the dispatched `offer` when captured; lists omit it.
Basis briefs retain full report and thread history alongside these facts.
Legacy resolutions without capture retain their stored card.
For an approved multi-piece plan, the first mate reuses existing successors and files the other pieces Queued (`when-ready`), under the approved answer's parent with that answer as basis.
The answer's kind need not be `plan`; the existing basis check and briefing path remain the owners of grounding.
It files prerequisites first and declares every blocker atomically in `blocked_by`; list order is not a dependency.
A queued update of a reused successor adds any declared prerequisite that is not linked yet and does not require the declaration to echo the current links.
After filing, linking or changing queue policy, it reads every piece by parent in a later model request and corrects and re-reads blocker or start-policy mismatches.
Queued work can start before that read; an incorrectly declared blocker list can therefore start a piece before the first mate discovers the mistake.
The host's existing queue starts each ready piece, including multiple independent roots, and rechecks the remaining pieces when blockers merge; no further first-mate turn or special dependent wake is required.
There is no separate plan permission mark, and settlement receipts carry their existing outcomes and refusals only.
Backlog (`on-request`) means waits for the captain's word.
Dragging an approved piece back to Backlog retains its blockers and holds, but it no longer starts automatically; prior plan approval does not authorize the first mate to queue it again.
A captain-only action named in the plan does not hold the piece before it starts; its crewmate asks on a card when it reaches that action.
Approval never authorizes credential commands, repair, permission changes or merges.
The first mate reads each task's effective autonomy only to report who merges, never changing it without the captain's explicit request, even to match another task.
Queue policy does not determine merge autonomy.
The first mate interprets approval through `HANDOFF`; the host uses typed task state, not plan names, labels, hierarchy or prose.

`update_task basis` edits grounding only on open work that has never started; unknown/self references are refused.
A combined basis-and-start call is refused, while ordinary edits apply before starting.
See `HANDOFF` for how an agent uses these facts and `docs/replay-harness.md` for independent evaluation requirements.
