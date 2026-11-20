# Contract revisions

Every revision of the Firstmate's orchestrator contract is one Markdown file in this folder.
The contract is what the Firstmate is served: its prompt, each tool's name, description and parameters, and what the host tells it in a context block or a wake.

## The version is counted, never written

`FIRSTMATE_CONTRACT_VERSION` (`../contractVersion.ts`) is 4.72, the last version written by hand, plus one for every revision file here.
With three files it is 4.75.
This README is not a revision and is not counted.

Two changes open at the same time each add a file of their own, so neither edits a line the other edits, and both merge cleanly.
The version moves once for each of them as they merge.
Which file brought which number is the order the files were added on the main line: `git log --diff-filter=A --reverse -- src/core/prompts/contract-revisions/`.

The version is a promise and the stamp's two hashes are the proof.
Every decision record stamps the version beside the served prompt's sha and the tool surface's fingerprint (`firstmateContractStamp`, `src/core/orchestrator/seat.ts`), and those two move with any change to the prompt text or to a tool's name, description or parameters, with or without a revision file.

## Adding a revision

- A change that revises the contract adds one file here in the same pull request.
- Name the file with a short kebab-case slug for the change, such as `pairing-actions.md`, never with a version number.
- Write what changed and why: the task and the captain's choice it came from, what the Firstmate is now told, and, when the fixed context grows, about how many tokens the new words cost (`tests/firstmate-fixed-context.test.ts`).
- Each rule the revision adds names its one home: the core, one tool description, a top-level parameter, a wake, or the builder's brief. A rule already said in that home is not said again.
- A rule speaks for every project: it names nothing only this repository has - its workflows and runners, its signing folders and settings, its tests, scripts or documents (`docs/orchestrator-contract.md`, "What the served text may name").
- Never delete a revision file: the version counts them, so a deletion would move it backwards.

## The ledger through 4.72

Until 4.72 the version was written by hand, with this ledger above it as a comment in `contractVersion.ts`.
It is kept here as it was written.

The contract revision the served Firstmate prompt carries (interaction P1:
v1.1 is the answer-with-default contract, the investigation boundary,
and revise-in-place; v1.2 - the fable review's Q4a - a dismissal is a
context-block line, never an [fm-op]; v1.3 makes the reasoning class a
prompt-guided judgment; v1.4 makes host-run settle refusals operational
instructions, while final outcomes may need nothing; v1.5 - cards/tasks/
agents P0 - removes the automatic Later and recall_decision, and makes a
crewmate's filings part of its report instead of wakes of their own;
v1.6 - cards/tasks/agents P1 - one card shape whose actions carry
effects: no kind, no reserved action ids, a merge offer is an action
whose effect is settle merge and closing a card is keep; v1.7 - cards/
tasks/agents P2 - the `finish` mode and `delivered` status are retired
(an idle crewmate stays resumable until merged, landed, or discarded),
and a settle refusal is a structured outcome whose ways out the Firstmate
carries as effect buttons, proceed_with_open among them; v1.8 - the
answer-with-default rule no longer prescribes an explain-more action:
a decision's default is its only required action, and keeps_open stays
available on any action for a genuinely non-closing choice, never a
default addition; v2.0 - the instruction audit's single-owner
restructure, captain rulings D1-D5 of 2026-09-15: the card contract is
one text in the emit_card descriptor (`src/core/prompts/cardContract.ts`)
that no persona prompt repeats, the style appendix is gone and the
served prompt is the core alone, the crewmate's completion card is the
only merge decision (the Firstmate never authors one; G-1 and the PR-link
gate go with it), the host renders a settle card's repo, branch, posture,
PR link and CI state itself, the lint names an entity-escaped body and
no longer counts sentences, each backend's differences are its own note,
and the self-brief goes to note_progress); v2.1 - card bodies render
verbatim with no sanitizer (captain decision 2026-09-15, direction C),
so the contract no longer claims literal colors, <image>, filters, or
external references are removed: tokens are a preference, an image the
body carries as a data: URI renders, and nothing else loads; v2.2 removes
the synchronous consultant and delegates evidence gathering to crewmates;
v2.3 adds the typed visual-only emote tool, permitted alongside the
no-card brief close; v2.4 delegates interactive UI prototypes and
multi-option UI explorations to crewmates, while retaining simple static
SVG diagrams for Firstmate explanations; v2.5 stops prescribing figure
shapes - the card contract owns the figure guidance and teaches the design
system instead of recipes - and deletes the `fm.viz` helper, since the
Firstmate cannot call a script and a scripted body can hand-write SVG;
v2.6 scopes the accent budget PER FIGURE - each figure may light its own
most-current element, reversing v2.5's whole-card reading;
v2.7 frames every served input (R2 provenance, `src/shared/servedFrame.ts`):
each part opens with U+2063 and a `FIRSTMATE_OP: v1 <kind> [<origin>]:` header, so
the captain's words, the host's context and an operational wake are
distinct by structure, and the prompt says only a user part is the captain.
v2.8 adds the personalization case to the operate move (talk-to-
personalize Step 1, captain decision Q5): the theme, a panel's rail,
position or visibility, a removed surface, or a standing instruction is
one `personalize` call naming an id from the context block's "your
surfaces" section and one feed line, never a card; a new panel or a
change to how one draws stays crewmate work. The six moves are unchanged.
Recorded with the prompt's sha in the rolling session itself
(`firstmateSession.ts`), so a dispatch corpus can tell which contract
produced each turn;
v2.9 (talk-to-personalize Step 4): an ask about the user's own panels is
spawn_crewmate with personal_ui, bound by the host to the personal
workspace, a change names the surface's id, and removal is personalize;
v3.0 takes the tier off the Firstmate (intelligence-bucket routing S2,
captain-approved 2026-09-18): `spawn_crewmate` carries the FACTS only it
can see - `basis`, `premium_ask`, `override_model_id` - in place of the
judged `difficulty` and `model_id`, and the host computes the tier from
the work's shape through the captain's own table
(`src/shared/routingPolicy.ts`). The routing rule states those facts and
names no tier;
v3.1 adds escalation to that same spawn (intelligence-bucket routing S4,
captain's Q2 with his override, Q4 B and O2 A): `escalate_from` names the
task whose result the CAPTAIN rejected in his own words, and the host
runs a fresh crewmate one tier up on the failed attempt's report. No new
tool - the count stays 24 - and the trigger is stated twice over: the
rule says only the captain's words escalate, and the tool boundary
refuses the field on any turn that does not carry them. A crewmate's own
"I am blocked" earns one decision card whose default offers a stronger
model; the captain's click is the say-so;
v3.2 adds the rigor default rule (delivery rigor tiers, phase 1; captain
decisions Q1, Q2, Q6, Q7 of 2026-09-19): rigor is the host's to derive -
direct-pr work ships at the standard tier, local-only and live work
quick - the Firstmate relays the user's words on care as a free
constraint, and a crewmate's three-round CI blocker report is one
decision card on its task. Instruction only: no host derivation, no
reviewer, no new tool parameter (`rigor_ask` is phase 2);
v3.3 replaces that rule with the reviewed tier's (delivery rigor phase
2, plan section 3.5): the host derives the rigor at dispatch and
`spawn_crewmate` carries `rigor_ask` only for the user's own words on
care and `review_of` to spawn the independent reviewer the host briefs
and whose task holds the merge - no new tool, the count stays 24. The
Firstmate owns the routing by instruction: auto-fix findings are steers
to the builder and a re-review at the new head (at most twice), an
ask-user finding it cannot settle from the user's words is one decision
card on the builder's task, and a pass is a merge with autonomy on or a
steer to emit the completion card without it;
v3.4 makes the caps the host's records (delivery rigor phase 3, plan
section 4): the host counts CI rounds and findings rounds on the
builder, holds the completion card and the re-reviews at the cap, and
wakes the Firstmate once - the same decision card a crewmate's own
three-round blocker earns, now with the steer after the captain's answer
named as what reopens the rounds. A repository's standing rigor is set by
talking (`configure_repo rigor`), on the user's words alone, no new tool;
v3.5 aligns the review loop to the no-mistakes pipeline (captain
rulings, 2026-09-19, on the review-cap assessment): rigor derives from
the user's words and the repository's configured rigor alone - standard
by default, never from the intelligence tier or an escalation; the
review runs BEFORE the pull request, on the builder's branch, so fix
rounds are local commits; info findings never block; auto-fix steers
carry the fixer preamble (legitimacy check, smallest root-cause fix,
never revert intent); ask-user findings are one card per round, and
declined findings ride re-review steers as user_chose_to_ignore, never
re-reported; the Firstmate never steers a reviewer except to request a
re-review at a named new head, because a reviewer's verdict-less
acknowledgment is no longer a verdict and never a round. The same revision lets the captain override delivery for one task (`delivery_ask` on spawn_crewmate, or a posture-token delivery_note): the host uses it for that task alone and the repository's default is unchanged;
v3.6 re-homes the card contract by kind and trims the prescribed cards to
their constraints (captain locks 1-3 of 2026-09-19 on the visual-density
audit `fm3000-card-visual-density-audit-s1`). Authoring policy - what a
card is and how it should look - is `CARD_AUTHORING`, which every persona
includes exactly once and no descriptor repeats; call mechanics stay in a
short `emit_card` description that fits the Claude transport's 2,048-char
cap. The visual intent is stated as a FACT about the card rather than a
judgment handed to the author, and so are the two opt-outs: the crewmate's
picture of a visible change, and the Firstmate's own figures. What THIS
task's answer should look like is host-rendered in the brief
(`renderAnswerShapeSection`). Three prescriptions move to the host: the
completion buttons are attached from the task's posture and work status,
a blocked or capped task's ways out arrive as structured options on the
wake or refusal that reports them, and a Firstmate `settle merge` card is
REFUSED while the task's own crewmate has yet to emit its completion card.
Three go entirely: the five headings leave the card's open body (they stay
required in the report and the PR body), findings are no longer "listed
verbatim", and the completion body no longer says what each option does.

v3.7 (2026-09-20, crew-posture rationalization Task A): the personal
workspace is a workspace KIND (`repos.kind: personal`), not a delivery
posture. `delivery` now says only where a change lands - direct-pr or
local-only - and `live` is gone from the enum, from `delivery_ask` and
from both personas. Rigor exists only where a change lands through a
gate, so a task on the personal workspace has no tier at all rather than
a quick one, and its brief writes neither a Delivery nor a Rigor line.

v3.8 (2026-09-20, crew-posture rationalization Task B): a task carries a
DELIVERABLE - `answer` or `change` - derived by the host from the
classifier's kind and a typed `read-only` constraint, never judged by an
agent. An answer task is told the truth in its brief: no delivery, no
rigor, a scratch worktree it commits nothing from, pushes nothing from
and opens no pull request in; its card is the deliverable and the
captain's resolution of that card closes it `done/answered`. The host
enforces it rather than only asking - `settle merge-pr` and `land` are
refused on an answer task, and so is a card carrying a settle effect. A
change grounded in a verified `basis` receives that task's report and
card in its brief, and any agent can read them back with the `tasks`
query by key. `read-only` is now a typed constraint beside `plan-first`,
replacing the free-text phrase the host used to pattern-match.

v3.9 (2026-09-20, crew-posture rationalization Task C) gives autonomy the
shape delivery and rigor have (captain ruling F7 A: "this should actually
be the same - repo default, per-task ask allowed"). Autonomy is a
repository default with a per-task ask - `autonomy_ask` on
`spawn_crewmate`, the count stays 24 - relayed only from the user's own
words, the way `rigor_ask` and `delivery_ask` are. Every reader takes one
effective value (`autonomyFor`), `crew_status`, the context block and the
completion card's fact strip carry it per task, and the HOST now enforces
it rather than the prompt alone: a Firstmate merge or land of a task
whose autonomy is off settles nothing and returns the structured
`autonomy-off` refusal, whose one way out is the captain's own click on
the completion card. A captain click is never refused. It is the second
host hold on the same two settle modes, beside v3.8's answer task: the
deliverable speaks first, because a task that ships nothing has no merge
for autonomy to be about.

v4.0 (2026-09-21, roadmap 1.5, the plain-language pass; captain round six,
Q8): every word the app shows is written for someone who has never opened
a terminal, and the rule reaches the text the models write through the
one home every persona already includes once - `CARD_AUTHORING` gains the
vocabulary sentence (your project, a proposed change, the checks, a
working copy, put it in, a save point, a tidy-up, your plan's allowance,
your sign-in, a helper, a stronger model) with the three places a
technical name may still stand: chosen by the person, the thing itself in
mono, or one click deeper. The design skill's `copy/Vocabulary.prompt.md`
is the page the app's own strings follow; the prompts carry the same
table so a card follows it too. Measured by a hand-scored sample in the
replay gate, never a banned-word lint.

v4.1 (2026-09-21, decision-first cards): `CARD_AUTHORING` makes the
note-versus-decision boundary explicit for every persona. Any potential
next step for the captain, including an optional one, makes the answer a
decision; only a pure fact with no next step is a note.

v4.2 (2026-09-21, cards-as-threads phase 1; the captain's "cards-as-threads
over a decision model - ship it", 2026-09-20, decided in R4 of
`fm3000-card-close-decision-model-s1`): every card is the head of a thread
between the captain and the card's AUTHOR. One shared card-reply contract
- `CARD_REPLY`, stated once the way `CARD_AUTHORING` is and included by
every persona - tells both agents the same thing: revise the card when the
reply changes what it should say (same id, `emit_card`), answer in prose
when nothing on the card changes, and a reply is prose only, resolving
nothing. A crewmate gains one output for that answer, `reply(card_id,
text)`, beside report / emit_card / note_progress / file_followup; the
tool count on the Firstmate side is unchanged at 24.

Three rules RETIRE with it (captain's Q3 A). The close rule - "a captain
message addressing an open card's content dismisses it: call close_card
first that turn, whoever emitted it" - is gone, because words about a card
now reach that card's author instead of costing a Firstmate turn and a
close attributed to the captain. With it goes `close_card` on the
captain's behalf: only a card's own author withdraws it, and the captain's
× is the only dismissal. The Jev pre-step and the relay classifier were
the alternatives this design replaced and are not built.

The settle hand-off carries no classifier: a reply asking to put a change
in, discard it, route a stronger model or take on new work is not the
crewmate's to do, so the crewmate closes its card and reports the
captain's words verbatim, which the whose-turn rule routes to the
Firstmate - the turn that runs the settle. The Firstmate is never woken
for a thread message; it reads a bounded "thread activity since your last
turn" section beside the captain's resolutions, and a `thread:` fact on
each task's crew line. A captain reply on the Firstmate's own card is a
captain turn about that card (phase 2): the same CARD_REPLY shape. Images
ride a thread reply/steer where the transport supports them; Observe
surfaces the thread on the session.

v4.3 (2026-09-21, brief-close wording clarification): the hidden
end-of-turn response is explicitly not a card action and a turn never ends
by calling `close_card`. A card emitted as that turn's answer is current,
not obsolete, and must not be withdrawn during the same turn.

4.4: shared playable-card prototype review contract and explicit settings capture.

4.5: the emote tool offers the reply emotes - nod, salute, tick, tuck, aww
(captain's board verdict 2026-09-22) - and says the app already nods for a
delivered steer, tucks for a kept note and ticks for an applied
personalize on a captain turn. The persona prompt is unchanged.

4.6: sequences (docs/sequences.md). The captain-owned sequences document is
served after the prompt, and one rule replaces "spawn a plan as its own
task and the build as a second one": open a new ask as a parent task with
its steps as children, follow the appended instructions and bend them on
the user's words, start each step on the previous one's report or the
captain's choice with update_task start_now; a parent carries no crewmate
and completes when its last child lands. Once a step has started, the
answer step it builds on closes with settle_task answered (a step the
Firstmate ran; the captain's own asks stay his to close). The plan-first
constraint retires into a plan step. The tool count stays 24.

4.7: the words for where a project lives (git integration, PR 0.2). The
vocabulary gained rows for a project's host and its sign-in, and
CARD_AUTHORING carries them to every persona: your GitHub sign-in, never
keyring; where the project lives, never remote or origin; clone for
cloning, never copy; the code, never device code; and never a CLI, a
tool, gh, a binary or the search path - say what could not be done.

4.8: pictures by reference (card pictures, phase 2 of the locked plan,
captain's rounds 1-4 of 2026-09-24). A picture is markup: CARD_AUTHORING
tells every persona that an <img> naming a file in a working copy - PNG,
JPEG or WebP, alt saying what it proves - is verified, copied and shown
fitted and whole by the host, that several inside
<figure class="fm-pictures"> are one group (a lead and thumbnails, the
figcaption its caption), and that a card holds as many as the answer
needs up to 64 MB. The emit_card `images` parameter retires on both
runtimes, with the crewmate addendum's sentence about it; the crewmate
prompt shows its image artifacts on the completion card rather than
attaching them. The persona prompts are otherwise unchanged.

4.9: the app's own GitHub sign-in (git integration, PR 1.2). One rule:
a tool answering "Not signed in to <host>" is one decision card whose
default is the sign-in way the refusal names (an open effect on Settings
-> Projects that starts the sign-in) and whose other action keeps the
project on this Mac; a sign-in is never presented as required, and a
listing the sign-in could give beats asking for a link. The open effect
gains the `projects` target and `sign_in`. A crewmate's direct-pr
paragraph names open_change and check_change in place of every gh
command, and a not-signed-in answer is its blocker, never its sign-in.
The Firstmate's tool count stays 24.

4.10: words and the record (git integration, PR 1.3). settle_task's
description stops calling every merge-pr a GitHub merge: it puts the
proposed change in where the project lives - the pull request merged on
GitHub, the default branch fast-forwarded on a plain Git host. The
persona prompts are unchanged; the context block's `lives` fact now
carries the app's sign-in where a project's changes go, and crew_status
names that host as `goesIn`. The Firstmate's tool count stays 24.

4.11: install by talking (one plugin vehicle, Phase A, captain's A2a).
The Firstmate gains its 25th tool, install_plugin: a panel someone else
made, from npm, a git address or a folder, is one call on the captain's
turn; the host fetches, pins and checks it and asks him on its own
consent card, and the Firstmate authors no card about it. The operate
rule names it in one sentence; personalize remove takes an added panel
away.

4.12: one tool spec for both runtimes, grouped spawn parameters
(primitives P7). spawn_crewmate's 22 parameters become 12: the work-shape
facts (basis, premium_ask, override_model_id, escalate_from, rigor_ask,
delivery_ask, autonomy_ask, internal_step, review_of) ride one `shape`
object and the waits (after_task, when_quota_resets, at_time) one
`start_after` object, one level deep, every field's name and description
verbatim and each group a one-line description; a flat call from a
durable session reads the same (`groupSpawnArgs`). A hold's "stronger
model" way names `shape.escalate_from`. Every crewmate tool is one entry
of the crewmate tool spec both runtimes generate from; its words are
unchanged. create_task stays flat, the persona prompts are unchanged, and
the Firstmate's tool count stays 25.

4.13: every Firstmate tool rule reaches a Claude seat (W1 S2). The
Claude client drops every parameter description below the top level, so
a rule that lived only there moves up, in the one spec both seats read:
each work-shape fact's and each wait's rule rides its group's own
description (`shape`, `start_after`) under the field's name, and what
`constraints[].kind` and `text` mean rides the constraints array's (on
spawn_crewmate and create_task). emit_card keeps its nested words, and
its top-level `actions` now names the rules only they carried: the
action id's and label's form, proceed_with_open, the projects target and
sign_in; `actions` is shared, so a crewmate on either runtime reads them
too, as its schema already offered them. Parameter names and shapes are unchanged, so a durable session's
earlier calls read the same; the tool descriptions and the persona
prompts are unchanged, and the Firstmate's tool count stays 25.

4.14: a card comes back at its author's close-out (the captain's "ship
it" of 2026-09-27; docs/card-threads.md "When a card reaches the
stage"). The host holds a card the captain replied under off the stage
until its author has answered and closed out - a crewmate's report or its
idle, the Firstmate's turn end - and a crewmate's every card reaches the
stage the same way. CARD_REPLY says so: do the work his words need first,
answer once, and never acknowledge or announce, because the card comes
back when you are done. The crewmate's thread steer preamble adds "then
report". The persona gains one sentence on its own cards: when the answer
to a reply needs a crewmate, say so in that card and revise the same card
when the answer lands; never answer a thread with a new card. Its closing
words stay its thread answer - now also for a reply it read mid-turn.
The Firstmate's tool count stays 25.

4.15: crewmates keep off the person's keychains and signing material
(finding R1, answering FI3-90). The crewmate prompt and spawn_crewmate's
description gain one rule: never run security, codesign or any Keychain
command against the real keychains or ~/.firstmate-3000/local-codesign,
never put a secret in a command line, and reproduce keychain behavior only
under a scratch HOME with FM3000_LOCAL_CODESIGN_DIR. Instruction only; the
persona prompt is unchanged and the Firstmate's tool count stays 25.

4.16: the host watches a change's checks (docs/forge.md, "The check
watch"). A reading that finds checks still running arms a watch the host
reads with plain forge calls on its own tick, and the crewmate is woken
once when they finish - passed, failed with the failing checks named,
still running at the bound, gone, or unreadable. check_change's
description tells the crewmate to end its turn and wait for that wake
instead of reading again, and that a host with no checks sends none; its
answer says the same. The Claude crewmate's backend note stops telling it
to sleep between checks and says to wait for the wake. check_pr_ci's
answer names the watch. The Firstmate persona prompt is unchanged, and
its tool count stays 25.

4.17: review routing preserves the latest captain decision and asks for
invariant-complete, minimal fixes with normal callers retraced. The reviewer
brief gains a complete changed-file checklist and evaluates supplied plans
independently; the crewmate prompt tries disposable verification before
declaring a scenario blocked and protects standing agent instructions.
No new review round or attachment mechanism; the tool count stays 25.

4.18: the settle-card strip names the task's effective care instead of
delivery posture and autonomy; card authoring names the same host facts.

4.19: a parent only for an ask of more than one step (the root cause of
the redundant parent-and-child pairs, fm3000-parent-child-split-rootcause-s1).
The persona's sequences rule and the sequences seed say an ask that takes
one step is one spawn_crewmate with no parent - a clear, small ask skips
the plan and with it the parent - and an ask of more than
one step files its parent, the step that runs now (spawned alone, never
also a create_task) and the next step on request in the same turn. A
parent stays on request: the persona's false "a parent carries no
crewmate" becomes that rule. start_policy is worded in the host's terms
(when-ready: the host starts a crewmate on the task by itself), and
create_task's container is "for several steps, left on request". Host
wording states the typed fact the model lacked: create_task's answer for a
when-ready row nothing waits on says a crewmate starts on it now, and the
queued-started wake says a crewmate is working on the task. The tool count
stays 25.

4.20: figure type draws at true size in the usual card. CARD_AUTHORING
names a 510-unit full-width drawing, the app's own label sizes, and a
pixel width for a smaller drawing so the card only shrinks it. The emit
check measures the 11px floor at the usual 510px column instead of the
350px narrow column. The frame is unchanged, so cards already stored
keep the size they were authored at. The tool count stays 25.

4.21: the quiet ledger (FI3-152, direction A). Charted counts crew-filed
rows the captain has not opened, a filing's row reads found on its origin,
and the record shows the reason and the Firstmate's one-line verdict.
A test-failure filing names its
test path and the host refuses a second open row for that path. A test
that fails outside the crewmate's change is a follow-up only when it also
fails on the untouched main line. A release cut re-verifies filings older
than the last release before a drop is proposed; nothing is dropped by
age. The tool count stays 25.

4.22: inline decisions (fm3000-card-decisions-width-s1, proposal 1 under
the captain's Q1 B of 2026-09-28). A decision with several questions asks
them in its body as ordinary named form controls the author presents as it
likes - the proposed option checked, required on a question the captain
must answer, a <label> on each option. CARD_AUTHORING says so and that a
pick sends nothing, never fm.action from a control; the click-to-send
"Use these settings" retires in favour of a named hidden field or
fm.stage, sent with the footer click. CARD_MECHANICS gains one sentence:
a footer button is the one send and carries every named field. No new
emit_card parameter. The tool count stays 25.

4.23: a card as wide as its content (the captain's Q5 to Q7 A of
2026-09-28, proposal 2 of fm3000-card-decisions-width-s1). emit_card
gains one top-level parameter, width: wide or full, which can only widen
what the host already decides from the body's facts (a table of 4+
columns, a code line over 60 characters, a picture 900 px or wider, a
picture group, a preview). Its description says prose keeps a
66-character line and a width="100%" figure draws at its own units at
most, so the 510-unit figure rule stands. The tool count stays 25.

4.24: the report's own headline (fm3000-task-popup-body-r1, the task
popup audit's A2 under the captain's picks of 2026-09-28). The crewmate's
report tool takes an optional top-level summary - one plain sentence of
what happened, never a heading or the ask restated - and its description
asks for it on every call. The record's headline and the feed's report
line prefer it; without one, the first sentence past a leading Intent
section stands in. The tool count stays 25.

4.25: the e2e assertion contract (fm3000-e2e-contract-lint-m4-r1, M4 of
the e2e rigidity proposal the captain adopted on 2026-09-28). The
crewmate's standard tier says that where a project's end-to-end tests
read a surface through shared helpers, the tests covering it are those
helpers' callers, and a change that moves what a helper reads is fixed
once in the helper, never in copies. The tool count stays 25.

4.26: explicit, evidenced closure of work delivered by an external release;
neither a missing proposed change nor a dismissed note can close work.

4.27: completed captain-requested work without its own change gets a factual
outcome card before the report; changes still get a settle decision.
Internal reviews, hand-off steps and personal-workspace builds deliver their
reports, not cards.

4.28: a Firstmate decision about a blocked crewmate offers one non-default
"Try a premium model" choice only when premium can serve; it replaces a
hold's stronger-model way, never sits beside it. The captain's click is
the premium ask and escalation trigger, carrying the failed work forward.

4.29: only a Chrome click serves captain speech; script-fired actions
remain operational. A captain choice has its own turn, with card/task
context and no borrowed operational wakes; replay matches the choice on
that turn. Eligibility also excludes premium attempts and spent lineages;
when premium is unavailable, the existing stronger-model way remains.

4.30: one blocked-work decision card, with exactly one model way: premium
when it can serve, the stronger-model fallback when it cannot, and neither
once the lineage is spent. A premium click stamps premium as the actual
escalation floor; the stronger click omits premium_ask.

4.31: crewmate save-point and proposed-change names use conventional subjects;
the host validates new subjects and explicitly squashes with the checked title.

4.32: an objective plan-skip test in the app-managed sequences seed, a
declared skip reason on direct builds, and no Firstmate-authored plan card.

4.33: continuation after a mid-task landing is directed at spawn, filing,
proposal, checks wake, card, report triage and carded-task steer; no runner added.

4.34: a card's native question is worded in its fieldset's <legend> (or a
lone field's bound <label>) with short, stable names and values, so the
footer click can record what was asked; no new parameter and no lint refusal.
v4.35: FI3-237 paired fix. Diagnose ordinary failed checks, coordinate
baseline ownership/waits and reserve one evidenced flake rerun without a
captain card. The cap counts three unsuccessful declared own repairs,
never raw failed versions; model retries remain captain-only.

4.36: the vocabulary the app shows and the models write restores pull
request, commit, push, merge, branch and lint. It keeps the checks (CI,
green and red may sit beside them), bring it up to date, version, where
the project lives, sign-in, project and the Continue: prefix. A project
kept on this Mac is merged locally (pill "local merge"); the record
label is Delivery. Captain's answers on the FI3-239 card override the
proposal's conflict, rebase and version rows.

4.37: finished code-work completion cards open at Why, then What changed,
Before and After; the title alone carries the answer, verification folds
into After, and a crewmate settle-merge decision missing an ordered heading
is refused. Notes follow the instruction alone; answers/prototypes stay free.

4.38: completion-card Why prefers the captain's original intent, wording or
framing when available, with faithful paraphrases, exact quotes and a factual fallback.

4.39: immediate prototype build authorization and current-settings reply handoff.

4.40: edit-before-start dispatch and complete specification-history retrieval.

4.41: the plan-to-build handoff has one home, HANDOFF, included once per persona
beside CARD_REPLY; the Firstmate core, card authoring, card replies, the sequences
seed and the brief's basis section stop restating it (audit FI3-377). No new rule.

4.42: a captain's reply sends the card to the back of his stack instead of
off his screen (docs/card-threads.md "When a card reaches the stage"; a
lone card stays put). CARD_REPLY and the crewmate's thread steer preamble
say he sees your answer only when you are done, and nothing else about
the reply changes.

4.43: combine accepted-plan HANDOFF and guarded recovery with reply-to-back
card behavior; retain persisted choices, edit-before-start and full basis history.

4.44: link_tasks says a blocks link on started work holds its merge and that related
is the link for keeping track; the host turns a crewmate's merge card back while that hold stands.

4.45: setup_repo says clone and init go in the projects folder - the fleet
root unless the user chose another in Settings under Projects - that only
the user changes it there, and that projects already set up stay put
(docs/fleet.md). No new tool or parameter.

4.46: update_task takes override_model_id, the model the user named for a
task already filed (open work no crewmate holds), stored on its shape so it
routes there when it starts - with start_now in the same call to start it
now; the start answer names the model that took it. The core says to use
it instead of dropping the task for a replacement spawn (FI3-436's card).

4.47: the captain's close of a crewmate's card reaches that crewmate, which
judges it (FI3-435). The crewmate's report declares waiting_on_captain (the
captain gate: no nudge, no wake) or finished (the Firstmate closes the task).
An answer task no longer closes on his close; settle_task answered closes
one its crewmate reported finished. The Firstmate never judges what he read.

4.48: pasted file pointers ride user_words; the crewmate reads the whole file.

4.49: crewmate emit_card accepts body_file; instructions ask for editable card body files.

4.50: shared app action catalog, app_state/app_change, actor gates and equal trails.

4.51: Intelligence actions join app_state/app_change; disconnect protects the running seat.

4.52: wide by default except short plain copy; full-width drawings use 750 units.

4.53: presence, release and forge sign-out; hand-over/captain-owned lines and strict parity.

4.54: piece 4 folds project settings, theme and panel arrangement into app_change;
configure_repo is retired and personalize retains removal and standing instructions.

4.55: project-setup shares Settings additions through the catalog; setup_repo retires.

4.56: FI3-517 direction A, piece 2. CARD_AUTHORING leaves a decision's radio,
checkbox and select questions unpicked - a select opens on an empty Choose
option - and marks the recommended input or option data-fm-recommended,
which the app tags (piece 1, FI3-518) without picking it; text fields keep
their prefilled text and previews their settings. The card lint refuses a
required choice question that arrives answered on a decision that is not a
preview. The footer sentence follows piece 1: only the default waits.

4.57: project-remove (own words only) shares Settings removal through the catalog;
unregister_repo retires.

4.58: CARD_AUTHORING gains five sentence habits for card copy (FI3-542, the
captain's Build it on the ASD-STE100 preview): one fact per sentence in at
most 25 words, one name per thing with the full name where two things share
a number, the doer named, the thing said literally, and three or more
actions in a row as a numbered list. They are the project's own words - no
outside dictionary or word list - and are hand-scored on recorded cards
(`clear_copy_share`), never linted.

4.59: the fixed-context trim (FI3-541, the captain's "file a task to trim our
instructions"). No rule is added or dropped: a rule that the core, a tool
description and a parameter each stated is now said once. The core keeps
which move and when; how a call works is the tool's own text. emit_card
describes only its top-level parameters, a fixed choice is one string with
an enum, and three authoring sentences that repeated their neighbours go.
docs/orchestrator-contract.md lists each removed sentence and its home.

4.60: FI3-579 piece 4. show-card joins the app_change catalog: it brings an
earlier closed card forward read-only, with no new tool and no new card.

4.61: files in the composer (FI3-467). A message may carry an
"[attached file: name]" preview with its "full text:" pointer, or the
plain-text local path of a file the captain dropped; the persona keeps each
verbatim in the brief and still reads nothing itself.

4.62: FI3-627. The crewmate's emit_card body_file parameter nudges (never
requires) editing a card in place, and a revision of a card the captain has
seen reports the app's own new and removed part counts in its result.

4.63: FI3-628 prevention. After an answer authorizes a build, HANDOFF leaves
the card alone unless the captain expects information, then names the
builder as next owner; the generic no-merge completion note is limited to
finished change work.

4.64: emote takes an optional top-level text (FI3-622's plan, the captain's
Approve and build): a few plain words, at most 40 characters, shown on the
line above the character where the first turn shows "Thinking…" - a visible
reaction in words that still needs no card, never an answer. Over 40 the
call is refused and nothing plays. No other tool or rule changes.

4.65: FI3-642. Every card action closes its card and changes come by reply,
never a revise button: CARD_MECHANICS and HANDOFF say so, keeps_open leaves
the emit_card actions and is refused there, and the sequences plan line adds
that the captain asks for changes by reply. A card saved before keeps its
keep-open button.

4.66: FI3-304 piece one. A captain's merge click GitHub refuses for a
conflict is kept by the host and runs by itself once the crewmate has
brought the branch up to date and its checks pass; the settle wake tells the
Firstmate to steer the repair and ask for no second click, and the
crewmate's text says to put up a new completion card only if the work
itself changed.

4.67: FI3-304, the rest of the plan. The captain's merge click mints a
versioned approval bound to the completion offer he saw and the head its
checks read; it stands through conflicts, waits and restarts, the host
merges only that head or a repair the crewmate declared conflict-only with
check_change conflictRepair, and update_task withdraw_merge takes it back
on his words. The crewmate's text names the declaration.

4.68: FI3-671, the captain's Approve and build. A report wake now names the
work its task waits on that nothing starts by itself - a blocking filing or
a baseline dependency - and wakes on any backend; the persona answers it
that turn with start_now, a steer to fold the fix into the waiting branch
when that is smaller, or one decision card, and never leaves it planned.
The crewmate's text says a wait is its to move or escalate, and check_change
answers whether the named task has started.

4.69: FI3-676, the captain's Approve and build. The crewmate's text asks for
a picture of every changed view before its first edit and after the change,
as many as the change needs, and the completion card's Before and After carry
them; a figure marked data-fm-new is the new view and needs no Before, and a
card that shows nothing says why in an element marked data-fm-no-picture.
The crewmate card lint refuses a merge card with none of the three, except
for a task at the quick care level. The Firstmate's own text is unchanged.

4.70: FI3-592, grounded on FI3-643 (the captain folded the thread waiting
line into FI3-592 and answered its PR #656 question with one thread line).
HANDOFF: a click that authorizes a build still needs no card update, and a
reply that does is answered with one thread line naming who is next, the
card unchanged. The host's own words change too, outside the prompt: a
crewmate card thread ends with a waiting line read from the task's state,
the checks refusal of a completion card asks for that thread answer now,
and a message a paused Firstmate keeps gets a saved line in the feed.

4.71: FI3-695, grounded on FI3-696 (the captain's Approve and build, with
the limit raised to 32). The context block's captain_resolutions list is
what the captain did outside the conversation since the last turn: his
card choices and closes, and now his task card clicks - Start, Continue,
Drop task before and after the start - worded per button, newest 32 within
six hours, then a count of the rest. Neither his Start nor the Firstmate's
own start_now raises the queued-started wake; a failed Start of his says
he pressed it. The prompt text is unchanged.

4.72: FI3-679, pairing. device-invite and device-remove join the app_change
catalog enum, both tier yours: making a link and removing a device stay the
captain's own, on the home Mac's window. No prompt text changes.

## The longer notes through 4.72

These were sections of `docs/orchestrator-contract.md`, kept here as they were written.

### Contract 4.55: adding projects from Settings

Settings and Firstmate share the asked `project-setup` catalog line through
`fm:repos:setup`. Firstmate uses `app_change` with kind clone (origin), init
(name) or adopt (absolute path); `setup_repo` is retired. Messages, captain-set
schedules and project picks may request setup. Each new project files one
operation under that project and one actor-attributed `repo_setup` feed line.
Duplicates return the existing entry without another trail. Setup has its own
queue so downloads do not delay other Settings changes. Adding never wakes Firstmate.

### Contract 4.61: files in the composer

The composer takes dropped and chosen files (`docs/composer.md`, "Files"). A supported text file reaches the Firstmate like a long paste: an `[attached file: name]` line, its first 2,000 characters and a "full text:" pointer to the managed copy. A picture rides as an image block. A file of an unsupported format arrives as its absolute path in the captain's own words. The persona rule that preserved a preview and pointer verbatim in a task's `user_words` now names the attached-file line and the dropped path as well, and says a path promises no document can be read. The Firstmate gains no file tool; the crewmate it briefs reads the file.

### Contract 4.72: pairing's two actions

FI3-679. `device-invite` and `device-remove` join the `app_change` enum, both
`yours`: the Firstmate is told that making a pairing link and removing a paired
device stay the captain's own, on the home Mac's window (`docs/devices.md`). The
prompt text is unchanged; the fixed part grows by the two enum values.

### Contract 4.71: the captain's task card clicks reach the next turn

FI3-695, grounded on FI3-696: the captain approved direction A and raised the
limit from 8 to 32. A click on a task card's own buttons - Start, Continue,
Drop task before the start and Drop task on started work - is written on the
task's history as the captain's, with `via: "task-card"`
(`TaskService.taskCardClicksSince`). The context block's `captain_resolutions`
list is now "what the captain did outside this conversation since your last
turn (already done; not a request)": his card choices and closes and these
clicks, in one list, newest first, each click in its button's words. It holds
the newest 32 within six hours and then one line counting the rest. No click
wakes the Firstmate. Neither the captain's Start nor the Firstmate's own
`update_task start_now` raises the `queued-started` wake, which now means a
start whose wait ended; a Start of the captain's that fails still wakes, and
says he pressed it. The prompt text is unchanged.

### Contract 4.70: a reply that authorizes a build gets one thread line

FI3-592, grounded on FI3-643: the captain folded the thread waiting line into
FI3-592 and answered that a reply which only authorizes a build is answered
"with one thread line naming who is next, without changing the card".
`HANDOFF` says so: a click that authorizes a build still needs no card update,
and a reply that does gets one line in its thread (the crewmate's `reply`, the
Firstmate's closing words), so the reply is answered and the card returns to
its place instead of waiting at the back. The rest of the change is the
host's own words, outside the prompt: the waiting line a crewmate card's
thread shows (`docs/card-threads.md`, "The waiting line"), the checks refusal
of a completion card asking for that thread answer now, and the saved line a
paused Firstmate writes for each message it keeps (`docs/architecture.md`
§16, "A paused seat").

### Contract 4.69: pictures on the completion card

FI3-676, the captain's Approve and build. The crewmate's text asks for a
picture of every view a person would notice, taken before the first edit and
again after the change, as many as the change needs, and its completion card
puts a picture of each changed view as it stood under Before and each result
picture beside its sentence under After. Something new sits in a figure marked
`data-fm-new` and needs no Before picture; a change nobody can see says why in
one sentence in an element marked `data-fm-no-picture`. The crewmate card lint
refuses a merge card that has none of the three, and exempts a task at the
quick care level (`docs/card-authoring.md`). The Firstmate's own text and
cards are unchanged.

### Contract 4.68: a wait on work nobody has started

FI3-671, the captain's Approve and build. A report wake names the work its
task waits on that nothing starts by itself - a blocking filing, or the task a
standing baseline-blocked diagnosis names - and a report beside such a wait
wakes the Firstmate on any backend (`docs/report-sort.md`, row 2a). The wake
states the fact; the follow-up triage rule says the move: the Firstmate
answers that turn with `update_task start_now` (raising priority when it
holds a release), a steer to fold the fix into the waiting branch when that
is smaller (then dropping or unlinking what it waited on), or one decision
card when only the captain can settle it, and never leaves that work planned.
The crewmate's text says a wait on another task is its to move or to
escalate, never to sit on, and `check_change` answers whether the task a
baseline-blocked diagnosis names has started. No tool is added.

The rule costs the fixed part about 80 tokens by the app's count. With it the
fixed part measures 17,476, under the 17,480 budget.

### Contract 4.67: a kept merge approval

FI3-304, the rest of the plan (`docs/delivery-rigor.md` "A kept merge
approval"). The captain's merge click mints a versioned approval bound to the
completion offer he saw and the head its checks read; it stands through
conflicts, waits and restarts, and the host merges only that head or a repair
the crewmate declared conflict-only with `check_change conflictRepair`. The
settle wake tells the Firstmate the click is kept and who moves next.
`update_task` takes `withdraw_merge` for the captain taking back a merge he
clicked; the crewmate's text names the declaration. No tool is added.

The parameter costs the fixed part about 25 tokens by the app's count. With it
the fixed part measures 17,396, under the 17,400 budget.

### Contract 4.64: words on an emote

FI3-622's plan, the captain's Approve and build: `emote` takes an optional
top-level `text`, a few plain words shown on the line above the character
where the first turn shows "Thinking…" (`docs/renderer.md` "The stage line").
Its description says the limit and that the words are never an answer; an
answer still goes on a card. `emoteWords` (`src/shared/emotes.ts`) cleans the
words and holds them to 40 characters. Longer words refuse the call with tool
text and request nothing, so the turn took no action by it. Accepted words
ride the `firstmate_emote` event (`PROTOCOL_VERSION` 1.53.0), which checks
them by the same rule, and an emote with words counts as an action exactly as
one without. The host's own reply emotes never carry words. No other tool,
rule or move changes.

The parameter costs the fixed part about 34 tokens by the app's count. With it
the fixed part measures 17,371, under the 17,400 budget.

### Contract 4.57: removing projects from Settings

Settings and Firstmate share the own-words `project-remove` line through
`fm:repos:remove`; `unregister_repo` is retired. Only the captain's own typed
words can ask Firstmate to run it. `fm:repos:removal` reads the tasks still on a
project (planned or working) from the one guard, and any of them refuses the
removal with their keys. The folder and finished tasks always stay. Each removal
files one operation (“Removed project X”) and one actor-attributed
`repo_unregistered` feed line. Removing never wakes Firstmate.

## The tool surface through 4.72

Until 4.72 a test pinned the tool surface's fingerprint, and this comment beside the pin said why it moved.

What the model is offered - every name, description and schema - is
pinned: a change here is a deliberate change to the tool words. Moved
at v4.13: the nested rules rode up onto their groups and `actions`;
at v4.15: spawn_crewmate gained the keychain rule; at v4.19:
start_policy speaks in the host's terms and create_task's container
is left on request; at v4.21: update_task gained verdict, the one
line the captain reads on a filing; at v4.22: emit_card says a footer
button is the one send and carries every named field in the body; at
v4.23: emit_card gained the width hint; v4.26: settle_task gained
released and its evidence field for externally delivered work; now
emit_card distinguishes completion decisions from factual outcome notes;
v4.35: the vocabulary rewrite (pull request, merge, push, lint).
v4.42 combines closing resolutions/basis recovery with the shared HANDOFF pointer; v4.44: link_tasks says a blocks link holds a started task's merge.

v4.45: setup_repo's clone and init go in the projects folder the user
chose in Settings, which only they change.

v4.46: update_task takes override_model_id, the model named for a filed task.

v4.47: settle_task answered also closes an answer task its crewmate
reported finished, and a dismissed card does not wake the Firstmate.

v4.51: Intelligence joins the catalog enum and area; disconnect requires own words.

v4.52: emit_card's width field describes wide by default and 750-unit drawings.

v4.55: setup_repo retires; project-setup joins app_change.

v4.57: unregister_repo retires; project-remove joins app_change.

v4.59: the fixed-context trim - a fixed choice is one string with an
enum, emit_card describes only its top-level parameters, and each
description drops what the core or another parameter already says.

v4.60: show-card joins the app_change catalog enum.

Field-check repair: app_change derives its own-words names from the
catalog, adding project-remove and the retained panel-remove guidance.

v4.64: emote takes optional words for the line above the character.

v4.65: emit_card's actions drop keeps_open; every action closes the
card and changes come by reply.

v4.67: update_task takes withdraw_merge, the captain taking back a kept merge.

v4.72: device-invite and device-remove join the app_change catalog enum,
both the captain's own.

## The fixed-context budget through 4.72

Until 4.72 the budget moved with each revision that grew the fixed context, and this comment beside it recorded each move.

The ceiling, in the app's count: the fixed part measured 19,851 before the
trim and 17,190 after it. It moves only with a contract revision that says
what the new words buy: a rule that a tool, the core and a parameter would
each state is written once, where it is used. v4.61 (FI3-628) spends ~60
tokens on one HANDOFF rule: the next owner stays visible after an answer
authorizes a build. v4.64 (FI3-622's approved plan) spends ~34 on the
emote's optional words, bringing the fixed part to 17,371. v4.67 (FI3-304)
spends ~25 on update_task's withdraw_merge, bringing it to 17,396. v4.68
(FI3-671) spends ~80 on the one rule a report wake about unstarted work
needs - start it, fold the fix in, or one card - bringing it to 17,476.
v4.72 (FI3-679) spends ~8 on pairing's two actions in app_change's enum,
both the captain's own, bringing it to 17,485.
