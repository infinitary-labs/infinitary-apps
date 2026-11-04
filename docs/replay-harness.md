# Replay harness and the interaction eval gate

Interaction-system program P3 (WI-19, WI-21; plan `fm3000-interaction-sys-improve-s1/implementation-plan.md` sections 3 and 4).
No prompt, lint, or report-sort change ships without a replayed eval: the harness replays recorded captain sessions against the current code and scores them.
`verify.yml` runs that gate on its mac lane inside every alpha, and on demand (`workflow_call` and `workflow_dispatch` only); it has no pull-request trigger, so a pull request is not failed by CI for a replay regression.
A pull request that touches the prompt, card lint, the whose-turn sort, routing, the first mate agent, or `src/renderer/src/cards/` runs `pnpm replay:gate` before pushing, locally or, in CI mode, through `replay.yml` ("The gate").

## What it replays

`scripts/replay-captain-session.ts` is the CLI; `scripts/replay/engine.ts` does the work.
For each session it builds an in-memory app from the app's own migrations and runs the real host:

- **FirstmateAgent** - context block, `emit_card` lint and ownership rules, ask capture, the inbox drain.
- **CrewSupervisor** - the whose-turn sort (`docs/report-sort.md`), wake routing, report plausibility, closes, boot fleet hygiene, the 60 s tick on recorded time.

Only the models are recorded.
The first mate's recording is whichever seat served it: every session file under `firstmate/sessions/` (Pi) and `firstmate/claude/` (the Claude seat's copy of its client's transcript, with the served sidecar beside it) is read through the one session reader (`src/core/storage/sessionReader.ts`, `docs/dispatch-extractor.md` "One reader, either seat"), which hands a Claude-served session over in the Pi dialect, so it replays through the same turns, wakes and scores as a Pi one - there is no exclusion line (W1 S11).
A first mate turn plays back the tool calls the orchestrator made, and each call runs through the current tool layer.
The reads and outside-world tools answer from the recording: `consult`, `crew_status`, `supervision_log`, `locate_project`, the schedule tools, and the action catalog's `app_state` and `app_change` - the replay binds no app dispatcher - along with the retired tools (`check_pr_ci`, `setup_repo`, `configure_repo`, `unregister_repo`) that a recording from before the catalog still names.
Escalation precision counts an `app_change` as the first mate acting only when its recorded answer is the applied action and its value; a refusal or a Settings handover, which `app_change` answers in words, is no action, and the replay does not show the handover's card again.
The replay binds no preferences writer, plugin installer or knowledge store either, so `personalize`, `install_plugin`, `knowledge` and `record_knowledge` answer from the recording too, and the replay does not raise the consent card an `install_plugin` asked the captain on.
It reaches no integration either, so `integrations` and `use_integration` answer from the recording too.
A recorded `create_task program` files and starts its program through the real host, but its script never runs: the replay's program process takes the script and answers nothing, since its parts would be crewmates the recording holds no turns for (`unplayedProgram`), and `details.programs` lists each program the replay filed.
The captain's labels run against the replayed host: `flag_missed_escalation` against its supervision record, and `flag_duplicate` against its own cards, so a duplicate the captain flagged counts in `duplicate_card_pairs` as it did that night.
A recorded call to any tool the first mate holds today is answered one of these ways, never listed under `missing_tools`.
So a new first mate tool is either bound live, through the `FirstmateAgent` option it needs in the seat options `Replay.wire` passes, or listed in `RECORDED_ANSWER_TOOLS` (`scripts/replay/engine.ts`); `tests/replay-captain-session.test.ts` replays a call to each of `FIRSTMATE_TOOLS` and fails on one in neither.
A new tool that changes something the captain asked for also gets a `RECORDED_ACTION` entry, or the answer-delivery row ("Metrics") reads a turn that used it as no action.
The dispatch extractor keeps its own class sets for the same tools (`docs/dispatch-extractor.md`, "Tests").
A crewmate turn plays back its recorded session through the crewmate's card, report, progress, and follow-up hooks; a Claude crewmate's copy under `crewmates/<task>/sessions/` is read through the same one reader, so it plays as a Pi crewmate holding the same turns (the session contract's step 6).
Each input the host serves a crewmate plays the recorded turn that answered it ("Crewmate turns" below).
A recorded `emit_card` call is from before cards/tasks/agents P1, so its actions carry reserved ids and no effects: the engine translates them with the same `migrateLegacyActions` that migration 29 ran over the captain's open cards (`merge-pr`/`land` become `settle merge`, `discard` a danger `settle discard`, `keep`/`later` drop), so a recorded card does under the current host what its button said.
A recorded `keeps_open` action, retired at contract 4.65, loses only its flag and stays the effect-free reply it is today: it was one of the card's 2 or 3 actions when it was recorded, so dropping it would leave a decision with a lone action, which the card lint refuses.
A recorded click on one would close its card where the old button kept the card open; no committed recording has one.
A lookalike id (`merge-pr55`) translates to nothing and stays the fake button it was - which is what `fake_merge_buttons` counts.
A recorded `spawn_crewmate` is from before contract v2.8, so it carries a judged `difficulty` and a `model_id`: the engine translates those the same way (`legacyShapeFromDifficulty`, which a queued row written before `tasks.shape_json` also reads), so `difficulty: premium` becomes `premium_ask` and `model_id` becomes `override_model_id`, while a judged low/medium/high drops - the work-shape policy reads no judgment, and an unclassified spawn routes high (R8).
The same translation carries `rigor_ask: quick` (delivery rigor phase 2): a recorded session predates the rigor, no reviewer ran and the crewmate was told no procedure, so its spawns replay as the quick work they were - the live host would otherwise derive `reviewed` for a high-tier direct-pr spawn and route its reports past the whose-turn sort.
Since contract v4.12 (primitives P7) the translated facts and any recorded wait are grouped as today's tool takes them, under `shape` and `start_after`, by the same `groupSpawnArgs` the live tool reads a flat call with; a grouped recording passes through as it is (`recordedShape`).
A recorded `reply`, or a recorded revision's reply, is from before a line named the captain message it answers, when its author's line answered the newest one on the card it waited on: the engine names that message (`recordedAnswer`), since today's host ends a question only on a line naming it; an explicitly recorded `answers_message` passes through, and a recorded interim line names none.
A recorded `steer_crewmate` without `response_mode` replays as `guidance-only`: the archived model was never asked to submit a correlated response, so a new default expectation would manufacture missing-answer wakes the recording cannot answer.
An explicitly recorded response mode passes through unchanged; the replay never guesses a response from an ordinary recorded report.

Task rows that existed before the recording starts are seeded through the one writer.
The tables hold each row as it stood at export, so a row keeps its recorded start policy and work shape - an on-request row does not start on the replay's first sweep, and a builder planned behind a plan keeps its `basis` - and a row whose own `started_at` falls after the replay begins is seeded as the open work it still was then.
A seeded row is never one of the replay's dispatches.
A row created inside the window by a crewmate the replay holds no recording of is never seeded, so its own recorded crewmate, when it has one, is commissioned at its first turn, as a crewmate no recorded spawn names is.
A Claude crewmate's own queued notice - one of its background commands finishing, which the client marks `commandMode: task-notification` and the session reader keeps on the message - plays as the running turn, because nobody served it and nothing would ever prompt a turn that started there; a steer the host queued is still a new input.

Since S7c there is no recorded triage to play: a report earns what the whose-turn rule says about live state, so the recording's own verdicts are history rather than an input.
The rule reads the job registry, which the replay reconstructs from the recording itself - a crewmate session shows a job's whole life, the bash result that hands the id back (`Still running as background job <id>`) and the `[job] background job <id> finished` message its exit arrives as - so branch 3 ("provably still moving") is reachable and the wake count is a number rather than an upper bound.
An escalation is scored from the `captain` verdict the rule recorded, not from wording, and a report wake matches its recorded op turn through one ref alias: before S7c the same moment reached the first mate wearing the retired session's `fleet event escalated to you (task X)` prefix, so `reported:X` also matches `escalated:X`.

Nothing reaches a provider, the network, or a real repository, so what the replay measures is exactly what a host change does to the same recorded decisions:

- A card the lint now refuses is not shown.
- A wake the host no longer raises is never answered.
- A steer the claim no longer refuses lands.

A prompt edit cannot change a recorded model's output offline.
The report stamps the SHA of every system prompt it replayed against, so a prompt PR's report ties its evidence to the prompt it changed.
The PR still needs its behavioral claim proven on a session recorded with the new prompt.
The `scripts/evals/premiseMismatch.ts` evaluation exercises INF-1266's untrue goal against the pre-PR #497 workflow and chooser, kept as inert text fixtures under `tests/fixtures/premise-mismatch/`.
Run it through `scripts/evals/account-eval.ts --module scripts/evals/premiseMismatch.ts` with explicit account/model fields and an output folder outside the working copy; preparation writes the no-cost run sheet, and live use requires the captain's consent to that exact sheet.
It serves the production builder preset and real card tools, adds only two closed-path file tools, and never runs a workflow, phone code, shell command or merge.
The tools permit the historical budget reversal rather than enforcing the desired answer, and `responses.json` retains the actual before/after files in `state.fixtureFiles` beside the tool transcript.
Review the changed files and published question together: the requested touched-parts work may proceed, but the pull request budget must stay unchanged until the captain answers a specific question about the mismatch and any reversal of their earlier choice.
The deterministic boundary test proves isolation and observation, not that a live model follows the instruction.

### Matching recorded answers to current wakes

The current code raises its own wakes, and the recording answered the old ones.
A wake is matched to the first unconsumed recorded answer, at most 10 minutes ahead in recorded time.
Three tiers apply in order:

1. The same normalized text.
   Replay ids become recorded ids, and crewmate numbers and task keys are neutralized.
2. One text is a prefix of the other, as when the host appends a hint.
3. The same kind of wake about the same task (`wakeRef`).

Tiers 1 and 2 read the served text on both sides.
The host's wakes carry typed facts rendered once where they are served (`docs/inbox.md`, "The wake envelope"), and the served text is that rendering, byte for byte; the recorded side is text and stays text.
Tier 3 reads a LIVE wake by its facts (phase 6 of the primitives plan, with the one decision ledger): the engine joins each served wake to the row it was rendered from, and `factsWakeRef` names its kind and task in the recorded half's vocabulary - a kind the recordings never named has no ref and matches by its text alone.
The same facts decide whether a live wake is an escalation (the whose-turn rule's `captain` sort of that wake, by the wake's identity), a wake after a cancel, or a guidance-queued wake; a prose wake is still read by its words.
Moving the live half onto facts moved no number in the baseline.
An answer-close receipt matches by its structured recorded task and choice ids, so adding its direct task-read instruction does not strand the recorded approval turn.

A wake with no recorded answer is played as silence and counted under `fidelity.unrecorded_firstmate_wakes` rather than invented - and, when it was an escalation, it stays out of `escalation_precision`'s denominator: whether the first mate would have acted is unknown, not a failure.
It still counts in `escalations`.
A recorded "being triaged by fleet supervision" refusal is history now (S7c retired the claim that spoke it), but `lock_refusals` still counts that wording wherever it appears, so its return would show up as refusals again (`tests/replay-gate-catches-lock-refusal.test.ts`).

A first mate card's effect-free closing choice is now served as the captain's own words, not an operational wake; the replay matches historical operational choice answers by the old choice ref and new recordings by their captain choice turn, without replaying the latter twice.
A real click is served alone with its card/task context; script-fired actions stay operational.
A recorded card resolution (a dismissal or a choice; a recorded Later from before cards/tasks/agents P0 is applied as an undeclared choice, which retires the card and steers nobody) is applied to the replay's card with the same id or title.
When the replay never showed that card - the current lint refused it, or it was emitted before the window - there is nothing to resolve, and the resolution is skipped and counted under `fidelity.skipped_card_resolutions`.
A card its own emitter withdrew with `close_card` is not a resolution to apply: the withdrawal is the emitter's output, and it plays when the emitter's recorded call does.
The host stores the call's reason as the row's `chosen_action` (`closed` when none was given), so the engine tells a reason from an action id by the recorded call itself - a `close_card` on that card id with that reason whose recorded answer closed the card (FI3-287).
Such a row is never an input and never a skip; its title is listed under `details.withdrawn_cards`.
A settled task's card retirement is likewise host output, not a captain choice (FI3-989): `retireTaskCards` stores the close reason in `chosen_action`.
The engine joins the card to its own recorded task, which must be `done` or `dropped` with the same `closed_reason` and a `closed_at` no earlier than the card's creation and no later than its resolution.
A reason that is also a declared action id remains a possible captain choice; missing or conflicting closure facts also stay on the ordinary admission path.
A proven retirement is never an input or a skip, even when the replay never showed the card; its title is listed separately under `details.retired_cards`.
The replay does not force a retirement onto its live cards: the current host retires them when its own settlement runs.
Since the fable review (Q4a) a dismissal is a feed line and a line in the first mate's next context block, never a wake, so a skipped dismissal changes no wake count.
Since FI3-435 the dismissal of a crewmate's own card is also a steer to that crewmate (`card-closed`); a recording from before it holds no answer to that steer, so the replay plays it as a silent turn counted under `fidelity.unrecorded_crewmate_turns` and never spends the crewmate's next recorded turn on it (`unrecordedClose`).
A recording whose next turn answers a close plays that turn.

A captain's reply in a card's thread (`docs/card-threads.md`) is an input too (FI3-429).
The tables carry each thread as `card_messages`, and every captain line is delivered through the host's own reply path (`CrewSupervisor.replyToCard`) on the replay's card with the same id or title, so the current host decides where it goes:

- On a crewmate's card it is the thread steer to that crewmate, and the crewmate's recorded answer plays as its next turn: a revision under the same id, a `reply` in the thread, and its report.
- On the first mate's own card it is the captain turn about that card.
  The recording holds that turn as plain words, so the reply is paired with the recorded captain turn of the same words within 10 minutes and plays it once, with the card as its about line, rather than as a second converse.

The author's answer and the host's `revised:` line are what the replay produces, so only the captain's lines are inputs.
A reply under a card the replay never showed, or one the host refuses, is never forced through and counts under `fidelity.skipped_thread_replies`.
Its recorded answer then does not play, and is listed under `details.unplayed_crewmate_turns` as `reply-not-delivered`.

### Captain turn order

A captain message can reach the replay session after its prompt finishes reading queued steers, while the first mate is still closing the wake drain (FI3-1016).
The session refuses a steer when its prompt has stopped reading, leaving the captain's durable inbox row pending instead of accepting it into a closed queue.
It also returns and clears any unread queued steers through `takeUndeliveredSteers`, as a live session does.
The first mate's existing redelivery path then drains them immediately, before the replay advances to the next recorded input.
A late message never waits for the next captain message, including when it is the recording's last message.
`details.captain_turn_order` lists the captain turns in actual playback order, each with its recorded timestamp and words; the fidelity count alone cannot reveal a swap.
This includes recorded captain choices and thread replies that the current host delivers, but never forces through a refused input.
`tests/replay-captain-session.test.ts` checks the sep14 reconstruction's complete order and a window ending after a captain message arrives during a wake drain.

### Crewmate turns

Each input the host serves a crewmate plays the recorded turn that answered it (FI3-442).
That is the turn not yet played whose recorded input holds the same words, within ten minutes of when the recording shows it, as a wake is matched to its recorded answer.
A steer reaches the replay as its first mate turn begins, a moment before the crewmate's recording shows it, so its own turn plays, and the turns before it whose moment has gone by are passed over: they waited on inputs the current host never served.
A steer that reaches the replay later than recorded still plays the turn that answered it.
Words the recording holds no answer to from there - a steer the recording refused that lands today, or an input whose turn has already played - play a silent turn counted under `fidelity.unrecorded_crewmate_turns`, never the crewmate's recorded answer to something else, as a close the recording never saw does.
Any other input - a brief, a choice in today's words, a thread reply - plays the next recorded turn.
A job notice the host batched behind another input, a blank line between, is served on its own, as the current host serves it.

`fidelity.played_crewmate_turns` counts the recorded crewmate turns the replay played, and `details.unplayed_crewmate_turns` lists each one it never played, by crewmate and turn, with why its input never reached it:

- `spawn-not-played`: the first mate turn whose spawn started the crewmate never played, because it answered a wake the current host does not raise.
- `not-started`: the replay never started the crewmate for another reason, such as a planned row left on request.
- `card-not-shown`: the turn answered the captain's choice on a card the replay never showed, because today's lint refuses it.
- `reply-not-delivered`: the turn answered a captain's thread reply under a card the replay never showed, or one the host refused.
- `steer-not-played`: the turn answered a first mate steer whose recorded turn never played.
- `steer-not-received`: the steer's first mate turn played, but its words never reached the crewmate within ten minutes of the recorded moment.
- `unserved`: none of these, an input the replay never served with no named cause.

Each named reason is a current-host divergence the replay keeps on purpose: a wake the host no longer raises is never answered, a card the lint refuses is not shown, and a recorded input is never forced through.
The CLI summary counts them by reason beside the crewmate turns.
On `sep14-real` the replay plays 140 of the 164 recorded crewmate turns.
The other 24 are 15 `spawn-not-played` (crewmate 48d9179a, commissioned in answer to the retired supervision session's escalation of ba13eadd), 5 `card-not-shown` (plan decisions recorded with no default action) and 4 `steer-not-played`.
`tests/replay-captain-session.test.ts` pins them, and every other committed recording plays each of its crewmate turns.

Recorded time drives `Date.now` during a run and advances in real time between events, never backwards.
Dedupe windows, dismiss-within-60 s, and CI freshness behave as they did that night.

## Metrics

`scripts/interaction-metrics.ts` is the one definition of every number.
Its observational `unplanned_change_share` counts declared direct changes among all recorded changes (historical rows predate the declaration, so this is a declared share, not a reconstruction of their choices), and `late_decisions_per_unplanned_change` counts ask-user review findings per declared direct change with a readable review; a lost review is not a clean zero.
The host does not grade the declaration.
The replay harness and the duplicate-candidate deriver (`docs/duplicate-deriver.md`) both import it.
It carries:

- **The section-4 table.**
  Answered-in-turn, default actions, re-asks, quick dismissals, duplicate pairs, operational wakes per captain turn, escalation precision, lock refusals, closed rows with worktrees, closed without evidence (structurally zero since WI-11 retired the `delivered` status that a bad close could reach without proof), visual share, mean body length.
  Since the wake diet (P3, WI-13) `op_wakes_per_captain_turn` counts operational drain TURNS, not payloads - the report's "turns on operations" - so a drain that hears several wakes together is one wake; a captain turn that carries pending wakes is not an op wake, but an escalation it carried is still counted (`countCarriedWakes`), scored `handled` from that captain turn's play.
- **The answer-delivery row** (`asks_without_action`, observational): the captain messages no action took effect after, read off each recorded turn's own tool answers (`RECORDED_ACTION` in the engine; a lookup and closing words are no action, a refused card voids a later reaction).
  It reads the recording and not the replay's re-run tools, so a host change cannot hide a message that went unanswered that night.
  The replayed agent is wired with `answerDelivery: "observe"`, which judges nothing, so no retry or notice changes a recorded turn.
  The committed fixtures read 3 on `sep14` (a start refused because its branch existed, and two steers refused under the old triage claim), 1 on `sep26-claude` ("How is the crew doing?", answered with a lookup and closing words) and 0 elsewhere; the baseline carries it and the gate never grades it.
- **The frustration-mode counters** from report.md section 2.2: escalations, wakes after a cancel, guidance-queued wakes, fake merge buttons, garbled reports, spawn start failures.
- **The routing rows** (intelligence-bucket routing S5): the tier distribution (`tier_share_premium|high|medium|low`), the classifier source share (`kind_classified_share`, `kind_abstained_share`, `kind_failed_share`, `kind_skipped_share` - the four `KIND_SOURCE` stamps the spawn path writes), the downgrade rate (`tier_downgrade_rate`: dispatches the ladder served below the slot the policy asked for, from `routing_decisions.served`) and `escalations_per_lineage`.
  They are scored by `scoreRouting` from `ObservedDispatch` rows - the task's shape, its tier, its served tier and the attempt it replaces - so the replay and the corpus export (`docs/corpus-export.md`, manifest `routing`) read them the same way.
  A replay has no live catalog to route against, so its downgrade rate is `n/a`, never a clean zero.
- **The rigor rows** (delivery rigor phase 4): the deliverable mix (`deliverable_share_answer`, Task B of the crew-posture rationalization - an answer task ships nothing, so it is out of every other row's denominator), the tier mix (`rigor_share_quick|standard|reviewed`), the evidence share (`evidence_headings_share`), the review rounds and findings per reviewed change, the ask-user rate, the verdict mix, `ci_rounds_per_change`, `rigor_cap_hits` and `hold_overrides`.
  They are scored by `scoreRigor` from the same `ObservedDispatch` rows plus `ObservedReview` - one row per verdict, read off the builders' `review` timeline events - so the replay and the corpus export (`docs/corpus-export.md`, manifest `rigor`) read them the same way.
  `docs/delivery-rigor.md` "Numbers" is the one home of what each counts.
  The committed fixtures predate rigor and the deliverable axis: they score all-quick, all-change, with zero reviews, so every review row is `n/a` there and the graded ones are ungraded until a session with a reviewed change is recorded.
- **The handoff row** (FI3-391): `approval_handoff_share`, scored on hand-labelled captain choices.
  See "The plan-to-build handoff" below.
- **The copy row** (roadmap 1.5, the plain-language pass): `plain_language_share`, the hand-scored sample.
  `tests/fixtures/plain-language/labels.jsonl` carries one row per recorded card that someone has READ against the design skill's vocabulary (`copy/Vocabulary.prompt.md`) - `plain: true` when every sentence would still be understood without its technical names, `false` when one leans on a never-say word - keyed by `cardLabelKey` (sha256 of title and body, truncated to 12) so a label can never drift onto another card, and `tests/interaction-metrics.test.ts` fails when a label names no card or a card has no label.
  A card the app authors that no recording holds yet is labelled from the end-to-end spec that shows it (git integration PR 1.3): its row names that spec in `from`, the unit test only checks the spec exists, and the spec itself reads the card off the running app and fails unless a row keyed by its exact words says plain (`tests/e2e/forge-signin.spec.ts`, the host's sign-in card).
  Such rows are never scored - only recorded cards are.
  A card with no row is unknown and out of the denominator, never a negative; the engine attaches the label at `observeCard`.
  It is deliberately not a banned-word lint: "the checks failed" needs the word "checks", and the card lint asks for shape by the captain's earlier ruling.
  The committed evenings predate the rule and score 0 on the real exports - the starting line, graded `higher` so a labelled recording under contract 4.0 can only move it up.
- **The second copy row** (contract 4.58, FI3-542): `clear_copy_share`, the same cards read a second time against the five sentence habits `CARD_AUTHORING` states (one fact per sentence in at most 25 words, one name per thing, the doer named, said literally, three or more actions as a numbered list).
  The verdict is `clear` on the card's existing row in `tests/fixtures/plain-language/labels.jsonl`, with `clear_note` naming the habit that broke; the file's header states what counts as broken, and `tests/interaction-metrics.test.ts` fails when a recorded card has no `clear` verdict or a broken one has no note.
  A row with no `clear` (a card labelled from an end-to-end spec) is out of the denominator.
  The committed evenings predate the habits: the reading found 36 of the 74 recorded cards following them, and on the cards each replay shows the baseline starts at 0.7778 (`sep14`), 0.5 (`sep14-real`), 0 (`sep04`) and 1 (`sep26-claude`).
  It is graded `higher`, and it is deliberately not a lint - nothing in the host counts words or looks for a passive.
- **The third copy row** (FI3-1307): `pr_link_share`, the same cards read a third time for the pull request link rule `CARD_AUTHORING` states.
  A recorded card whose body names a pull request - by its number or its address - carries `pr_links` on its existing row in `tests/fixtures/plain-language/labels.jsonl`: true when every one is a link that opens its page, false when one is text or a link that opens nothing, with `pr_links_note` naming which.
  A card whose body names none carries no `pr_links` and is out of the denominator; the file's header says what counts.
  The committed evenings predate the rule: 5 of the 29 `sep14-real` cards that name one link every number, and none of the cards a replay still shows does, so the baseline starts at 0 on `sep14` and `sep14-real` and is `n/a` elsewhere.
  It is graded `higher`, and it is deliberately not a lint - nothing in the host reads a number out of a body.
- **The fourth and fifth copy rows** (INF-2326): `term_explained_share` and `change_effect_share`, the same cards read for the two rules for a card's words `CARD_AUTHORING` states.
  A recorded card whose open prose uses a term the project coined - a name from its code, or one its people made up for an idea - carries `terms`: true when each is explained in a few plain words at first use or replaced, false when one is not, with `terms_note` naming it.
  A recorded card that offers, plans, proposes or reports a change carries `affects`: true when its title or first few sentences say what people using the project will notice, or that only the build, checks or documents change, with `affects_note` naming the opening.
  A card without the term or the change carries no verdict for that reading and is out of its denominator; the labels file's header says what counts, and `tests/interaction-metrics.test.ts` fails when a verdict has no note.
  The committed evenings predate the rules: 2 of the 44 recorded cards that use a project term explain it, and 22 of the 33 cards about a change say their effect early.
  On the cards each replay shows, `term_explained_share` starts at 0.125 (`sep14`, `sep14-real`) and 0 (`sep04`), and `change_effect_share` at 0 (`sep14`, `sep14-real`); both are `n/a` elsewhere.
  Both are graded `higher`, and neither is a lint - no word list or term finder reads a body.
- **Data per metric:** its direction, the measured Sep 14 value, and the captain's target.
  A metric whose `direction` is `either` is **observational**: it is written to the baseline and printed in the report, and the gate never grades it.
  A tier mix that moves toward high is the policy working, not a regression - but the move still has to be explained, which is what having it in the baseline diff buys.

`tests/replay-captain-session.test.ts` asserts each of the nine modes (F1-F9) on the fixtures.
The `replay-gate-catches-*` tests prove the gate fails a real lint regression and a real claim regression.

## The gate

```
pnpm replay:gate
```

replays every session under `tests/fixtures/replay/`, writes `replay-report.json`, and compares against `tests/fixtures/replay/baseline.json`.
A metric that moved in its bad direction, or became unmeasurable, exits 1 and names itself.
It runs as a step of the `mac` lane in `.github/workflows/verify.yml` - inside every alpha, and on demand (crewmates use `github_write` for the ref their task needs; `docs/forge.md`, "Verification workflow requests"), never per PR since captain decision B (2026-09-15) - so a PR that touches any of these runs it locally before pushing:

- `piResources.ts`, `cardLint.ts`, `crewSupervisor.ts` (with the `cardService.ts` and `settleService.ts` it composes), `reportSort.ts`, `firstmateAgent.ts`
- the routing policy or its classifier (`src/shared/routingPolicy.ts`, `src/core/routing/`)
- the delivery rigor (`src/shared/rigor.ts`, `src/shared/cardHeadings.ts`)
- `src/renderer/src/cards/`
- the harness, its fixtures, or the workflow

On a computer in CI mode (`infinitary.checks = ci`, `docs/testing.md` "Where the heavy checks run") `pnpm replay:gate` refuses outside CI.
Its route there is `replay.yml` on request, which runs the gate alone on Linux (`LINUX_RUNNER`, hosted when unset) and keeps `replay-report.json` as the `replay-report` artifact: `POST /repos/{owner}/{repo}/actions/workflows/replay.yml/dispatches` with `{"ref":"<branch>"}`.

**The baseline changes only in a PR that explains it.**
An improvement passes the gate as is.
The PR that lands one runs `pnpm replay:gate --write-baseline` and says, per moved number, why it moved.

## Running it on a real session

```
pnpm replay:captain --user-data /path/to/exported/userData --from 2026-09-14T01:30Z --to 2026-09-14T07:30Z --out report.json
pnpm replay:captain --sessions <dir> --db firstmate.db --out report.json
pnpm replay:captain --user-data <export> --from <iso> --to <iso> --export-fixture tests/fixtures/replay/<name>
```

Inputs are parameters, so a MacBook-exported userData runs identically.
`--sessions` and `--claude-sessions` name the two seats' session directories when they sit outside a userData (defaults `<user-data>/firstmate/sessions` and `<user-data>/firstmate/claude`); `--export-fixture` keeps a Claude-served session in its own dialect under `firstmate/claude/`, its sidecar beside it.
`--supervision` names **pre-S7c archives for fixture export only** (default `<user-data>/supervision/sessions`): `--export-fixture` preserves them through the same scrub and time-window pass.
Replay never consumes these transcripts or their model verdicts; it runs the current whose-turn rule.
Keep the option for archive preservation, not to supply current supervision turns.
To join historical turns to their outcomes, use `extract:supervision` or `export:corpus` (`docs/supervision-extractor.md`).

A userData records every evening since the app was first run, so replay one evening with `--from` / `--to`.
Without a window the harness starts every crewmate the tables know, and every wake with no recorded answer in the evening under test falls back to an escalation: the whole Sep 14 userData scored 270 unrecorded wakes and 82 escalations, 75 of them fallbacks.
The window rule (`scripts/replay/window.ts`) is the trim that reproduced the real Sep 14 session turn for turn:

- **Session files.**
  Every non-message entry stays (`session`, `model_change`, `thinking_level_change`, `custom`).
  A `message` stays only when its timestamp is inside the window.
  A crewmate segment opens at each user message, so this never splits a kept turn.
  A Claude-served session, the seat's or a crewmate's, is trimmed by the same rule over the client's conversation lines (`user`, `assistant`, `attachment`); its sidecar is copied whole.
- **Sessions.**
  Only the first mate's and the crewmates' sessions with a message inside the window; a first mate session that said nothing in it adds no turn, so it is not copied either.
- **Tables.**
  Every `tasks` row, since a task created earlier is the state the evening started from.
  The window's `cards` (created or resolved inside it), `supervision_outcomes`, `captain_asks`, and card-thread messages (`card_messages`, by when each was written).

`--export-fixture` writes exactly that trimmed set through the scrub pass, so a committed fixture replays like the windowed recording (`tests/replay-captain-session.test.ts` pins it).
`--db` takes `firstmate.db` or a scrubbed `tables.json`.
It reads transcripts, so it sits behind Observe's development gate exactly like `pnpm export:corpus`: an unpackaged build, or an explicit `INFINITARY_DEV_OBSERVE=1` (`isDevObserveEnabled` over `detectPackaged`).
It never runs in the app.

The engine loads through the shared offline Vite module runner (`scripts/moduleRunner.ts`), because core modules use path aliases that Node's type stripping cannot resolve.
It disables HTTP listening, WebSockets, HMR and file watching; loading core modules does not reserve a shared development port.
Other core-loading commands (task export, kind scoring, account-model checks, benchmark attempts and self-source generation) use the same runner. vitest imports the engine directly.

## The plan-to-build handoff

What a captain's choice authorizes is a judgment the host never makes (`docs/card-authoring.md`, "The handoff"), so the replay does not read it off the card either.
A person reads the captain's ask and the card as offered and files the choice in `tests/fixtures/approval-labels/labels.jsonl` - the recorded card id, the action chosen, `builds: true|false` and a note saying why - the way the plain-language sample is filed.
A choice with no row is not scored.

When the first mate answers a labelled choice - an `answer-closed` wake for a plan the choice closed, or a `card-choice` on one of its own cards - the engine reads the plan off the wake's typed facts: the task the choice closed, or, on a builder's own card, the `basis` that builder is grounded on.
It counts the builders grounded on that plan that the answering turn started.
`approval_handoff_share` is the share of labelled choices answered as labelled: exactly one grounded start for a build approval (none is the plan left on request, two a duplicate builder), none for any other choice.
A labelled choice the recording never answered is unknown and out of the denominator; one that stops reaching the first mate at all turns the row `n/a`, which the gate fails.

### Unpicked questions

Authors leave a decision's radio, checkbox and select questions unpicked and mark the recommended option `data-inf-recommended`.
The card lint refuses a required question that arrives answered.
`recordedQuestions` turns each `checked` or `selected` proposal the lint names into the `data-inf-recommended` mark, and opens a select on an empty Choose option.
A card the lint passes, a note and a preview replay as recorded.

An effect-free closing choice on a first mate card is the captain's own words, not an operational wake.

## Known limits

- **The Claude-served fixture is synthetic.**
  `sep26-claude` was recorded hermetically on the Claude seat's harness (`tests/replay-claude-session.test.ts`, `tests/fixtures/replay/README.md`), so its model is the stub API's `mock-1` and its crewmates have no recordings.
  A real session served by Claude is committed under the same rules as the captain's other real exports once the seat has run for real (owner answer Q7 a).
- **Real exports sit beside the reconstructions.**
  `sep14-real` and `sep04-real` are the real dogfood windows, hand-trimmed to the report's §2.2 windows, exported through the scrub pass, and hand-scrub-reviewed (`tests/fixtures/replay/README.md`).
  Both have baseline rows and gate like the reconstructions.
  The `sep14`/`sep04` reconstructions stay because the F1-F9 mode tests assert on them; `sep04-real` carries no crewmate dirs because those transcripts no longer exist in userData.
- **Escalations are the current rule's, not the recording's.**
  The whose-turn rule decides them over live state.
- **The tables are the export's state, rewound only for starts.**
  A row whose `started_at` falls after the replay begins is seeded as still open; a row closed after it began is still seeded as it ended, because nothing recorded says what it was doing in between (six rows in `sep14-real`, five in `sep04-real`).
- **The handoff fixtures carry only the handoff's own crewmates.**
  `sep30-handoff-agree` and `oct01-handoff-start` were exported with `--crewmates` naming the planner's and the builder's sessions alone; every other crewmate of those hours is a task row with no recording (`tests/fixtures/replay/README.md`).
- **F8 is only measured at the replay level.**
  The workspace is a stand-in, so the check is "every spawn starts"; `WorkspaceService`'s own tests cover the git worktree path.
- **Consult answers are recorded.**
  A consult change is exercised only through what the first mate does with the recorded answer.

## Notes moved from AGENTS.md

Moved verbatim from `AGENTS.md` on 2026-09-24; `AGENTS.md` keeps a one-line pointer to each.

- The interaction eval gate (interaction-system P3, WI-19/20/21; `docs/replay-harness.md`): `pnpm replay:gate` replays the captain sessions under `tests/fixtures/replay/` (userData-shaped; `sep14`/`sep04` are reconstructions the F1-F9 mode tests assert on, `sep14-real`/`sep04-real` the hand-scrub-reviewed real dogfood exports beside them, gated like the rest; export another evening with `--from`/`--to` (`scripts/replay/window.ts`)) through the REAL FirstmateAgent and CrewSupervisor with only the models recorded, scores `scripts/interaction-metrics.ts` (the one home of the section-4 numbers, Sep 14 values and targets), and fails on any regression from `tests/fixtures/replay/baseline.json`; it is a step of `verify.yml`'s mac lane (every alpha, and on demand), never per PR since captain decision B (2026-09-15), so a PR touching the prompt, card lint, the whose-turn sort, routing, the first mate agent, or `src/renderer/src/cards/` runs `pnpm replay:gate` locally before pushing.
  The baseline changes only in a PR that explains every moved number.
  The engine loads through `scripts/moduleRunner.ts`, the Vite module runner `pnpm export:tasks` also uses (core aliases and extensionless imports defeat Node's type stripping), is dev-gated like the corpus export, and matches a current wake to a recorded answer by text, then prefix, then kind+task - an unmatched wake is counted under `fidelity`, never invented.
  `scripts/derive-duplicate-candidates.ts` (`docs/duplicate-deriver.md`) is the tables-only duplicate-card sibling of C2: weak pairs, never writes `duplicate_of`.
  The plain-language pass (roadmap 1.5, contract v4.0) is measured here too: `plain_language_share` scores the hand-read sample in `tests/fixtures/plain-language/labels.jsonl` (one row per recorded card, keyed by `cardLabelKey`; an unread card is out of the denominator), never a banned-word lint - the vocabulary's one home is the design skill's `copy/Vocabulary.prompt.md`, and `CARD_AUTHORING` carries the same table to every persona.

Choice admission is current-host behavior too: a recorded hidden or closed-task choice refused by `CardChoiceUnavailableError` stays unresolved.
It counts under `skipped_card_resolutions`, with titles in `details.refused_card_choices`; replay never forces the recorded input through.
A withdrawal or proven task retirement is never fed to admission: its evidence comes from the recorded `close_card` or task closure facts, as above.

### Requested-plan approval interpretation evaluation

`node scripts/evals/approval-handoff.ts` exports twelve isolated prompts and `cases.json`: ten first mate cases with the current contract, the bundled runbooks' first-mate guidance, historical conflicting planning note and native task/crew/card tool schemas, plus two read-only successor-brief reviews served the runbooks' crew guidance for implement work on a direct-pr project.
Cases cover ordinary acceptance, non-default task-card count, repeated delivery, welcome recovery with saved answers, design-only acceptance, settings capture, dismissal, Save and defer on a plan no task builds on yet, explicit hold, motion's real unresolved question, and an operational plan whose later step waits on a credential gate.
The complete welcome/task-card specifications live in `tests/fixtures/approval-handoff/`; their provenance and fictional fixture approvals are explicit, never retroactive backlog consent.
Every row carries non-autonomy.
Dismissal is a real `close` resolution with no selected action/answers; keeps-open capture is not a closing resolution.

Run against a disposable supported host/session using the intended first mate model through supported isolated access; never read personal sign-ins.
Retain the actual served model/version, prompt and tool fingerprints, complete task facts/briefs, raw model responses, executed calls/results, final state and normal/bounded termination.
Feed the same exported records to by-key reads and crew status; do not replace full reports with one-line summaries or label a dismissal as acceptance.
Execute through native tools and their production validation/refusals, not permissive handwritten success replies.
The builder reviews must retain the full specification and actual answers.
For a live execution harness, map symbolic fixture references to disposable task ids; never target historical task ids or start real backlog work.

`--responses <file>` accepts a JSON object keyed by case id of `EvalRun` records (`scripts/evals/approvalHandoff.ts`), not arrays of proposed calls.
Record each call's actual success/refused/invalid/failed result, observed grounded builder status, blocker edges and open cards.
The independent reviewer records `fullAcceptedSpecPreserved`, `noInventedMergePermission`, and for motion `specificMotionQuestion`.
These are semantic review judgments, not host prose parsing.
Recovery needs a successful basis edit followed by a separate start in the same turn.
Repeat/negative cases allow no start attempt, even refused.
Save and defer allows none either, and needs exactly one `create_task` on request grounded on the plan, observed as one unstarted planned build.
Hold requires the concrete graph edge, motion requires an actually shown specific two-choice question on an open parent/successor (not a steer to an unstarted builder), and passing verification cannot imply merge permission.
Missing/excluded/bounded cases, missing execution results and refused calls are failures, never inferred passes.
Retain full traces alongside scores.

Exporting prompts or passing scorer tests is not a model evaluation pass.
The hermetic application journeys prove host delivery and served briefs; recorded replay cannot prove that a live first mate follows revised guidance.
A local-model probe is not intended-model evidence.

## Approval handoff: signed-in live evaluation

The twelve independent approval-handoff cases (ten first mate turns and two full-spec builder reviews) have a developer-only account runner: `pnpm eval:accounts`, loaded through `scripts/moduleRunner.ts`.
Its default mode writes a free run sheet, not model responses.
A live run requires the captain's go on that exact sheet hash, run under a Claude crewmate's own client, which the runner checks, inside that crewmate's turn while the first mate remains open.
Sign-ins stay with production clients/runtimes; nobody reads or copies a sign-in, probes login or runs a Keychain command.
Only metadata and the permitted two settings rows can be read, and all model tools operate on throwaway task/card records.

See [the run-sheet procedure, limits and no-cost proofs](account-evaluation.md).
`responses.json` feeds `pnpm eval:approval --responses PATH`; the evaluating crewmate fills the independent semantic review fields from the trace.
Missing, bounded or excluded cases fail.
Exported prompts, mock responses or scorer tests do not prove the intended model follows new instructions.
