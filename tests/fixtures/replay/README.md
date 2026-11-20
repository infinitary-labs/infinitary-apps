# Replay fixtures

Recorded captain sessions for the interaction eval gate (`docs/replay-harness.md`). Every subdirectory is one session laid out like an app userData directory, so `pnpm replay:captain --user-data tests/fixtures/replay/<name>` and a real MacBook export run the same way:

```
<name>/
  firstmate/sessions/*.jsonl          the Firstmate's rolling transcript
  firstmate/claude/<id>.jsonl         or a Claude-served one: the app's copy of its client's transcript
  firstmate/claude/<id>.served.jsonl    and the served sidecar beside it (docs/provenance-capture.md section 4)
  crewmates/<task>/sessions/*.jsonl   each crewmate it drove
  supervision/sessions/*.jsonl        the supervision session's triage turns
  tables.json                         scrubbed rows: tasks, cards (supervision_outcomes, captain_asks, card_messages when present)
```

`baseline.json` is what the committed sessions score at the current code. It changes only in a PR that explains every moved number.

## Fleet recordings

Both are independently authored examples in the historical Pi session and table formats.
They use fictional projects, tasks, paths and transcripts, not exports from a person's machine.

- `fleet-captain-only` follows a harbour timetable over 12 captain turns and 22 legacy operational turns.
  It has no crewmate recordings.
  All 18 supervision rows store the first 160 characters of their served wake, exercising the legacy prefix join.
- `fleet-mixed` follows a greenhouse crew over 36 captain turns, including two host-retired and five emitter-withdrawn cards.
  It has 174 exact supervision joins and 164 crewmate turns: 140 play, and the other 24 name the missing start, unseen cards or unplayed steers.
  Its tables contain a duplicate note pair and a plan-versus-settle pair that must not count as a duplicate.

## Plan-to-build recordings

`handoff-approval` and `handoff-start` are independently authored recordings about a fictional forecast board.
The first includes a pre-recovery structured answer receipt and a Claude-format planner session with its served sidecar.
A captain reply reaches the original card, the planner revises that card and reports, and agreement closes the plan without starting a builder.
The second starts one on-request builder grounded in that plan, and the builder plays its first recorded turn.
Both choices are labeled in `tests/fixtures/approval-labels/labels.jsonl` so the gate distinguishes the miss from the start.

## The Claude-served recording: `sep26-claude`

`sep26-claude/` is a Firstmate session served by the Claude seat (a hermetic recording with authored inputs). It was recorded by `tests/replay-claude-session.test.ts`, which plays a scripted captain session through the REAL Firstmate agent on the Claude seat, over the SDK's own client boxed by the seat's hermetic harness (`tests/helpers/claudeSeatHarness.ts`: a throwaway config dir, a dummy token, a local stub of the Anthropic API). Only the model's answers are scripted:

- the captain asks for the flaky sign-in test to be fixed - a spawn;
- asks how the crew is doing, and while that turn is mid-tool adds "Also have someone fix the typo on the settings page." - a steer the client folds into the running turn, answered with a second spawn;
- asks whether to release tonight - a decision card with a default, which the captain answers "Wait for the fix", and the Firstmate hears the choice as a wake.

It replays 4/4 captain turns and 1/1 op turns. The two crewmates carry no recordings (the session is about the Firstmate), and the model reads `mock-1`, the stub API's name.

To re-record it (a client update that changes what the transcript holds, say), run `INFINITARY_WRITE_CLAUDE_FIXTURE=1 pnpm exec vitest run --project integration tests/replay-claude-session.test.ts`: the recording goes through the replay's own export and its scrub pass, with the throwaway HOME written as `/Users/captain/Library/Application Support/firstmate-3000`. Its card's plain-language label is keyed by its words, so a re-recording keeps it; then `pnpm replay:gate --write-baseline` and explain every moved number. Nothing in it came from a person: the words are the script's, and no credential, token or machine path survives.

## The program reconstruction: `oct22-program`

`oct22-program/` is one first mate turn written by hand for INF-799 piece 3 and rewritten for INF-3022, like the reconstructions below: the captain says "Loop on the flaky checkout tests: keep fixing them until the whole suite passes." in a local-only project, and the first mate answers with one `spawn_crewmate` whose free constraint says "Use start_program to do this", as the served Programs guide asks, writing no script. The tool answer is written in the live host's words with a made-up key and id. Its tables are empty. `tests/replay-captain-session.test.ts` replays it as one crewmate task and no program the first mate filed (`docs/replay-harness.md`). It has a baseline row like the others. It shows the host takes the hand-off the guide serves; it is not evidence that a live model writes it.

## The reconstructions: `sep14` and `sep04`

The raw Sep 4-5 and Sep 14 dogfood sessions were not on the machine when the harness was built, so these two were reconstructed from the evidence in `fm3000-interaction-sys-improve-s1/report.md` (sections 2.2 and 7), the same way the P0 crewmate replays were. They are kept beside the authored fleet recordings because the F1-F9 mode tests assert on them:

- `sep14` - the frustrating evening: the six ghost crewmates (F1), the ba13eadd wake storm, its garbled report and the cancel (F2, F3, F9), the c9dab1e7 plan-card escalations and lock-refused steers (F2, F9), the "delivered" question thread with its restated crewmate notes, the table card and the 3,885-character note (F4, F5, F6), the branch-collision start (F8), and the merge-click question (F7). `crewmates/ba13eadd` and `crewmates/c9dab1e7` are the P0 fixtures, moved here unchanged; `crewSupervisor.test.ts` and `inboxStore.test.ts` still read them.
- `sep04` - the fake merge buttons: three decision cards with per-PR merge ids the host never dispatched (F7), the consult that hit its bound, the scout's truncated self-brief escalations, and the Firstmate card that restated the scout's finding (F4).

Message wording, ids, and counts follow the report where it gives them and are paraphrased where it does not. The numbers these fixtures score are the replay's numbers, never the report's measured Sep 14 values (those live in `scripts/interaction-metrics.ts`).

`lock-refusals-sep14.jsonl` is the P0 lock-refusal reconstruction that `crewSupervisor.test.ts` replays directly; it is not a userData-shaped session.

## Exporting a recording for private analysis

```
pnpm replay:captain --user-data /path/to/exported/userData \
  --from 2026-09-14T01:30Z --to 2026-09-14T07:30Z \
  --export-fixture /path/outside/the/checkout
```

copies the evening's window (the trim rule in `docs/replay-harness.md`) through the scrub pass (Observe's redaction on every string, image payloads dropped). Keep exports from private user data out of the repository; to add a fixture, use independently authored or hermetic inputs and review the result by hand - then run `pnpm replay:gate --write-baseline` and explain every new or moved baseline number in the PR.
