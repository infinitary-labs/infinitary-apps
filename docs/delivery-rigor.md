# Delivery rigor

The user-facing care labels are Quick (stored `quick`), Default (stored `standard`), and Careful (stored `reviewed`).
These names do not alter the gates, review, fallback, or persisted values.

This document is the tier model's one home: what each tier asks of a crewmate, how a task's tier is derived, what the evidence contract is, how the reviewed tier runs, and what the host holds as a record.

Rigor derives from the user's words and the repository's configured rigor alone (captain rulings, 2026-09-19): standard is every project's standing value, never the intelligence tier or an escalation.
The review runs before the pull request, on the builder's branch.
A verdict-less reviewer report records nothing and spends no round.
Info-only findings derive a pass.
Declined findings converge through `user_chose_to_ignore`.
Validation is agent-driven and evidence-first; no configured command is mandated in the pipeline.
The reviewer is a crewmate, never an external pipeline.
Autonomy on is consent to merge at any risk: there is no risk-high captain card.

## Why instruction first

Every crewmate's coding session receives the working copy's own instruction file and skills (FI3-789), so the prompt tells the crewmate to read the instructions before anything else and follow the project's gate.
`projectResources.ts` reads the first available root instruction file (`AGENTS.md`, otherwise `CLAUDE.md`) and discovers skills directly under `.claude/skills` and `.agents/skills`, from the working copy alone.
Pi serves the instruction file through its resource loader's `agentsFiles` and exposes the project skills through its skill loader; Claude stages the project skills as a local plugin and appends the project instructions to its prompt (`piResourceLoader.ts`, `claudeProjectResources.ts`, `claude/session.ts`).
These are project resources, not the person's machine-wide instructions, skills, or agent configuration; Claude's empty `settingSources` does not prevent the app from supplying the working copy's own resources.
The prompt states the standard tier's procedure in full when care is standard, reviewed, or not yet known.
A task whose typed delivery and care say a passage does not apply is not served that passage, on either model backend and on a task that runs on another computer.
Unknown facts keep the full text.
The resource readers supply the project-specific instructions and skills.

## What delivery takes, confirmed first

Every crewmate, at every tier and on every backend, confirms before its first edit that it can deliver and prove its work (FI3-356, from FI3-343's delivery audit).
A builder in that audit, its implementation done, still waited for a reader of its evidence to be built.
So the crewmate prompt (`buildCrewmateSystemPrompt`) asks the crewmate to name what delivery and evidence will take: pushing, opening the pull request and reading its checks when the work ships through one, and whatever its evidence needs, such as a reader of workflow logs or artifacts, a test runner or launcher, an account or a device.
It confirms each with the cheapest call that changes nothing (the tool is in its session, `git push --dry-run` or a read where the project lives answers, the runner reports its version), closes the gaps it can itself, and plans only evidence it can gather.
A gap only someone else can close surfaces before the build, through the paths a handoff blocker already takes: a missing tool or a defect in the way is a filing (`blocks_me` when delivery cannot finish without it), and a sign-in or access only the captain can give is a blocker in its report.
That report ends the turn and says what the crewmate can build meanwhile, so it is sorted now rather than at handoff (`docs/report-sort.md`): a filing wakes the first mate on any backend, and a blocker alone reaches it as any report does, at once where the host sees all of the backend's work and on the idle ladder's clock where it cannot.
The recorded brief says what was confirmed.
Which tools a task needs is a judgment about the work, so it lives in the instructions; the host adds no check of its own (`AGENTS.md`, "Put ambiguous judgments in agent instructions").
The host's own dispatch-time sign-in hold still runs first (`docs/forge.md`, "Dispatch-time GitHub auth refusal").

## The default rule on tests

Every crewmate, at every tier, delivery and backend, is served one passage on how tests are written and repaired (`CREWMATE_TEST_DEFAULT` in `src/core/pi/piResources.ts`, from FI3-1756's approved plan).
It names six words a test meets - intent, fixture, failure, layer, owner and gate - so a test is written only for a stated intent: the user's ask, a standing ruling, or a bug being fixed.
It gives four rules for an existing test: a failure is a bug report first; a test the product outgrew on purpose is re-typed only for a stated intent and otherwise deleted; an intermittent failure is fixed at its owner with no retry or sleep; and a repaired test meets the same six words as a new one.
The passage is the one copy of its words.
It is a default, not a mandate: its last sentence lets the project's own rule on tests win, read from the instructions the crewmate already treats as its gate ("Why instruction first").
This project keeps no testing policy of its own beyond one ruling, weakening or deleting a test only on the captain's approval (`docs/testing.md`, "This project's rulings on tests").
A new end-to-end journey follows the passage like any other test, with no ask, and its review still names the promised result, the data, the completion signal, the platform prerequisites and the shared resources (FI3-1732).
The passage decides the rest.
The brief's `tests-required` constraint asks for tests of the task's stated intent, in the passage's sense (`src/core/orchestrator/intentBrief.ts`).

## The three tiers

| Tier | What it asks | Default for |
|---|---|---|
| **quick** | green CI; the five headings are welcome, nothing more is required | only when asked for: the captain's words (`rigor_ask`) or a repository configured `quick` |
| **standard** | the fixed pre-PR procedure, evidence-first validation, the evidence contract, the test-quality rule, three CI rounds then a blocker report | every project, explicitly set as its standing value |
| **reviewed** | standard, then an independent read-only review of the branch BEFORE the pull request; the push and merge are held until the review passes, and the reviewer runs on a different provider than the builder when one can serve | only when asked for: the captain's words (`rigor_ask`) or a repository configured `reviewed` |

The middle tier is **standard**, not "checked" (captain's call): it is what a careful engineer does by default, not an extra step layered on.

### The standard tier's procedure

Before opening or updating a PR the crewmate:

1. rebases onto the default branch and resolves any conflict itself, and never combines its commits itself, since a pull request is squashed when it merges: a `git reset --soft` onto a default branch another working copy has moved keeps the older files, and merging it undoes the newer work (PR #913);
2. validates the change itself, evidence first (the no-mistakes evidence instructions, ported): understand the user intent and demonstrate it working end-to-end the way an end user would actually experience it.
   Show that the intent is met with evidence.
   Turn the intent into the few concrete things an end user would do and the result each should produce, and gather evidence for each one: product-level artifacts that directly show the behavior working, such as screenshots, recordings, rendered UI, CLI transcripts, API responses, persisted state, or logs.
   Use as many artifacts as it takes; when the change has a visible surface, that includes pictures of it.
   Where the change is behavior a still cannot show - a drag, a keyboard journey, motion, progress, recovery from an error - the self-brief says so and why, and that view gets a demo recording in place of its pictures: the same action before the first edit and after the last, at the same window size, theme, data and crop, through the project's own isolated test launcher (this project's `startDemo`, `docs/testing.md` "Recording a demo"), shown on the card as `figure[data-inf-demo]` with its poster (`docs/card-authoring.md`, "Demo recordings").
   Unit tests passing, generic pass/fail output, and reading the code are not evidence on their own.
   Keep every artifact in the task's evidence folder (`userData/crewmates/<taskId>/evidence/`, named in the crewmate's instructions), outside the working copy, and never commit or push one as project content.
   Future github.com pull requests and gitlab.com merge requests upload only selected, inspected, publishable pictures and recordings through their saved story (`docs/forge.md`, "Saved change stories"); existing PRs and other hosts keep evidence in prose, with no local paths.
   Bulk working material whose destination the crewmate chooses, such as downloads, unpacked copies, throwaway environments and test-run output, goes in the task's temporary folder beside it, which the app removes when the task closes; evidence keeps its week (`docs/task-retention.md`).
   A picture the repository's own instructions keep with the change - this project's release-note hero pair (`docs/release-notes.md` "Hero pictures") - is part of the change, not evidence, and is committed where they say.
   Show image artifacts on the completion card by their path in that folder, and in Verified say in words what each artifact shows, or what stopped you gathering it.
   Run the smallest set of existing tests that would catch a break in what an end user experiences, including end-to-end tests that cover the surfaces you changed, and re-run them after any rebase that brings in overlapping changes.
   Where the project's end-to-end tests read a surface through shared helpers, the tests that cover it are those helpers' callers, and a change that moves what a helper reads is fixed once in the helper.
   If you can't run a test you judge relevant, say which one and why rather than dropping it quietly (captain's wording, 2026-09-24).
   When no existing test produces the evidence, write or improve a test so one does, under the default rule on tests above; when automated testing cannot, execute manual verification steps and record what you performed;
3. reads the whole diff once against the user's words and its own self-brief, and reverts or names every change the words did not ask for;
4. updates every document the change makes stale.

Then it reports under the evidence contract below.
Future github.com pull requests, gitlab.com merge requests and their completion cards use one saved story; legacy PRs and other hosts retain the five-heading PR description.
The crewmate is told that once, on `emit_card`'s `presentation` field (`tests/crewmate-fixed-context.test.ts`).
Failed checks first require reading the failed step and logs and declaring an explicit diagnosis at the head/check via `check_change`.
Initial diagnosis spends nothing.
Own regressions are repaired on this task: declare a stable repair id, source head, new target head/check and fix evidence; only the unsuccessful result spends one of three attempts.
The third unsuccessful repair is a blocker report (no completion card), which the first mate turns into one decision: retry, one captain-only model way, or discard.

An evidenced suspected flake may reserve **one failed-job rerun per task allowance**, before running it without code changes.
A repeated reservation is refused, including after restart.
If it fails again, investigate or reclassify with evidence, never rerun in a loop.
A confirmed baseline failure needs untouched-main reproduction evidence and a separately owned task id; the first mate coordinates its dependency; the host resumes the waiting crewmate when that task closes (FI3-250).
The declaration's answer says where that task stands (FI3-671): nobody has started it, so the crewmate leads its report with its key and that report wakes the first mate on any backend (`docs/report-sort.md`, row 2a), which starts it, steers the crewmate to fold the fix into its own branch when that is smaller, or asks the captain in one card; it is underway or queued, so the crewmate reports the wait once and ends its turn, and nothing nudges it until the sweep's one steer says that task closed; it is done, so the crewmate brings its change up to date.
A blocking follow-up nobody started wakes the first mate the same way.
Before accepting a current non-green-head baseline diagnosis, the host checks the same live-wait graph used by ordinary blocker insertion (`docs/task-graph.md`, "Combining repairs after a circular-wait refusal").
A loop refusal names the complete task-key path and changes no diagnosis, link, or repair budget.
The crewmate reports it to the first mate, which chooses one existing owner, combines attributed patches, removes only obsolete waits, verifies every failed check, and reconciles after merge.
Historical diagnoses and closed dependencies do not create mixed-wait edges; valid waits still derive from durable delivery records across restart and resume when the dependency closes.
A wait instruction alone proves no external ownership.
Diagnosis, waiting, and the one flake rerun spend no own repair attempts and earn no captain card.
Unknown allows one outstanding evidenced investigation gap; resolve it through a bounded investigation, then report it for the first mate to coordinate if still unknown, rather than repeated readings or reruns.
Only an exhausted repair allowance or a real decision/access/information only the captain can supply warrants a question.
Every current check must still pass before completion.

If a relevant scenario cannot run, first try disposable data/accounts, an isolated local instance or workspace-local tools where the project's gate allows it; never touch the person's real or shared state.
Name attempted workarounds if still blocked.
A supplied verification plan is a proposal, not proof or the user's intent: assess its expected outcomes and artifacts independently against the project gate.
During fixes, avoid unrequested rewrites of `AGENTS.md`/`CLAUDE.md`, while still reviewing explicit edits, resolving conflicts and updating instructions made stale by the change.

The test-quality rule travels with the tier: a test whose only evidence is that source text contains or omits a string proves nothing; exercise an interface and assert behavior.
The prompt pins in `piResources.test.ts` are the one sanctioned exception, because the prompt IS the interface being shipped.

## How a task's tier is derived

The host derives it for each current reading (`effectiveTaskPolicies` over `rigorFor` in `src/shared/rigor.ts`, pure and fixture-tested like `tierFor`), from facts it holds.
The order is fixed and short (captain rulings, 2026-09-19); the first rule that applies wins.

0. **A gate at all.**
   Rigor exists only where a CHANGE lands through a gate (`RigorInput.gated`, Tasks A and B of the crew-posture rationalization, 2026-09-20).
   Three tasks are ungated: one whose deliverable is an ANSWER ships nothing at all (`WorkShape.deliverable`, below), one on the personal workspace builds in place - there is no branch to review and no pull request to hold - and a review task reads a change rather than shipping one.
   For each, `rigorFor` answers no tier at all rather than a quick one, the brief writes no `Rigor:` line, and nothing is stamped on the shape.
1. **The captain's ask.**
   The user said in words how careful to be, and the first mate passed it as `rigor_ask` at creation or `rigor` on `update_task` for open work; a live edit supersedes the original ask, while `project` explicitly resets it.
2. **The repository's own rigor.**
   `repos.rigor` (migration 36), set by talking - `app_change project-settings` with `changes.rigor: quick|standard|reviewed`, on the user's words alone, and `default` to hand the repository back to this derivation.
   Null is "derive".
3. **Standard.**
   Every repository's default, whatever its posture.

Nothing else moves the rigor: not the intelligence tier - the tier routes models, never ceremony - and not an escalation, because rejecting a result is a signal to try a stronger model, not to add review rounds.

### The deliverable axis (Task B)

Rule 0's first case is its own fact on the record.
`WorkShape.deliverable` is `answer` or `change`, derived by the host at the mint from two typed facts it already holds (`deliverableFor` in `src/core/orchestrator/intentBrief.ts`): a `plan`, `research`, `retrieval` or `reproduce` kind off the classifier (a `teach` kind is always a `change`: its card is never the end of the work), or the typed `read-only` constraint - which is the first mate relaying that the captain wants no changes.
Everything else is a change, `unclear` included (an unknown piece of work is treated as work).
A plan is its own answer step since contract v4.6 (`docs/sequences.md`), so the retired `plan-first` constraint - which a stored intent may still name - changes nothing here.
No agent judges it, the same way none judges the tier or the rigor.

An answer task is told so, in the one place the visual-density audit measured as the channel every model family obeys - the brief.
It gets no `Delivery:` line, no rigor section, and `renderAnswerShapeSection` says the rest as facts about the task: its card is the deliverable, its worktree is a laboratory that is discarded when the task closes, and it commits nothing, pushes nothing, and opens no pull request.
The host does not only ask: `settle_task merge-pr` and `land` are refused on it, a card carrying a settle effect is refused at the card boundary the way the personal workspace's is, and its worktree is removed whatever it holds with nothing saved first (every other closed task's unlanded work is saved on a hidden kept ref before its tree goes) - the record's own `deliverable` is what says the worktree was scratch.
A crewmate's follow-up is held to the same brief, though it has no intent to render from: its brief was written at filing, with the `Delivery:` line last, so when the classifier calls it an answer the host drops that line (`withoutDeliveryLine`) and appends the same answer-shape section.
Its tools follow the same stamped deliverable, so an answer is never told to open a pull request it has no `open_change` to open (FI3-598).
A follow-up the classifier calls a change gets that line written again when it starts, from its own record's posture - the project's, or an ask made of the follow-up itself - which is the one its merge takes (`withDeliveryLine`, FI3-733).
An ask made of the origin never reaches it, and a posture the project changed while it waited does.

The captain's choice on that card is the CLOSE (captain F2 A): it closes the row `done/answered`, because the deliverable was produced and he answered it.
His close control reaches the crewmate instead (FI3-435), which reports `finished` once he has read it, and the first mate closes the row with `settle_task answered`.
The findings travel to a builder through `basis`: when `spawn_crewmate` names a verified basis, `renderBasisSection` carries that task's captain words and its report into the builder's brief, and names the file its card body is saved to whole (`docs/sequences.md`); any agent can read them back with the `tasks` query by key.

One bound sits under the order, mechanical rather than judged: reviewed ships a pull request after its review passes, so a reviewed answer someone asked for on a local-only posture ships standard instead, the most care that posture can take, with the reason saying why.

The dispatch answer is stamped on `WorkShape.rigor` as provenance, while `effectiveTaskPolicies` supplies current care to `crew_status`, crew context, completion facts, briefs and guards.
The task detail keeps dispatch `rigor` and publishes current `policies` separately; Details displays the latter.
The brief names current care through `renderRigorSection`, and later durable policy notices supersede the brief without changing its scope.
A queued row is told the rigor of the moment it starts.
The kind classifier never sees the section - it runs on the intent before the mint - and a row dispatched before phase 2 reads as `quick`, which is what the replay gate and the corpus export treat a recorded spawn as.

The first mate never judges a rigor, the same way it never judges a reasoning class (routing S2): its prompt says the host derives it, and its care fields relay the captain's words.

## Changing policy on open work

`update_task` is the conversation-first editing surface described in `docs/task-record.md`, “Live task policies”.
An explicit self-merging request (including a reset to an autonomous project) releases only a routine completion offer and its matching captain wait; unrelated decisions, dependencies, explicit withdrawals, repair caps and safety holds remain.
The first mate then uses the existing settle operation, which rereads current checks, destination, review, consent and close requirements; permission is not evidence that they passed.
A task that merges on its own puts no merge card in front of the captain: at green its crewmate reports `needs_firstmate` to merge (the report sort's row 0a wakes the first mate) and the first mate runs `settle_task merge-pr`; Activity and the record say so.
When a standing direction's exception covers the final change, the crewmate emits the usual completion decision and asks the first mate to set the task to Asks first, citing the direction; a refused merge falls back to that card.
The first mate applies the standing directions that bear on a task, merging included, when the captain starts it (`docs/inbox.md`, "A captain's Start is a wake").
“Asks first” cancels unsent merges and kept approvals even when the displayed value already says Asks first, while a later explicit self-merging request remains possible.
A delivery edit also invalidates approval for the previous destination, but changing delivery or care alone grants no merge permission.
Each accepted edit advances a revision; asynchronous merge attempts compare it at the final boundary immediately before sending the merge, not just before reading checks.
GitHub unattended merges also check draft, conflicts, head and review readiness at that boundary.
Once a merge has been sent it cannot be recalled; the first mate says so, and any retry reads the new policy.
Changing delivery keeps commits, published work and the original pull request linked; switching back reuses that identity when possible and never silently closes it or falls back on missing access.
Higher care requires missing validation or review before the next push or merge, including a pull request already opened; the reviewed gate requires a pass for this change.
Lower care removes only a host review's policy-owned blocking edge; review history, failed checks, repair counts and other holds stay.
Queued or waiting work does not start merely because a policy changed, and active crews receive the notice through the existing inbox rather than restarting.
`tests/e2e/task-policies.spec.ts` exercises keyboard edits, sources, Activity, reset/restart and an already-ready result under passing and failed checks; the supervisor and workspace tests cover the asynchronous cancellation boundaries.

## The evidence contract

A standard-tier report, and a legacy PR body or one on a host without saved stories, carry five headings, in this order:

| Heading | What it holds |
|---|---|
| **Intent** | what the user asked for, in one or two sentences, against the self-brief |
| **What changed** | the change itself, at the level a reviewer reads first |
| **Verified** | the exact commands and tests run and the evidence that the intent is met, one or more product-level artifacts for each concrete thing an end user would do - pictures of any visible surface among them (a demo recording where the change is behavior), kept in the task's evidence folder, never committed, and shown as `<img>` (or `figure[data-inf-demo]`) absolute paths in the completion card, which the host verifies and serves - and what each artifact shows, or what stopped you gathering it |
| **Risk** | low, medium or high, with one sentence |
| **Not done** | what the words asked for that this change leaves out, and why |

The report and the PR body are where the contract lives.
The completion card is not a third copy of it (captain lock 3, 2026-09-19).
Contract v4.37 gives finished code-work completion decisions and notes a loose outline: **Why**, **What changed**, **Before**, **After**, in order, with no body lead; the title alone carries the answer.
Before is one sentence on how it stood, then a picture of each changed view as it stood, taken before the first edit; each result picture and the verification sit in After, as many pictures as the change needs (contract v4.69).
A demo recording stands in for a view's pictures in either section, its poster the picture the check counts.
The standard tier's self-brief lists the views and states a person will see; the quick tier is exempt from the picture check.
What is left closes after After when decision-relevant, otherwise in details, not a fifth heading.
The crewmate's standing instructions carry one sentence; its card boundary refuses a declared settle-merge decision missing an ordered heading, but notes follow the instruction alone.
Answer cards, previews included, keep their own shape.
The report's five headings and rigor numbers are unchanged.
The host appends the project, crewmate model, effective care tier, PR link, CI state and its own holds itself (`CrewSupervisor.settleFacts`, contract v2.0 ruling D4; the labeled fact strip since v2.7), so the body never repeats those either.

`tests/e2e/rigor-standard.spec.ts` is the binding test: a crewmate commissioned through the real app on a real Pi session is served the prompt for its own delivery and care, which names its tier, and reports under the five headings, and a completion card with the four-heading outline publishes through the real emit -> lint -> CI gate -> frame path with the host's own buttons on it; a missing heading is refused and the corrected card publishes, with no answer line before Why.

PR-8 stands (board decision): a project that runs no checks (a PR that reports zero checks where none are coming) is green when the report's Verified names the local gate that ran on the final commit; checks that have not started yet read pending (`docs/forge.md`).

## The reviewed sequence

A task derived as reviewed ends with an independent reviewer whose task holds the merge until it passes.
The review runs BEFORE the pull request (the no-mistakes ordering, captain-approved 2026-09-19), so fix rounds are local commits rather than push + CI cycles.
The host owns the derivation, the reviewer's brief and the hold; the first mate owns the routing of findings, by instruction (contract v3.5).
Since FI3-566 (cut C) those instructions sit where each step arises, the way `CHECK_DIAGNOSIS_NEXT` rides a failed check: the first mate's core says when to commission the review and to carry the captain's latest decision into every fix and review steer, the builder's reviewed brief says how to fix a finding, and each review wake names the step it asks for (`wakes.ts`).

1. **The builder finishes locally and emits no card.**
   It commits its work on its branch, reports under the five headings, and does not push, open a PR, or emit a completion card - its brief's rigor line says so, and also how to fix the findings the first mate relays (`REVIEW_FIX_RULES`, the ported fixer preamble); a completion card with a merge effect emitted before the review passed is refused at the boundary (`CrewSupervisor.addCrewmateCard`), naming where the review stands.
   The report reaches the first mate directly: a reviewed task's events, and a review task's, skip the whose-turn sort's sorting (`routeCrewEvent`).
2. **The first mate spawns the reviewer** - `spawn_crewmate` with `review_of` naming the builder and the user's original words; no new tool, the count stays 24.
   The host refuses it as text before anything exists when the builder is not reviewed, has not reported, has no commits on its branch (`WorkspaceService.branchHead`), or already has a review open.
   A builder with a pull request already on record is still reviewed at its committed branch head, not that pull request's recorded head.
3. **The host briefs the reviewer** (`renderReviewBrief`, byte-stable like the escalation brief, its instruction text aligned to the no-mistakes review prompt): the fixed review instruction around the captain's verbatim words, the builder's branch at the assigned commit (worktrees share refs, so the diff of that commit against the default branch is the change, never the live branch), and the builder's last report and the complete changed-file checklist at that head.
   The reviewer runs on its builder's recorded computer, in a separate working copy at the assigned commit, with the evidence folder on that computer (`docs/helper.md`, "Independent reviews").
   Its provider is selected from that computer's own subscriptions, preferring a different provider than the builder's when one can serve.
   The builder's computer supplies the committed head, the checklist and the change reading; an unavailable computer refuses the review rather than falling back to a stale home branch.
   A computer on an older contract supplies no reading, so a pass from it does not carry.
   Before a re-review turn, the host refreshes the clean review copy to the new assigned commit; edits or unexpected commits refuse the refresh without losing work.
   Guidance during a review waits for the next turn, and the verdict records the commit assigned to that turn, not a later builder head.
   The reviewer checks every listed path, does not call an omitted path clean, and recomputes the checklist at a new head.
   A review commissioned after an earlier review of the same builder passed at another version names that passed version and reads only what changed since it, not the whole change again (INF-401, the captain's direction for an unavoidable update).
   Its brief gives the reviewer `git range-diff` between the two versions, keeps the complete checklist to compare path by path, and says a path whose change reads the same was reviewed at the pass.
   The review task records that version as `passedHead`, so each later turn of that review, a re-review after findings included, keeps the same scope.
   The builder's committed head must be available on the builder's computer before the reviewer can start at that commit.
   A bounded follow-up coverage turn is not implied.
   It is read-only by instruction - change nothing, commit nothing, push nothing, run no tests: the builder's Verified section and the builder's evidence folder (named in the brief) are the test record; evidence is never committed.
   Its shape is `kind: review`, established by the host (`kind_source: host:review`, never the classifier) and routed like research (high); its title is `Review: <builder title>`, its parent the BUILDER itself - the one stored review-to-builder join since the `review_of` fold (captain-approved 2026-09-19; `review_of` survives only as the spawn ask) - and a `blocks` edge from it onto the builder is the hold: the builder's close is refused while the review is live, by the existing blocks-at-close rule.
   The `host:*` kind_source makes the review delivery machinery: it never counts in the children-open close gate, its parent is fixed, and every builder close in any direction retires a live review with it (superseded, silent), so a reviewer never outlives its builder.
4. **The verdict.**
   The reviewer opens its report with exactly one line, `verdict: pass|findings|blocked`, reports one finding per line - id, severity (error / warning / info), file and line, one sentence, and an action: auto-fix, ask-user, or no-op - and closes with one line, `risk: low|medium|high`, with one sentence why.
   The host reads the verdict line, the finding lines and the risk line (`parseReviewReport`, `parseReviewFindings`).
   A report with NO verdict line records nothing and spends no round - a reviewer's acknowledgment ("standing by") is not a verdict, and the hold stands regardless, so it still fails toward the human.
   A stated findings verdict whose findings are all info/no-op derives a `pass`: info never blocks (`findingsBlock` - blocking is an error or warning severity, or an ask-user action at any severity).
   The verdict, the head read, the change reading taken at assignment and the risk land on the builder's delivery facts (`reviewVerdict`, `reviewSha`, `reviewChange`, `reviewRisk`, `reviewRiskNote`, `reviewedAt`) as a `review` timeline event whose data also names the review task; which review a builder's verdict came from is otherwise read off the parent edge (`TaskService.verdictReviewOf`).
   A pass holds for a later version whose stored change reading matches the review's reading.
   The approved head's reading is stored when the captain approves, and each repair's reading is stored when that repair is recorded, in the read that already brought the branch home.
   Opening the pull request still carries a version that has no stored reading yet, by reading it once and storing that reading, and a quiet timeline line records that carry.
   The kept merge compares the stored readings and does not read the branch again.
   A carry recorded before the reading was stored with the version still covers its head.
   The reading keeps one neighboring line and drops where the lines sit.
   A main edit right next to the change asks for a fresh review, because that neighbor is part of the reading.
   A line moved beside the same neighbors still counts as the same change, and the pass carries.
   A move that changes those neighbors asks for a fresh review, and so does any edited line, added change, dropped line, spacing change, or a version the app cannot read.
   A main edit farther from the change does not.
   The checks still run on every version and must pass before a merge.
   A pass recorded before the reading was stored carries the same way when its reviewed commit is still on this Mac and the task is not placed.
5. **Findings and blocked leave the reviewer idle and steerable.**
   The findings wake names the first mate's next steps (`reviewFindingsNext`), and so does a blocked one; the findings wake the review cap rides names only the cap's way out.
   The first mate steers the builder with every auto-fix finding verbatim; the builder's reviewed brief carries the ported fixer preamble - double-check legitimacy, identify sibling sites of a broken invariant, repair the defect class with one small correction rather than new machinery, retrace normal callers, and verify resolution without reverting intentional changes.
   A builder whose care rose to reviewed after its brief never read it, so its findings wake (`briefed` false, from the builder's dispatch rigor) has the first mate prefix the preamble to the steer.
   The captain's latest decision governs subsequent fixes and reviews: a declined finding is not implemented and a chosen fix is not undone merely because earlier wording differed.
   Genuinely new problems remain reviewable.
   Info findings never block and need no steer.
   It decides an ask-user finding itself when the user's own words already settle it; the rest are ONE decision card per round on the builder's task, listing them verbatim with the step it would take as the default.
   The builder's next report names its open review, that review's last verdict and the head it read (`review` on the `report` wake, while no cap holds the re-reviews).
   When that report brings a new head, the first mate steers the reviewer to re-review at that head, listing findings the captain declined under `user_chose_to_ignore` with the instruction not to re-report them unless the code genuinely introduces a new, materially different problem - and it never steers the reviewer otherwise: an idle reviewer needs no stand-by and no status, which the findings wake and a reviewer's verdict-less report also say.
6. **A pass closes the review task** (done / finished, the host's actor), which releases the hold.
   The one feed line is the builder's own event - `review passed at <sha>, risk <level>: <note> - <builder title>` - and the review's close is silent.
   The wake to the first mate refs the builder, whose move is next, and names it: a steer to push, open the PR and drive CI green; then with autonomy on, `settle_task merge-pr`, otherwise the builder's completion card is the decision.
   The completion card carries the review beside CI in the host's facts strip (a Review cell: `passed
   <sha> · risk <level>` with the note on the cell's title; `open` while
   one is live, `awaiting` before one exists).

**Risk never holds (Q4).**
The reviewer's risk is recorded on the builder and rendered beside CI; autonomy on is consent to merge at any risk, so a green reviewed PR on an autonomy-on repository merges like any other, and the first mate settles after a pass without reading it.

Where the review stands is on every surface the fleet already has: `crew_status` and the context block's crew lines carry `rigor` and the review state (`awaiting review`, `review open (<key>)`, `review: findings`, `review passed`, and `reviews <key>` on the reviewer's own row), the task detail carries `rigor` and the review facts in `delivery`, and Details shows current Care separately from Delivery, with the verdict and its risk beside CI.
Nothing new reaches a user surface: no card kind, no setting, no control.

`tests/e2e/rigor-reviewed.spec.ts` is the binding test: through the real app on real Pi sessions with a local GitHub stand-in the app reads through its own sign-in (`tests/e2e/githubStub.ts`), a direct-pr task derived reviewed reports green with no card, the first mate checks CI and spawns `review_of`, the findings become one steer and one decision card, a merge asked for while the review is open is refused, the re-review's pass is one feed line that releases the hold, and the completion card renders the review beside CI and merges.
`crewSupervisor.test.ts` covers the refusals, the hold, the verdicts, the sort bypass and the facts each review wake carries; `wakes.test.ts` the next steps each review wake words; `tests/firstmate-fixed-context.test.ts` that every step the core gave up is still served where it arises; `rigor.test.ts` the derivation order and the verdict line; `intentBrief.test.ts` the rigor section and the review brief.

## The record and its holds (phase 3)

Phase 1 bounded the crewmate by instruction - three CI rounds, then a blocker report - and phase 2 bounded the first mate the same way - re-review at most twice.
Neither bound was a fact the host held, so a crewmate that never self-reported, or a first mate that kept steering, could spend rounds without end.
Phase 3 makes the bounds records on the builder's delivery facts and holds on them.

**The repository's rigor is a posture.**
`app_change project-settings` writes `rigor` beside `delivery` and `autonomy` (`configure_repo` is retired); Settings → Projects writes the same row.
The project-settings feed line (`repo_configured` in `src/shared/feed.ts`) names the care (`CARE_WORDS`: Quick, Default, Careful) only when the column is set, and says nothing when the host derives it.
The context block does the same: `rigor` is on a repo only when the column is set (`firstmateAgent`'s context `repos`).
`rigorFor` reads the column as `repoRigor` (rule 3 above).
`setup_repo` is retired; `project-setup` puts up the setup card, where the captain may set a new project's care before it is added (`docs/fleet.md` "Asking the first mate to add a project").
The personal workspace takes no policy at all - its registry refuses the whole patch with one message - because it is a workspace KIND (`repos.kind: personal`, migration 37) rather than a posture.

**CI rounds (FI3-237 paired fix, contract v4.35).**
Raw failed head/check history lives in `TaskDelivery.ciRepair.failures`, separately from diagnoses, repair ids/results and the one flake reservation.
The host does not infer ownership from report prose.
`check_change` carries `diagnosis`, `repair` or `rerun`; it requires observed failure evidence, an existing separate baseline task in this project, and an own-regression diagnosis before a repair declaration.
An unknown diagnosis cannot exempt an attempt or reserve a rerun.
Only an unsuccessful declared own repair result adds to `ciRounds`; a repaired check passing while an unrelated check fails spends nothing but still cannot complete.
Foreground reads and check watches use the same ledger.
Repeated ids/target heads/results and revisiting historical heads add nothing; the delivery JSON persists across restarts.
Pending checks cannot settle a repair; terminal neutral results are unsuccessful and still block completion; skipped results are accepted and spend no repair attempt.

The third unsuccessful repair stamps `ciCapAt` and sends one cap wake; completion stays held pending the captain's answer and relaying steer.
That steer reopens the counters and flake allowance alongside the existing caps, retaining raw history, evidence and completed repair ids/results so an old observation still cannot become a new attempt.
Uncapped legacy failed-version counts have no ownership evidence: the first reading archives them as `legacyFailedVersions`, rather than spending the new repair allowance.
Existing legacy captain holds are preserved until answered, never silently released.
A passing reading cannot erase a captain hold.
The strict fresh all-current-checks-accepted gate (including the zero-check local-gate exception) is unchanged.

**Review rounds.**
Every stated `findings` verdict at a head not yet counted is one round on the builder (`reviewRounds`; `reviewRoundSha` is the last counted head, so a repeated verdict at the same head records the verdict and spends nothing, and a verdict-less report spends nothing at all - the two shapes that produced the phantom rounds of 2026-09-19).
The first round is the review itself, so the cap bounds the re-reviews after it (`REVIEW_ROUND_CAP`, 2): a third findings is one past it.
That findings wake carries the cap - one wake, never a second - stamps `reviewCapAt`, and while it holds a steer to the review task (a re-review) is refused as text naming the way out; `crew_status` and the context crew lines say `review: findings (cap reached)`.

**The answer reopens the rounds.**
The captain answers the first mate's decision card on the task (`capAnsweredAt`, stamped by the captain's resolution of a first mate card there since the cap - a dismissal is not an answer), and the first mate's next steer to the task with that answer, or the captain's own steer, clears both counters and both caps together and writes one `cap_reset` timeline event (feed: no).
A first mate steer before the answer reopens nothing.
Supervision steers never do.

**The caps are gates** (the primitives review's P2, captain-approved 2026-09-26).
A cap is a wait on the captain by definition, so it is a hold on the gate the task already has rather than a second place a wait lives: while a cap stands (`ciCapAt` / `reviewCapAt` set and not answered since), the builder carries a `captain` gate, ref the head the cap was reached at and reason `the CI cap` / `the review cap` (`standingCap`, placed by `IdleLadder.syncCaptainGate`).
When the first mate raises its decision card on the task the gate names that card; the captain's answer releases it (`capAnsweredAt` is the release), and the relaying steer clears the caps.
A close is not an answer: the gate goes back to the head, and the idle clock restarts at the close.
Rounds and heads stay delivery facts.
So the board shows a capped task `held`, waiting on the captain once the card is up, and the idle ladder reads the gate instead of treating a capped crewmate as a stalled one (`docs/report-sort.md`).
Migration 47 gave rows capped before this their gate (logged in `cap_gate_backfill`).

The five headings stay required in the report and the PR body.
Nothing lints a card for them.
What still speaks at the crewmate card boundary, before the shape rules, are the task's holds - the personal workspace, an unpassed review, a standing CI cap - so a card the task cannot take at all is refused for that.

**The autonomy hold.**
Autonomy - who merges a task's green work - now has the shape delivery and rigor have (contract v3.9, captain ruling F7 A of 2026-09-20: "this should actually be the same - repo default, per-task ask allowed").
The repository's `autonomy` column is the default, the first mate relays the captain's own words for one task as `autonomy_ask` on `spawn_crewmate`, and `autonomyFor` (`src/shared/repos.ts`, beside `deliveryFor`) is the one derivation: the ask, then the repository.
The ask is read by PRESENCE, so `autonomy_ask: false` - "ask me before merging this one" on an autonomous repository - is an ask, not a silence.
The mint stamps the effective value on `WorkShape.autonomy` the quiet way rigor is stamped, as provenance; every reader that decides anything derives it live from the record instead, so turning a repository autonomous reaches work already in flight.

It is the fourth HOST-enforced merge rule, beside the unpassed review, the CI cap and v3.8's answer task, and the only one that had been prompt-only: with autonomy off, `settleTaskOnce` refuses a `merge-pr` or `land` whose actor is the first mate and settles nothing, returning the structured `autonomy-off` `SettleRefusal` (WI-12).
Its one way out is not a tool the first mate can run - it is the button already in front of the captain, so the refusal names the open completion card's own merge action by card and action id (a `SettleWay` variant that carries a `card` rather than a `tool`), and says whose card is owed when none is up.
The captain's click arrives as `actor: "captain"` and this rule never reads it.
Three rows take no autonomy at all, for the reason they take no rigor - there is no merge to hold: a task on the personal workspace (it builds in place), an **answer** task (it commits nothing, and v3.8's deliverable hold refuses its merge whoever asks, so that refusal speaks first), and a task with **no repository** - the default workspace - because the hold enforces a REPOSITORY's standing answer and there is none to enforce there.
The completion card's fact strip carries an `Autonomy on|off` cell, so the captain reads what a click will do, and `crew_status` and the context crew lines carry it per task.

**A kept merge approval (FI3-304).**
The captain's merge click on a completion card is an approval of that change, and a refusal that is not a verdict on the work does not spend it.
`src/core/orchestrator/mergeAuthorization.ts` holds its closed facts; `SettleService` runs it.

- **The baseline.**
  When a crewmate's completion card clears the checks gate (`pendingCiGate`), `CrewSupervisor.recordCompletionOffer` keeps the shown offer's id with the head those checks read and its pull request (`delivery.completionOffers`, the newest four).
  An offer that shows the same content at another head keeps no baseline.
  A new completion card supersedes any standing approval: the crewmate is asking again.
- **The approval.**
  The captain's chrome click mints `delivery.mergeAuthorization` (version 1) in the card resolution's own transaction (`CardService.resolve`'s `alongside`): a fresh id and a generation, the card, lifecycle, offer, action and gesture ids, the GitHub repository, pull request and branch, squash, the approved head and an empty repair lineage.
  On a reviewed task that click also stores the approved head's change reading on the approval, so a later kept merge compares it without reading the branch.
  It is minted only on a GitHub direct-pr task for an offer with a baseline on the pull request the task still names.
  A first mate card, a seeded card, a plain Git host or an ambiguous baseline mints nothing: that click is one attempt, as before.
  Frames and agents cannot mint one - a settle effect runs only from the chrome.
- **Its words (INF-23).**
  The completion card's merge says what a click does, on an offer a click would approve (`approvableOffer`, `CrewSupervisor.mergeLabel`): Merge when checks pass while the task's checks are still running, Merge after fixing errors once they failed (the captain's words), and Merge the pull request again once they pass.
  `CardService.refreshSettleFacts` writes it with the fact strip whenever the task's record changes, so it follows each new reading.
  A click then keeps the approval waiting on the checks, and its feed line says what the merge waits for (`keptFeedLine`, by the task's last reading): the running checks, or a fix after failed ones.
  A fix brings a new version with fresh checks, so it comes back to the captain on a new completion card when it changed the work (a repair declared `changed-work`, under "Repairs" below); a fix that only brought the change up to date, or the same version passing on a rerun, merges on the kept approval once the checks pass.
  A card whose click approves nothing keeps its words, since a click there is refused and nothing waits.
- **The head it covers.**
  A merge under the approval runs with a `MergeGuard` (`PrCiService.merge`): only the candidate head (the approved head, or the newest accepted repair) on the pinned pull request.
  A pull request at any other head stops as `moved`, and nothing is sent.
- **Repairs.**
  The crewmate declares bringing the change up to date with `check_change conflictRepair` (`fromHead`, `toHead`, `newBase`, `impact`, `changedPaths`, `evidence`, `validation`).
  The host checks the closed facts with git: the repair starts from the candidate head, `toHead` is a commit here, `newBase` is in it and was not already in `fromHead`, and every path that differs between the ORIGINAL approved change and the repaired one is named, so drift across several repairs adds up.
  That same read stores the repaired head's change reading on the repair.
  `conflict-only` extends the lineage; `changed-work` invalidates the approval with a hold, and the crewmate puts up a new completion card; `unknown` holds the merge for an independent assessment (next).
  Whether the repaired change still does what was approved is the crewmate's judgment (the captain's guard = builder).
- **An undecided repair (FI3-663).**
  The guard = builder choice gives uncertainty "an independent bounded assessment", so a crewmate's `unknown` is its last word on that repair: the host checks the same lineage facts, keeps the paths both changes touch on the repair (`paths`), and refuses the crewmate's own later `conflict-only` for it (`changed-work` still ends the approval).
  Once the crewmate's turn is over, the kept merge's preflight asks the supervisor to assess it (`CrewSupervisor.assessRepair`), which commissions one assessment of that repair and records it on the repair before it starts, so a second read starts none.
  The assessment is a review-kind child of the builder with `kind_source: host:repair-assessment` (`isRepairAssessment`): delivery machinery like the independent review, retired with its builder, placed on another provider than the builder's when one can serve, and never counted as the task's code review.
  Its brief (`renderRepairAssessmentBrief`) names the approved head, the repair's heads, the newer base, every path either change touches and the crewmate's evidence, and asks for one read-only look answered with a first line, `impact: conflict-only|changed-work|unknown` (`parseRepairAssessment`).
  Its first report is its verdict, and the host closes it (`decideMergeRepair`): `conflict-only` adds the repair to the lineage and the kept merge runs again under every gate; anything else - `changed-work`, `unknown`, no impact line - invalidates the approval with a hold, writes one feed line, and steers the crewmate once (`repair-assessed`) to put up a new completion card, so the captain decides again.
  The bound is a fact the tick reads: an `evidence` wait is timed, and an assessment that could not start, stopped without reporting, or is still open an hour after it started (`ASSESSMENT_BOUND_MS`) ends the approval the same way.
  A verdict about a repair the approval no longer waits on - a newer repair, a newer approval, an ended one - records nothing.
- **The captain's newer words (FI3-662).**
  While the approval stands, every steer of the captain's on the task is guidance that holds its merge: his reply under a crewmate's card, his choice on one or his ask to explain it, a line he types in the task's Crewmate tab, and the first mate's steer in a turn that carries his words (`isCaptainGuidance`, read from who sent the steer and its typed kind, never from his words).
  His close of a card is not a choice and Continue is the host's own nudge, so neither holds anything, and neither does the first mate's steer on an operational wake.
  As the steer's row is recorded, `SettleService.holdForGuidance` gives it the approval's next mark (`guidance.latest`), with a timeline line and, when the hold begins, one feed line; the mark rides the message itself (`kept-merge-guidance`, `withGuidanceMark`), so the crewmate can declare only guidance it read.
  The crewmate declares the newest mark it read with `check_change captainGuidance` (`mark`, `impact`, `evidence`): `none` lifts the hold through that mark, and a later mark still holds; `changed-work` invalidates the approval with a hold, and the crewmate puts up a new completion card.
  A mark no message named is refused.
- **The gates.**
  A host-run attempt (`runMergeAuthorization`: every idle boundary, the tick's `kept-merges` rider when a timed wait comes due, and boot) first checks the task and pull request are still the approved ones, no new completion card is up, no round cap holds, no guidance of the captain's waits for its declaration, no repair is undecided, and a reviewed task's review passed for this change (the candidate head, or a stored change reading that matches the review's).
  That attempt does not read the branch to carry the review.
  The kept-merge line on a checks reading asks the crewmate to bring the branch up to date only when the merge waits on a conflict or a moved version.
  Then every page of the checks (`GitHubForge.checks`; a suite past the pages it reads keeps a pending item), and GitHub's own readiness for the pinned pull request (`GitHubForge.pull`): only `clean` merges, so a sign-in that could bypass a required review or another branch rule never does.
  The captain's own click keeps today's single attempt and reads readiness only to classify a refusal.
  Right before the last look, the guard's `held` reads the approval again, so guidance that arrives while the gates are read - or while his own click waits for the crewmate's turn to end - stops the merge as a `guidance` wait and the approval stands.
- **Waits.**
  A conflict, a moved head, checks, a review, GitHub's rules, GitHub not knowing yet, a draft, a sign-in, a hiccup, the captain's undeclared guidance or another refusal leaves the approval standing with `waiting` on that stop.
  A wait new for its head is a quiet timeline line, and one wake to the first mate where someone other than the crewmate the check watch wakes must move.
  Timed waits (`retryAt`, backing off to 30 minutes) are read again by the tick, never in a hot loop.
- **Restart safety.**
  Right before the merge request goes out the guard's `beforeDispatch` re-reads the approval (same id, generation and head, the crewmate idle, no new card) and persists an `attempt` token.
  Its answer clears it; a 200 merges only when GitHub says `merged`.
  A token that outlived its answer - a quit, a timeout - is read back by the pull request's number before anything is sent again: merged spends the approval and closes the task once, closed ends it, open at the same head runs every gate again.
- **Ends.**
  Consumed by the merge; revoked by an interruption (the captain's interrupt = revoke) or the captain's own words through `update_task withdraw_merge`; invalidated by changed work, a closed or swapped pull request, or a changed project, host or delivery; superseded by a new completion card or click; ended with its task.
  A revoked or work-changed end `holds` the task's merge for the captain: `autonomyRefusal` refuses a first mate merge whatever the project's autonomy, until his new click.
  Contract 4.66's unversioned `delivery.mergeOrder` names no approved head, so the boot retires it and says so rather than carrying it forward.

Not built: approvals on local-only and plain Git hosts or from first mate cards.
A first mate merge on project autonomy reads no guidance mark: the hold is the kept approval's own.

**Reviewer placement (Q5).**
`Router.decide` takes `avoidProvider` on a review task - the Pi provider the builder's newest `routing_decisions` row chose (`Router.servedProvider`) - and the ladder prefers another signed-in provider at the same tier, falling back to the builder's with the reason on the record when none can serve; it never descends a tier for it, and a pin still wins.
The decision is recorded with rule `R9` (`ruleIdSchema`), its reasons naming the tier row it rode on (`review -> high`, R2).

Observe's crewmate header renders the rigor beside the tier, a builder's review verdict with its risk, and on a review task the builder it reads (`docs/dev-observe.md`); the dispatch corpus carries `rigor`, `review_of`, `review_verdict` and `review_risk` on every task join, null where the record carries none (`docs/dispatch-extractor.md`); a pre-phase-2 database exports exactly as before.
`tests/e2e/rigor-reviewed.spec.ts` drives the review cap end to end (a third findings, the cap card, the refused re-review, the answer, the reopened pass) and `tests/e2e/rigor-standard.spec.ts` the card boundary (the four-heading completion outline, its corrective refusal and publication under the host's own buttons); `crewSupervisor.test.ts` covers both caps and the reset, `prCi.test.ts` the round counting, `routingEngine.test.ts` and `router.test.ts` the placement, `db.test.ts` migration 36 and `rigor.test.ts` the derivation.

## Numbers (phase 4)

The rigor system is countable from records the app already writes, in the one home the routing numbers already have: `scoreRigor` in `scripts/interaction-metrics.ts`, beside `scoreRouting`.
Both the replay gate (`docs/replay-harness.md`) and the offline corpus export (`docs/corpus-export.md`, manifest `rigor`) call it, so the two can never disagree about what a review round or a cap hit is.
Nothing new is written for it: the numbers come off the work shape, the delivery facts, the `review` and `cap_reset` timeline events, and the completion cards themselves.

An ANSWER task is out of every denominator here (Task B): a task that ships nothing cannot carry the evidence contract, spend a CI round or hit a cap, so counting it would dilute every share with work the tiers were never about.
Its own share is reported instead, as an observational row nobody grades.

Two row types feed it.
`ObservedDispatch` gains the rigor facts - `rigor` (quick where a shaped row predates the tiers, the same reading the C5 join takes), the delivery posture, whether a PR is on record, `ciRounds`, the holds the caps placed, and whether the change's REPORT carried the five headings.
A review task is shaped too and carries no rigor at all: it read a change rather than shipping one, so it stays out of the mix.
`ObservedReview` is one row per verdict a reviewer returned, read off the builder's own `review` events; its findings are counted from the reviewer's report by the action each line asks for.

| Metric | Direction | What it counts |
|---|---|---|
| `deliverable_share_answer` | either | the share of shaped dispatches whose deliverable is an answer rather than a change |
| `rigor_share_quick` / `rigor_share_standard` / `rigor_share_reviewed` | either | the tier mix over every shaped dispatch that shipped a change |
| `evidence_headings_share` | up | standard-or-above changes that settled with a completion card and whose report carried Intent / What changed / Verified / Risk / Not done, in order |
| `review_rounds_per_change` | down | verdicts returned, per change a reviewer read |
| `findings_auto_fix_per_change` / `findings_ask_user_per_change` / `findings_no_op_per_change` | either | findings by the action each asks for, per reviewed change |
| `findings_ask_user_rate` | either | the share of findings that went to the captain rather than the builder |
| `review_verdict_share_pass` / `_findings` / `_blocked` | either | the verdict mix |
| `ci_rounds_per_change` | down | unsuccessful own repairs (legacy records: distinct red heads), per direct-pr change that opened a PR |
| `rigor_cap_hits` | down | round caps the host placed: each cap standing now, plus each `cap_reset` |

Three rules keep them honest, and they are the same rules the routing rows follow.
A distribution has **no good direction**, so those rows are `direction: "either"` - written to the baseline, printed in the report, graded by nobody; only the evidence share, the two round counts and the cap hits are graded.
Every denominator is the population that could answer its question: a fleet that reviewed nothing has no review numbers at all (`n/a`), not a clean zero, and a change whose tier asks for no evidence is not a card that failed the contract.
And **unknown is never zero**: a review whose report the record no longer holds - a review task keeps only its latest, so only the newest verdict can be credited with findings - contributes no findings rather than zero findings.

The evidence share follows the contract to where it is required.
Until contract v3.6 it read the completion card's body through `bodyHeadings`, because that is what the lint refused on; now the headings are the report's, so it reads them with `reportEvidenceHeadings` (`src/shared/rigor.ts`) - a report is plain text, so a heading is a LINE that is the heading and nothing else, however the crewmate marked it up.
`missingEvidenceHeading` is still the one order check, so the metric can never grade a change by a rule nothing asked for.
A change that never settled with a completion card is `null`, not a failure: it did not ship.

Observe is the one surface in the app where any of this renders: the crewmate header carries the rigor, the review verdict and its risk, and the reviewers sit in their own **Review** group with each row's verdict on it (`docs/dev-observe.md`).

For a saved story on GitHub or GitLab, a host-accepted conflict-only repair republishes the same content at its new head after checks pass, before the kept-approval merge.
It reuses confirmed attachments and the approved content hash; a separate story edit needs a new completion offer.
The merge validates the published and PR heads without waking the work computer or inspecting its uncommitted files.

## Notes moved from AGENTS.md

Moved verbatim from `AGENTS.md` on 2026-09-24; `AGENTS.md` keeps a one-line pointer to each.
The CI-counting lines below match the current ledger (`observeCheckRepair`, `CI_ROUND_CAP` of 3); a round per red head, and a fourth red as the blocker, are not the rule.

- Delivery direct-pr (captain rule): a crewmate that opens a PR must babysit CI (`check_change`, through the app's own sign-in) until every check on the head SHA is green before the final report; the local evidence is the standard tier's (the Standing CI rule in `docs/testing.md`), not the full suite; the first mate must not present any land/merge/accept decision while CI is red or running.
- Delivery rigor (captain-approved tiers, 2026-09-19; `docs/delivery-rigor.md` is the one home): three tiers - quick, standard, reviewed - and PHASE 1 is instruction only.
  Standard is EVERY repository's default (captain ruling 2026-09-19; a task with no gate to land through takes no tier at all), stated in the crewmate prompt (`buildCrewmateSystemPrompt`, every backend) when care is standard, reviewed, or unknown, and in the first mate's rigor rule, which relays the user's words on care as `rigor_ask`.
  A known quick task is served the quick sentence and, when delivery is a pull request, the check diagnosis.
  A task with no gate is not served the direct-pr passage.
  A crewmate's session carries the working copy's AGENTS.md (or its CLAUDE.md where it has none) and lists its project skills on every backend (`src/core/session/projectResources.ts`), and the prompt sends it FIRST to the instructions its session does not carry (CONTRIBUTING.md, a CLAUDE.md beside the AGENTS.md, and any file they point to), AGENTS.md, CLAUDE.md and CONTRIBUTING.md in that order of authority.
  At standard it rebases, reads its diff against the user's words, updates stale docs, validates the change itself evidence-first (the ported no-mistakes evidence instructions: demonstrate the intent end-to-end as an end user would experience it; evidence for each concrete thing an end user would do, as many product-level artifacts as it takes, and unit tests, pass/fail output or reading the code are not evidence on their own; the smallest set of existing tests that would catch a break in what an end user experiences, end-to-end tests over the changed surfaces included and re-run after an overlapping rebase, a relevant test that cannot run named rather than dropped, a test written or improved under the default rule on tests when none produces evidence, and recorded manual checks when automated testing cannot), and reports and writes its PR body under five headings in order - Intent, What changed, Verified, Risk, Not done; only an unsuccessful declared own repair adds a CI round (`observeCheckRepair`), the third stamps `ciCapAt` (`CI_ROUND_CAP` is 3), and that cap is a blocker report with no completion card, which the first mate turns into one decision card.
  `tests/e2e/rigor-standard.spec.ts` is the binding test for the standard tier.
- The reviewed tier (delivery rigor phase 2; `docs/delivery-rigor.md` "The reviewed sequence"): the HOST derives the rigor at the single brief mint (`rigorFor` in `src/shared/rigor.ts`, revised by the captain 2026-09-19 - the captain's `rigor_ask`, then the repository's own `repos.rigor` column, then STANDARD, full stop; neither the intelligence tier nor an escalation moves it - rejecting a result routes a stronger model, never more ceremony; a task with no gate to land through - one whose deliverable is an ANSWER, a review task, or one on the personal workspace - takes NO tier at all (`RigorInput.gated`), and reviewed on a local-only posture ships standard because reviewed ships a PR), stamps it on `WorkShape.rigor` (quiet, like the kind) and appends `renderRigorSection` after the classifier ran; a pre-phase-2 row and a recorded replay spawn read as `quick`.
  `spawn_crewmate review_of` (tool count stays 24) commissions the reviewer: host-briefed (`renderReviewBrief`, read-only by instruction), shape `kind: review` / `kind_source: host:review` (never classifiable, routed like research), titled `Review: <builder>`, its PARENT the builder itself - the one stored review-to-builder join since the `review_of` shape-field fold (captain-approved 2026-09-19; `review_of` survives only as the spawn ask) - and a `blocks` edge reviewer -> builder IS the merge hold - refused as text on an unreported builder, a branch with no commits, a non-reviewed task, or a review already open.
  A `host:*` kind_source makes the row DELIVERY MACHINERY (`TaskService.isDeliveryChild`): it never counts in the children-open close gate (so a builder settle shows one refusal, in review vocabulary, and `proceed_with_open` never speaks for it), its parent is fixed (`setParent` refuses), and EVERY builder close - discard, drop, supersede, merge, failed turn - retires its live review with it (`SettleService.retireDeliveryChildren`: closed dropped/superseded, silent, runtime aborted, worktree gone), so a reviewer never outlives its builder.
  The review runs BEFORE the pull request (the no-mistakes ordering, captain-approved 2026-09-19): the reviewer reads the builder's branch at its head (worktrees share refs; `WorkspaceService.branchHead`), fix rounds land as local commits, and the push, PR and CI come after the pass - a builder with a pull request already on record is still reviewed at its committed branch head, not that pull request's recorded head.
  A reviewed task's events and a review task's bypass the whose-turn sort and go straight to the first mate.
  The host reads the reviewer's first line `verdict: pass|findings|blocked`, its finding lines (`parseReviewFindings`: one per line, severity + action) and its last `risk:` line (`parseReviewReport`).
  A report with NO verdict line records nothing and spends no round - a reviewer's acknowledgment is not a verdict (the phantom rounds of 2026-09-19), and the merge stays held regardless; a stated findings verdict whose findings are all info/no-op derives a PASS, because info never blocks (the no-mistakes rule; blocking = error/warning severity or an ask-user action, `findingsBlock`).
  Findings/blocked leave the reviewer idle and steerable, a pass records verdict, head and risk on the BUILDER's delivery facts as a feed-worthy `review` event, closes the review task silently (done/finished) and wakes the first mate with the builder as ref.
  Risk never holds (Q4); a completion card with a merge effect before the pass is refused; `settleFacts`, `crewStatus` and the context crew lines carry `rigor` and the review state.
  The first mate routes findings by instruction only (contract v3.5): auto-fix findings are relayed verbatim and fixed by the ported fixer preamble (double-check legitimacy, smallest root-cause fix, never revert intent), ask-user findings are ONE decision card per round, declined findings ride re-review steers as `user_chose_to_ignore` and are never re-reported, and a reviewer is steered only to re-review at a named new head - never to stand by; since FI3-566 the preamble is in the builder's reviewed brief and the other steps ride the review wakes ("The reviewed sequence").
  `tests/e2e/rigor-reviewed.spec.ts` is the binding test.
- The tier as a record, with host holds (delivery rigor phase 3; `docs/delivery-rigor.md` "The record and its holds"): a repository's standing rigor is `repos.rigor` (migration 36; null = derive), set by talking through `app_change project-settings` with `changes.rigor` of `quick`, `standard`, `reviewed`, or `default` (`configure_repo` is retired) or Settings → Projects - the `project settings` feed line names the care only when set.
  The round caps are RECORDS on the builder's delivery facts: `observeCheckRepair` counts one CI round only for an unsuccessful declared own repair (`ciRounds`; a passing repair spends nothing, and a legacy uncapped red-head count is archived rather than charged; a crewmate's `check_change` and the host's watch write the same ledger), stamps `ciCapAt` once at `CI_ROUND_CAP` (3) and tells `CrewSupervisor.holdForCiCap` through the `onCap` seam - ONE `[fm-op]`, and `pendingCiGate` refuses the completion card while the cap holds, even on a green reading, before any gh call; every stated `findings` verdict at a head not yet counted is a `reviewRounds` round (`reviewRoundSha` is the last counted head - a repeat at the same head records the verdict and spends nothing) and the third is one past `REVIEW_ROUND_CAP` (2): that findings wake carries the cap (never a second wake), `reviewCapAt` holds, and a steer to the review task is refused as text naming the door.
  The answer is the captain's resolution of a first mate card on the task since the cap (`capAnsweredAt`; a dismissal is not one) followed by a first mate or captain steer to the task, which clears both counters and both caps together in one `cap_reset` timeline event; a first mate steer before the answer reopens nothing.
  The evidence contract was linted at the crewmate card boundary (`lintCrewmateCard` with the task's rigor) until contract v3.6 removed that rule and the rigor option with it (captain lock 3: the card was the third copy of a record the report and the PR body already carried); the five headings stay REQUIRED in the report and the PR body, and the task's holds (the personal workspace, an unpassed review, a standing CI cap) still speak before the shape rules.
  Reviewer placement (Q5): `Router.decide` takes `avoidProvider` on a review task - the builder's provider off its newest `routing_decisions` row (`Router.servedProvider`) - prefers another signed-in provider at the same tier, falls back with the reason recorded, never descends a tier, and records rule `R9`; the replay scorer keys on `kind_source`, so the new rule id needs no tolerance there.
  Observe's crewmate header renders rigor, review verdict/risk and the reviewed builder; the C5 join carries `review_of`/`review_verdict`/`review_risk`, null on a pre-phase-2 database.
  Contract v3.4 names the cap wake as the same decision card as a crewmate's own three-round blocker and the steer after the answer as what reopens the rounds; v3.5 is the no-mistakes alignment above; `PROTOCOL_VERSION` 1.15.0 since contract v3.8 (the `read-only` constraint in the intent vocabulary and `deliverable` on the task detail, over v3.7's `RepoView.kind`, narrowed delivery enum and `TaskDelivery.mode: in-place`).
  `tests/e2e/rigor-reviewed.spec.ts` (the review cap) and `tests/e2e/rigor-standard.spec.ts` (the card boundary: since v3.6 a drawn body publishing under the host's own buttons) are the binding tests.
- The rigor numbers (delivery rigor phase 4, the last; `docs/delivery-rigor.md` "Numbers"): `scoreRigor` in `scripts/interaction-metrics.ts` is their ONE home, beside `scoreRouting`, so the replay gate and `manifest.rigor` in the corpus export cannot disagree - fourteen rows over `ObservedDispatch` (which gains the rigor, the posture, the PR, `ciRounds`, the cap holds and whether the change's REPORT carried the five headings - the card's body since contract v3.6 no longer carries them, so `reportEvidenceHeadings` is what the share reads) and `ObservedReview`, one row per verdict read off the builder's `review` timeline events (a review task carries no rigor at all: it read a change rather than shipping one).
  Since Task B the row also carries the `deliverable`, and an ANSWER task is out of every rigor denominator - it ships nothing, so it can carry no evidence contract, spend no CI round and hit no cap - reported instead by its own observational share `deliverable_share_answer`.
  Nothing new is written for it.
  Three rules the rows keep: a distribution is `direction: "either"` and graded by nobody (only the evidence share, the two round counts and the cap hits are graded); a denominator is the population that could answer its question, so a fleet that reviewed nothing scores `n/a`, never a clean zero; and a review task keeps only its latest report, so only its newest verdict can be credited with findings - an earlier round's are unknown, not zero.
  `missingEvidenceHeading` (`src/shared/rigor.ts`) is the one order check, over `reportEvidenceHeadings` for a report and `bodyHeadings` (`src/shared/cardHeadings.ts`) for a body, so nothing grades a change by a rule nobody asked for.
  The committed replay fixtures predate rigor: all-quick, zero reviews.
  Observe gains a fifth group, **Review**, listing review tasks with their verdicts (the verdict lives on the builder, read only while it still names that review task).
