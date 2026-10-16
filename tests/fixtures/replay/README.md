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

## The real exports: `sep14-real` and `sep04-real`

`sep14-real/` and `sep04-real/` are the real dogfood windows exported from the captain's MacBook userData and hand-scrub-reviewed (Q1a, review `fm3000-interaction-fable-review-s1/report.md` §2.2, §8). They sit beside the reconstructions, not in place of them: the F1-F9 mode tests still assert on `sep14`/`sep04`, and these two carry the numbers the plan named so a prompt or supervision change can be scored against the real evening.

- **`sep14-real`** - the frustrating evening, window `2026-09-14T01:30Z`-`07:30Z`: 36 captain turns, 13 crewmate dirs, the supervision session, all 80 `tasks` and the window's `cards` / `supervision_outcomes` / `captain_asks`. Replays 36/36 captain turns, 34/132 op turns, 109/174 triage, 3 unrecorded wakes; 22 escalations at precision 0.32, 0.97 op wakes per captain turn (the report's §2.2 middle column, reproduced exactly).
- **`sep04-real`** - the fake-merge night, window `2026-09-04T23:30Z`-`2026-09-05T04:00Z`: 12 captain turns plus the supervision session. It carries **no crewmate dirs** - those transcripts no longer exist in userData (review L3) - so it replays 12/12 captain turns but 0/22 op turns and 0/18 triage, captain-side only.

Both have rows in `baseline.json` and gate like the reconstructions. The rows were written after the fable review fixes; the fixtures PR's description records their 578a76b2 values, and the fixes PR explains every number that moved from those.

### How they were built (reproducible)

Hand-trimmed to the window per §2.2 (before the CLI had `--from`/`--to`, which now applies the same rule), then exported through the scrub pass. Per file: keep the rolling session's `session` / `model_change` / `thinking_level_change` / `custom` entries plus every `message` inside the window; keep only crewmate dirs with a message inside the window and trim their files the same way; trim the supervision file the same way; `tables.json` keeps all `tasks` and the window's `cards` (created or resolved inside), `supervision_outcomes`, and `captain_asks`. The trimmed set was then run through `pnpm replay:captain --export-fixture`, whose scrub pass redacts secrets by shape and drops image payloads.

### Scrub attestation (hand review)

The shape-based scrub (Observe redaction) fired: api keys, tokens, `Bearer`, and system prompts are redacted, image payloads dropped. It catches secrets by shape, not meaning, so this export was reviewed by hand for what it misses:

- **Home paths** - the macOS username in `/Users/kunchen/...` is neutralized to `/Users/captain/...` (dash-encoded form too). `kunchenguid` is the captain's public social handle and stays.
- **PII** - personal contact email addresses are replaced with `[redacted email]`; vendor/service and example addresses stay.
- **Content** - every task in these windows is firstmate-3000's own development (the repo is a nested checkout of this product), so there is no external private-repo content. Card bodies and captain prompts were reviewed and carry only product discussion.
- The only large opaque blobs left are provider reasoning signatures (`thinkingSignature` / `encrypted_content`) - not credentials or PII.

## The handoff recording: `sep30-handoff-agree` and `oct01-handoff-start`

The real FI3-309 to FI3-310 session (FI3-391), exported from the captain's MacBook userData through the scrub pass and hand-scrub-reviewed like the real exports above. Its two captain choices are labelled in `tests/fixtures/approval-labels/labels.jsonl` and scored by `approval_handoff_share` (`docs/replay-harness.md`, "The plan-to-build handoff"). The six hours between the two choices span 42 recorded sessions and 60 MB, so the session is two fixtures, one per choice:

- **`sep30-handoff-agree`** - window `2026-09-30T18:52:00Z`-`19:35:30Z`. The captain asks for task popovers as ordinary cards and solid card backgrounds; the Firstmate starts FI3-309, a Fable planner, and plans FI3-310 on its basis, on request; the planner's card goes up; at 19:34:59 the captain chooses "Agree the plan", and the Firstmate answers with a verdict on FI3-310 and no start. 5/5 captain turns; scores 0 (the miss).
- **`oct01-handoff-start`** - window `2026-10-01T00:44:30Z`-`00:46:00Z`. The captain asks "did we land the work to make main cards background solid?"; the Firstmate's card offers "Start implementation"; he chooses it at 00:45:16 and the Firstmate starts FI3-310, whose builder's first turn plays. 2/2 captain turns; scores 1.

Each carries only the handoff's own crewmate - the planner in the first, the builder in the second - so `--crewmates` named a folder holding that one task's sessions; every other crewmate of those hours is a task row with no recording (the first window's full set is 15 MB across 14 crewmates). The tables are the standard window: every `tasks` row, as it stood at export, and the window's cards.

The card threads (`card_messages`) were added afterwards (FI3-429), when the export began to carry them. Only that key changed: the window's rows were read from a second read-only snapshot taken the same way, through the export's own window and scrub, and written beside the tables already committed. `sep30-handoff-agree` holds three: the captain's 19:25 reply under the planner's card, and the host's two `revised:` lines (one for that card's 19:30 revision, one for a card whose crewmate has no recording here). `oct01-handoff-start` holds none, so its key is an empty list.

```
pnpm replay:captain --user-data <snapshot> --crewmates <folder with crewmates/1cf310e2 only> \
  --from 2026-09-30T18:52:00Z --to 2026-09-30T19:35:30Z --export-fixture tests/fixtures/replay/sep30-handoff-agree
pnpm replay:captain --user-data <snapshot> --crewmates <folder with crewmates/ced91481 only> \
  --from 2026-10-01T00:44:30Z --to 2026-10-01T00:46:00Z --export-fixture tests/fixtures/replay/oct01-handoff-start
```

`<snapshot>` was a read-only copy of the userData: the database copied with SQLite's online backup, the session folders read in place, nothing written back.

Scrub attestation (hand review, as above): home paths and the dash-encoded project folder name say `captain` instead of the macOS username, and so do the owner columns of directory listings in tool output; `kunchenguid`, the captain's public handle, stays. The captain's two personal addresses and a vendor contact's personal address quoted in a task report are `[redacted email]`; `noreply@anthropic.com` stays. Every task in these windows is firstmate-3000's own development or the app's own scratch and personal-workspace rows, and the transcripts read only this repository's source. The large opaque blobs left are provider reasoning signatures. The cards in these windows carry no plain-language labels yet, so `plain_language_share` is `n/a` for both.

## The Claude-served recording: `sep26-claude`

`sep26-claude/` is a Firstmate session served by the Claude seat (W1 S11, owner answer Q7 a: a hermetic synthetic recording now, a real dogfood session later under the same rules as the real exports above). It was recorded by `tests/replay-claude-session.test.ts`, which plays a scripted captain session through the REAL Firstmate agent on the Claude seat, over the SDK's own client boxed by the seat's hermetic harness (`tests/helpers/claudeSeatHarness.ts`: a throwaway config dir, a dummy token, a local stub of the Anthropic API). Only the model's answers are scripted:

- the captain asks for the flaky sign-in test to be fixed - a spawn;
- asks how the crew is doing, and while that turn is mid-tool adds "Also have someone fix the typo on the settings page." - a steer the client folds into the running turn, answered with a second spawn;
- asks whether to release tonight - a decision card with a default, which the captain answers "Wait for the fix", and the Firstmate hears the choice as a wake.

It replays 4/4 captain turns and 1/1 op turns. The two crewmates carry no recordings (the session is about the Firstmate), and the model reads `mock-1`, the stub API's name.

To re-record it (a client update that changes what the transcript holds, say), run `INFINITARY_WRITE_CLAUDE_FIXTURE=1 pnpm exec vitest run --project integration tests/replay-claude-session.test.ts`: the recording goes through the replay's own export and its scrub pass, with the throwaway HOME written as `/Users/captain/Library/Application Support/firstmate-3000`. Its card's plain-language label is keyed by its words, so a re-recording keeps it; then `pnpm replay:gate --write-baseline` and explain every moved number. Nothing in it came from a person: the words are the script's, and no credential, token or machine path survives.

## The reconstructions: `sep14` and `sep04`

The raw Sep 4-5 and Sep 14 dogfood sessions were not on the machine when the harness was built, so these two were reconstructed from the evidence in `fm3000-interaction-sys-improve-s1/report.md` (sections 2.2 and 7), the same way the P0 crewmate replays were. They are kept beside the real exports above because the F1-F9 mode tests assert on them:

- `sep14` - the frustrating evening: the six ghost crewmates (F1), the ba13eadd wake storm, its garbled report and the cancel (F2, F3, F9), the c9dab1e7 plan-card escalations and lock-refused steers (F2, F9), the "delivered" question thread with its restated crewmate notes, the table card and the 3,885-character note (F4, F5, F6), the branch-collision start (F8), and the merge-click question (F7). `crewmates/ba13eadd` and `crewmates/c9dab1e7` are the P0 fixtures, moved here unchanged; `crewSupervisor.test.ts` and `inboxStore.test.ts` still read them.
- `sep04` - the fake merge buttons: three decision cards with per-PR merge ids the host never dispatched (F7), the consult that hit its bound, the scout's truncated self-brief escalations, and the Firstmate card that restated the scout's finding (F4).

Message wording, ids, and counts follow the report where it gives them and are paraphrased where it does not. The numbers these fixtures score are the replay's numbers, never the report's measured Sep 14 values (those live in `scripts/interaction-metrics.ts`).

`lock-refusals-sep14.jsonl` is the P0 lock-refusal reconstruction that `crewSupervisor.test.ts` replays directly; it is not a userData-shaped session.

## Dropping in a real export

```
pnpm replay:captain --user-data /path/to/exported/userData \
  --from 2026-09-14T01:30Z --to 2026-09-14T07:30Z \
  --export-fixture tests/fixtures/replay/<name>
```

copies the evening's window (the trim rule in `docs/replay-harness.md`) through the scrub pass (Observe's redaction on every string, image payloads dropped). Review the result by hand before committing it - redaction catches secrets by shape, not by meaning - then run `pnpm replay:gate --write-baseline` and explain every new or moved baseline number in the PR.
